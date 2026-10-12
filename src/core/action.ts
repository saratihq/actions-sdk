import { type AuthHandle, type AuthScheme, redactorOf } from './auth';
import { type ManifestEntry, toManifestEntry } from './catalog';
import { ActionError, normalizeError, scrubError } from './errors';
import { HttpClient } from './http/client';
import { credentialScope, scopeHandle } from './http/credential-scope';
import { type DropdownResult, parseProps, type PropsSchema, type PropsValue, resolveOptions } from './props';

/** Public action namespace: `<slug>.<action>`, both `[a-z][a-z0-9_]*`. */
const TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** The seam an action's `run` receives — typed props plus the transport-agnostic client. */
export interface ActionContext<TProps extends PropsSchema> {
  auth: AuthHandle;
  props: PropsValue<TProps>;
  http: HttpClient;
}

export interface ActionDefinition<TProps extends PropsSchema, TOutput> {
  /** Stable public type, `<slug>.<action>` (e.g. `slack.send_channel_message`). */
  type: string;
  name: string;
  description: string;
  auth: AuthScheme;
  props: TProps;
  run(ctx: ActionContext<TProps>): Promise<TOutput>;
}

/** Raw, untrusted execution input — props are validated before `run` sees them. */
export interface ExecuteInput {
  auth: AuthHandle;
  props: Record<string, unknown>;
  /** Supply a configured client (retry policy, injected fetch); defaults to a fresh one. */
  http?: HttpClient;
}

export interface Action<TProps extends PropsSchema, TOutput> extends ActionDefinition<TProps, TOutput> {
  /** Validate raw props, then run. Always throws the one {@link ActionError} shape on failure. */
  execute(input: ExecuteInput): Promise<TOutput>;
  /** Resolve a dynamic (or static) dropdown/multiSelect prop's options — the live picker. */
  loadOptions(
    propName: string,
    ctx: { auth?: AuthHandle; http?: HttpClient; search?: string },
  ): Promise<DropdownResult<unknown>>;
  /** Serialise to the platform catalog shape. */
  toManifest(): ManifestEntry;
}

/** Define an action: validates the public `type` at definition time and wraps `run` with execute/loadOptions/toManifest. */
export function defineAction<TProps extends PropsSchema, TOutput>(
  def: ActionDefinition<TProps, TOutput>,
): Action<TProps, TOutput> {
  if (!TYPE_PATTERN.test(def.type)) {
    throw new ActionError({
      code: 'invalid_input',
      message: `invalid action type "${def.type}" — expected "<slug>.<action>" ([a-z][a-z0-9_]*)`,
      retryable: false,
    });
  }

  const scope = credentialScope(def.auth);
  const action: Action<TProps, TOutput> = {
    ...def,
    async execute(input: ExecuteInput): Promise<TOutput> {
      const props = parseProps(def.props, input.props);
      const http = input.http ?? new HttpClient();
      const auth = scopeHandle(scope, input.auth);
      try {
        return await def.run({ auth, props, http });
      } catch (err) {
        // Scrubbed before it is read, then wrapped, so anything `run` throws leaves as one shape.
        const scrubbed = scrubError(err, redactorOf(auth));
        throw scrubbed instanceof ActionError
          ? scrubbed
          : new ActionError({ code: 'unknown', ...normalizeError(scrubbed), cause: scrubbed });
      }
    },
    async loadOptions(propName, ctx): Promise<DropdownResult<unknown>> {
      const schema = def.props[propName];
      if (!schema || (schema.kind !== 'dropdown' && schema.kind !== 'multiSelect')) {
        throw new ActionError({
          code: 'invalid_input',
          message: `prop "${propName}" is not a dropdown/multiSelect on ${def.type}`,
          retryable: false,
        });
      }
      const http = ctx.http ?? new HttpClient();
      return resolveOptions(schema, {
        ...(ctx.auth ? { auth: scopeHandle(scope, ctx.auth) } : {}),
        http,
        ...(ctx.search ? { search: ctx.search } : {}),
      });
    },
    toManifest(): ManifestEntry {
      return toManifestEntry({
        type: def.type,
        name: def.name,
        description: def.description,
        auth: def.auth,
        props: def.props,
      });
    },
  };
  return action;
}
