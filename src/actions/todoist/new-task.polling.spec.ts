import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newTask } from './new-task.polling';

/** A transport that answers Todoist's `/api/v1/tasks` from one page of task records. */
function todoistTransport(tasks: Array<{ id: string; content: string }>): FakeTransport {
  return new FakeTransport((req: NormalizedRequest): NormalizedResponse => {
    if (req.url.includes('/tasks'))
      return { status: 200, headers: {}, data: { results: tasks, next_cursor: null } };
    return { status: 404, headers: {}, data: null };
  });
}

describe('todoist.new_task polling trigger', () => {
  it('emits active tasks, then dedupes by id on the next poll', async () => {
    const store = new MemoryStore();
    const first = await newTask.runPoll({
      auth: stubAuth(
        todoistTransport([
          { id: '1', content: 'one' },
          { id: '2', content: 'two' },
        ]),
        'oauth2',
      ),
      props: {},
      store,
    });
    expect(first.events.map((t) => t.id)).toEqual(['1', '2']);

    const second = await newTask.runPoll({
      auth: stubAuth(
        todoistTransport([
          { id: '1', content: 'one' },
          { id: '2', content: 'two' },
        ]),
        'oauth2',
      ),
      props: {},
      store,
    });
    expect(second.events).toEqual([]);

    const third = await newTask.runPoll({
      auth: stubAuth(
        todoistTransport([
          { id: '3', content: 'three' },
          { id: '1', content: 'one' },
        ]),
        'oauth2',
      ),
      props: {},
      store,
    });
    expect(third.events.map((t) => t.id)).toEqual(['3']);
  });

  it('scopes the request to the chosen project when set', async () => {
    const transport = todoistTransport([{ id: '1', content: 'one' }]);
    await newTask.runPoll({
      auth: stubAuth(transport, 'oauth2'),
      props: { project: '2203306141' },
      store: new MemoryStore(),
    });
    const req = transport.requests.find((r) => r.url.includes('/tasks'))!;
    expect(new URL(req.url).searchParams.get('project_id')).toBe('2203306141');
    expect(req.url).toContain('https://api.todoist.com/api/v1/tasks');
  });
});
