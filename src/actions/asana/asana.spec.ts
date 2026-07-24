import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { listProjects } from './projects';
import { addComment, createTask, getTask, listTasks, updateTask } from './tasks';

/**
 * Golden offline tests for the Asana actions. A {@link FakeTransport} replays
 * canned `{ data }`-enveloped API v1 responses and records requests, so the tests
 * assert the envelope wrapping/unwrapping, the project→`projects: [gid]` mapping,
 * PUT partial-update, the `offset` cursor pagination, and the live project picker
 * without a connection.
 */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

describe('asana.create_task', () => {
  it('wraps the body in { data } and maps the project picker to projects[]', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 201,
      headers: {},
      data: { data: { gid: 't1', name: 'Ship it' } },
    }));
    const out = await createTask.execute({
      auth,
      http,
      props: { name: 'Ship it', project: 'p1', notes: 'do the thing' },
    });
    expect(out.gid).toBe('t1');
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/tasks');
    expect(req.body).toEqual({ data: { name: 'Ship it', projects: ['p1'], notes: 'do the thing' } });
  });
});

describe('asana.get_task', () => {
  it('GETs a task by id and unwraps { data }', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { data: { gid: 't9', name: 'Look at me' } },
    }));
    const out = await getTask.execute({ auth, http, props: { taskId: 't9' } });
    expect(out.name).toBe('Look at me');
    expect(transport.requests[0]!.url).toContain('/tasks/t9?opt_fields=');
  });
});

describe('asana.update_task', () => {
  it('PUTs only the supplied fields wrapped in { data }', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { data: { gid: 't1', completed: true } },
    }));
    await updateTask.execute({ auth, http, props: { taskId: 't1', completed: true } });
    const req = transport.requests[0]!;
    expect(req.method).toBe('PUT');
    expect(req.body).toEqual({ data: { completed: true } });
  });
});

describe('asana.list_tasks', () => {
  it('scopes to the project and follows the offset cursor', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? { status: 200, headers: {}, data: { data: [{ gid: 't1' }], next_page: { offset: 'OFF2' } } }
        : { status: 200, headers: {}, data: { data: [{ gid: 't2' }], next_page: null } },
    );
    const out = await listTasks.execute({ auth, http, props: { project: 'p1', limit: 100 } });
    expect(out.count).toBe(2);
    expect(transport.requests[0]!.url).toContain('project=p1');
    expect(transport.requests[1]!.url).toContain('offset=OFF2');
  });
});

describe('asana.add_comment', () => {
  it('POSTs a story with the comment text', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 201,
      headers: {},
      data: { data: { gid: 's1', text: 'nice' } },
    }));
    const out = await addComment.execute({ auth, http, props: { taskId: 't1', text: 'nice' } });
    expect(out.text).toBe('nice');
    expect(transport.requests[0]!.url).toContain('/tasks/t1/stories');
    expect(transport.requests[0]!.body).toEqual({ data: { text: 'nice' } });
  });
});

describe('asana.list_projects', () => {
  it('scopes to a workspace and follows the offset cursor', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { data: [{ gid: 'p1', name: 'A' }], next_page: { offset: 'OFF2' } },
          }
        : { status: 200, headers: {}, data: { data: [{ gid: 'p2', name: 'B' }], next_page: null } },
    );
    const out = await listProjects.execute({ auth, http, props: { workspace: 'w1', limit: 100 } });
    expect(out.count).toBe(2);
    expect(out.projects.map((p) => p.gid)).toEqual(['p1', 'p2']);
    expect(transport.requests[0]!.url).toContain('workspace=w1');
    expect(transport.requests[1]!.url).toContain('offset=OFF2');
  });
});

describe('asana project picker', () => {
  it('loads projects and maps name→gid', async () => {
    const { auth, http } = fake(() => ({
      status: 200,
      headers: {},
      data: { data: [{ gid: 'p1', name: 'Roadmap' }] },
    }));
    const picker = await listTasks.loadOptions('project', { auth, http });
    expect(picker.disabled).toBe(false);
    expect(picker.options[0]).toEqual({ label: 'Roadmap', value: 'p1' });
  });
});
