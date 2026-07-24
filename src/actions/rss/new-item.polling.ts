import { defineTrigger } from '../../core/trigger';
import { guardUserUrl } from '../../core/http/ssrf';
import { shortText } from '../../core/props';
import { type FeedItem, parseFeed } from './feed';

/**
 * Polling trigger (`rss.new_item`) — fires for each new entry in an RSS/Atom feed.
 * This is the canonical "RSS-poll style" reference for the SDK polling framework.
 * No-auth: the feed URL is read over the direct transport. The SDK's
 * `runPoll` dedupes by the item's guid/id, so re-polling an unchanged feed emits
 * nothing — the polling contract.
 */

export const RSS_NEW_ITEM_TYPE = 'rss.new_item';

export const newItem = defineTrigger({
  type: RSS_NEW_ITEM_TYPE,
  strategy: 'polling',
  name: 'New RSS Item',
  description: 'Fires for each new item published to an RSS or Atom feed.',
  auth: { type: 'none' },
  props: {
    url: shortText({ label: 'Feed URL', required: true }),
  },
  async poll({ auth, props, http }): Promise<FeedItem[]> {
    // SSRF guard: the feed URL is fully user-controlled on the no-auth direct
    // transport — block private/internal/cloud-metadata targets before fetching.
    await guardUserUrl(props.url);
    const res = await http.get<unknown>(props.url, { auth });
    const xml = typeof res.data === 'string' ? res.data : '';
    return parseFeed(xml);
  },
  dedupeKey: (item): string => item.id || item.link || item.title,
});
