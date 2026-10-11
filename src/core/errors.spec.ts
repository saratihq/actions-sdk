import {
  ActionError,
  failureReason,
  isRetryableStatus,
  normalizeError,
  redactSecrets,
  transportFailure,
} from './errors';

describe('isRetryableStatus', () => {
  it.each([
    [0, true],
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false],
    [501, false],
    [505, false],
    [200, false],
  ])('status %i → retryable %s', (status, expected) => {
    expect(isRetryableStatus(status)).toBe(expected);
  });
});

describe('normalizeError', () => {
  it('reduces an ActionError to its failure shape', () => {
    const err = new ActionError({ message: 'nope', status: 404, code: 'http_error' });
    expect(normalizeError(err)).toEqual({ status: 404, message: 'nope', retryable: false });
  });

  it('maps a network error code to a retryable status-0 failure', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(normalizeError(err)).toEqual({ status: 0, message: 'connect ECONNREFUSED', retryable: true });
  });

  it('maps an AbortError to a retryable timeout', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(normalizeError(err)).toMatchObject({ status: 0, retryable: true });
  });

  it('treats an unknown Error as non-retryable so a bug is not retried forever', () => {
    expect(normalizeError(new Error('boom'))).toEqual({ status: 0, message: 'boom', retryable: false });
  });

  it('handles a non-Error throw', () => {
    expect(normalizeError('weird')).toMatchObject({ status: 0, retryable: false });
  });
});

describe('redactSecrets', () => {
  it('scrubs tokens from query strings', () => {
    expect(redactSecrets('GET https://x.com/a?access_token=abc123def&b=1')).toBe(
      'GET https://x.com/a?access_token=[redacted]&b=1',
    );
  });

  it('scrubs bearer tokens and Slack tokens', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJ.payload.sig')).toContain('Bearer [redacted]');
    expect(redactSecrets('token xoxb-123456789-abcdef')).toContain('[redacted]');
  });

  it('leaves clean text untouched', () => {
    expect(redactSecrets('HTTP 404: channel_not_found')).toBe('HTTP 404: channel_not_found');
  });
});

describe('ActionError', () => {
  it('derives retryability from status when not given', () => {
    expect(new ActionError({ message: 'x', status: 503 }).retryable).toBe(true);
    expect(new ActionError({ message: 'x', status: 400 }).retryable).toBe(false);
  });

  it('scrubs secrets from the message', () => {
    const err = new ActionError({ message: 'failed for token xoxb-1-secretvalue' });
    expect(err.message).not.toContain('secretvalue');
  });
});

