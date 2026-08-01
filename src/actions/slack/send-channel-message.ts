import { defineAction } from '../../core/action';
import { checkbox, dropdown, longText, shortText } from '../../core/props';
import { assertSlackOk, SLACK_API_BASE, slackOAuth, type SlackEnvelope } from './common';
import { listSlackChannels } from './list-channels';

/** Public type for the send-message action. */
export const SEND_CHANNEL_MESSAGE_TYPE = 'slack.send_channel_message';

export interface PostMessageResponse extends SlackEnvelope {
  channel?: string;
  ts?: string;
  message?: { text?: string; user?: string; bot_id?: string };
}

/** Post a message to a channel, with a live-fetched channel picker instead of a pasted channel id. */
export const sendChannelMessage = defineAction({
  type: SEND_CHANNEL_MESSAGE_TYPE,
  name: 'Send message to a channel',
  description: 'Post a message to a Slack channel.',
  auth: slackOAuth,
  props: {
    channel: dropdown<string, true>({
      label: 'Channel',
      description: 'The channel to post to — loaded live from your workspace.',
      required: true,
      options: async ({ auth, http }) => {
        const channels = await listSlackChannels(http, auth, { maxItems: 1000 });
        return channels.map((channel) => ({ label: `#${channel.name}`, value: channel.id }));
      },
    }),
    text: longText({
      label: 'Message',
      description: 'The text of your message.',
      required: true,
    }),
    threadTs: shortText({
      label: 'Thread timestamp',
      description: 'Reply within a thread by giving its parent message ts (e.g. 1710304378.475129).',
      required: false,
    }),
    unfurlLinks: checkbox({
      label: 'Unfurl links',
      description: 'Show link previews for URLs in the message.',
      required: false,
      defaultValue: true,
    }),
  },
  async run({ auth, props, http }): Promise<PostMessageResponse> {
    const res = await http.post<PostMessageResponse>(`${SLACK_API_BASE}/chat.postMessage`, {
      auth,
      // POST is not idempotent, so the client must never retry it on an ambiguous 5xx.
      body: {
        channel: props.channel,
        text: props.text,
        unfurl_links: props.unfurlLinks ?? true,
        ...(props.threadTs ? { thread_ts: props.threadTs } : {}),
      },
    });
    return assertSlackOk(res.data);
  },
});
