import { defineTrigger } from '../../core/trigger';
import { guardUserUrl } from '../../core/http/ssrf';
import { shortText } from '../../core/props';
import { type FeedItem, parseFeed } from './feed';

/** Polling trigger — fires for each new entry in an RSS/Atom feed, deduped by guid/id. */
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
    // SSRF guard: the feed URL is fully user-controlled, so block private/internal targets before fetching.
    await guardUserUrl(props.url);
    const res = await http.get<unknown>(props.url, { auth });
    const xml = typeof res.data === 'string' ? res.data : '';
    return parseFeed(xml);
  },
  dedupeKey: (item): string => item.id || item.link || item.title,
});
