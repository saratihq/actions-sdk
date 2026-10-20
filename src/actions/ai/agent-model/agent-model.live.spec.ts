import { createDirectAuth } from '../../../core/auth-factories';
import { HttpClient } from '../../../core/http/client';
import type { JsonValue } from '../../../core/http/types';
import { liveDescribe } from '../../../testing/live';
import { asRecord } from '../generate-text';
import { agentModelAdapters, agentModelAuth } from './index';
import type {
  AgentConversationMessage,
  AgentModelRequest,
  AgentModelResult,
  AgentToolSchema,
  AgentTurnReplay,
} from './types';

// LIVE behind ORCHESTR_LIVE=1; each provider self-skips unless GEMINI_API_KEY / ANTHROPIC_API_KEY is set.

type Echoing = 'gemini' | 'claude';
type Expectation = (status: number) => void;

interface Patch {
  headers?: Record<string, string>;
  body?: Record<string, JsonValue>;
}

interface Outcome {
  status: number;
  type: string;
  turn?: AgentModelResult;
}

interface Suite {
  label: string;
  provider: Echoing;
  model: string;
  key: string | undefined;
  patch: Patch;
  withoutReasoning: Expectation;
  asV022: Expectation;
}

const CALL_TIMEOUT = 120_000;
const ROUND_ONE_ATTEMPTS = 4;

const WEATHER: AgentToolSchema = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

const PROMPT =
  'I am choosing between Paris and Tokyo for an outdoor lunch today. Call get_weather once for each city, ' +
  'then weigh the two forecasts and recommend one.';

// Opts an older account into the preserved-thinking prefix check that accounts created from 2026-08-31 get by default.
const PREFIX_CHECK: Patch = {
  headers: { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' },
  body: { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } } },
};

const REASONING_BLOCKS = new Set(['thinking', 'redacted_thinking']);

const rejected: Expectation = (status) => expect(status).toBe(400);
const recorded: Expectation = (status) => expect(status).toBeGreaterThan(0);

function errorType(data: unknown): string {
  const error = asRecord(asRecord(data)?.error);
  const type = error?.type ?? error?.status;
  return typeof type === 'string' ? type : 'unknown';
}

const report = (label: string, outcome: Outcome): void =>
  console.log(`live: ${label} → ${outcome.status} ${outcome.type}`);

function withoutSignature(part: Record<string, JsonValue>): Record<string, JsonValue> {
  const rest = { ...part };
  delete rest.thoughtSignature;
  return rest;
}

function stripReasoning(replay: AgentTurnReplay): AgentTurnReplay {
  const content = replay.content as Record<string, JsonValue>[];
  return {
    provider: replay.provider,
    content:
      replay.provider === 'gemini'
        ? content.map(withoutSignature)
        : content.filter((block) => typeof block.type !== 'string' || !REASONING_BLOCKS.has(block.type)),
  };
}

function answered(
  messages: AgentConversationMessage[],
  turn: AgentModelResult,
  replay: AgentTurnReplay | undefined,
): AgentConversationMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: turn.text ?? '', toolCalls: turn.toolCalls, ...(replay ? { replay } : {}) },
    ...turn.toolCalls.map((call, index) => ({
      role: 'tool' as const,
      toolCallId: call.id,
      content: JSON.stringify({ tempC: 18 + index, sky: 'clear' }),
    })),
  ];
}

