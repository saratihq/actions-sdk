export { type FeedItem, parseFeed } from './feed';
export { RSS_NEW_ITEM_TYPE, newItem } from './new-item.polling';

/**
 * RSS is a trigger-only app — its whole value is the polling trigger. No actions,
 * so no `rssActions` array; the trigger is registered via `pollingTriggers` in
 * `../index.ts`.
 */
