import type { JsonValue } from '../../../core/http/types';
import { asArray, asRecord } from '../generate-text';
import { answeredCalls, normalizeUsage, throwNoTurn, type ToolCallDraft, uniqueToolCalls } from './shared';
import type {
  AgentConversationMessage,
  AgentModelAdapter,
  AgentModelRequest,
  AgentModelResult,
  AgentToolCall,
  AgentToolSchema,
} from './types';

/**
 * Gemini `:generateContent` function calling — results thread by NAME, with an optional per-call `id`
 * that is the only way to disambiguate concurrent calls to the same function.
 */

/** Gemini omits the per-call id on older responses — synthesize a stable one. */
function synthesizeId(name: string, index: number): string {
  return `${name}_${index}`;
}

/** Gemini's `Schema` is an OpenAPI-3.0 subset and v1beta 400s on any unknown key — allowlist, never a denylist. */
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'default',
  'enum',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'propertyOrdering',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
]);

/** Recursively coerce any tool JSON schema into a Gemini-safe `Schema`, keeping only allowlisted keys. */
function sanitizeGeminiSchema(schema: unknown): JsonValue {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema as JsonValue;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, JsonValue> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        props[name] = sanitizeGeminiSchema(sub);
      }
      out.properties = props;
    } else if (key === 'items' || key === 'anyOf') {
      out[key] = sanitizeGeminiSchema(value);
    } else {
      out[key] = value as JsonValue;
    }
  }
  return out;
}

/** True when a sanitized schema declares no parameters — Gemini rejects an empty-properties `parameters`. */
function isNoParamSchema(schema: JsonValue): boolean {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const props = schema.properties;
  const hasProps =
    props !== null && typeof props === 'object' && !Array.isArray(props) && Object.keys(props).length > 0;
  return (schema.type === undefined || schema.type === 'object') && !hasProps;
}

/** One bound tool → a Gemini `functionDeclaration`, `parameters` sanitized (omitted when no-param). */
function functionDeclaration(tool: AgentToolSchema): JsonValue {
  const parameters = sanitizeGeminiSchema(tool.parameters);
  return {
    name: tool.name,
    description: tool.description,
    ...(isNoParamSchema(parameters) ? {} : { parameters }),
  };
}

// parseResponse gives `providerId` to an issued id equal to its own slot, so only synthesized ids match here.
function geminiIssuedId(call: AgentToolCall, index: number): string | undefined {
  if (call.providerId !== undefined) return call.providerId ?? undefined;
  return call.id === synthesizeId(call.name, index) ? undefined : call.id;
}

/** An assistant turn → a `model` content with a text part (if any) + `functionCall` parts. */
function modelContent(message: AgentConversationMessage): JsonValue {
  const parts: JsonValue[] = [];
  if (message.content) parts.push({ text: message.content });
  (message.toolCalls ?? []).forEach((call, index) => {
    const functionCall: Record<string, JsonValue> = {
      name: call.name,
      args: (call.input ?? {}) as JsonValue,
    };
    const issued = geminiIssuedId(call, index);
    if (issued !== undefined) functionCall.id = issued;
    parts.push({ functionCall });
  });
  return { role: 'model', parts: parts.length > 0 ? parts : [{ text: message.content }] };
}

/** Serialize the buffer to Gemini contents, merging runs of tool results into one user turn. */
function geminiContents(messages: readonly AgentConversationMessage[]): JsonValue {
  const answered = answeredCalls(messages);
  const out: JsonValue[] = [];
  let pendingResponses: JsonValue[] = [];
  const flush = (): void => {
    if (pendingResponses.length > 0) {
      out.push({ role: 'user', parts: pendingResponses });
      pendingResponses = [];
    }
  };
  for (const [at, message] of messages.entries()) {
    if (message.role === 'tool') {
      const answer = answered[at];
      const functionResponse: Record<string, JsonValue> = {
        name: answer?.call.name ?? message.toolCallId ?? '',
        response: { result: message.content },
      };
      // Only a Gemini-issued id disambiguates same-name calls; a synthesized or de-duplicated one is ours.
      const issued = answer && geminiIssuedId(answer.call, answer.index);
      if (issued !== undefined) functionResponse.id = issued;
      pendingResponses.push({ functionResponse });
      continue;
    }
    flush();
    if (message.role === 'user') out.push({ role: 'user', parts: [{ text: message.content }] });
    else out.push(modelContent(message));
  }
  flush();
  return out;
}

function buildBody(req: AgentModelRequest): JsonValue {
  const generationConfig: Record<string, JsonValue> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
  return {
    contents: geminiContents(req.messages),
    // Omit `tools` entirely when empty — Gemini 400s on an empty `functionDeclarations`.
    ...(req.tools.length > 0
      ? { tools: [{ functionDeclarations: req.tools.map(functionDeclaration) }] }
      : {}),
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}

function parseResponse(data: unknown): AgentModelResult {
  const parts = asArray(asRecord(asRecord(asArray(asRecord(data)?.candidates)?.[0])?.content)?.parts);
  if (!parts) throwNoTurn('gemini');
  const textParts: string[] = [];
  const drafts: ToolCallDraft[] = [];
  for (const raw of parts) {
    const part = asRecord(raw);
    const fnCall = asRecord(part?.functionCall);
    if (fnCall && typeof fnCall.name === 'string') {
      // Prefer the real id Gemini sends; synthesize only when the call carried none.
      const issued = typeof fnCall.id === 'string' && fnCall.id.length > 0 ? fnCall.id : undefined;
      drafts.push({
        id: issued ?? synthesizeId(fnCall.name, drafts.length),
        issued,
        name: fnCall.name,
        input: fnCall.args ?? {},
      });
    } else if (typeof part?.text === 'string') {
      textParts.push(part.text);
    }
  }
  const toolCalls = uniqueToolCalls(drafts).map((call, index) => {
    const issued = drafts[index]?.issued;
    return issued === synthesizeId(call.name, index) ? { ...call, providerId: issued } : call;
  });
  const text = textParts.join('');
  const usage = normalizeUsage(
    data,
    'usageMetadata',
    'promptTokenCount',
    'candidatesTokenCount',
    'totalTokenCount',
  );
  return { ...(text ? { text } : {}), toolCalls, ...(usage ? { usage } : {}) };
}

/** Gemini generateContent tool-aware adapter. */
export const geminiAgentAdapter: AgentModelAdapter = {
  buildUrl: (req) => `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent`,
  buildBody,
  parseResponse,
};