function liveSuite(suite: Suite): void {
  (suite.key ? describe : describe.skip)(suite.label, () => {
    const http = new HttpClient({ defaultTimeoutMs: CALL_TIMEOUT - 10_000 });
    const auth = createDirectAuth(agentModelAuth[suite.provider], { type: 'apiKey', value: suite.key ?? '' });
    const opening: AgentConversationMessage[] = [{ role: 'user', content: PROMPT }];
    let turn: AgentModelResult;
    let replay: AgentTurnReplay;

    async function send(
      messages: AgentConversationMessage[],
      options: Pick<AgentModelRequest, 'tools' | 'toolChoice'> = { tools: [WEATHER] },
    ): Promise<Outcome> {
      const req: AgentModelRequest = {
        provider: suite.provider,
        model: suite.model,
        system: '',
        messages,
        ...options,
      };
      const adapter = agentModelAdapters[suite.provider];
      const res = await http.post<unknown>(adapter.buildUrl(req), {
        auth,
        headers: { ...adapter.extraHeaders, ...suite.patch.headers },
        body: { ...(adapter.buildBody(req) as Record<string, JsonValue>), ...suite.patch.body },
        throwOnError: false,
      });
      if (res.status !== 200) return { status: res.status, type: errorType(res.data) };
      return { status: res.status, type: 'ok', turn: adapter.parseResponse(res.data) };
    }

    beforeAll(async () => {
      for (let attempt = 1; attempt <= ROUND_ONE_ATTEMPTS; attempt += 1) {
        const outcome = await send(opening);
        report(`${suite.label} round 1, attempt ${attempt}`, outcome);
        if (outcome.status !== 200) break;
        if (outcome.turn?.replay && outcome.turn.toolCalls.length > 0) {
          turn = outcome.turn;
          replay = outcome.turn.replay;
          return;
        }
      }
      throw new Error(`${suite.label}: round 1 never returned a tool turn carrying reasoning state`);
    }, CALL_TIMEOUT * ROUND_ONE_ATTEMPTS);

    it(
      'round 2, echoing the turn exactly as returned, succeeds',
      async () => {
        const outcome = await send(answered(opening, turn, replay));
        report(`${suite.label} round 2, turn echoed`, outcome);
        expect(outcome.status).toBe(200);
      },
      CALL_TIMEOUT,
    );

    it(
      'negative control: round 2 with the echoed turn differing only by its missing reasoning state',
      async () => {
        const outcome = await send(answered(opening, turn, stripReasoning(replay)));
        report(`${suite.label} round 2, echoed turn without its reasoning state`, outcome);
        suite.withoutReasoning(outcome.status);
      },
      CALL_TIMEOUT,
    );

    it(
      'round 2 as v0.2.2 sends it: the turn rebuilt from its text and calls',
      async () => {
        const outcome = await send(answered(opening, turn, undefined));
        report(`${suite.label} round 2, turn rebuilt as v0.2.2 does`, outcome);
        suite.asV022(outcome.status);
      },
      CALL_TIMEOUT,
    );

    it(
      'records a close-out that drops the tools after the echoed turn',
      async () => {
        const outcome = await send(answered(opening, turn, replay), { tools: [] });
        report(`${suite.label} close-out, no tools`, outcome);
        recorded(outcome.status);
      },
      CALL_TIMEOUT,
    );

    it(
      'a close-out that keeps the tools and sets tool choice none answers without calling one',
      async () => {
        const outcome = await send(answered(opening, turn, replay), { tools: [WEATHER], toolChoice: 'none' });
        report(`${suite.label} close-out, tools kept, tool choice none`, outcome);
        expect(outcome.status).toBe(200);
        expect(outcome.turn?.toolCalls).toEqual([]);
      },
      CALL_TIMEOUT,
    );
  });
}

liveDescribe('agent model — live: reasoning state survives the tool round', () => {
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const suites: Suite[] = [
    {
      label: 'gemini gemini-3.6-flash',
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      key: geminiKey,
      patch: {},
      withoutReasoning: rejected,
      asV022: rejected,
    },
    ...['claude-sonnet-5', 'claude-sonnet-5-5'].map((model) => ({
      label: `claude ${model}`,
      provider: 'claude' as const,
      model,
      key: anthropicKey,
      patch: {},
      withoutReasoning: recorded,
      asV022: recorded,
    })),
    {
      label: 'claude claude-sonnet-5-5, prefix check on',
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      key: anthropicKey,
      patch: PREFIX_CHECK,
      withoutReasoning: recorded,
      asV022: recorded,
    },
  ];
  suites.forEach(liveSuite);
});
