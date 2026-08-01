import { defineAction } from '../../core/action';
import { paginate } from '../../core/http/pagination';
import { dropdown, number } from '../../core/props';
import {
  beforeTokenNext,
  formOptions,
  TYPEFORM_API_BASE,
  type TypeformResponse,
  typeformAuth,
} from './common';

/** Public catalog id for the list-responses action. */
export const LIST_RESPONSES_TYPE = 'typeform.list_responses';

const RESPONSES_PAGE_SIZE = 100;

/** List a form's submitted responses, newest first, following Typeform's `before`-token cursor up to `limit`. */
export const listResponses = defineAction({
  type: LIST_RESPONSES_TYPE,
  name: 'List responses',
  description: 'List the submitted responses for a Typeform form.',
  auth: typeformAuth,
  props: {
    formId: dropdown<string, true>({
      label: 'Form',
      description: 'Loaded live from your account; type to search.',
      required: true,
      options: ({ auth, http, search }) => formOptions(http, auth, search),
    }),
    limit: number({ label: 'Max results', required: false, defaultValue: 100 }),
  },
  async run({ auth, props, http }): Promise<{ responses: TypeformResponse[]; count: number }> {
    const responses = await paginate<TypeformResponse>({
      http,
      auth,
      url: `${TYPEFORM_API_BASE}/forms/${encodeURIComponent(props.formId)}/responses`,
      query: { page_size: RESPONSES_PAGE_SIZE },
      extractItems: (res) => (res.data as { items?: TypeformResponse[] }).items ?? [],
      nextPage: beforeTokenNext(RESPONSES_PAGE_SIZE),
      maxItems: props.limit ?? 100,
    });
    return { responses, count: responses.length };
  },
});
