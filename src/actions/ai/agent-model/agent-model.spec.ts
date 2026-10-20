import { HttpClient } from '../../../core/http/client';
import type { NormalizedRequest } from '../../../core/http/types';
import { FakeTransport, stubAuth } from '../../../testing/fakes';
import { callAgentModel } from './index';
import { uniqueToolCalls } from './shared';
import type { AgentConversationMessage, AgentModelRequest, AgentToolCall } from './types';

/** Golden offline tests for the tool-aware agent model call, replaying captured provider responses. */

function run(response: unknown) {
  const transport = new FakeTransport(() => ({ status: 200, headers: {}, data: response }));
  return {
    transport,
    invoke: (req: AgentModelRequest) => callAgentModel(req, stubAuth(transport, 'apiKey'), new HttpClient()),
  };
}

/** A multi-turn buffer: user → assistant-with-tool-call → tool-result, one bound tool. */
function multiTurn(provider: AgentModelRequest['provider'], model: string): AgentModelRequest {
  return {
    provider,
    model,
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: 'Weather in SF?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'get_weather', input: { location: 'SF' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: '15 C' },
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a given location.',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    ],
    maxTokens: 1024,
  };
}

function body(req: NormalizedRequest): Record<string, unknown> {
  return req.body as Record<string, unknown>;
}

// ─── Anthropic (tool_use blocks + tool_result) ───

