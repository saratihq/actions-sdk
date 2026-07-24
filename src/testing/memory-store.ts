import type { TriggerStore } from '../core/trigger';

/**
 * In-memory {@link TriggerStore} for tests and local runs. Deliberately trivial:
 * a real runtime backs the store with a durable KV, but trigger dedup/watermark
 * logic is testable without one.
 */
export class MemoryStore implements TriggerStore {
  private readonly data = new Map<string, unknown>();

  get<T = unknown>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.get(key) as T | undefined);
  }

  set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }

  /** Test helper: snapshot the raw contents. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.data);
  }
}
