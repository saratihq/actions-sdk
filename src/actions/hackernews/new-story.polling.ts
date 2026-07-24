import { defineTrigger } from '../../core/trigger';
import { dropdown } from '../../core/props';
import { fetchStories, type HackerNewsItem, type StoryList } from './common';

/**
 * Polling trigger (`hackernews.new_story`) — fires when a new story enters the
 * chosen Hacker News list. On each poll it fetches the head of the list and the
 * SDK's `runPoll` dedupes by story id, so only stories not seen before fire (the
 * polling contract). No-auth.
 */

export const NEW_STORY_TYPE = 'hackernews.new_story';
/** Head-of-list window sampled per poll — new stories appear at the top. */
const POLL_WINDOW = 20;

export const newStory = defineTrigger({
  type: NEW_STORY_TYPE,
  strategy: 'polling',
  name: 'New Story',
  description: 'Fires when a new story appears in the chosen Hacker News list.',
  auth: { type: 'none' },
  props: {
    list: dropdown<StoryList, false>({
      label: 'List',
      required: false,
      defaultValue: 'top',
      options: [
        { label: 'Top', value: 'top' },
        { label: 'New', value: 'new' },
        { label: 'Best', value: 'best' },
      ],
    }),
  },
  async poll({ auth, props, http }): Promise<HackerNewsItem[]> {
    return fetchStories(http, auth, props.list ?? 'top', POLL_WINDOW);
  },
  dedupeKey: (story): string => String(story.id),
});
