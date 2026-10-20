import { ActionError } from '../../../core/errors';
import { asRecord } from '../generate-text';
import type { AgentConversationMessage, AgentToolCall, AgentUsage } from './types';

/** Cross-provider serialization helpers shared by the four adapters. */

/** Raised when a provider response lacks the expected message/candidate. */
export function throwNoTurn(label: string): never {
  throw new ActionError({
    code: 'provider_error',
    message: `${label}: response did not contain a model turn`,
    retryable: false,
  });
}

/** Per buffer message, the call a tool result answers and its index, found in the latest assistant turn. */
export function answeredCalls(
  messages: readonly AgentConversationMessage[],
): ({ call: AgentToolCall; index: number } | undefined)[] {
  let turn: readonly AgentToolCall[] = [];
  return messages.map((message) => {
    if (message.role === 'assistant') turn = message.toolCalls ?? [];
    if (message.role !== 'tool') return undefined;
    const index = turn.findIndex((call) => call.id === message.toolCallId);
    const call = turn[index];
    return call && { call, index };
  });
}

/** One parsed call before de-duplication: `id` may repeat within its response; `issued` is the id the provider sent. */
export interface ToolCallDraft {
  id: string;
  issued: string | undefined;
  name: string;
  input: unknown;
}

/** Make one response's call ids unique: the first holder keeps its id; a later one appends `_<index>` until free, noting `providerId`. */
export function uniqueToolCalls(drafts: readonly ToolCallDraft[]): AgentToolCall[] {
  const reserved = new Set(drafts.map((draft) => draft.id));
  const held = new Set<string>();
  return drafts.map(({ id, issued, name, input }, index) => {
    if (!held.has(id)) {
      held.add(id);
      return { id, name, input };
    }
    let unique = `${id}_${index}`;
    while (reserved.has(unique)) unique = `${unique}_${index}`;
    return { id: unique, name, input, providerId: issued ?? null };
  });
}

/** Parse a provider's JSON-string tool arguments to a value; fall back to the raw string. */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Keep the raw text rather than lose the call; the tool's schema validation surfaces it.
    return raw;
  }
}

/** Read a numeric token count off an (unknown) usage block; undefined when absent. */
function tokenCount(usage: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = usage?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** Normalize a provider usage block to {@link AgentUsage}; `totalTokens` falls back to input+output. */
export function normalizeUsage(
  data: unknown,
  block: string,
  inputKey: string,
  outputKey: string,
  totalKey: string,
): AgentUsage | undefined {
  const usage = asRecord(asRecord(data)?.[block]);
  if (!usage) return undefined;
  const inputTokens = tokenCount(usage, inputKey);
  const outputTokens = tokenCount(usage, outputKey);
  const explicitTotal = tokenCount(usage, totalKey);
  const totalTokens =
    explicitTotal ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  const out: AgentUsage = {};
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}
