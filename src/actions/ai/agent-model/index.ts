import type { AuthHandle } from '../../../core/auth';
import { ActionError } from '../../../core/errors';
import type { HttpClient } from '../../../core/http/client';
import { anthropicAgentAdapter } from './anthropic';
import { mistralAgentAdapter, openaiAgentAdapter } from './chat-completions';
import { geminiAgentAdapter } from './gemini';
import type { AgentModelAdapter, AgentModelRequest, AgentModelResult, AgentProvider } from './types';

/** The tool-aware model call the agent loop drives — an engine primitive, never a catalog action. */

const ADAPTERS: Record<AgentProvider, AgentModelAdapter> = {
  claude: anthropicAgentAdapter,
  openai: openaiAgentAdapter,
  mistral: mistralAgentAdapter,
  gemini: geminiAgentAdapter,
};

/** Generate one agent turn against `req.provider`; throws `invalid_input` for an unknown provider. */
export async function callAgentModel(
  req: AgentModelRequest,
  auth: AuthHandle,
  http: HttpClient,
): Promise<AgentModelResult> {
  const adapter = ADAPTERS[req.provider];
  if (!adapter) {
    throw new ActionError({
      code: 'invalid_input',
      message: `unsupported agent model provider: ${String(req.provider)}`,
      retryable: false,
    });
  }
  const res = await http.post<unknown>(adapter.buildUrl(req), {
    auth,
    ...(adapter.extraHeaders ? { headers: adapter.extraHeaders } : {}),
    body: adapter.buildBody(req),
  });
  return adapter.parseResponse(res.data);
}

/** The four provider adapters, exposed for targeted testing / advanced binding. */
export const agentModelAdapters = ADAPTERS;

export { anthropicAgentAdapter, openaiAgentAdapter, mistralAgentAdapter, geminiAgentAdapter };
export type {
  AgentConversationMessage,
  AgentModelAdapter,
  AgentModelRequest,
  AgentModelResult,
  AgentProvider,
  AgentToolCall,
  AgentToolSchema,
  AgentUsage,
  JsonSchema,
} from './types';
