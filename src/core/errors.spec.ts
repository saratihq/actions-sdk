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
  const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code });

  it('keeps the reason when every address of a dual-stack name refused (an AggregateError with no message)', () => {
    const refused = Object.assign(
      new AggregateError([
        coded('connect ECONNREFUSED ::1:1', 'ECONNREFUSED'),
        coded('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED'),
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
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND x.example'],
    ['UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'],
    ['CERT_HAS_EXPIRED', 'certificate has expired'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"],
  ])('calls %s a host never reached, safe to send again', (code, message) => {
    expect(transportFailure('https://x.example', coded(message, code), 'request')).toMatchObject({
      code: 'transport_unreachable',
      message: `could not reach https://x.example: ${message}`,
    });
  });

  it.each([
    ['UND_ERR_NOT_SUPPORTED', 'expect header not supported'],
    ['UND_ERR_INVALID_ARG', 'invalid keep-alive header'],
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

  it("calls fetch's own codeless refusal (a bad port) a request that could not be sent", () => {
    expect(transportFailure('http://127.0.0.1:9', new Error('bad port'), 'request')).toMatchObject({
      code: 'invalid_input',
      retryable: false,
      message: 'the request to http://127.0.0.1:9 could not be sent: bad port',
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
