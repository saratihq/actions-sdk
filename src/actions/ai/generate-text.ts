import type { ApiKeyScheme } from '../../core/auth';
import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import type { JsonValue } from '../../core/http/types';
import { checkbox, dropdown, longText, number } from '../../core/props';

/** The "generate text" family: one prompt-in / text-out action per LLM provider, from a single factory. */

const DEFAULT_MAX_TOKENS = 1024;

/** The uniform output every provider returns. */
export interface GenerateTextOutput {
  text: string;
  model: string;
  usage?: unknown;
}

/** The typed, defaulted request the factory hands each provider's body/url builder. */
export interface GenerateInput {
  prompt: string;
  system?: string;
  model: string;
  temperature?: number;
  /** Always resolved (defaults to the provider's {@link ProviderConfig.defaultMaxTokens} for the model, else 1024). */
  maxTokens: number;
  /** Always resolved (defaults to false). */
  jsonOutput: boolean;
}

/** What a single provider contributes on top of the shared shape. */
export interface ProviderConfig<TBody extends JsonValue = JsonValue> {
  /** Catalog slug — also the brand icon key. One of: openai | claude | gemini | mistral. */
  slug: string;
  name: string;
  description: string;
  auth: ApiKeyScheme;
  /** Pre-selected model (the dropdown's default). */
  defaultModel: string;
  /** Static model options offered by this provider. */
  models: readonly string[];
  /** `Max tokens` for a model when the step leaves it blank; set, the field has no pre-fill, else it pre-fills 1024. */
  defaultMaxTokens?: (model: string) => number;
  /** Non-secret headers this provider requires on every call (e.g. anthropic-version). */
  extraHeaders?: Record<string, string>;
  /** The POST URL — some providers (Gemini) put the model in the path. */
  buildUrl(input: GenerateInput): string;
  /** The provider-shaped JSON request body. */
  buildBody(input: GenerateInput): TBody;
  /** Make the call through `post` and return the response to read; defaults to one POST of the body. */
  send?: (post: (body: TBody) => Promise<unknown>, body: TBody) => Promise<unknown>;
  /** Pull the generated text out of the (unknown) response, or throw. Never returns undefined. */
  extractText(data: unknown): string;
  /** Pull the provider's usage/metadata block, if any. */
  extractUsage(data: unknown): unknown;
}

/** Build one provider's `<slug>.generate_text` action; every provider has the same props, only some defaults differ. */
export function makeGenerateText<TBody extends JsonValue>(config: ProviderConfig<TBody>) {
  const defaultMaxTokens = config.defaultMaxTokens ?? (() => DEFAULT_MAX_TOKENS);
  const maxTokensField = config.defaultMaxTokens
    ? { description: "Upper bound on tokens to generate; leave blank for the model's default." }
    : { description: 'Upper bound on tokens to generate.', defaultValue: DEFAULT_MAX_TOKENS };
  const send = config.send ?? ((post: (body: TBody) => Promise<unknown>, body: TBody) => post(body));
  return defineAction({
    type: `${config.slug}.generate_text`,
    name: config.name,
    description: config.description,
    auth: config.auth,
    props: {
      prompt: longText({ label: 'Prompt', description: 'The user prompt to generate from.', required: true }),
      system: longText({
        label: 'System prompt',
        description: 'Optional instructions that steer the model.',
        required: false,
      }),
      model: dropdown<string, true>({
        label: 'Model',
        description: 'Which model to call.',
        required: true,
        defaultValue: config.defaultModel,
        options: config.models.map((model) => ({ label: model, value: model })),
      }),
      temperature: number({
        label: 'Temperature',
        description: 'Sampling temperature; higher is more random.',
        required: false,
      }),
      maxTokens: number({ label: 'Max tokens', required: false, ...maxTokensField }),
      jsonOutput: checkbox({
        label: 'JSON output',
        description: 'Ask the model to return valid JSON.',
        required: false,
        defaultValue: false,
      }),
    },
    async run({ auth, props, http }): Promise<GenerateTextOutput> {
      const input: GenerateInput = {
        prompt: props.prompt,
        ...(props.system !== undefined ? { system: props.system } : {}),
        model: props.model,
        ...(props.temperature !== undefined ? { temperature: props.temperature } : {}),
        maxTokens: props.maxTokens ?? defaultMaxTokens(props.model),
        jsonOutput: props.jsonOutput ?? false,
      };
      const url = config.buildUrl(input);
      const post = async (body: TBody): Promise<unknown> => {
        const res = await http.post<unknown>(url, {
          auth,
          ...(config.extraHeaders ? { headers: config.extraHeaders } : {}),
          body,
        });
        return res.data;
      };
      const data = await send(post, config.buildBody(input));
      const text = config.extractText(data);
      const usage = config.extractUsage(data);
      return { text, model: input.model, ...(usage !== undefined ? { usage } : {}) };
    },
  });
}

// ─── response-boundary helpers ───

/** Narrow to a plain object (arrays excluded), else undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Narrow to an array of unknowns, else undefined. */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? (value as unknown[]) : undefined;
}

/** Raised when a provider response lacks the expected text path. */
export function throwNoText(label: string): never {
  throw new ActionError({
    code: 'provider_error',
    message: `${label}: response did not contain generated text`,
    retryable: false,
  });
}

/** The generated text; none at a Max tokens stop means thinking spent the budget, and the failure says to raise it. */
export function requireText(label: string, text: string | undefined, stoppedAtMaxTokens: boolean): string {
  if (!text && stoppedAtMaxTokens) {
    throw new ActionError({
      code: 'provider_error',
      message: `${label}: thinking used the whole Max tokens budget before any text was written; thinking counts toward Max tokens, so raise it`,
      retryable: false,
    });
  }
  if (text === undefined) throwNoText(label);
  return text;
}

/** Read a top-level field off the (unknown) response. */
export function usageField(data: unknown, key: string): unknown {
  return asRecord(data)?.[key];
}

// ─── OpenAI-shaped chat completions (OpenAI + Mistral) ───

/** The `/chat/completions` request body OpenAI and Mistral both accept. */
export function chatCompletionBody(input: GenerateInput): JsonValue {
  return {
    model: input.model,
    messages: [
      ...(input.system !== undefined ? [{ role: 'system', content: input.system }] : []),
      { role: 'user', content: input.prompt },
    ],
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    max_tokens: input.maxTokens,
    ...(input.jsonOutput ? { response_format: { type: 'json_object' } } : {}),
  };
}

/** Extract `choices[0].message.content` from an OpenAI-shaped response, or throw. */
export function extractChatCompletionText(data: unknown, label: string): string {
  const first = asArray(asRecord(data)?.choices)?.[0];
  const content = asRecord(asRecord(first)?.message)?.content;
  if (typeof content !== 'string') throwNoText(label);
  return content;
}
