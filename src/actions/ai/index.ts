/**
 * The LLM `generate_text` family — one action per provider, all built from the
 * shared {@link makeGenerateText} factory. Each `type` is `<slug>.generate_text`
 * where the slug (openai | claude | gemini | mistral) also drives the brand icon.
 */
export {
  type GenerateInput,
  type GenerateTextOutput,
  makeGenerateText,
  type ProviderConfig,
} from './generate-text';
export { openaiGenerateText } from './openai';
export { claudeGenerateText } from './claude';
export { geminiGenerateText } from './gemini';
export { mistralGenerateText } from './mistral';

import { claudeGenerateText } from './claude';
import { geminiGenerateText } from './gemini';
import { mistralGenerateText } from './mistral';
import { openaiGenerateText } from './openai';

/** Every AI action, flattened for catalog registration. */
export const aiActions = [openaiGenerateText, claudeGenerateText, geminiGenerateText, mistralGenerateText];

/**
 * The tool-aware model call for the AI Agent node. A loop-internal engine
 * primitive driven by the host agent loop — deliberately NOT in {@link aiActions}
 * (it is never a catalog action).
 */
export {
  type AgentConversationMessage,
  type AgentModelAdapter,
  agentModelAdapters,
  type AgentModelRequest,
  type AgentModelResult,
  type AgentProvider,
  type AgentToolCall,
  type AgentToolSchema,
  type AgentUsage,
  anthropicAgentAdapter,
  callAgentModel,
  geminiAgentAdapter,
  type JsonSchema,
  mistralAgentAdapter,
  openaiAgentAdapter,
} from './agent-model';
