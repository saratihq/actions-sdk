import { defineTrigger, type HandshakeResponse, type WebhookRequest } from '../../core/trigger';
import { checkbox } from '../../core/props';
import { slackOAuth } from './common';
import { verifySlackSignature } from './signature';

/** Public type for the webhook trigger. */
export const NEW_MESSAGE_TYPE = 'slack.new_message';

/** A normalised message event — what a workflow step receives. */
export interface SlackMessageEvent {
  channel: string;
  channelType: string;
  user?: string;
  text?: string;
  ts: string;
  botId?: string;
}

/** The Slack Events API request envelope (the relevant fields). */
interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    text?: string;
    ts?: string;
    bot_id?: string;
  };
}

/**
 * Webhook trigger over Slack Events; the app-level subscription URL means no per-connection
 * registration, and this stays out of `catalogTriggers` until the host provides app-level intake.
 */
export const newMessage = defineTrigger({
  type: NEW_MESSAGE_TYPE,
  strategy: 'webhook',
  name: 'New message',
  description: 'Fires when a message is posted to a channel the app can see.',
  auth: slackOAuth,
  props: {
    ignoreBots: checkbox({
      label: 'Ignore bot messages',
      description: 'Skip messages posted by bots (including this app).',
      required: false,
      defaultValue: true,
    }),
  },
  sampleData: {
    channel: 'C0123456789',
    channelType: 'channel',
    user: 'U0123456789',
    text: 'Hello from Slack',
    ts: '1710304378.475129',
  },
  /** Echo Slack's one-time URL verification challenge so the subscription can be enabled. */
  handshake(request: WebhookRequest): HandshakeResponse | null {
    const body = request.body as SlackEventEnvelope | undefined;
    if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
      return { status: 200, body: { challenge: body.challenge } };
    }
    return null;
  },
  /** Authenticate the request with the app signing secret before trusting the payload. */
  verify(request, secrets): boolean {
    const signingSecret = secrets.signingSecret;
    return signingSecret ? verifySlackSignature(request, signingSecret) : false;
  },
  onRequest({ request, props }): SlackMessageEvent[] {
    const body = request.body as SlackEventEnvelope | undefined;
    const event = body?.event;
    if (!event || event.type !== 'message' || typeof event.ts !== 'string') return [];
    if (props.ignoreBots && event.bot_id) return [];
    return [
      {
        channel: event.channel ?? '',
        channelType: event.channel_type ?? '',
        ts: event.ts,
        ...(event.user ? { user: event.user } : {}),
        ...(event.text ? { text: event.text } : {}),
        ...(event.bot_id ? { botId: event.bot_id } : {}),
      },
    ];
  },
  /** Slack retries redeliver the same event — dedupe on channel + ts. */
  dedupeKey: (event) => `${event.channel}:${event.ts}`,
});