describe('callAgentModel — claude (Anthropic Messages tool use)', () => {
  it('parses a tool_use response to toolCalls[] with usage', async () => {
    // Captured from platform.claude.com …/build-with-claude/tool-use.
    const { invoke } = run({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        {
          type: 'tool_use',
          id: 'toolu_01A09q90qw90lq917835lq9',
          name: 'get_weather',
          input: { location: 'San Francisco, CA' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 472, output_tokens: 91 },
    });
    const out = await invoke(multiTurn('claude', 'claude-opus-4-8'));
    expect(out.text).toBe('Let me check.');
    expect(out.toolCalls).toEqual([
      { id: 'toolu_01A09q90qw90lq917835lq9', name: 'get_weather', input: { location: 'San Francisco, CA' } },
    ]);
    expect(out.usage).toEqual({ inputTokens: 472, outputTokens: 91, totalTokens: 563 });
  });

  it('parses a text-only response to { text } with no tool calls', async () => {
    const { invoke } = run({
      content: [{ type: 'text', text: 'It is 15 degrees and partly cloudy.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 510, output_tokens: 28 },
    });
    const out = await invoke(multiTurn('claude', 'claude-opus-4-8'));
    expect(out.text).toBe('It is 15 degrees and partly cloudy.');
    expect(out.toolCalls).toEqual([]);
  });

  it('serializes tools (input_schema) + the prior tool-result as a user tool_result turn', async () => {
    const { invoke, transport } = run({ content: [{ type: 'text', text: 'ok' }] });
    await invoke(multiTurn('claude', 'claude-opus-4-8'));
    const req = transport.requests[0]!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    const b = body(req);
    expect(b.max_tokens).toBe(1024);
    expect(b.system).toBe('You are helpful.');
    expect(b.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get the current weather for a given location.',
        input_schema: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    ]);
    expect(b.messages).toEqual([
      { role: 'user', content: 'Weather in SF?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'SF' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '15 C' }] },
    ]);
  });

  it('defaults max_tokens to an agent-sized 4096 when the request omits it', async () => {
    const { invoke, transport } = run({ content: [{ type: 'text', text: 'ok' }] });
    const req: AgentModelRequest = { ...multiTurn('claude', 'claude-opus-4-8') };
    delete req.maxTokens;
    await invoke(req);
    expect(body(transport.requests[0]!).max_tokens).toBe(4096);
  });
});

// ─── OpenAI (tools + tool_calls) ───

describe('callAgentModel — openai (Chat Completions tool calling)', () => {
  it('parses a tool_calls response (JSON-string arguments) to toolCalls[] with usage', async () => {
    // Captured from the OpenAI function-calling guide.
    const { invoke } = run({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_12345xyz',
                type: 'function',
                function: { name: 'get_horoscope', arguments: '{"sign":"Aquarius"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
    });
    const out = await invoke(multiTurn('openai', 'gpt-4o'));
    expect(out.toolCalls).toEqual([
      { id: 'call_12345xyz', name: 'get_horoscope', input: { sign: 'Aquarius' } },
    ]);
    expect(out.text).toBeUndefined();
    expect(out.usage).toEqual({ inputTokens: 150, outputTokens: 50, totalTokens: 200 });
  });

  it('parses a text response to { text }', async () => {
    const { invoke } = run({
      choices: [
        {
          message: { role: 'assistant', content: 'Next Tuesday you befriend an otter.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
    });
    const out = await invoke(multiTurn('openai', 'gpt-4o'));
    expect(out.text).toBe('Next Tuesday you befriend an otter.');
    expect(out.toolCalls).toEqual([]);
  });

  it('serializes tools + the assistant tool_calls turn + the role:tool result', async () => {
    const { invoke, transport } = run({ choices: [{ message: { content: 'ok' } }] });
    await invoke(multiTurn('openai', 'gpt-4o'));
    const req = transport.requests[0]!;
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    const b = body(req);
    expect(b.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a given location.',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      },
    ]);
    expect(b.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Weather in SF?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"SF"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '15 C' },
    ]);
    expect(b.max_tokens).toBe(1024);
  });
});

// ─── Mistral (tools + tool_calls, OpenAI-shaped) ───

describe('callAgentModel — mistral (Chat Completions tool calling)', () => {
  it('parses a tool_calls response to toolCalls[] with usage', async () => {
    // Captured from the Mistral function-calling docs.
    const { invoke } = run({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'D681PevKs',
                type: 'function',
                function: { name: 'retrieve_payment_status', arguments: '{"transaction_id": "T1001"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 94, completion_tokens: 30, total_tokens: 124 },
    });
    const out = await invoke(multiTurn('mistral', 'mistral-large-latest'));
    expect(out.toolCalls).toEqual([
      { id: 'D681PevKs', name: 'retrieve_payment_status', input: { transaction_id: 'T1001' } },
    ]);
    expect(out.usage).toEqual({ inputTokens: 94, outputTokens: 30, totalTokens: 124 });
  });

  it('POSTs the OpenAI-shaped body to the Mistral endpoint', async () => {
    const { invoke, transport } = run({ choices: [{ message: { content: 'ok' } }] });
    await invoke(multiTurn('mistral', 'mistral-large-latest'));
    const req = transport.requests[0]!;
    expect(req.url).toBe('https://api.mistral.ai/v1/chat/completions');
    const b = body(req);
    // Same tool + tool-result shape as OpenAI — the result carries the function name.
    expect(b.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Weather in SF?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"SF"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '15 C' },
    ]);
  });
});

// ─── Gemini (functionDeclarations + functionCall) ───

describe('callAgentModel — gemini (generateContent function calling)', () => {
  it('parses a functionCall response to toolCalls[] (synthesized id) with usage', async () => {
    // Captured from the generateContent function-calling reference.
    const { invoke } = run({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'get_weather', args: { location: 'Boston' } } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 45, totalTokenCount: 195 },
    });
    const out = await invoke(multiTurn('gemini', 'gemini-2.0-flash'));
    expect(out.toolCalls).toEqual([
      { id: 'get_weather_0', name: 'get_weather', input: { location: 'Boston' } },
    ]);
    expect(out.usage).toEqual({ inputTokens: 150, outputTokens: 45, totalTokens: 195 });
  });

  it('parses a text response to { text }', async () => {
    const { invoke } = run({
      candidates: [{ content: { role: 'model', parts: [{ text: 'The weather in Boston is sunny.' }] } }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, totalTokenCount: 40 },
    });
    const out = await invoke(multiTurn('gemini', 'gemini-2.0-flash'));
    expect(out.text).toBe('The weather in Boston is sunny.');
    expect(out.toolCalls).toEqual([]);
  });

  it('serializes functionDeclarations + the functionCall/functionResponse turns (synthesized id → threaded by name, no id)', async () => {
    const { invoke, transport } = run({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });
    // Synthesized `name_index` call id — Gemini sent none, so no `id` rides the wire.
    const req: AgentModelRequest = {
      ...multiTurn('gemini', 'gemini-2.0-flash'),
      messages: [
        { role: 'user', content: 'Weather in SF?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'get_weather_0', name: 'get_weather', input: { location: 'SF' } }],
        },
        { role: 'tool', toolCallId: 'get_weather_0', content: '15 C' },
      ],
    };
    await invoke(req);
    const request = transport.requests[0]!;
    expect(request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    );
    const b = body(request);
    expect(b.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get the current weather for a given location.',
            parameters: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        ],
      },
    ]);
    expect(b.systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
    expect(b.generationConfig).toEqual({ maxOutputTokens: 1024 });
    expect(b.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather in SF?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { location: 'SF' } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { result: '15 C' } } }],
      },
    ]);
  });

  it('preserves a real functionCall id and threads it back on both echoed call + result', async () => {
    // Two concurrent calls to the SAME function — only Gemini's own id can map each result to its call.
    const { invoke } = run({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { functionCall: { id: 'fc_sf', name: 'get_weather', args: { location: 'SF' } } },
              { functionCall: { id: 'fc_nyc', name: 'get_weather', args: { location: 'NYC' } } },
            ],
          },
        },
      ],
    });
    const parseOut = await invoke(multiTurn('gemini', 'gemini-2.0-flash'));
    expect(parseOut.toolCalls).toEqual([
      { id: 'fc_sf', name: 'get_weather', input: { location: 'SF' } },
      { id: 'fc_nyc', name: 'get_weather', input: { location: 'NYC' } },
    ]);

    // Thread both results back: the id must ride the functionCall AND the functionResponse.
    const { invoke: invoke2, transport } = run({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    const req: AgentModelRequest = {
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: 'Weather in SF and NYC?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'fc_sf', name: 'get_weather', input: { location: 'SF' } },
            { id: 'fc_nyc', name: 'get_weather', input: { location: 'NYC' } },
          ],
        },
        { role: 'tool', toolCallId: 'fc_sf', content: '15 C' },
        { role: 'tool', toolCallId: 'fc_nyc', content: '9 C' },
      ],
      tools: multiTurn('gemini', 'gemini-2.0-flash').tools,
    };
    await invoke2(req);
    const b = body(transport.requests[0]!);
    expect(b.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather in SF and NYC?' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'fc_sf', name: 'get_weather', args: { location: 'SF' } } },
          { functionCall: { id: 'fc_nyc', name: 'get_weather', args: { location: 'NYC' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'fc_sf', name: 'get_weather', response: { result: '15 C' } } },
          { functionResponse: { id: 'fc_nyc', name: 'get_weather', response: { result: '9 C' } } },
        ],
      },
    ]);
  });

  it('strips JSON-Schema-only keys so any tool schema serializes to a valid Gemini Schema', async () => {
    // Gemini's Schema is an OpenAPI subset — `additionalProperties`/`$schema`/`$defs` 400 it.
    const { invoke, transport } = run({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    const req: AgentModelRequest = {
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Do it.' }],
      tools: [
        {
          name: 'call_workflow',
          description: 'Run a sub-workflow.',
          // The open/default tool schema (empty props + additionalProperties) → no-param function.
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: true,
            $schema: 'http://json-schema.org/draft-07/schema#',
          },
        },
        {
          name: 'search',
          description: 'Search.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              q: { type: 'string', description: 'query' },
              filters: {
                type: 'object',
                additionalProperties: true,
                properties: { tag: { type: 'string' } },
              },
              tags: {
                type: 'array',
                additionalItems: false,
                items: { type: 'string', additionalProperties: false },
              },
            },
            required: ['q'],
            $defs: { foo: { type: 'string' } },
          },
        },
      ],
      maxTokens: 1024,
    };
    await invoke(req);
    const b = body(transport.requests[0]!);
    expect(b.tools).toEqual([
      {
        functionDeclarations: [
          // Empty-properties object → emitted as a no-parameter function (no `parameters`).
          { name: 'call_workflow', description: 'Run a sub-workflow.' },
          {
            name: 'search',
            description: 'Search.',
            // additionalProperties/$defs/additionalItems stripped at every depth; structure kept.
            parameters: {
              type: 'object',
              properties: {
                q: { type: 'string', description: 'query' },
                filters: { type: 'object', properties: { tag: { type: 'string' } } },
                tags: { type: 'array', items: { type: 'string' } },
              },
              required: ['q'],
            },
          },
        ],
      },
    ]);
  });
});

