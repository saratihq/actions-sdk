import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { typeformAuth } from './common';
import { getForm, getFormFields, listFormsAction } from './forms';
import { listResponses } from './responses';

function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

describe('typeform auth scopes', () => {
  it('requests the webhook scopes so the new_response trigger can register on OAuth', () => {
    expect(typeformAuth.scopes).toEqual(
      expect.arrayContaining(['forms:read', 'responses:read', 'webhooks:write', 'webhooks:read']),
    );
  });
});

describe('typeform.list_forms', () => {
  it('follows page-number pagination to page_count and applies the search filter', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { total_items: 3, page_count: 2, items: [{ id: 'f1', title: 'A' }] },
          }
        : {
            status: 200,
            headers: {},
            data: { total_items: 3, page_count: 2, items: [{ id: 'f2', title: 'B' }] },
          },
    );
    const out = await listFormsAction.execute({ auth, http, props: { search: 'contact', limit: 200 } });
    expect(out.count).toBe(2);
    expect(transport.requests[0]!.url).toContain('page=1');
    expect(transport.requests[0]!.url).toContain('search=contact');
    expect(transport.requests[1]!.url).toContain('page=2');
  });

  it('stops when the current page is the last page', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { total_items: 1, page_count: 1, items: [{ id: 'f1', title: 'Only' }] },
    }));
    const out = await listFormsAction.execute({ auth, http, props: {} });
    expect(out.count).toBe(1);
    expect(transport.requests).toHaveLength(1);
  });
});

describe('typeform.get_form + form picker', () => {
  it('GETs the form by id and the picker maps title→id (with search)', async () => {
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? {
            status: 200,
            headers: {},
            data: { total_items: 1, page_count: 1, items: [{ id: 'f9', title: 'Survey' }] },
          }
        : { status: 200, headers: {}, data: { id: 'f9', title: 'Survey', fields: [] } },
    );
    const picker = await getForm.loadOptions('formId', { auth, http, search: 'Sur' });
    expect(picker.disabled).toBe(false);
    expect(picker.options[0]).toEqual({ label: 'Survey', value: 'f9' });
    expect(transport.requests[0]!.url).toContain('search=Sur');

    const out = await getForm.execute({ auth, http, props: { formId: 'f9' } });
    expect(out.title).toBe('Survey');
    expect(transport.requests[1]!.url).toBe('https://api.typeform.com/forms/f9');
  });
});

describe('typeform.get_form_fields', () => {
  it('returns just the form fields with a count', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: {
        id: 'f1',
        title: 'Q',
        fields: [
          { id: 'q1', title: 'Name', type: 'short_text' },
          { id: 'q2', title: 'Email', type: 'email' },
        ],
      },
    }));
    const out = await getFormFields.execute({ auth, http, props: { formId: 'f1' } });
    expect(out.count).toBe(2);
    expect(out.fields[1]!.type).toBe('email');
    expect(transport.requests[0]!.url).toBe('https://api.typeform.com/forms/f1');
  });
});

describe('typeform.list_responses', () => {
  it('follows the before-token cursor and encodes the form id in the path', async () => {
    // Page 1 is full (2 items, page size faked as 2 via a short-page stop on page 2).
    const fullPage = Array.from({ length: 100 }, (_v, n) => ({ token: `t${n}` }));
    const { auth, http, transport } = fake((_req, i) =>
      i === 0
        ? { status: 200, headers: {}, data: { total_items: 150, page_count: 2, items: fullPage } }
        : { status: 200, headers: {}, data: { total_items: 150, page_count: 2, items: [{ token: 't100' }] } },
    );
    const out = await listResponses.execute({ auth, http, props: { formId: 'f1', limit: 200 } });
    expect(out.count).toBe(101);
    expect(transport.requests[0]!.url).toBe('https://api.typeform.com/forms/f1/responses?page_size=100');
    // The next page carries before=<last token of page 1>.
    expect(transport.requests[1]!.url).toContain('before=t99');
  });

  it('stops on a short first page (fewer than page_size items)', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { total_items: 1, page_count: 1, items: [{ token: 'only' }] },
    }));
    const out = await listResponses.execute({ auth, http, props: { formId: 'f1' } });
    expect(out.count).toBe(1);
    expect(transport.requests).toHaveLength(1);
  });
});
