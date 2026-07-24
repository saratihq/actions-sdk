import { ActionError } from '../../../core/errors';
import { asRecord } from '../generate-text';
import type { AgentConversationMessage, AgentUsage } from './types';

/**
 * Cross-provider serialization helpers shared by the four adapters. Kept in one
 * place so a change to the tool-result round-trip rule lands once.
 */

/** The one failure raised when a provider response lacks the expected message/candidate. */
export function throwNoTurn(label: string): never {
  throw new ActionError({
    code: 'provider_error',
    message: `${label}: response did not contain a model turn`,
    retryable: false,
  });
}

/**
 * Map every prior tool-call id → the tool name that was called, scanning the
 * assistant turns the loop echoed back. Providers that thread tool results by id
 * (OpenAI/Anthropic/Mistral) carry the id directly; Gemini threads by NAME, so
 * its adapter resolves the name from a `tool` turn's `toolCallId` through here.
 */
export function toolNamesById(messages: readonly AgentConversationMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue;
    for (const call of message.toolCalls) names.set(call.id, call.name);
  }
  return names;
}

/** Parse a provider's JSON-string tool arguments to a value; fall back to the raw string. */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // A model very rarely emits invalid JSON arguments; keep the raw text rather
    // than lose the call — the tool's own schema validation surfaces the problem.
    return raw;
  }
}

/** Read a numeric token count off an (unknown) usage block; undefined when absent. */
function tokenCount(usage: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = usage?.[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Normalize a provider usage block to {@link AgentUsage}, given each provider's
 * input/output field names. `totalTokens` is taken from `totalKey` when present,
 * else summed from input+output so the loop can always meter a turn.
 */
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
