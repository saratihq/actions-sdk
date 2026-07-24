export {
  fetchItem,
  fetchStories,
  fetchStoryIds,
  HN_BASE,
  type HackerNewsItem,
  type StoryList,
} from './common';
export { FETCH_TOP_STORIES_TYPE, type FetchTopStoriesResult, fetchTopStories } from './fetch-top-stories';
export { NEW_STORY_TYPE, newStory } from './new-story.polling';

import { fetchTopStories } from './fetch-top-stories';

/** Every Hacker News action, for catalog builds and registration. */
export const hackernewsActions = [fetchTopStories] as const;
