import { ActionError, isRetryableStatus, normalizeError, redactSecrets } from './errors';

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