// ─── tool-call ids are unique within a turn (the engine keys each tool step by `<round>:tool:<id>`) ───

interface WireCall {
  id?: string;
  location: string;
}

const withId = (call: WireCall): { id?: string } => (call.id === undefined ? {} : { id: call.id });

function claudeTurn(calls: WireCall[]): unknown {
  return {
    content: calls.map((call) => ({
      type: 'tool_use',
      ...withId(call),
      name: 'get_weather',
      input: { location: call.location },
    })),
  };
}

function chatTurn(calls: WireCall[]): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: calls.map((call) => ({
            ...withId(call),
            type: 'function',
            function: { name: 'get_weather', arguments: JSON.stringify({ location: call.location }) },
          })),
        },
      },
    ],
  };
}

function geminiTurn(calls: WireCall[]): unknown {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: calls.map((call) => ({
            functionCall: { ...withId(call), name: 'get_weather', args: { location: call.location } },
          })),
        },
      },
    ],
  };
}

async function roundTrip(
  provider: AgentModelRequest['provider'],
  model: string,
  turns: unknown[],
  ok: unknown,
): Promise<Record<string, unknown>> {
  const messages: AgentConversationMessage[] = [{ role: 'user', content: 'Weather in SF and NYC?' }];
  for (const turn of turns) {
    const { toolCalls } = await run(turn).invoke(multiTurn(provider, model));
    messages.push(
      { role: 'assistant', content: '', toolCalls },
      ...toolCalls.map((call) => ({
        role: 'tool' as const,
        toolCallId: call.id,
        content: `weather in ${(call.input as { location: string }).location}`,
      })),
    );
  }
  return sentBody(provider, model, messages, ok);
}

