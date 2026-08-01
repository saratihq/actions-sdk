import { defineAction } from '../../core/action';
import { cursorInBody, paginate } from '../../core/http/pagination';
import type { QueryValue } from '../../core/http/types';
import { number } from '../../core/props';
import { ASANA_API_BASE, type AsanaResource, asanaAuth, resolveWorkspaceGid, workspaceProp } from './common';

/** Public type — a stable public catalog id. */
export const LIST_PROJECTS_TYPE = 'asana.list_projects';

/** List projects, optionally workspace-scoped, following Asana's `next_page.offset` cursor up to `limit`. */
export const listProjects = defineAction({
  type: LIST_PROJECTS_TYPE,
  name: 'List projects',
  description: 'List the projects in Asana, optionally scoped to a workspace.',
  auth: asanaAuth,
  props: {
    workspace: workspaceProp(false),
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ projects: AsanaResource[]; count: number }> {
    // Asana's /projects 400s without a workspace/team scope.
    const workspace = await resolveWorkspaceGid(http, auth, props.workspace);
    if (!workspace) return { projects: [], count: 0 };
    const query: Record<string, QueryValue> = {
      workspace,
      limit: 100,
      opt_fields: 'name',
      archived: false,
    };
    const projects = await paginate<AsanaResource>({
      http,
      auth,
      url: `${ASANA_API_BASE}/projects`,
      query,
      extractItems: (res) => (res.data as { data?: AsanaResource[] }).data ?? [],
      nextPage: cursorInBody({ cursorPath: ['next_page', 'offset'], cursorParam: 'offset' }),
      maxItems: props.limit ?? 100,
    });
    return { projects, count: projects.length };
  },
});
