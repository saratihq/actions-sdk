export { type FeedItem, parseFeed } from './feed';
export { RSS_NEW_ITEM_TYPE, newItem } from './new-item.polling';

/** RSS is trigger-only — no `rssActions` array; the trigger registers via `pollingTriggers` in `../index.ts`. */
