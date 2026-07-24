import { defineAction } from '../../core/action';
import { number } from '../../core/props';
import { fetchStories, type HackerNewsItem } from './common';

/**
 * Fetch the current top stories from Hacker News — a no-auth read of the public
 * Firebase API.
 */

export const FETCH_TOP_STORIES_TYPE = 'hackernews.fetch_top_stories';
export interface FetchTopStoriesResult {
  stories: HackerNewsItem[];
  count: number;
}
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export const fetchTopStories = defineAction({
  type: FETCH_TOP_STORIES_TYPE,
  name: 'Fetch Top Stories',
  description: 'Fetch the current top stories from Hacker News.',
  auth: { type: 'none' },
  props: {
    limit: number({ label: 'Number of stories', required: false, defaultValue: DEFAULT_LIMIT }),
  },
  async run({ auth, props, http }): Promise<FetchTopStoriesResult> {
    const limit = Math.min(Math.max(1, Math.floor(props.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
    const stories = await fetchStories(http, auth, 'top', limit);
    return { stories, count: stories.length };
  },
});