const ids = (calls: AgentToolCall[]): string[] => calls.map((call) => call.id);

// One turn as recorded before ids were unique: ids may repeat, no `providerId`, results in call order.
function legacyTurn(calls: AgentToolCall[]): AgentConversationMessage[] {
  return [
    { role: 'user', content: 'Weather in SF and NYC?' },
    { role: 'assistant', content: '', toolCalls: calls },
    ...calls.map((call, index) => ({
      role: 'tool' as const,
      toolCallId: call.id,
      content: `result ${index}`,
    })),
  ];
}

async function sentBody(
  provider: AgentModelRequest['provider'],
  model: string,
  messages: AgentConversationMessage[],
  ok: unknown,
): Promise<Record<string, unknown>> {
  const { invoke, transport } = run(ok);
  await invoke({ ...multiTurn(provider, model), messages });
  return body(transport.requests[0]!);
}

describe('uniqueToolCalls — every response of up to four calls over ids that collide with their own suffixes', () => {
  const alphabet = ['A', 'A_1', 'A_2', 'A_1_1', 'A_1_2'];
  const responses = (length: number): string[][] =>
    length === 0 ? [[]] : responses(length - 1).flatMap((head) => alphabet.map((id) => [...head, id]));

  it('keeps each first holder, and moves each repeat onto an id no call in the response was issued', () => {
    const broken = [1, 2, 3, 4].flatMap(responses).filter((issued) => {
      const calls = uniqueToolCalls(issued.map((id) => ({ id, issued: id, name: 'n', input: {} })));
      return (
        new Set(ids(calls)).size !== calls.length ||
        calls.some((call, index) => {
          const id = issued[index] ?? '';
          return issued.indexOf(id) === index
            ? call.id !== id || 'providerId' in call
            : issued.includes(call.id) || call.providerId !== id;
        })
      );
    });
    expect(broken).toEqual([]);
  });
});

