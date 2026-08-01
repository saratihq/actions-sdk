import { HttpClient } from '../../../core/http/client';
import type { NormalizedRequest } from '../../../core/http/types';
import { FakeTransport, stubAuth } from '../../../testing/fakes';
import { callAgentModel } from './index';
import type { AgentModelRequest } from './types';

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
