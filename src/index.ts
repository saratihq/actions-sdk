/** Orchestr Action SDK public API — `createAuthHandle`/`transportOf` stay unexported so the transport is unreachable from action code. */

// Errors — the one failure shape.
export {
  ActionError,
  type ActionErrorCode,
  isRetryableStatus,
  type NormalizedFailure,
  normalizeError,
  redactSecrets,
} from './core/errors';

// Auth — schemes, the opaque handle, and the handle factories.
export {
  type ApiKeyScheme,
  type AuthHandle,
  type AuthScheme,
  type AuthSchemeType,
  type BasicScheme,
  type CustomScheme,
  type DirectCredential,
  type NoneScheme,
  type OAuth2Scheme,
} from './core/auth';
export { createAuth, createDirectAuth } from './core/auth-factories';

// HTTP — client, transports, pagination, retry, wire types.
export {
  HttpClient,
  type HttpClientOptions,
  type HttpResponse,
  type RequestOptions,
} from './core/http/client';
export {
  type FetchLike,
  type FetchLikeResponse,
  FORM,
  type FormBody,
  type HttpMethod,
  isFormBody,
  isMultipartBody,
  type JsonValue,
  MULTIPART,
  type MultipartBody,
  type MultipartPart,
  type NormalizedRequest,
  type NormalizedResponse,
  type QueryValue,
  type RequestBody,
  resolveFetch,
  type ResponseType,
  type Transport,
} from './core/http/types';
export {
  buildMultipart,
  encodeMultipart,
  type MultipartFileInput,
  type MultipartInput,
} from './core/http/multipart';
export { buildForm, encodeForm, type FormInput, type FormScalar } from './core/http/form';
export { DirectTransport, type DirectTransportOptions } from './core/http/transport-direct';
export {
  cursorInBody,
  linkHeader,
  type NextPageFn,
  paginate,
  type PaginateOptions,
} from './core/http/pagination';
export { backoffDelay, DEFAULT_RETRY_POLICY, parseRetryAfter, type RetryPolicy } from './core/http/retry';
// SSRF guard — the single choke point every fully user-supplied outbound URL passes through.
export { assertPublicUrl, guardUserUrl, isBlockedIp, ssrfAllowedHostsFromEnv } from './core/http/ssrf';

// Props — typed prop kinds + boundary validation.
export {
  type AnyPropSchema,
  type BasePropSchema,
  checkbox,
  dateTime,
  dropdown,
  type DropdownOption,
  type DropdownResult,
  type DropdownSchema,
  file,
  type FileInput,
  json,
  longText,
  multiSelect,
  type MultiSelectSchema,
  number,
  type OptionsContext,
  type OptionsSource,
  parseProps,
  type PropKind,
  type PropsSchema,
  type PropsValue,
  type PropValue,
  resolveOptions,
  shortText,
} from './core/props';

// Action + trigger primitives.
export {
  type Action,
  type ActionContext,
  type ActionDefinition,
  defineAction,
  type ExecuteInput,
} from './core/action';
export {
  defineTrigger,
  type DisableInput,
  type EnableInput,
  type HandleWebhookInput,
  type HandshakeResponse,
  type PollingContext,
  type PollingTrigger,
  type PollingTriggerDefinition,
  type PollInput,
  type PollResult,
  type TriggerStore,
  type WebhookContext,
  type WebhookRegistration,
  type WebhookRequest,
  type WebhookTrigger,
  type WebhookTriggerDefinition,
} from './core/trigger';

// Catalog serialisation (the platform manifest shape).
export {
  type ManifestEntry,
  type ManifestProp,
  type ManifestPropType,
  type ManifestSource,
  toManifestEntry,
} from './core/catalog';

// The tool-aware model call for the AI Agent node — a loop-internal primitive, not a catalog action.
export {
  type AgentConversationMessage,
  type AgentModelAdapter,
  agentModelAdapters,
  type AgentModelRequest,
  type AgentModelResult,
  type AgentProvider,
  type AgentToolCall,
  type AgentToolSchema,
  type AgentUsage,
  anthropicAgentAdapter,
  callAgentModel,
  geminiAgentAdapter,
  mistralAgentAdapter,
  openaiAgentAdapter,
} from './actions/ai/agent-model';

// Actions + triggers.
export * as actions from './actions';