describe('callAgentModel — claude tool-call ids are unique within a turn', () => {
  const claude = (calls: WireCall[]) => run(claudeTurn(calls)).invoke(multiTurn('claude', 'claude-opus-4-8'));

  it('suffixes a repeated tool_use id by call index, deterministically', async () => {
    const turn = [
      { id: 'toolu_A', location: 'SF' },
      { id: 'toolu_A', location: 'NYC' },
    ];
    const out = await claude(turn);
    expect(out.toolCalls).toStrictEqual([
      { id: 'toolu_A', name: 'get_weather', input: { location: 'SF' } },
      { id: 'toolu_A_1', name: 'get_weather', input: { location: 'NYC' }, providerId: 'toolu_A' },
    ]);
    expect((await claude(turn)).toolCalls).toStrictEqual(out.toolCalls);
  });

  it('keeps the name fallback for the first id-less call and suffixes the next', async () => {
    const out = await claude([{ location: 'SF' }, { location: 'NYC' }]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'get_weather', name: 'get_weather', input: { location: 'SF' } },
      { id: 'get_weather_1', name: 'get_weather', input: { location: 'NYC' }, providerId: null },
    ]);
  });

  it('suffixes a real id that equals the name fallback of an earlier call', async () => {
    const out = await claude([{ location: 'SF' }, { id: 'get_weather', location: 'NYC' }]);
    expect(ids(out.toolCalls)).toEqual(['get_weather', 'get_weather_1']);
    expect(out.toolCalls[1]!.providerId).toBe('get_weather');
  });

  it('suffixes the name fallback of a later call that equals an earlier real id', async () => {
    const out = await claude([{ id: 'get_weather', location: 'SF' }, { location: 'NYC' }]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'get_weather', name: 'get_weather', input: { location: 'SF' } },
      { id: 'get_weather_1', name: 'get_weather', input: { location: 'NYC' }, providerId: null },
    ]);
  });

  it('leaves an already-unique response byte-for-byte unchanged', async () => {
    const out = await claude([
      { id: 'toolu_A', location: 'SF' },
      { id: 'toolu_B', location: 'NYC' },
    ]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'toolu_A', name: 'get_weather', input: { location: 'SF' } },
      { id: 'toolu_B', name: 'get_weather', input: { location: 'NYC' } },
    ]);
  });

  it('sends the de-duplicated ids back on tool_use and tool_result, each result on its own call', async () => {
    const b = await roundTrip(
      'claude',
      'claude-opus-4-8',
      [
        claudeTurn([
          { id: 'toolu_A', location: 'SF' },
          { id: 'toolu_A', location: 'NYC' },
        ]),
      ],
      { content: [{ type: 'text', text: 'ok' }] },
    );
    expect(b.messages).toEqual([
      { role: 'user', content: 'Weather in SF and NYC?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_A', name: 'get_weather', input: { location: 'SF' } },
          { type: 'tool_use', id: 'toolu_A_1', name: 'get_weather', input: { location: 'NYC' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_A', content: 'weather in SF' },
          { type: 'tool_result', tool_use_id: 'toolu_A_1', content: 'weather in NYC' },
        ],
      },
    ]);
  });
});

