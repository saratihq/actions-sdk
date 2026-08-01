import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { defineTrigger, type WebhookRegistration, type WebhookRequest } from '../../core/trigger';
import { dropdown } from '../../core/props';
import { formOptions, TYPEFORM_API_BASE, typeformAuth } from './common';

/** Public type for the registered-webhook trigger. */
export const NEW_RESPONSE_TYPE = 'typeform.new_response';

/** A Typeform field reference on an answer — matches an answer back to its question. */
interface TypeformAnswerField {
  id?: string;
  ref?: string;
  type?: string;
}

/** One answer in the webhook's `form_response.answers` (only the fields normalised). */
interface TypeformWebhookAnswer {
  type?: string;
  field?: TypeformAnswerField;
  text?: string;
  email?: string;
  number?: number;
  boolean?: boolean;
  date?: string;
  url?: string;
  phone_number?: string;
  choice?: { label?: string; other?: string };
  choices?: { labels?: string[]; other?: string };
  file_url?: string;
}

/** The `form_response` webhook envelope (the relevant fields). */
interface TypeformWebhookPayload {
  event_id?: string;
  event_type?: string;
  form_response?: {
    form_id?: string;
    token?: string;
    response_id?: string;
    submitted_at?: string;
    landed_at?: string;
    hidden?: Record<string, unknown>;
    answers?: TypeformWebhookAnswer[];
    definition?: { id?: string; title?: string };
  };
}

/** One normalised answer — the question ref/id paired with its scalar value. */
export interface TypeformNormalisedAnswer {
  fieldId?: string;
  fieldRef?: string;
  type?: string;
  /** The answer value flattened to a JSON-friendly scalar/array. */
  value: string | number | boolean | string[] | null;
}

/** A normalised Typeform submission — what a workflow step receives. */
export interface TypeformResponseEvent {
  /** Typeform's `event_id` — the delivery-dedup key. */
  eventId: string;
  formId: string;
  formTitle?: string;
  /** The submission token (also the response id). */
  token: string;
  submittedAt?: string;
  landedAt?: string;
  hidden?: Record<string, unknown>;
  answers: TypeformNormalisedAnswer[];
}

/** Flatten a Typeform answer to a single scalar/array value by its declared `type`. */
function answerValue(answer: TypeformWebhookAnswer): TypeformNormalisedAnswer['value'] {
  switch (answer.type) {
    case 'text':
    case 'long_text':
      return answer.text ?? null;
    case 'email':
      return answer.email ?? null;
    case 'number':
      return answer.number ?? null;
    case 'boolean':
      return answer.boolean ?? null;
    case 'date':
      return answer.date ?? null;
    case 'url':
      return answer.url ?? null;
    case 'phone_number':
      return answer.phone_number ?? null;
    case 'file_url':
      return answer.file_url ?? null;
    case 'choice':
      return answer.choice?.label ?? answer.choice?.other ?? null;
    case 'choices':
      return answer.choices?.labels ?? [];
    default:
      return answer.text ?? null;
  }
}

/** A stable per-`webhookUrl` tag: uniqueness keeps two workflows on one form apart, determinism makes PUT/DELETE idempotent. */
export function tagForWebhookUrl(webhookUrl: string): string {
  const digest = createHash('sha256').update(webhookUrl).digest('hex').slice(0, 24);
  return `orchestr-${digest}`;
}

export const newResponse = defineTrigger({
  type: NEW_RESPONSE_TYPE,
  strategy: 'webhook',
  name: 'New response',
  description: 'Fires when a Typeform form receives a new submission.',
  auth: typeformAuth,
  props: {
    formId: dropdown<string, true>({
      label: 'Form',
      description: 'Loaded live from your account; type to search.',
      required: true,
      options: ({ auth, http, search }) => formOptions(http, auth, search),
    }),
  },
  sampleData: {
    eventId: '01HZX8P7Q9J8N6M5K4T3R2W1V0',
    formId: 'u6nXL7',
    formTitle: 'Customer feedback',
    token: 'a3a9c2f0b1e24d6f8c7b5a4e3d2c1b0a',
    submittedAt: '2026-07-18T18:17:02Z',
    landedAt: '2026-07-18T18:16:20Z',
    hidden: { utm_source: 'newsletter' },
    answers: [
      { fieldId: 'abc123', fieldRef: 'name', type: 'text', value: 'Ada Lovelace' },
      { fieldId: 'def456', fieldRef: 'email', type: 'email', value: 'ada@example.com' },
      { fieldId: 'ghi789', fieldRef: 'rating', type: 'number', value: 9 },
    ],
  },
  /** Register (upsert) a webhook for this form under the derived tag, signed with `secret`. */
  async onEnable({ http, auth, props, webhookUrl, secret }): Promise<WebhookRegistration> {
    const tag = tagForWebhookUrl(webhookUrl);
    await http.put(
      `${TYPEFORM_API_BASE}/forms/${encodeURIComponent(props.formId)}/webhooks/${encodeURIComponent(tag)}`,
      { auth, body: { url: webhookUrl, enabled: true, secret, verify_ssl: true } },
    );
    return { subscriptionId: tag, formId: props.formId };
  },
  /** Delete the webhook by its tag. A 404 means it's already gone — teardown is idempotent. */
  async onDisable({ http, auth, props, registration }): Promise<void> {
    const tag = registration?.subscriptionId;
    if (!tag) return;
    const formId = typeof registration.formId === 'string' ? registration.formId : props.formId;
    const res = await http.delete(
      `${TYPEFORM_API_BASE}/forms/${encodeURIComponent(formId)}/webhooks/${encodeURIComponent(tag)}`,
      { auth, throwOnError: false },
    );
    if (res.status !== 404 && (res.status < 200 || res.status >= 300)) {
      throw new Error(`Typeform webhook delete failed: HTTP ${res.status}`);
    }
  },
  /** Authenticate the delivery: base64 HMAC-SHA256 of the raw body under `sha256=`. */
  verify(request: WebhookRequest, secrets: Record<string, string>): boolean {
    const secret = secrets.signingSecret;
    if (!secret || request.rawBody === undefined) return false;
    const header = request.headers['typeform-signature'];
    if (!header) return false;
    const expected = `sha256=${createHmac('sha256', secret).update(request.rawBody).digest('base64')}`;
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(header);
    return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  },
  onRequest({ request }): TypeformResponseEvent[] {
    const body = request.body as TypeformWebhookPayload | undefined;
    if (!body || body.event_type !== 'form_response') return [];
    const response = body.form_response;
    if (!response || typeof response.token !== 'string') return [];
    return [
      {
        eventId: body.event_id ?? response.token,
        formId: response.form_id ?? '',
        ...(response.definition?.title ? { formTitle: response.definition.title } : {}),
        token: response.token,
        ...(response.submitted_at ? { submittedAt: response.submitted_at } : {}),
        ...(response.landed_at ? { landedAt: response.landed_at } : {}),
        ...(response.hidden ? { hidden: response.hidden } : {}),
        answers: (response.answers ?? []).map((answer) => ({
          ...(answer.field?.id ? { fieldId: answer.field.id } : {}),
          ...(answer.field?.ref ? { fieldRef: answer.field.ref } : {}),
          ...(answer.type ? { type: answer.type } : {}),
          value: answerValue(answer),
        })),
      },
    ];
  },
  /** Typeform redelivers with the same `event_id` — dedupe on it. */
  dedupeKey: (event) => event.eventId,
});
