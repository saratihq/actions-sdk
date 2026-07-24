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

/** Gemini takes the key as a `?key=` query parameter. */
const geminiAuth: ApiKeyScheme = { type: 'apiKey', in: 'query', name: 'key' };

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
  const candidate = asArray(asRecord(data)?.candidates)?.[0];
  const firstPart = asArray(asRecord(asRecord(candidate)?.content)?.parts)?.[0];
  const text = asRecord(firstPart)?.text;
  if (typeof text !== 'string') throwNoText('gemini');
  return text;
}

/** `gemini.generate_text` — generate text with a Google Gemini model. */
export const geminiGenerateText = makeGenerateText({
  slug: 'gemini',
  name: 'Generate text (Google Gemini)',
  description: 'Generate text from a prompt using a Google Gemini model.',
  auth: geminiAuth,
  defaultModel: 'gemini-2.0-flash',
  models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  buildUrl: (input) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${input.model}:generateContent`,
  buildBody: geminiBody,
  extractText: extractGeminiText,
  extractUsage: (data) => usageField(data, 'usageMetadata'),
});
