import type { AuthHandle } from '../../core/auth';
import { defineAction } from '../../core/action';
import type { HttpClient } from '../../core/http/client';
import { cursorInBody, paginate } from '../../core/http/pagination';
import { dropdown, number } from '../../core/props';
import { assertSlackOk, SLACK_API_BASE, slackOAuth, type SlackEnvelope } from './common';

/** Public type — a stable public catalog id. */
export const LIST_CHANNELS_TYPE = 'slack.list_channels';

/** A Slack conversation (channel), trimmed to the fields config and workflows use. */
export interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_archived: boolean;
  is_member?: boolean;
  num_members?: number;
}

interface ConversationsListResponse extends SlackEnvelope {
  channels?: SlackChannel[];
}

const DEFAULT_MAX_CHANNELS = 1000;
/** Slack caps `conversations.list` at 1000/page; 200 keeps each page light while proving multi-page. */
const PAGE_SIZE = 200;

/**
 * What a channel PICKER asks Slack for. A monitoring or alerting channel is usually private, and
 * the token only ever sees private channels the app was invited to, so asking for both leaks
 * nothing and is the only way a private channel can be selected at all.
 */
export const PICKER_CHANNEL_TYPES = 'public_channel,private_channel';

/** A picker row: private channels are marked so two same-named rows can be told apart. */
export function channelLabel(channel: SlackChannel): string {
  return channel.is_private ? `🔒 #${channel.name}` : `#${channel.name}`;
}

/** Fetch all channels via `conversations.list`, following Slack's cursor pagination to completion. */
export async function listSlackChannels(
  http: HttpClient,
  auth: AuthHandle,
  options: { types?: string; maxItems?: number } = {},
): Promise<SlackChannel[]> {
  return paginate<SlackChannel>({
    http,
    auth,
    url: `${SLACK_API_BASE}/conversations.list`,
    query: { types: options.types ?? 'public_channel', exclude_archived: true, limit: PAGE_SIZE },
    extractItems: (res) => assertSlackOk(res.data as ConversationsListResponse).channels ?? [],
    nextPage: cursorInBody({ cursorPath: ['response_metadata', 'next_cursor'], cursorParam: 'cursor' }),
    maxItems: options.maxItems ?? DEFAULT_MAX_CHANNELS,
  });
}

/** List the workspace's channels (a paginated read). */
export const listChannels = defineAction({
  type: LIST_CHANNELS_TYPE,
  name: 'List channels',
  description: 'List channels in the connected Slack workspace.',
  auth: slackOAuth,
  props: {
    types: dropdown<string, false>({
      label: 'Channel types',
      description: 'Which conversation types to include.',
      required: false,
      defaultValue: 'public_channel',
      options: [
        { label: 'Public channels', value: 'public_channel' },
        { label: 'Private channels', value: 'private_channel' },
        { label: 'Public and private', value: 'public_channel,private_channel' },
      ],
    }),
    limit: number({
      label: 'Maximum channels',
      description: 'Stop after collecting this many channels.',
      required: false,
      defaultValue: DEFAULT_MAX_CHANNELS,
    }),
  },
  async run({ auth, props, http }): Promise<{ channels: SlackChannel[]; count: number }> {
    const channels = await listSlackChannels(http, auth, {
      types: props.types ?? 'public_channel',
      maxItems: props.limit ?? DEFAULT_MAX_CHANNELS,
    });
    return { channels, count: channels.length };
  },
});
