/**
 * The tool-aware model-call contract.
 *
 * These shapes let an agent loop hand its running conversation buffer to
 * {@link callAgentModel} and read back a normalized `{ text | toolCalls[] } +
 * usage` turn with zero adapter glue. The SDK owns the per-provider wire format;
 * the loop owns the durability. Nothing here reads a credential — the call rides
 * the opaque {@link AuthHandle} transport, same as every other action.
 */

/** The provider families the agent's model call supports. */
export type AgentProvider = 'openai' | 'claude' | 'gemini' | 'mistral';

/** A permissive JSON-schema shape — one bound tool's `parameters`. */
export type JsonSchema = Record<string, unknown>;

/** A tool invocation the model requested — normalized across providers. */
export interface AgentToolCall {
  /**
   * Call id that threads the result back to this call in the next turn. Real for
   * OpenAI/Anthropic/Mistral; synthesized for Gemini (which matches by name).
   */
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

/**
 * One message in the running conversation buffer. `system` is NOT a buffer
 * message — it is passed alongside (the request's `system` field). The buffer
 * holds only `user` / `assistant` / `tool` turns.
 */
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

/**
 * One normalized model turn: prose text and/or the tools it wants called. An
 * empty `toolCalls` is the natural final answer (the loop returns `text`).
 */
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
  /** Upper bound on generated tokens. Anthropic requires it, so it defaults to an agent-sized 4096 there. */
  maxTokens?: number;
}

/**
 * One provider's wire adapter: build the URL + body, and parse the response into
 * the normalized {@link AgentModelResult}. Auth is intentionally absent — the
 * transport pulled from the {@link AuthHandle} injects the credential, so an
 * adapter is a pure request/response shaping function, unit-testable offline.
 */
export interface AgentModelAdapter {
  buildUrl(req: AgentModelRequest): string;
  /** Non-secret headers this provider requires (e.g. `anthropic-version`). */
  extraHeaders?: Record<string, string>;
  buildBody(req: AgentModelRequest): import('../../../core/http/types').JsonValue;
  parseResponse(data: unknown): AgentModelResult;
}
