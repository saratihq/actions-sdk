import type { JsonValue } from '../../../core/http/types';
import { asArray, asRecord } from '../generate-text';
import { normalizeUsage, throwNoTurn } from './shared';
import type {
  AgentConversationMessage,
  AgentModelAdapter,
  AgentModelRequest,
  AgentModelResult,
  AgentToolCall,
} from './types';

/**
 * Anthropic Messages API tool use. Tools carry an `input_schema`; the model's
 * calls come back as `tool_use` content blocks (`stop_reason: "tool_use"`), and
 * results go back as `tool_result` blocks INSIDE a user turn — so consecutive
 * `tool` messages are merged into a single user turn (the shape Anthropic expects
 * after a parallel-call assistant turn). Verified against the public tool-use
 * reference (platform.claude.com/docs …/build-with-claude/tool-use).
 */

/** One assistant turn → a text block (if any) followed by its `tool_use` blocks. */
function assistantBlocks(message: AgentConversationMessage): JsonValue {
  const blocks: JsonValue[] = [];
  if (message.content) blocks.push({ type: 'text', text: message.content });
  for (const call of message.toolCalls ?? []) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input as JsonValue });
  }
  // An assistant turn always has content; if it was pure prose keep the string form.
  return blocks.length > 0 ? blocks : message.content;
}

/** Serialize the buffer to Anthropic messages, merging runs of tool results into one user turn. */
function anthropicMessages(messages: readonly AgentConversationMessage[]): JsonValue {
  const out: JsonValue[] = [];
  let pendingResults: JsonValue[] = [];
  const flush = (): void => {
    if (pendingResults.length > 0) {
      out.push({ role: 'user', content: pendingResults });
      pendingResults = [];
    }
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      pendingResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      });
      continue;
    }
    flush();
    if (message.role === 'user') out.push({ role: 'user', content: message.content });
    else out.push({ role: 'assistant', content: assistantBlocks(message) });
  }
  flush();
  return out;
}

function buildBody(req: AgentModelRequest): JsonValue {
  return {
    model: req.model,
    // Anthropic requires max_tokens. An agent turn can emit large tool-call
    // arguments or a long final answer, and a truncated tool_use block is
    // malformed JSON that corrupts the loop — so the default is agent-sized
    // (4096), not the 1024 that a single completion could get away with.
    // The caller can still raise/lower it via req.maxTokens.
    max_tokens: req.maxTokens ?? 4096,
    ...(req.system ? { system: req.system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    // Anthropic tolerates an empty `tools` array, but omit it when zero for
    // consistency with the other adapters (a tools-less "just reason" agent; §2).
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters as JsonValue,
          })),
        }
      : {}),
    messages: anthropicMessages(req.messages),
  };
}

function parseResponse(data: unknown): AgentModelResult {
  const content = asArray(asRecord(data)?.content);
  if (!content) throwNoTurn('claude');
  const textParts: string[] = [];
  const toolCalls: AgentToolCall[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block?.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
    else if (block?.type === 'tool_use' && typeof block.name === 'string') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : block.name,
        name: block.name,
        input: block.input ?? {},
      });
    }
  }
  const text = textParts.join('');
  const usage = normalizeUsage(data, 'usage', 'input_tokens', 'output_tokens', 'total_tokens');
  return { ...(text ? { text } : {}), toolCalls, ...(usage ? { usage } : {}) };
}

/** The Anthropic tool-aware adapter. */
export const anthropicAgentAdapter: AgentModelAdapter = {
  buildUrl: () => 'https://api.anthropic.com/v1/messages',
  extraHeaders: { 'anthropic-version': '2023-06-01' },
  buildBody,
  parseResponse,
};