describe('transportFailure', () => {
  const coded = (message: string, code: string, syscall?: string): Error =>
    Object.assign(new Error(message), { code, ...(syscall ? { syscall } : {}) });

  it('keeps the reason when every address of a dual-stack name refused (an AggregateError with no message)', () => {
    const refused = Object.assign(
      new AggregateError([
        coded('connect ECONNREFUSED ::1:1', 'ECONNREFUSED', 'connect'),
        coded('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED', 'connect'),
      ]),
      { code: 'ECONNREFUSED' },
    );
    expect(refused.message).toBe('');
    expect(transportFailure('http://localhost:1', refused, 'request')).toMatchObject({
      code: 'transport_unreachable',
      retryable: true,
      message:
        'could not reach http://localhost:1: connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1',
      detail: {
        origin: 'http://localhost:1',
        reason: 'connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1',
      },
    });
  });

  it.each([
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND x.example', 'getaddrinfo'],
    ['ECONNREFUSED', 'connect ECONNREFUSED 1.2.3.4:443', 'connect'],
    ['ETIMEDOUT', 'connect ETIMEDOUT 1.2.3.4:443', 'connect'],
    ['UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error', undefined],
    ['UND_ERR_CLOSED', 'The client is closed', undefined],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'wrong version number', undefined],
  ])('calls %s a host never reached, safe to send again', (code, message, syscall) => {
    expect(transportFailure('https://x.example', coded(message, code, syscall), 'request')).toMatchObject({
      code: 'transport_unreachable',
      retryable: true,
      message: `could not reach https://x.example: ${message}`,
    });
  });

  it.each([
    ['CERT_HAS_EXPIRED', 'certificate has expired'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"],
  ])('calls a refused certificate (%s) never sent, and does not retry it', (code, message) => {
    expect(transportFailure('https://x.example', coded(message, code), 'request')).toMatchObject({
      code: 'transport_unreachable',
      retryable: false,
    });
  });

  it.each([
    ['read ETIMEDOUT', 'ETIMEDOUT', 'read'],
    ['write EHOSTUNREACH', 'EHOSTUNREACH', 'write'],
  ])(
    'calls %s on an established socket possibly sent, since the request may have gone out',
    (message, code, syscall) => {
      expect(transportFailure('https://x.example', coded(message, code, syscall), 'request')).toMatchObject({
        code: 'transport_interrupted',
        message: `the connection to https://x.example broke possibly after the request was sent: ${message}`,
      });
    },
  );

  it.each([
    ['UND_ERR_NOT_SUPPORTED', 'expect header not supported'],
    ['UND_ERR_INVALID_ARG', 'invalid keep-alive header'],
    ['UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'Request body length does not match content-length header'],
    ['ERR_INVALID_ARG_VALUE', 'The argument is invalid'],
  ])('calls %s a request that could not be built: invalid input, never retried', (code, message) => {
    expect(transportFailure('https://x.example', coded(message, code), 'request')).toMatchObject({
      code: 'invalid_input',
      retryable: false,
      message: `the request to https://x.example could not be sent: ${message}`,
    });
  });

  it.each([['UND_ERR_SOCKET'], ['ECONNRESET'], ['UND_ERR_HEADERS_TIMEOUT'], ['SOMETHING_NEW']])(
    'calls %s a connection that may have carried the request',
    (code) => {
      expect(
        transportFailure('https://x.example', coded('other side closed', code), 'request'),
      ).toMatchObject({
        code: 'transport_interrupted',
        message:
          'the connection to https://x.example broke possibly after the request was sent: other side closed',
      });
    },
  );

  it('calls a codeless failure possibly sent, so a non-idempotent request is not resent', () => {
    expect(transportFailure('https://x.example', new Error(''), 'request')).toMatchObject({
      code: 'transport_interrupted',
      message:
        'the connection to https://x.example broke possibly after the request was sent: no reason given',
    });
  });

  it('says a server that did not answer with HTTP did not, and does not retry it', () => {
    const notHttp = Object.assign(new Error('Response does not match the HTTP/1.1 protocol'), {
      name: 'HTTPParserError',
    });
    expect(transportFailure('http://x.example:22', notHttp, 'request')).toMatchObject({
      code: 'http_error',
      retryable: false,
      message: 'http://x.example:22 did not answer with HTTP: Response does not match the HTTP/1.1 protocol',
    });
  });

  it('calls a body that cannot be decoded a provider error, not a broken connection', () => {
    expect(
      transportFailure('https://x.example', coded('incorrect header check', 'Z_DATA_ERROR'), 'response'),
    ).toMatchObject({
      code: 'provider_error',
      retryable: false,
      message: 'https://x.example sent a response body that could not be decoded: incorrect header check',
    });
  });

  it('says a failure while reading the body happened there', () => {
    expect(
      transportFailure('https://x.example', coded('other side closed', 'UND_ERR_SOCKET'), 'response'),
    ).toMatchObject({
      code: 'transport_interrupted',
      message: 'the connection to https://x.example broke while reading the response: other side closed',
    });
  });

  it('falls back to the code when a failure carries no message', () => {
    expect(failureReason(coded('', 'ECONNREFUSED'))).toBe('ECONNREFUSED');
  });
});
