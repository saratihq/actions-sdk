import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { createTask, getTask, listTasks, updateTask } from './tasks';

/**
 * Offline tests for the ClickUp actions. A {@link FakeTransport} replays canned
 * API v2 responses and records requests, asserting the create body, PUT
 * partial-update, the `page`/`last_page` cursor, and the hierarchy-walking list
 * picker (team → space → folderless lists + folder lists) without a connection.
 */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'apiKey'), http: new HttpClient(), transport };
}

describe('clickup.create_task', () => {
  it('POSTs the task to /list/{id}/task with the mapped fields', async () => {
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: { id: 'tk1' } }));
    const out = await createTask.execute({
      auth,
      http,
      props: { listId: 'L1', name: 'Fix bug', priority: 2, assignees: [42] },
    });
    expect(out.id).toBe('tk1');
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.clickup.com/api/v2/list/L1/task');
    expect(req.body).toEqual({ name: 'Fix bug', priority: 2, assignees: [42] });
  });
});

describe('clickup.get_list_task', () => {
  it('GETs a task by id', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 'tk9', name: 'A' },
    }));
    const out = await getTask.execute({ auth, http, props: { taskId: 'tk9' } });
    expect(out.name).toBe('A');
    expect(transport.requests[0]!.url).toBe('https://api.clickup.com/api/v2/task/tk9');
  });
});

describe('clickup.update_task', () => {
  it('PUTs only the supplied fields', async () => {
    const { auth, http, transport } = fake(() => ({ status: 200, headers: {}, data: { id: 'tk1' } }));
    await updateTask.execute({ auth, http, props: { taskId: 'tk1', status: 'in progress' } });
    const req = transport.requests[0]!;
    expect(req.method).toBe('PUT');
    expect(req.body).toEqual({ status: 'in progress' });
  });
});

describe('clickup.list_tasks', () => {
  it('follows the page cursor while last_page is false', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? { status: 200, headers: {}, data: { tasks: [{ id: 'tk1' }], last_page: false } }
        : { status: 200, headers: {}, data: { tasks: [{ id: 'tk2' }], last_page: true } },
    );
    const out = await listTasks.execute({ auth, http, props: { listId: 'L1', limit: 100 } });
    expect(out.count).toBe(2);
    expect(transport.requests[0]!.url).toContain('page=0');
    expect(transport.requests[1]!.url).toContain('page=1');
  });
});

describe('clickup list picker (hierarchy walk)', () => {
  it('walks team → space → folderless + folder lists and labels by path', async () => {
    // 0: /team, 1: /team/T1/space, 2: /space/S1/list, 3: /space/S1/folder
    const { auth, http } = fake((req) => {
      const url = req.url;
      if (url.endsWith('/team'))
        return { status: 200, headers: {}, data: { teams: [{ id: 'T1', name: 'Team' }] } };
      if (url.includes('/team/T1/space'))
        return { status: 200, headers: {}, data: { spaces: [{ id: 'S1', name: 'Eng' }] } };
      if (url.includes('/space/S1/list'))
        return { status: 200, headers: {}, data: { lists: [{ id: 'L1', name: 'Backlog' }] } };
      if (url.includes('/space/S1/folder'))
        return {
          status: 200,
          headers: {},
          data: { folders: [{ name: 'Sprint', lists: [{ id: 'L2', name: 'Current' }] }] },
        };
      return { status: 200, headers: {}, data: {} };
    });
    const picker = await createTask.loadOptions('listId', { auth, http });
    expect(picker.disabled).toBe(false);
    expect(picker.options).toEqual([
      { label: 'Eng / Backlog', value: 'L1' },
      { label: 'Eng / Sprint / Current', value: 'L2' },
    ]);
  });
});
