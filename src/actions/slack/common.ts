import type { OAuth2Scheme } from '../../core/auth';
import { ActionError } from '../../core/errors';

/**
 * Shared Slack building blocks: the endpoints, scopes, and the `ok`/`error`
 * envelope convention from Slack's public API.
 */

export const SLACK_API_BASE = 'https://slack.com/api';

/** The OAuth2 scheme actions declare; connect-UI metadata only — the token is attached by the transport. */
export const slackOAuth: OAuth2Scheme = {
  type: 'oauth2',
  authUrl: 'https://slack.com/oauth/v2/authorize',
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  scopes: ['channels:read', 'groups:read', 'chat:write'],
};

/** The common envelope every Web API method returns: `ok` gates data vs. `error`. */
export interface SlackEnvelope {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string; messages?: string[] };
}

/** Slack error codes that are transient (worth a retry) rather than the caller's fault. */
const RETRYABLE_SLACK_ERRORS = new Set([
  'ratelimited',
  'service_unavailable',
  'internal_error',
  'fatal_error',
]);

/**
 * Slack signals failure as HTTP 200 with `{ ok: false, error }` — invisible to
 * HTTP-status checks. Convert that into the SDK's one failure shape so a Slack
 * `channel_not_found` is a structured, non-retryable error, and `ratelimited`
 * is retryable, exactly like a real HTTP 4xx/5xx.
 */
export function assertSlackOk<T extends SlackEnvelope>(data: T): T {
  if (data.ok) return data;
  const error = data.error ?? 'unknown_error';
  throw new ActionError({
    code: 'provider_error',
    message: `Slack API error: ${error}`,
    status: RETRYABLE_SLACK_ERRORS.has(error) ? 503 : 400,
    retryable: RETRYABLE_SLACK_ERRORS.has(error),
    detail: { provider: 'slack', error },
  });
}
