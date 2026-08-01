/** The LLM `generate_text` family — one `<slug>.generate_text` action per provider. */
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

/** Tool-aware model call for the AI Agent node — engine primitive, deliberately NOT a catalog action. */
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
