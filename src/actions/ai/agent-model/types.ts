/** The tool-aware model-call contract: conversation buffer in, normalized turn + usage out. */

/** The provider families the agent's model call supports. */
export type AgentProvider = 'openai' | 'claude' | 'gemini' | 'mistral';

/** A permissive JSON-schema shape — one bound tool's `parameters`. */
export type JsonSchema = Record<string, unknown>;

/** A tool invocation the model requested — normalized across providers. */
export interface AgentToolCall {
  /** Call id threading the result back next turn; synthesized for Gemini (which matches by name). */
  id: string;
  /** The tool name the model chose — resolved against the agent's bound tools. */
  name: string;
  /** The arguments the model produced (already JSON-parsed; never a raw string). */
  input: unknown;
}

/** One bound tool as the model call receives it (name + description + JSON-schema params). */
export interface AgentToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** One buffer message; `system` is not a buffer message — it rides the request's own `system` field. */
export interface AgentConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  /** Free-form text: the user prompt, the model's prose, or a tool result rendered for the model. */
  content: string;
  /** Present on an `assistant` turn that requested tools — the calls it made (echoed back for context). */
  toolCalls?: AgentToolCall[];
  /** Present on a `tool` turn — which {@link AgentToolCall.id} this result answers. */
  toolCallId?: string;
}

/** Aggregate token usage, normalized across providers' differing field names. */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** One normalized model turn; an empty `toolCalls` is the final answer. */
export interface AgentModelResult {
  text?: string;
  toolCalls: AgentToolCall[];
  usage?: AgentUsage;
}

/** What the loop hands the model call each round (system + running buffer + the bound tools' schemas). */
export interface AgentModelRequest {
  provider: AgentProvider;
  model: string;
  /** The system prompt; empty string when none — omitted from the wire body. */
  system: string;
  messages: AgentConversationMessage[];
  tools: AgentToolSchema[];
  temperature?: number;
  /** Upper bound on generated tokens; Anthropic requires it and defaults to 4096. */
  maxTokens?: number;
}

/** One provider's wire adapter: build URL + body, parse into {@link AgentModelResult}; auth-free by design. */
export interface AgentModelAdapter {
  buildUrl(req: AgentModelRequest): string;
  /** Non-secret headers this provider requires (e.g. `anthropic-version`). */
  extraHeaders?: Record<string, string>;
  buildBody(req: AgentModelRequest): import('../../../core/http/types').JsonValue;
  parseResponse(data: unknown): AgentModelResult;
}
