import type { ApiKeyScheme } from '../../core/auth';
import type { JsonValue } from '../../core/http/types';
import {
  asArray,
  asRecord,
  type GenerateInput,
  makeGenerateText,
  throwNoText,
  usageField,
} from './generate-text';

/** Anthropic authenticates with the raw key in `x-api-key` (no bearer prefix). */
const claudeAuth: ApiKeyScheme = { type: 'apiKey', in: 'header', name: 'x-api-key' };

/**
 * Anthropic has no `response_format`, so JSON output is requested by appending an
 * instruction to the system prompt. Returns undefined only when there is no
 * system prompt AND JSON output is off (so `system` is omitted from the body).
 */
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
  const block = asArray(asRecord(data)?.content)?.find((b) => asRecord(b)?.type === 'text');
  const text = asRecord(block)?.text;
  if (typeof text !== 'string') throwNoText('claude');
  return text;
}

/** `claude.generate_text` — generate text with an Anthropic Claude model. */
export const claudeGenerateText = makeGenerateText({
  slug: 'claude',
  name: 'Generate text (Claude)',
  description: 'Generate text from a prompt using an Anthropic Claude model.',
  auth: claudeAuth,
  defaultModel: 'claude-opus-4-8',
  models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  extraHeaders: { 'anthropic-version': '2023-06-01' },
  buildUrl: () => 'https://api.anthropic.com/v1/messages',
  buildBody: claudeBody,
  extractText: extractClaudeText,
  extractUsage: (data) => usageField(data, 'usage'),
});
