import type { TriggerStore } from '../core/trigger';

/** In-memory {@link TriggerStore} for tests and local runs; a real runtime backs this with a durable KV. */
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
