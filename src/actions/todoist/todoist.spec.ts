import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { closeTask, createTask, getTasks, updateTask } from './tasks';

/**
 * Golden offline tests for the Todoist actions. A {@link FakeTransport} replays
 * canned unified-API-v1 responses (`{ results }` for lists) and records requests,
 * asserting the create body (with the inverted priority scale), the project-scoped
 * cursor-paged get, the POST partial-update, the 204 close synthesis, and the live
 * project picker without a connection.
 */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

describe('todoist.create_task', () => {
  it('POSTs the task with content, project_id and the wire priority', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 't1', content: 'Buy milk' },
    }));
    const out = await createTask.execute({
      auth,
      http,
      props: { content: 'Buy milk', project: 'P1', priority: 4, dueString: 'tomorrow' },
    });
    expect(out.id).toBe('t1');
    expect(transport.requests[0]!.body).toEqual({
      content: 'Buy milk',
      project_id: 'P1',
      priority: 4,
      due_string: 'tomorrow',
    });
  });
});

describe('todoist.find_task (get tasks)', () => {
  it('scopes to a project (no filter) via GET /tasks?project_id=', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: {
        results: [
          { id: 't1', content: 'A' },
          { id: 't2', content: 'B' },
        ],
        next_cursor: null,
      },
    }));
    const out = await getTasks.execute({ auth, http, props: { project: 'P1' } });
    expect(out.count).toBe(2);
    const url = transport.requests[0]!.url;
    expect(url).toContain('/api/v1/tasks?');
    expect(url).toContain('project_id=P1');
    expect(url).not.toContain('/tasks/filter');
  });

  it('routes a natural-language filter to GET /tasks/filter?query= (not the ignored /tasks?filter=)', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { results: [{ id: 't9', content: 'overdue thing' }], next_cursor: null },
    }));
    const out = await getTasks.execute({ auth, http, props: { filter: 'today | overdue' } });
    expect(out.count).toBe(1);
    const url = decodeURIComponent(transport.requests[0]!.url).replace(/\+/g, ' ');
    expect(url).toContain('/api/v1/tasks/filter?');
    expect(url).toContain('query=today | overdue');
    expect(url).not.toContain('filter=');
  });
});

describe('todoist.update_task', () => {
  it('POSTs only the supplied fields to /tasks/{id}', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { id: 't1', content: 'C' },
    }));
    await updateTask.execute({ auth, http, props: { taskId: 't1', content: 'C' } });
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.todoist.com/api/v1/tasks/t1');
    expect(req.body).toEqual({ content: 'C' });
  });
});

describe('todoist.mark_task_completed (close)', () => {
  it('POSTs to /close and synthesises a confirmation from a 204', async () => {
    const { auth, http, transport } = fake(() => ({ status: 204, headers: {}, data: undefined }));
    const out = await closeTask.execute({ auth, http, props: { taskId: 't1' } });
    expect(out).toEqual({ closed: true, taskId: 't1' });
    expect(transport.requests[0]!.url).toBe('https://api.todoist.com/api/v1/tasks/t1/close');
  });
});

describe('todoist project picker', () => {
  it('loads projects and maps name→id', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { results: [{ id: 'P1', name: 'Work' }], next_cursor: null },
    }));
    const picker = await getTasks.loadOptions('project', { auth, http });
    expect(picker.disabled).toBe(false);
    expect(picker.options[0]).toEqual({ label: 'Work', value: 'P1' });
  });
});