describe.each([
  ['openai', 'gpt-4o'],
  ['mistral', 'mistral-large-latest'],
] as const)('callAgentModel — %s tool-call ids are unique within a turn', (provider, model) => {
  const chat = (calls: WireCall[]) => run(chatTurn(calls)).invoke(multiTurn(provider, model));

  it('suffixes a repeated tool_calls id by call index, deterministically', async () => {
    const turn = [
      { id: 'call_A', location: 'SF' },
      { id: 'call_A', location: 'NYC' },
    ];
    const out = await chat(turn);
    expect(out.toolCalls).toStrictEqual([
      { id: 'call_A', name: 'get_weather', input: { location: 'SF' } },
      { id: 'call_A_1', name: 'get_weather', input: { location: 'NYC' }, providerId: 'call_A' },
    ]);
    expect((await chat(turn)).toolCalls).toStrictEqual(out.toolCalls);
  });

  it('keeps the name fallback for the first id-less call and suffixes the next', async () => {
    const out = await chat([{ location: 'SF' }, { location: 'NYC' }]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'get_weather', name: 'get_weather', input: { location: 'SF' } },
      { id: 'get_weather_1', name: 'get_weather', input: { location: 'NYC' }, providerId: null },
    ]);
  });

  it('suffixes a real id that equals the name fallback of an earlier call', async () => {
    const out = await chat([{ location: 'SF' }, { id: 'get_weather', location: 'NYC' }]);
    expect(ids(out.toolCalls)).toEqual(['get_weather', 'get_weather_1']);
    expect(out.toolCalls[1]!.providerId).toBe('get_weather');
  });

  it('suffixes the name fallback of a later call that equals an earlier real id', async () => {
    const out = await chat([{ id: 'get_weather', location: 'SF' }, { location: 'NYC' }]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'get_weather', name: 'get_weather', input: { location: 'SF' } },
      { id: 'get_weather_1', name: 'get_weather', input: { location: 'NYC' }, providerId: null },
    ]);
  });

  it('never suffixes onto an id a later call was issued', async () => {
    const out = await chat([
      { id: 'call_A', location: 'SF' },
      { id: 'call_A', location: 'NYC' },
      { id: 'call_A_1', location: 'LA' },
    ]);
    expect(ids(out.toolCalls)).toEqual(['call_A', 'call_A_1_1', 'call_A_1']);
    expect(out.toolCalls[2]).not.toHaveProperty('providerId');
  });

  it('keeps extending a suffix until it is free of every issued id', async () => {
    const out = await chat([
      { id: 'call_A', location: 'SF' },
      { id: 'call_A', location: 'NYC' },
      { id: 'call_A_1', location: 'LA' },
      { id: 'call_A_1_1', location: 'SEA' },
    ]);
    expect(ids(out.toolCalls)).toEqual(['call_A', 'call_A_1_1_1', 'call_A_1', 'call_A_1_1']);
    expect(out.toolCalls[1]!.providerId).toBe('call_A');
    expect(out.toolCalls[3]).not.toHaveProperty('providerId');
  });

  it('leaves an already-unique response byte-for-byte unchanged', async () => {
    const out = await chat([
      { id: 'call_A', location: 'SF' },
      { id: 'call_B', location: 'NYC' },
    ]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'call_A', name: 'get_weather', input: { location: 'SF' } },
      { id: 'call_B', name: 'get_weather', input: { location: 'NYC' } },
    ]);
  });

  it('sends the de-duplicated ids back on tool_calls and tool_call_id, each result on its own call', async () => {
    const b = await roundTrip(
      provider,
      model,
      [
        chatTurn([
          { id: 'call_A', location: 'SF' },
          { id: 'call_A', location: 'NYC' },
        ]),
      ],
      { choices: [{ message: { content: 'ok' } }] },
    );
    expect(b.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Weather in SF and NYC?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_A',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"SF"}' },
          },
          {
            id: 'call_A_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_A', name: 'get_weather', content: 'weather in SF' },
      { role: 'tool', tool_call_id: 'call_A_1', name: 'get_weather', content: 'weather in NYC' },
    ]);
  });

  const resultNames = async (messages: AgentConversationMessage[]): Promise<(string | undefined)[]> => {
    const b = await sentBody(provider, model, messages, { choices: [{ message: { content: 'ok' } }] });
    return (b.messages as { role: string; name?: string }[])
      .filter((message) => message.role === 'tool')
      .map((message) => message.name);
  };

  it('names each result after the call it answers in its own turn, though ids repeat across turns', async () => {
    const names = await resultNames([
      { role: 'user', content: 'Weather in SF, then the time there?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', input: {} }] },
      { role: 'tool', toolCallId: 'call_1', content: '15 C' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_time', input: {} }] },
      { role: 'tool', toolCallId: 'call_1', content: '9 AM' },
    ]);
    expect(names).toEqual(['get_weather', 'get_time']);
  });

  it('names each result after the call at its own position when a turn recorded before unique ids repeats an id', async () => {
    const names = await resultNames(
      legacyTurn([
        { id: 'call_0', name: 'get_weather', input: {} },
        { id: 'call_0', name: 'get_time', input: {} },
      ]),
    );
    expect(names).toEqual(['get_weather', 'get_time']);
  });
});

