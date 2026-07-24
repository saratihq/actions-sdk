import type { JsonValue } from '../../../core/http/types';
import { asArray, asRecord } from '../generate-text';
import { normalizeUsage, parseToolArguments, throwNoTurn, toolNamesById } from './shared';
import type {
  AgentConversationMessage,
  AgentModelAdapter,
  AgentModelRequest,
  AgentModelResult,
  AgentToolCall,
} from './types';

/**
 * The OpenAI / Mistral `/chat/completions` tool-calling shape (both APIs are
 * byte-identical here). Tools are `{ type:"function", function:{…} }`; the model's
 * calls come back as `message.tool_calls` with a JSON-STRING `arguments`; results
 * go back as standalone `{ role:"tool", tool_call_id, content }` messages. Verified
 * against the OpenAI function-calling guide and Mistral's function-calling docs.
 */

/** Serialize the buffer to chat-completions messages (system prepended). */
function chatMessages(req: AgentModelRequest): JsonValue {
  const names = toolNamesById(req.messages);
  const out: JsonValue[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });
  for (const message of req.messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
    } else if (message.role === 'tool') {
      const id = message.toolCallId ?? '';
      out.push({
        role: 'tool',
        tool_call_id: id,
        // Mistral requires the function name on the result; OpenAI tolerates it.
        name: names.get(id) ?? id,
        content: message.content,
      });
    } else {
      out.push(assistantMessage(message));
    }
  }
  return out;
}

/** An assistant turn → prose (or null) plus any `tool_calls` with JSON-string arguments. */
function assistantMessage(message: AgentConversationMessage): JsonValue {
  const toolCalls = message.toolCalls ?? [];
  return {
    role: 'assistant',
    // `content` must be present; null when the turn was purely tool calls.
    content: message.content ? message.content : null,
    ...(toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
          })),
        }
      : {}),
  };
}

function buildBody(req: AgentModelRequest): JsonValue {
  return {
    model: req.model,
    messages: chatMessages(req),
    // A zero-tool request omits `tools` entirely — OpenAI/Mistral 400 on an empty
    // `tools` array (a tools-less "just reason" agent is valid; §2).
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters as JsonValue,
            },
          })),
        }
      : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
  };
}

function parseResponse(data: unknown): AgentModelResult {
  const message = asRecord(asRecord(asArray(asRecord(data)?.choices)?.[0])?.message);
  if (!message) throwNoTurn('openai-chat');
  const toolCalls: AgentToolCall[] = [];
  for (const raw of asArray(message.tool_calls) ?? []) {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (fn && typeof fn.name === 'string') {
      toolCalls.push({
        id: typeof call?.id === 'string' ? call.id : fn.name,
        name: fn.name,
        input: parseToolArguments(fn.arguments),
      });
    }
  }
  const text = typeof message.content === 'string' ? message.content : '';
  const usage = normalizeUsage(data, 'usage', 'prompt_tokens', 'completion_tokens', 'total_tokens');
  return { ...(text ? { text } : {}), toolCalls, ...(usage ? { usage } : {}) };
}

/** Build a chat-completions adapter for a given endpoint (OpenAI vs Mistral differ only in URL). */
function chatCompletionsAdapter(url: string): AgentModelAdapter {
  return { buildUrl: () => url, buildBody, parseResponse };
}

/** OpenAI Chat Completions tool-aware adapter. */
export const openaiAgentAdapter = chatCompletionsAdapter('https://api.openai.com/v1/chat/completions');

/** Mistral Chat Completions tool-aware adapter (same wire shape as OpenAI). */
export const mistralAgentAdapter = chatCompletionsAdapter('https://api.mistral.ai/v1/chat/completions');
