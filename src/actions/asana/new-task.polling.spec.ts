import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import type { AsanaTask } from './common';
import { newTask } from './new-task.polling';

const PROJECT = '1201234567890123';

/** Real-shaped Asana task records (the `{ data: [...] }` envelope wraps these). */
const TASK_A = {
  gid: '1209876543210001',
  name: 'Draft the launch checklist',
  created_at: '2025-01-24T14:32:18.076Z',
  completed: false,
  permalink_url: 'https://app.asana.com/0/1201234567890123/1209876543210001',
  assignee: { gid: '1200000000000001', name: 'Sarah Chen' },
};
const TASK_B = {
  gid: '1209876543210002',
  name: 'Book the venue',
  created_at: '2025-01-24T15:01:02.000Z',
  completed: false,
  permalink_url: 'https://app.asana.com/0/1201234567890123/1209876543210002',
  assignee: null,
};
const TASK_C = {
  gid: '1209876543210003',
  name: 'Send invites',
  created_at: '2025-01-24T16:10:44.512Z',
  completed: false,
  permalink_url: 'https://app.asana.com/0/1201234567890123/1209876543210003',
  assignee: { gid: '1200000000000002', name: 'Amir Diab' },
};

type AsanaTaskRecord = typeof TASK_A | typeof TASK_B | typeof TASK_C;

/** A transport that answers Asana's `/tasks` from a single page of task records. */
function asanaTransport(tasks: AsanaTaskRecord[]): FakeTransport {
  return new FakeTransport((req: NormalizedRequest): NormalizedResponse => {
    if (req.url.includes('/tasks')) return { status: 200, headers: {}, data: { data: tasks } };
    return { status: 404, headers: {}, data: null };
  });
}

/** Drive one poll against a fresh transport, returning the transport for assertions. */
async function poll(
  store: MemoryStore,
  tasks: AsanaTaskRecord[],
): Promise<{ transport: FakeTransport; events: AsanaTask[] }> {
  const transport = asanaTransport(tasks);
  const result = await newTask.runPoll({
    auth: stubAuth(transport, 'oauth2'),
    props: { project: PROJECT },
    store,
  });
  return { transport, events: result.events };
}

describe('asana.new_task polling trigger', () => {
  it('self-baselines on the first poll (fires nothing, makes no /tasks call)', async () => {
    const store = new MemoryStore();
    const { transport, events } = await poll(store, [TASK_A, TASK_B]);

    // No pre-existing task fires on enablement...
    expect(events).toEqual([]);
    // ...and the first poll doesn't even hit /tasks — the watermark is all it needs.
    expect(transport.requests.some((r) => r.url.includes('/tasks'))).toBe(false);
    // The runtime persisted the watermark, so the next poll can window on it.
    expect(await store.get<string>('lastPolledAt')).toBeTruthy();
  });

  it('windows later polls by modified_since and dedupes by gid', async () => {
    const store = new MemoryStore();
    await poll(store, [TASK_A]); // baseline

    // Second poll: watermark exists → tasks changed since fire.
    const second = await poll(store, [TASK_A, TASK_B]);
    expect(second.events.map((t) => t.gid)).toEqual([TASK_A.gid, TASK_B.gid]);

    // Third poll: TASK_A is windowed back in (edited after firing) but its gid is
    // already seen — only the genuinely-new TASK_C fires.
    const third = await poll(store, [TASK_C, TASK_A]);
    expect(third.events.map((t) => t.gid)).toEqual([TASK_C.gid]);
  });

  it('scopes to the project and carries the watermark as an ISO 8601 modified_since', async () => {
    const store = new MemoryStore();
    await poll(store, []); // baseline — persists the watermark
    const watermark = await store.get<string>('lastPolledAt');
    expect(watermark).toBeTruthy();

    const { transport } = await poll(store, [TASK_A]);
    const req = transport.requests.find((r) => r.url.includes('/tasks'))!;
    expect(req.url).toContain('https://app.asana.com/api/1.0/tasks');

    const params = new URL(req.url).searchParams;
    expect(params.get('project')).toBe(PROJECT);

    const modifiedSince = params.get('modified_since');
    expect(modifiedSince).toBe(watermark);
    // The value the provider receives is a valid ISO 8601 instant.
    expect(new Date(modifiedSince!).toISOString()).toBe(modifiedSince);
  });
});