describe('callAgentModel — gemini tool-call ids are unique within a turn', () => {
  const gemini = (calls: WireCall[]) =>
    run(geminiTurn(calls)).invoke(multiTurn('gemini', 'gemini-2.0-flash'));
  const ok = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
  const geminiTrip = (...turns: WireCall[][]) =>
    roundTrip('gemini', 'gemini-2.0-flash', turns.map(geminiTurn), ok);
  const wireIds = (b: Record<string, unknown>): (string | undefined)[][] =>
    (b.contents as { parts: Record<string, { id?: string }>[] }[])
      .slice(1)
      .map((content) => content.parts.map((part) => Object.values(part)[0]?.id));

  it('suffixes a repeated functionCall id by call index, deterministically', async () => {
    const turn = [
      { id: 'fc_A', location: 'SF' },
      { id: 'fc_A', location: 'NYC' },
    ];
    const out = await gemini(turn);
    expect(out.toolCalls).toStrictEqual([
      { id: 'fc_A', name: 'get_weather', input: { location: 'SF' } },
      { id: 'fc_A_1', name: 'get_weather', input: { location: 'NYC' }, providerId: 'fc_A' },
    ]);
    expect((await gemini(turn)).toolCalls).toStrictEqual(out.toolCalls);
  });

  it('keeps synthesizing by index for same-name calls with no id', async () => {
    const out = await gemini([{ location: 'SF' }, { location: 'NYC' }]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'get_weather_0', name: 'get_weather', input: { location: 'SF' } },
      { id: 'get_weather_1', name: 'get_weather', input: { location: 'NYC' } },
    ]);
  });

  it('suffixes a real id that equals the synthesized id of an earlier call', async () => {
    const out = await gemini([{ location: 'SF' }, { id: 'get_weather_0', location: 'NYC' }]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'get_weather_0', name: 'get_weather', input: { location: 'SF' } },
      { id: 'get_weather_0_1', name: 'get_weather', input: { location: 'NYC' }, providerId: 'get_weather_0' },
    ]);
  });

  it('suffixes a synthesized id that equals the real id of an earlier call', async () => {
    const out = await gemini([{ id: 'get_weather_1', location: 'SF' }, { location: 'NYC' }]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'get_weather_1', name: 'get_weather', input: { location: 'SF' } },
      { id: 'get_weather_1_1', name: 'get_weather', input: { location: 'NYC' }, providerId: null },
    ]);
  });

  it('leaves an already-unique response byte-for-byte unchanged', async () => {
    const out = await gemini([{ id: 'fc_A', location: 'SF' }, { location: 'NYC' }]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'fc_A', name: 'get_weather', input: { location: 'SF' } },
      { id: 'get_weather_1', name: 'get_weather', input: { location: 'NYC' } },
    ]);
  });

  it('marks an issued id that equals its own synthesized slot as issued', async () => {
    const out = await gemini([
      { id: 'fc_A', location: 'SF' },
      { id: 'get_weather_1', location: 'NYC' },
    ]);
    expect(out.toolCalls).toStrictEqual([
      { id: 'fc_A', name: 'get_weather', input: { location: 'SF' } },
      { id: 'get_weather_1', name: 'get_weather', input: { location: 'NYC' }, providerId: 'get_weather_1' },
    ]);
  });

  it.each([
    ['alone', [{ id: 'get_weather_1' }], ['fc_A', 'get_weather_1']],
    [
      'repeated',
      [{ id: 'get_weather_1' }, { id: 'get_weather_1' }],
      ['fc_A', 'get_weather_1', 'get_weather_1'],
    ],
    ['after a synthesized twin', [{}, { id: 'get_weather_1' }], ['fc_A', undefined, 'get_weather_1']],
  ])(
    'sends back exactly the ids Gemini issued when one equals its own synthesized slot (%s)',
    async (_, rest: { id?: string }[], sent: (string | undefined)[]) => {
      const calls = [{ id: 'fc_A' }, ...rest].map((call, index) => ({ ...call, location: `L${index}` }));
      expect(wireIds(await geminiTrip(calls))).toEqual([sent, sent]);
    },
  );

  it('sends back each turn its own issued ids, though a synthesized id repeats an issued one across turns', async () => {
    const b = await geminiTrip(
      [{ location: 'SF' }],
      [
        { id: 'fc_C', location: 'LA' },
        { id: 'get_weather_0', location: 'NYC' },
      ],
      [{ location: 'SEA' }],
    );
    expect(wireIds(b)).toEqual([
      [undefined],
      [undefined],
      ['fc_C', 'get_weather_0'],
      ['fc_C', 'get_weather_0'],
      [undefined],
      [undefined],
    ]);
  });

  it('sends back only the ids Gemini issued: a repeated id goes back as issued, on call and result', async () => {
    const b = await geminiTrip([
      { id: 'fc_A', location: 'SF' },
      { id: 'fc_A', location: 'NYC' },
    ]);
    expect(JSON.stringify(b)).not.toContain('fc_A_1');
    expect(b.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather in SF and NYC?' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'fc_A', name: 'get_weather', args: { location: 'SF' } } },
          { functionCall: { id: 'fc_A', name: 'get_weather', args: { location: 'NYC' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'fc_A', name: 'get_weather', response: { result: 'weather in SF' } } },
          { functionResponse: { id: 'fc_A', name: 'get_weather', response: { result: 'weather in NYC' } } },
        ],
      },
    ]);
  });

  it('sends back a real id that collided with a synthesized one, and no id for the synthesized call', async () => {
    const b = await geminiTrip([{ location: 'SF' }, { id: 'get_weather_0', location: 'NYC' }]);
    expect(b.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather in SF and NYC?' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'get_weather', args: { location: 'SF' } } },
          { functionCall: { id: 'get_weather_0', name: 'get_weather', args: { location: 'NYC' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'get_weather', response: { result: 'weather in SF' } } },
          {
            functionResponse: {
              id: 'get_weather_0',
              name: 'get_weather',
              response: { result: 'weather in NYC' },
            },
          },
        ],
      },
    ]);
  });

  it('never sends a suffixed synthesized id as if Gemini had issued it', async () => {
    const b = await geminiTrip([{ id: 'get_weather_1', location: 'SF' }, { location: 'NYC' }]);
    expect(b.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather in SF and NYC?' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'get_weather_1', name: 'get_weather', args: { location: 'SF' } } },
          { functionCall: { name: 'get_weather', args: { location: 'NYC' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'get_weather_1',
              name: 'get_weather',
              response: { result: 'weather in SF' },
            },
          },
          { functionResponse: { name: 'get_weather', response: { result: 'weather in NYC' } } },
        ],
      },
    ]);
  });

  const geminiSent = (messages: AgentConversationMessage[]) =>
    sentBody('gemini', 'gemini-2.0-flash', messages, ok);

  it('answers each call in order, by name and by id, when a turn recorded before unique ids repeats an issued id', async () => {
    const b = await geminiSent(
      legacyTurn([
        { id: 'fc_1', name: 'get_weather', input: {} },
        { id: 'fc_1', name: 'get_time', input: {} },
      ]),
    );
    expect((b.contents as unknown[]).slice(1)).toEqual([
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'fc_1', name: 'get_weather', args: {} } },
          { functionCall: { id: 'fc_1', name: 'get_time', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'fc_1', name: 'get_weather', response: { result: 'result 0' } } },
          { functionResponse: { id: 'fc_1', name: 'get_time', response: { result: 'result 1' } } },
        ],
      },
    ]);
  });

  it('pairs each functionResponse id with its functionCall when a turn recorded before unique ids gave a synthesized id an issued twin', async () => {
    const b = await geminiSent(
      legacyTurn([
        { id: 'get_weather_1', name: 'get_weather', input: { location: 'SF' } },
        { id: 'get_weather_1', name: 'get_weather', input: { location: 'NYC' } },
      ]),
    );
    expect(wireIds(b)).toEqual([
      ['get_weather_1', undefined],
      ['get_weather_1', undefined],
    ]);
  });
});

