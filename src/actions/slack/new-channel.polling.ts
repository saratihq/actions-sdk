import { defineTrigger } from '../../core/trigger';
import { dropdown } from '../../core/props';
import { slackOAuth } from './common';
import { listSlackChannels, type SlackChannel } from './list-channels';

/** Public type for the polling trigger. */
export const NEW_CHANNEL_TYPE = 'slack.new_channel';

/** Holds the FULL set of channel ids seen so far — must stay uncapped, since the SDK's LRU `seen` would evict ids that then re-list as "new". */
const KNOWN_CHANNELS_KEY = 'known_channel_ids';

/** Sits above `paginate`'s ~10k ceiling on purpose, so an oversized workspace errors loudly rather than truncating the known-set. */
const MAX_TRACKED_CHANNELS = 50_000;

/** Polling trigger — emits channels whose id is not in the persisted known-set; the first poll (known-set `undefined`) baselines and emits nothing. */
export const newChannel = defineTrigger({
  type: NEW_CHANNEL_TYPE,
  strategy: 'polling',
  name: 'New channel',
  description: 'Fires when a new channel appears in the workspace.',
  auth: slackOAuth,
  props: {
    types: dropdown<string, false>({
      label: 'Channel types',
      required: false,
      defaultValue: 'public_channel',
      options: [
        { label: 'Public channels', value: 'public_channel' },
        { label: 'Public and private', value: 'public_channel,private_channel' },
      ],
    }),
  },
  async poll({ auth, props, http, store }): Promise<SlackChannel[]> {
    // List order is NOT creation-time, so a fixed head window would miss new channels.
    const channels = await listSlackChannels(http, auth, {
      types: props.types ?? 'public_channel',
      maxItems: MAX_TRACKED_CHANNELS,
    });
    const priorKnown = await store.get<string[]>(KNOWN_CHANNELS_KEY);
    const known = new Set(priorKnown ?? []);
    const fresh = channels.filter((channel) => !known.has(channel.id));
    // Persist the FULL current id set, not an LRU window.
    await store.set(
      KNOWN_CHANNELS_KEY,
      channels.map((channel) => channel.id),
    );
    // `undefined` marks the first poll (an empty `[]` is a real prior state): baseline only.
    if (priorKnown === undefined) return [];
    return fresh;
  },
  dedupeKey: (channel) => channel.id,
});
