import type { AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';

/** Shared Hacker News building blocks — the public Firebase API needs no credentials. */

export const HN_BASE = 'https://hacker-news.firebaseio.com/v0';

/** The three story lists the API exposes. */
export type StoryList = 'top' | 'new' | 'best';

/** A Hacker News item, trimmed to the fields workflows use (extra fields ride along). */
export interface HackerNewsItem {
  id: number;
  type?: string;
  by?: string;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  time?: number;
  descendants?: number;
}

/** Fetch the ordered id list for a story list (top/new/best). */
export async function fetchStoryIds(http: HttpClient, auth: AuthHandle, list: StoryList): Promise<number[]> {
  const res = await http.get<number[]>(`${HN_BASE}/${list}stories.json`, { auth });
  return Array.isArray(res.data) ? res.data : [];
}

/** Fetch a single item; returns null if the API responds with no object. */
export async function fetchItem(
  http: HttpClient,
  auth: AuthHandle,
  id: number,
): Promise<HackerNewsItem | null> {
  const res = await http.get<HackerNewsItem | null>(`${HN_BASE}/item/${id}.json`, { auth });
  return res.data ?? null;
}

/** Fetch the first `limit` items of a story list, in order, dropping any that 404. */
export async function fetchStories(
  http: HttpClient,
  auth: AuthHandle,
  list: StoryList,
  limit: number,
): Promise<HackerNewsItem[]> {
  const ids = (await fetchStoryIds(http, auth, list)).slice(0, Math.max(0, limit));
  const items = await Promise.all(ids.map((id) => fetchItem(http, auth, id)));
  return items.filter((item): item is HackerNewsItem => item !== null);
}
