import type { AuthHandle, AuthScheme } from './auth';
import { type ManifestEntry, toManifestEntry } from './catalog';
import { ActionError } from './errors';
import { HttpClient } from './http/client';
import type { JsonValue } from './http/types';
import { parseProps, type PropsSchema, type PropsValue } from './props';

/** Minimal durable KV the runtime provides for dedup + cursor/watermark state. */
export interface TriggerStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Cap on the remembered dedup keys — bounds store growth on a hot trigger. */
const DEDUPE_CAP = 1000;

interface TriggerBase<TProps extends PropsSchema> {
  type: string;
  name: string;
  description: string;
  auth: AuthScheme;
  props: TProps;
  /** Example event payload for the UI/AI author; never used at runtime. */
  sampleData?: JsonValue;
}

// ─── polling ───

export interface PollingContext<TProps extends PropsSchema> {
  auth: AuthHandle;
  props: PropsValue<TProps>;
  http: HttpClient;
  store: TriggerStore;
  /** ISO timestamp of the last successful poll; undefined on the first run. */
  lastPolledAt?: string;
}

export interface PollingTriggerDefinition<TProps extends PropsSchema, TItem> extends TriggerBase<TProps> {
  strategy: 'polling';
  /** Fetch candidate items (newest-relevant first); dedup happens in the SDK. */
  poll(ctx: PollingContext<TProps>): Promise<TItem[]>;
  /** Stable id per item so an item seen in a prior poll is not re-emitted. */
  dedupeKey(item: TItem): string;
}

export interface PollInput {
  auth: AuthHandle;
  props: Record<string, unknown>;
  store: TriggerStore;
  http?: HttpClient;
}

export interface PollResult<TItem> {
  events: TItem[];
  polledAt: string;
}

export interface PollingTrigger<TProps extends PropsSchema, TItem> extends PollingTriggerDefinition<
  TProps,
  TItem
> {
  /** Poll once: validate props, fetch, dedupe against the store, advance the watermark. */
  runPoll(input: PollInput): Promise<PollResult<TItem>>;
  toManifest(): ManifestEntry;
}

// ─── webhook ───

/** An inbound webhook request as the SDK sees it. */
export interface WebhookRequest {
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Parsed JSON body. */
  body: unknown;
  /** Exact bytes as received — required for signature verification. */
  rawBody?: string;
}

/** The synchronous reply to a provider verification challenge. */
export interface HandshakeResponse {
  status: number;
  body?: JsonValue;
}

/** Durable, JSON-serialisable handle from `onEnable`; `subscriptionId` is what `onDisable` deletes. */
export interface WebhookRegistration {
  subscriptionId: string;
  [key: string]: JsonValue;
}

export interface WebhookContext<TProps extends PropsSchema> {
  auth: AuthHandle;
  props: PropsValue<TProps>;
  http: HttpClient;
  store: TriggerStore;
  /** The public URL the provider should call — passed to registration. */
  webhookUrl: string;
  /** Per-trigger signing secret shared by `onEnable` and `verify`; empty for app-level webhooks. */
  secret: string;
}

export interface WebhookTriggerDefinition<TProps extends PropsSchema, TItem> extends TriggerBase<TProps> {
  strategy: 'webhook';
  /** Register a subscription at `ctx.webhookUrl` signed with `ctx.secret`; omit for app-level webhooks. */
  onEnable?(ctx: WebhookContext<TProps>): Promise<WebhookRegistration | void>;
  /** Remove the subscription `onEnable` created, by `registration.subscriptionId`. */
  onDisable?(ctx: WebhookContext<TProps> & { registration?: WebhookRegistration }): Promise<void>;
  /** Echo a provider verification challenge (Slack `url_verification`). Return null to ignore. */
  handshake?(request: WebhookRequest): HandshakeResponse | null;
  /** Authenticate the request (HMAC signature). Return false to reject. */
  verify?(request: WebhookRequest, secrets: Record<string, string>): boolean;
  /** Transform an authentic request into zero or more events. */
  onRequest(ctx: WebhookContext<TProps> & { request: WebhookRequest }): Promise<TItem[]> | TItem[];
  /** Optional dedup key so provider retries don't double-fire. */
  dedupeKey?(item: TItem): string;
}

export interface HandleWebhookInput {
  auth: AuthHandle;
  props: Record<string, unknown>;
  store: TriggerStore;
  request: WebhookRequest;
  http?: HttpClient;
  webhookUrl?: string;
  /** The per-trigger signing secret — surfaced to `onRequest` via `ctx.secret`. */
  secret?: string;
  /** Verification secrets (e.g. `{ signingSecret }`); passed to `verify`. */
  secrets?: Record<string, string>;
}

export interface EnableInput {
  auth: AuthHandle;
  props: Record<string, unknown>;
  store: TriggerStore;
  webhookUrl: string;
  /** The per-trigger signing secret to register the subscription with. */
  secret: string;
  http?: HttpClient;
}

export interface DisableInput extends EnableInput {
  /** The handle `enable` returned; hands `onDisable` the subscription to delete. */
  registration?: WebhookRegistration;
}

export interface WebhookTrigger<TProps extends PropsSchema, TItem> extends WebhookTriggerDefinition<
  TProps,
  TItem
