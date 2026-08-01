import type { ApiKeyScheme } from '../../core/auth';
import { chatCompletionBody, extractChatCompletionText, makeGenerateText, usageField } from './generate-text';

/** OpenAI authenticates with a bearer key in the `Authorization` header. */
const openaiAuth: ApiKeyScheme = { type: 'apiKey', in: 'header', name: 'Authorization', prefix: 'Bearer ' };

/** `openai.generate_text` — generate text with an OpenAI chat model. */
export const openaiGenerateText = makeGenerateText({
  slug: 'openai',
  name: 'Generate text (OpenAI)',
  description: 'Generate text from a prompt using an OpenAI chat model.',
  auth: openaiAuth,
  // Chat models only — o-series reasoning models 400 against the shared body (no `max_tokens`/`temperature`).
  defaultModel: 'gpt-4o',
  models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  buildUrl: () => 'https://api.openai.com/v1/chat/completions',
  buildBody: chatCompletionBody,
  extractText: (data) => extractChatCompletionText(data, 'openai'),
  extractUsage: (data) => usageField(data, 'usage'),
});
