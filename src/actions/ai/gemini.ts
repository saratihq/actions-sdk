import type { ApiKeyScheme } from '../../core/auth';
import { ActionError } from '../../core/errors';
import type { JsonValue } from '../../core/http/types';
import {
  asArray,
  asRecord,
  type GenerateInput,
  makeGenerateText,
  requireText,
  usageField,
} from './generate-text';

/** Gemini takes the key as a `?key=` query parameter. */
export const geminiAuth: ApiKeyScheme = {
  type: 'apiKey',
  origins: ['https://generativelanguage.googleapis.com'],
  in: 'query',
  name: 'key',
};

type GeminiBody = { [key: string]: JsonValue };

// gemini-4-argon takes at most 32,768 per non-streaming REST call; above that the call 400s or long-decodes.
const MODEL_MAX_TOKENS: Readonly<Record<string, number>> = {
  'gemini-3.6-flash': 65_536,
  'gemini-3.8-flash': 65_536,
  'gemini-3.5-flash-lite': 65_536,
  'gemini-4-argon': 32_768,
};
const REST_REQUEST_CAP = 32_768;

/** The `:generateContent` request body. `systemInstruction` and JSON mode live in their own slots. */
function geminiBody(input: GenerateInput): GeminiBody {
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

function firstCandidate(data: unknown): Record<string, unknown> | undefined {
  return asRecord(asArray(asRecord(data)?.candidates)?.[0]);
}

// A MAX_TOKENS stop carries a token too, but resuming it needs a higher budget, so only CONTINUATION continues.
function continuationToken(hop: unknown): string | undefined {
  const candidate = firstCandidate(hop);
  if (candidate?.finishReason !== 'CONTINUATION') return undefined;
  const token = candidate.continuationToken;
  if (typeof token === 'string' && token !== '') return token;
  throw new ActionError({
    code: 'provider_error',
    message:
      'gemini: a CONTINUATION response carried no continuation token, so the rest of the answer cannot be fetched',
    retryable: false,
  });
}

// REST reports usage per hop.
function sumUsage(hops: unknown[]): Record<string, number> | undefined {
  const blocks = hops
    .map((hop) => asRecord(asRecord(hop)?.usageMetadata))
    .filter((block) => block !== undefined);
  if (blocks.length === 0) return undefined;
  const total: Record<string, number> = {};
  for (const [key, value] of blocks.flatMap((block) => Object.entries(block))) {
    if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
  }
  return total;
}

function joinHops(hops: unknown[]): unknown {
  const candidates = hops.map(firstCandidate);
  const last = candidates[candidates.length - 1];
  const parts = candidates.flatMap((candidate) => asArray(asRecord(candidate?.content)?.parts) ?? []);
  return {
    candidates: [{ ...last, content: { ...asRecord(last?.content), parts } }],
    usageMetadata: sumUsage(hops),
  };
}

async function longDecode(post: (body: GeminiBody) => Promise<unknown>, body: GeminiBody): Promise<unknown> {
  const hops: unknown[] = [];
  let token: string | undefined;
  do {
    const hop = await post(token === undefined ? body : { ...body, continuationToken: token });
    hops.push(hop);
    token = continuationToken(hop);
  } while (token !== undefined);
  return hops.length === 1 ? hops[0] : joinHops(hops);
}

/** Join the first candidate's non-thought text parts, or throw. */
function extractGeminiText(data: unknown): string {
  const candidate = firstCandidate(data);
  const texts = (asArray(asRecord(candidate?.content)?.parts) ?? [])
    .map((part) => asRecord(part))
    .filter((part) => part?.thought !== true)
    .map((part) => part?.text)
    .filter((text) => typeof text === 'string');
  return requireText(
    'gemini',
    texts.length > 0 ? texts.join('') : undefined,
    candidate?.finishReason === 'MAX_TOKENS',
  );
}

/** `gemini.generate_text` — generate text with a Google Gemini model. */
export const geminiGenerateText = makeGenerateText({
  slug: 'gemini',
  name: 'Generate text (Google Gemini)',
  description: 'Generate text from a prompt using a Google Gemini model.',
  auth: geminiAuth,
  defaultModel: 'gemini-3.6-flash',
  models: Object.keys(MODEL_MAX_TOKENS),
  defaultMaxTokens: (model) => MODEL_MAX_TOKENS[model] ?? REST_REQUEST_CAP,
  buildUrl: (input) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${input.model}:generateContent`,
  buildBody: geminiBody,
  send: longDecode,
  extractText: extractGeminiText,
  extractUsage: (data) => usageField(data, 'usageMetadata'),
});
