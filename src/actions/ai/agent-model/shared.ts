import { ActionError } from '../../../core/errors';
import { asRecord } from '../generate-text';
import type { AgentConversationMessage, AgentUsage } from './types';

/** Cross-provider serialization helpers shared by the four adapters. */

/** Raised when a provider response lacks the expected message/candidate. */
export function throwNoTurn(label: string): never {
  throw new ActionError({
    code: 'provider_error',
    message: `${label}: response did not contain a model turn`,
    retryable: false,
  });
}

/** Map prior tool-call id → tool name; Gemini threads tool results by NAME and resolves through here. */
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