> {
  /** Register the subscription and return the handle to persist (or undefined for app-level webhooks). */
  enable(input: EnableInput): Promise<WebhookRegistration | undefined>;
  /** Deregister the subscription named by `input.registration`. */
  disable(input: DisableInput): Promise<void>;
  /** Answer a verification handshake, or null if this request isn't one. */
  handleHandshake(request: WebhookRequest): HandshakeResponse | null;
  /** Verify (if configured), transform, and dedupe an inbound request into events. */
  handleRequest(input: HandleWebhookInput): Promise<TItem[]>;
  toManifest(): ManifestEntry;
}

// ─── factory ───

const TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function defineTrigger<TProps extends PropsSchema, TItem>(
  def: PollingTriggerDefinition<TProps, TItem>,
): PollingTrigger<TProps, TItem>;
export function defineTrigger<TProps extends PropsSchema, TItem>(
  def: WebhookTriggerDefinition<TProps, TItem>,
): WebhookTrigger<TProps, TItem>;
export function defineTrigger<TProps extends PropsSchema, TItem>(
  def: PollingTriggerDefinition<TProps, TItem> | WebhookTriggerDefinition<TProps, TItem>,
): PollingTrigger<TProps, TItem> | WebhookTrigger<TProps, TItem> {
  if (!TYPE_PATTERN.test(def.type)) {
    throw new ActionError({
      code: 'invalid_input',
      message: `invalid trigger type "${def.type}" — expected "<slug>.<action>"`,
      retryable: false,
    });
  }
  const manifest = (): ManifestEntry =>
    toManifestEntry({
      type: def.type,
      name: def.name,
      description: def.description,
      auth: def.auth,
      props: def.props,
    });

  return def.strategy === 'polling' ? buildPollingTrigger(def, manifest) : buildWebhookTrigger(def, manifest);
}

function buildPollingTrigger<TProps extends PropsSchema, TItem>(
  def: PollingTriggerDefinition<TProps, TItem>,
  manifest: () => ManifestEntry,
): PollingTrigger<TProps, TItem> {
  return {
    ...def,
    async runPoll(input: PollInput): Promise<PollResult<TItem>> {
      const props = parseProps(def.props, input.props);
      const http = input.http ?? new HttpClient();
      const lastPolledAt = await input.store.get<string>('lastPolledAt');
      const items = await def.poll({
        auth: input.auth,
        props,
        http,
        store: input.store,
        ...(lastPolledAt ? { lastPolledAt } : {}),
      });

      const seen = (await input.store.get<string[]>('seen')) ?? [];
      const seenSet = new Set(seen);
      const fresh: TItem[] = [];
      const freshKeys: string[] = [];
      for (const item of items) {
        const key = def.dedupeKey(item);
        if (seenSet.has(key)) continue;
        seenSet.add(key);
        fresh.push(item);
        freshKeys.push(key);
      }
      const polledAt = new Date().toISOString();
      await input.store.set('seen', [...freshKeys, ...seen].slice(0, DEDUPE_CAP));
      await input.store.set('lastPolledAt', polledAt);
      return { events: fresh, polledAt };
    },
    toManifest: manifest,
  };
}

function buildWebhookTrigger<TProps extends PropsSchema, TItem>(
  def: WebhookTriggerDefinition<TProps, TItem>,
  manifest: () => ManifestEntry,
): WebhookTrigger<TProps, TItem> {
  return {
    ...def,
    async enable(input: EnableInput): Promise<WebhookRegistration | undefined> {
      if (!def.onEnable) return undefined;
      const props = parseProps(def.props, input.props);
      const http = input.http ?? new HttpClient();
      const registration = await def.onEnable({
        auth: input.auth,
        props,
        http,
        store: input.store,
        webhookUrl: input.webhookUrl,
        secret: input.secret,
      });
      return registration ?? undefined;
    },
    async disable(input: DisableInput): Promise<void> {
      if (!def.onDisable) return;
      const props = parseProps(def.props, input.props);
      const http = input.http ?? new HttpClient();
      await def.onDisable({
        auth: input.auth,
        props,
        http,
        store: input.store,
        webhookUrl: input.webhookUrl,
        secret: input.secret,
        ...(input.registration ? { registration: input.registration } : {}),
      });
    },
    handleHandshake(request: WebhookRequest): HandshakeResponse | null {
      return def.handshake ? def.handshake(request) : null;
    },
    async handleRequest(input: HandleWebhookInput): Promise<TItem[]> {
      if (def.verify) {
        const ok = def.verify(input.request, input.secrets ?? {});
        if (!ok) {
          throw new ActionError({
            code: 'provider_error',
            message: 'webhook signature verification failed',
            status: 401,
            retryable: false,
          });
        }
      }
      const props = parseProps(def.props, input.props);
      const http = input.http ?? new HttpClient();
      const events = await def.onRequest({
        auth: input.auth,
        props,
        http,
        store: input.store,
        webhookUrl: input.webhookUrl ?? '',
        secret: input.secret ?? '',
        request: input.request,
      });

      if (!def.dedupeKey) return events;
      const seen = (await input.store.get<string[]>('seen')) ?? [];
      const seenSet = new Set(seen);
      const fresh: TItem[] = [];
      const freshKeys: string[] = [];
      for (const item of events) {
        const key = def.dedupeKey(item);
        if (seenSet.has(key)) continue;
        seenSet.add(key);
        fresh.push(item);
        freshKeys.push(key);
      }
      if (freshKeys.length > 0) await input.store.set('seen', [...freshKeys, ...seen].slice(0, DEDUPE_CAP));
      return fresh;
    },
    toManifest: manifest,
  };
}
