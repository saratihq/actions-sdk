import type { ApiKeyScheme } from '../../core/auth';
import type { JsonValue } from '../../core/http/types';
import {
  asArray,
  asRecord,
  type GenerateInput,
  makeGenerateText,
  requireText,
  usageField,
} from './generate-text';

/** Anthropic authenticates with the raw key in `x-api-key` (no bearer prefix). */
export const claudeAuth: ApiKeyScheme = {
  type: 'apiKey',
  origins: ['https://api.anthropic.com'],
  in: 'header',
  name: 'x-api-key',
};

/** Per-request timeout of a Claude model call: the 10 minutes Anthropic's SDKs give a non-streaming request. */
export const claudeTimeoutMs = 600_000;

// Above 21,333 Anthropic's SDKs require streaming; of these models only claude-sonnet-5 thinks by default.
const NON_STREAMING_CAP = 21_333;
const MODEL_MAX_TOKENS: Readonly<Record<string, number>> = {
  'claude-opus-4-8': 1024,
  'claude-sonnet-5': NON_STREAMING_CAP,
  'claude-haiku-4-5-20251001': 1024,
};

/** Anthropic has no `response_format`, so JSON output is requested via the system prompt. */
function claudeSystem(input: GenerateInput): string | undefined {
  if (input.jsonOutput) return `${input.system ?? ''}\n\nRespond with only valid JSON.`;
  return input.system;
}

/** The Messages API body. `max_tokens` is REQUIRED by this API, so it is always sent. */
function claudeBody(input: GenerateInput): JsonValue {
  const system = claudeSystem(input);
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    ...(system !== undefined ? { system } : {}),
    messages: [{ role: 'user', content: input.prompt }],
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  };
}

/** Extract the first `text` block from the `content` array, or throw. */
function extractClaudeText(data: unknown): string {
  const response = asRecord(data);
  const block = asArray(response?.content)?.find((b) => asRecord(b)?.type === 'text');
  const text = asRecord(block)?.text;
  return requireText(
    'claude',
    typeof text === 'string' ? text : undefined,
    response?.stop_reason === 'max_tokens',
  );
}

/** `claude.generate_text` — generate text with an Anthropic Claude model. */
export const claudeGenerateText = makeGenerateText({
  slug: 'claude',
  name: 'Generate text (Claude)',
  description: 'Generate text from a prompt using an Anthropic Claude model.',
  auth: claudeAuth,
  defaultModel: 'claude-opus-4-8',
  models: Object.keys(MODEL_MAX_TOKENS),
  defaultMaxTokens: (model) => MODEL_MAX_TOKENS[model] ?? NON_STREAMING_CAP,
  extraHeaders: { 'anthropic-version': '2023-06-01' },
  timeoutMs: claudeTimeoutMs,
  buildUrl: () => 'https://api.anthropic.com/v1/messages',
  buildBody: claudeBody,
  extractText: extractClaudeText,
  extractUsage: (data) => usageField(data, 'usage'),
});
