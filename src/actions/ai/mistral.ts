import type { ApiKeyScheme } from '../../core/auth';
import { chatCompletionBody, extractChatCompletionText, makeGenerateText, usageField } from './generate-text';

/** Mistral authenticates with a bearer key in the `Authorization` header (OpenAI-shaped API). */
export const mistralAuth: ApiKeyScheme = {
  type: 'apiKey',
  origins: ['https://api.mistral.ai'],
  in: 'header',
  name: 'Authorization',
  prefix: 'Bearer ',
};

/** Per-request timeout of a Mistral model call: the 5 minutes Mistral's reasoning guide gives its client. */
export const mistralTimeoutMs = 300_000;

/** `mistral.generate_text` — generate text with a Mistral chat model. */
export const mistralGenerateText = makeGenerateText({
  slug: 'mistral',
  name: 'Generate text (Mistral)',
  description: 'Generate text from a prompt using a Mistral chat model.',
  auth: mistralAuth,
  defaultModel: 'mistral-large-latest',
  models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
  timeoutMs: mistralTimeoutMs,
  buildUrl: () => 'https://api.mistral.ai/v1/chat/completions',
  buildBody: chatCompletionBody,
  extractText: (data) => extractChatCompletionText(data, 'mistral'),
  extractUsage: (data) => usageField(data, 'usage'),
});