// ─── zero-tool requests (a tools-less "just reason" agent) ───

describe('callAgentModel — a zero-tool request omits `tools` entirely', () => {
  /** A valid tools-less agent: one user turn, no bound tools. */
  function zeroTool(provider: AgentModelRequest['provider'], model: string): AgentModelRequest {
    return {
      provider,
      model,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Just say hi.' }],
      tools: [],
      maxTokens: 1024,
    };
  }

  it('claude: no `tools` key (empty array not sent)', async () => {
    const { invoke, transport } = run({ content: [{ type: 'text', text: 'hi' }] });
    await invoke(zeroTool('claude', 'claude-opus-4-8'));
    expect(body(transport.requests[0]!)).not.toHaveProperty('tools');
  });

  it('openai: no `tools` key (empty array 400s)', async () => {
    const { invoke, transport } = run({ choices: [{ message: { content: 'hi' } }] });
    await invoke(zeroTool('openai', 'gpt-4o'));
    expect(body(transport.requests[0]!)).not.toHaveProperty('tools');
  });

  it('mistral: no `tools` key (empty array 400s)', async () => {
    const { invoke, transport } = run({ choices: [{ message: { content: 'hi' } }] });
    await invoke(zeroTool('mistral', 'mistral-large-latest'));
    expect(body(transport.requests[0]!)).not.toHaveProperty('tools');
  });

  it('gemini: no `tools` key (empty functionDeclarations 400s)', async () => {
    const { invoke, transport } = run({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    await invoke(zeroTool('gemini', 'gemini-2.0-flash'));
    expect(body(transport.requests[0]!)).not.toHaveProperty('tools');
  });
});

// ─── dispatcher ───

describe('callAgentModel — dispatcher', () => {
  it('rejects an unknown provider with invalid_input', async () => {
    const req = { ...multiTurn('openai', 'gpt-4o'), provider: 'grok' as AgentModelRequest['provider'] };
    await expect(
      callAgentModel(
        req,
        stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} }))),
        new HttpClient(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('throws provider_error when the response has no model turn', async () => {
    const { invoke } = run({ choices: [] });
    await expect(invoke(multiTurn('openai', 'gpt-4o'))).rejects.toMatchObject({ code: 'provider_error' });
  });
});
