import { defineAction } from '../../core/action';
import { paginate } from '../../core/http/pagination';
import { dropdown, number, shortText } from '../../core/props';
import {
  formOptions,
  pageNumberNext,
  TYPEFORM_API_BASE,
  type TypeformField,
  type TypeformForm,
  type TypeformFormSummary,
  typeformAuth,
} from './common';

/** Public catalog ids for the Typeform form actions. */
export const LIST_FORMS_TYPE = 'typeform.list_forms';
export const GET_FORM_TYPE = 'typeform.get_form';
export const GET_FORM_FIELDS_TYPE = 'typeform.get_form_fields';

/**
 * List the forms in the account, optionally filtered by a `search` term, following
 * Typeform's page-number pagination up to `limit`.
 */
export const listFormsAction = defineAction({
  type: LIST_FORMS_TYPE,
  name: 'List forms',
  description: 'List the forms in your Typeform account.',
  auth: typeformAuth,
  props: {
    search: shortText({ label: 'Search', description: 'Filter forms by title.', required: false }),
    limit: number({ label: 'Max results', required: false, defaultValue: 200 }),
  },
  async run({ auth, props, http }): Promise<{ forms: TypeformFormSummary[]; count: number }> {
    const forms = await paginate<TypeformFormSummary>({
      http,
      auth,
      url: `${TYPEFORM_API_BASE}/forms`,
      query: { page: 1, page_size: 200, ...(props.search ? { search: props.search } : {}) },
      extractItems: (res) => (res.data as { items?: TypeformFormSummary[] }).items ?? [],
      nextPage: pageNumberNext,
      maxItems: props.limit ?? 200,
    });
    return { forms, count: forms.length };
  },
});

/** The required, live-picker `formId` prop shared by the form/response actions. */
function formIdProp() {
  return dropdown<string, true>({
    label: 'Form',
    description: 'Loaded live from your account; type to search.',
    required: true,
    options: ({ auth, http, search }) => formOptions(http, auth, search),
  });
}

/** Retrieve a full form definition by id. The form picker is live. */
export const getForm = defineAction({
  type: GET_FORM_TYPE,
  name: 'Get form',
  description: 'Retrieve a Typeform form definition by id.',
  auth: typeformAuth,
  props: {
    formId: formIdProp(),
  },
  async run({ auth, props, http }): Promise<TypeformForm> {
    const res = await http.get<TypeformForm>(
      `${TYPEFORM_API_BASE}/forms/${encodeURIComponent(props.formId)}`,
      {
        auth,
      },
    );
    return res.data;
  },
});

/**
 * Get just a form's fields (its questions) by id — the convenience read for
 * mapping answers to questions. The form picker is live.
 */
export const getFormFields = defineAction({
  type: GET_FORM_FIELDS_TYPE,
  name: 'Get form fields',
  description: 'Get the fields (questions) of a Typeform form.',
  auth: typeformAuth,
  props: {
    formId: formIdProp(),
  },
  async run({ auth, props, http }): Promise<{ fields: TypeformField[]; count: number }> {
    const res = await http.get<TypeformForm>(
      `${TYPEFORM_API_BASE}/forms/${encodeURIComponent(props.formId)}`,
      {
        auth,
      },
    );
    const fields = res.data.fields ?? [];
    return { fields, count: fields.length };
  },
});
