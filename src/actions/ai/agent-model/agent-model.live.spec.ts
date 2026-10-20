import { createDirectAuth } from '../../../core/auth-factories';
import { HttpClient } from '../../../core/http/client';
import type { JsonValue } from '../../../core/http/types';
import { liveDescribe } from '../../../testing/live';
import { asRecord } from '../generate-text';
import { agentModelAdapters, agentModelAuth } from './index';
import type { AgentConversationMessage, AgentModelRequest, AgentModelResult, AgentToolSchema } from './types';

// LIVE behind ORCHESTR_LIVE=1; each provider self-skips unless GEMINI_API_KEY / ANTHROPIC_API_KEY is set.

type Echoing = 'gemini' | 'claude';

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
  expectWithout: (status: number) => void;
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

const NONE_CHOICE: Record<Echoing, Patch> = {
  gemini: { body: { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } },
  claude: { body: { tool_choice: { type: 'none' } } },
};

// Opts an older account into the preserved-thinking prefix check that accounts created from 2026-08-31 get by default.
const PREFIX_CHECK: Patch = {
  headers: { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' },
  body: { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } } },
};

const rejected = (status: number): void => expect(status).toBe(400);
const recorded = (status: number): void => expect(status).toBeGreaterThan(0);

function errorType(data: unknown): string {
  const error = asRecord(asRecord(data)?.error);
  const type = error?.type ?? error?.status;
  return typeof type === 'string' ? type : 'unknown';
}

const report = (label: string, outcome: Outcome): void =>
  console.log(`live: ${label} → ${outcome.status} ${outcome.type}`);

function answered(
  messages: AgentConversationMessage[],
  turn: AgentModelResult,
  withReplay: boolean,
): AgentConversationMessage[] {
  return [
    ...messages,
    {
      role: 'assistant',
      content: turn.text ?? '',
      toolCalls: turn.toolCalls,
      ...(withReplay && turn.replay ? { replay: turn.replay } : {}),
    },
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

    async function send(
      messages: AgentConversationMessage[],
      tools: AgentToolSchema[] = [WEATHER],
      patch: Patch = {},
    ): Promise<Outcome> {
      const req: AgentModelRequest = {
        provider: suite.provider,
        model: suite.model,
        system: '',
        messages,
        tools,
      };
      const adapter = agentModelAdapters[suite.provider];
      const res = await http.post<unknown>(adapter.buildUrl(req), {
        auth,
        headers: { ...adapter.extraHeaders, ...suite.patch.headers, ...patch.headers },
        body: {
          ...(adapter.buildBody(req) as Record<string, JsonValue>),
          ...suite.patch.body,
          ...patch.body,
        },
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
          return;
        }
      }
      throw new Error(`${suite.label}: round 1 never returned a tool turn carrying reasoning state`);
    }, CALL_TIMEOUT * ROUND_ONE_ATTEMPTS);

    it(
      'round 2, echoing the turn exactly as returned, succeeds',
      async () => {
        const outcome = await send(answered(opening, turn, true));
        report(`${suite.label} round 2, turn echoed`, outcome);
        expect(outcome.status).toBe(200);
      },
      CALL_TIMEOUT,
    );

    it(
      'negative control: round 2 with the turn rebuilt without its reasoning state',
      async () => {
        const outcome = await send(answered(opening, turn, false));
        report(`${suite.label} round 2, turn rebuilt without reasoning state`, outcome);
        suite.expectWithout(outcome.status);
      },
      CALL_TIMEOUT,
    );

    it(
      'records the max-steps close-out the engine sends today: the echoed history with no tools',
      async () => {
        const outcome = await send(answered(opening, turn, true), []);
        report(`${suite.label} close-out, no tools`, outcome);
        recorded(outcome.status);
      },
      CALL_TIMEOUT,
    );

    it(
      'records a close-out that keeps the tools and forbids calling them',
      async () => {
        const outcome = await send(answered(opening, turn, true), [WEATHER], NONE_CHOICE[suite.provider]);
        report(`${suite.label} close-out, tools kept, tool choice none`, outcome);
        recorded(outcome.status);
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
      expectWithout: rejected,
    },
    ...['claude-sonnet-5', 'claude-sonnet-5-5'].map((model) => ({
      label: `claude ${model}`,
      provider: 'claude' as const,
      model,
      key: anthropicKey,
      patch: {},
      expectWithout: recorded,
    })),
    {
      label: 'claude claude-sonnet-5-5, prefix check on',
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      key: anthropicKey,
      patch: PREFIX_CHECK,
      expectWithout: recorded,
    },
  ];
  suites.forEach(liveSuite);
});
