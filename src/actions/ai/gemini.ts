import type { ApiKeyScheme } from '../../core/auth';
import { ActionError } from '../../core/errors';
import type { JsonValue } from '../../core/http/types';
import {
  asArray,
  asRecord,
  type GenerateInput,
  makeGenerateText,
  throwNoText,
  usageField,
} from './generate-text';

/** Gemini takes the key as a `?key=` query parameter. */
export const geminiAuth: ApiKeyScheme = {
  type: 'apiKey',
  origins: ['https://generativelanguage.googleapis.com'],
  in: 'query',
  name: 'key',
};

/** The `:generateContent` request body. `systemInstruction` and JSON mode live in their own slots. */
function geminiBody(input: GenerateInput): JsonValue {
  return {
    contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
    ...(input.system !== undefined ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
    generationConfig: {
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      maxOutputTokens: input.maxTokens,
      ...(input.jsonOutput ? { responseMimeType: 'application/json' } : {}),
    },
  };
}

/** Extract `candidates[0].content.parts[0].text`, or throw. */
function extractGeminiText(data: unknown): string {
  const candidate = asRecord(asArray(asRecord(data)?.candidates)?.[0]);
  const firstPart = asArray(asRecord(candidate?.content)?.parts)?.[0];
  const text = asRecord(firstPart)?.text;
  const noText = typeof text !== 'string' || text === '';
  if (noText && candidate?.finishReason === 'MAX_TOKENS') {
    throw new ActionError({
      code: 'provider_error',
      message:
        'gemini: thinking used the whole Max tokens budget before any text was written; thinking counts toward Max tokens, so raise it',
      retryable: false,
    });
  }
  if (typeof text !== 'string') throwNoText('gemini');
  return text;
}

/** `gemini.generate_text` — generate text with a Google Gemini model. */
export const geminiGenerateText = makeGenerateText({
  slug: 'gemini',
  name: 'Generate text (Google Gemini)',
  description: 'Generate text from a prompt using a Google Gemini model.',
  auth: geminiAuth,
  defaultModel: 'gemini-3.6-flash',
  models: ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon'],
  // Each listed model's own output limit, which its thinking tokens count toward.
  defaultMaxTokens: 65_536,
  buildUrl: (input) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${input.model}:generateContent`,
  buildBody: geminiBody,
  extractText: extractGeminiText,
  extractUsage: (data) => usageField(data, 'usageMetadata'),
});
