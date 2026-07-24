import { defineTrigger } from '../../core/trigger';
import { dropdown } from '../../core/props';
import { slackOAuth } from './common';
import { listSlackChannels, type SlackChannel } from './list-channels';

/** Public type for the polling trigger. */
export const NEW_CHANNEL_TYPE = 'slack.new_channel';

/**
 * The store key holding the FULL set of channel ids seen so far — this trigger's
 * own dedup memory, independent of the SDK's LRU `seen` window.
 *
 * `slack.new_channel` is a full-ENUMERATION trigger: `conversations.list` has no
 * "since" cursor, so every poll re-lists the whole workspace and a new channel is
 * simply one whose id has never been recorded. That set-difference is only correct
 * if the remembered set holds EVERY prior channel id — the SDK's generic `seen`
 * is LRU-capped (`DEDUPE_CAP`), so on a workspace at/above that cap it evicts old
 * ids that then re-list as "new" (spurious re-fires). This trigger therefore keeps
 * the full id set itself, uncapped-by-workspace-size, and lets the SDK's `seen`
 * only ever see the (small) per-poll delta.
 */
const KNOWN_CHANNELS_KEY = 'known_channel_ids';

/**
 * A high safety bound on collected channels. It sits ABOVE `paginate`'s own
 * 50-page × 200-item ceiling (~10k) on purpose: a workspace larger than that
 * trips `paginate`'s `pagination_limit` and the poll errors loudly (an honest
 * `last_error` on the activation) rather than silently truncating the set — a
 * truncated set would drop the tail from the known-set and re-fire it as "new".
 */
const MAX_TRACKED_CHANNELS = 50_000;

/**
 * A polling trigger (exercises the polling strategy end to end): each poll
 * enumerates the workspace's channels and emits only ids not in the persisted
 * known-set, so only genuinely-new channels fire. Uses only `channels:read` — the
 * scope the live harness uses — so it is genuinely live-testable, and re-polling the same
 * set emits nothing (the dedup contract), even on a workspace with thousands of
 * channels (where the SDK's LRU `seen` alone would re-fire evicted ids).
 *
 * INV-1 (first-poll baseline): `conversations.list` has no "since" cursor, so the
 * known-set IS this trigger's watermark. The FIRST poll — when the known-set has
 * never been persisted (`undefined`, distinct from an empty `[]` "no channels yet")
 * — records every existing channel id and emits ZERO events, so activating the
 * trigger never fires the whole channel list as history. This holds even if the
 * reconciler's enable() seed poll failed, because the baseline is the first real
 * poll itself, not a separate seed step.
 */
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
    // Enumerate every channel (list order is NOT creation-time, so a fixed head
    // window would miss new channels beyond it).
    const channels = await listSlackChannels(http, auth, {
      types: props.types ?? 'public_channel',
      maxItems: MAX_TRACKED_CHANNELS,
    });
    const priorKnown = await store.get<string[]>(KNOWN_CHANNELS_KEY);
    const known = new Set(priorKnown ?? []);
    const fresh = channels.filter((channel) => !known.has(channel.id));
    // Persist the FULL current id set (not an LRU window) so a large workspace
    // never re-fires an id the SDK's `seen` would have evicted.
    await store.set(
      KNOWN_CHANNELS_KEY,
      channels.map((channel) => channel.id),
    );
    // First poll (known-set never stored): baseline the existing channels above
    // and emit nothing — activation must not fire the workspace's whole channel
    // list. `undefined` marks the first poll; an empty `[]` is a real prior state.
    if (priorKnown === undefined) return [];
    return fresh;
  },
  dedupeKey: (channel) => channel.id,
});
