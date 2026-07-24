import { defineAction } from '../../core/action';
import { type AirtableBase, airtableAuth, listAirtableBases } from './common';

/** Public type — a stable public catalog id. */
export const LIST_BASES_TYPE = 'airtable.list_bases';

/**
 * List every base the token can access. Read-only and the benign live-smoke
 * action for Airtable — it also underpins the base picker on the record actions.
 */
export const listBases = defineAction({
  type: LIST_BASES_TYPE,
  name: 'List bases',
  description: 'List the Airtable bases the connection can access.',
  auth: airtableAuth,
  props: {},
  async run({ auth, http }): Promise<{ bases: AirtableBase[]; count: number }> {
    const bases = await listAirtableBases(http, auth);
    return { bases, count: bases.length };
  },
});
