import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { parseProps } from '../../core/props';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { claudeGenerateText } from './claude';
import { geminiGenerateText } from './gemini';
import { mistralGenerateText } from './mistral';
import { openaiGenerateText } from './openai';

/** Golden offline tests for the LLM `generate_text` family, driven by a {@link FakeTransport}. */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'apiKey'), http: new HttpClient(), transport };
}

const constant = (data: unknown) => () => ({ status: 200, headers: {}, data });

describe('openai.generate_text', () => {
  it('has the public type and default model', () => {
    expect(openaiGenerateText.type).toBe('openai.generate_text');
  });

  it('POSTs an OpenAI chat-completion body and extracts choices[0].message.content', async () => {
    const { auth, http, transport } = fake(
      constant({
        choices: [{ message: { content: 'hi from openai' } }],
        usage: { total_tokens: 7 },
      }),
    );
    const out = await openaiGenerateText.execute({
      auth,
      http,
      props: {
        prompt: 'Say hi',
        system: 'Be terse',
        model: 'gpt-4o-mini',
        temperature: 0.2,
        maxTokens: 256,
      },
    });

    expect(out).toEqual({ text: 'hi from openai', model: 'gpt-4o-mini', usage: { total_tokens: 7 } });
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    const body = req.body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      max_tokens: number;
      response_format?: { type: string };
    };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be terse' },
      { role: 'user', content: 'Say hi' },
    ]);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(256);
    expect(body.response_format).toBeUndefined();
  });

  it('toggles response_format and omits the system message when unset', async () => {
    const { auth, http, transport } = fake(constant({ choices: [{ message: { content: '{}' } }] }));
    await openaiGenerateText.execute({
      auth,
      http,
      props: { prompt: 'JSON please', model: 'gpt-4o', jsonOutput: true },
    });
    const body = transport.requests[0]!.body as {
      messages: Array<{ role: string }>;
      max_tokens: number;
      response_format?: { type: string };
    };
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toEqual([{ role: 'user', content: 'JSON please' }]);
    expect(body.max_tokens).toBe(1024);
  });

  it('throws provider_error when the response has no text', async () => {
    const { auth, http } = fake(constant({ choices: [] }));
    await expect(
      openaiGenerateText.execute({ auth, http, props: { prompt: 'x', model: 'gpt-4o' } }),
    ).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('parseProps rejects a missing required prompt', () => {
    expect(() => parseProps(openaiGenerateText.props, { model: 'gpt-4o' })).toThrow(/prompt/);
  });
});

describe('mistral.generate_text', () => {
  it('POSTs the OpenAI-shaped body to the Mistral endpoint and extracts the content', async () => {
    const { auth, http, transport } = fake(
      constant({
        choices: [{ message: { content: 'bonjour' } }],
        usage: { prompt_tokens: 3 },
      }),
    );
    const out = await mistralGenerateText.execute({
      auth,
      http,
      props: { prompt: 'Bonjour?', model: 'mistral-small-latest', jsonOutput: true },
    });

    expect(out).toEqual({ text: 'bonjour', model: 'mistral-small-latest', usage: { prompt_tokens: 3 } });
    const req = transport.requests[0]!;
    expect(req.url).toBe('https://api.mistral.ai/v1/chat/completions');
    const body = req.body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
      response_format?: { type: string };
    };
    expect(body.model).toBe('mistral-small-latest');
    expect(body.messages).toEqual([{ role: 'user', content: 'Bonjour?' }]);
    expect(body.max_tokens).toBe(1024);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('claude.generate_text', () => {
  it('POSTs the Messages body with the anthropic-version header and always sends max_tokens', async () => {
    const { auth, http, transport } = fake(
      constant({
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'hello from claude' },
        ],
        usage: { input_tokens: 4, output_tokens: 5 },
      }),
    );
    const out = await claudeGenerateText.execute({
      auth,
      http,
      props: { prompt: 'Hi', system: 'Be kind', model: 'claude-sonnet-5', temperature: 0.5, maxTokens: 512 },
    });

    expect(out.text).toBe('hello from claude');
    expect(out.model).toBe('claude-sonnet-5');
    expect(out.usage).toEqual({ input_tokens: 4, output_tokens: 5 });

    const req = transport.requests[0]!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    const body = req.body as {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
    };
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(512);
    expect(body.system).toBe('Be kind');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    expect(body.temperature).toBe(0.5);
  });

  it('appends the JSON instruction to the system prompt when jsonOutput is set', async () => {
    const { auth, http, transport } = fake(constant({ content: [{ type: 'text', text: '{}' }] }));
    await claudeGenerateText.execute({
      auth,
      http,
      props: { prompt: 'Give JSON', system: 'Base', model: 'claude-opus-4-8', jsonOutput: true },
    });
    const body = transport.requests[0]!.body as { system: string; max_tokens: number };
    expect(body.system).toBe('Base\n\nRespond with only valid JSON.');
    expect(body.max_tokens).toBe(1024);
  });

  it.each([undefined, 'end_turn', 'refusal'])(
    'reports missing text when no text block is present and the stop reason is %s',
    async (stopReason) => {
      const { auth, http } = fake(
        constant({ content: [{ type: 'thinking', thinking: 'x' }], stop_reason: stopReason }),
      );
      await expect(
        claudeGenerateText.execute({ auth, http, props: { prompt: 'x', model: 'claude-opus-4-8' } }),
      ).rejects.toMatchObject({
        code: 'provider_error',
        retryable: false,
        message: 'claude: response did not contain generated text',
      });
    },
  );
});

describe('gemini.generate_text', () => {
  it('PUTs the model in the URL path and shapes contents/generationConfig', async () => {
    const { auth, http, transport } = fake(
      constant({
        candidates: [{ content: { parts: [{ text: 'hi from gemini' }] } }],
        usageMetadata: { totalTokenCount: 9 },
      }),
    );
    const out = await geminiGenerateText.execute({
      auth,
      http,
      props: {
        prompt: 'Hi',
        system: 'Be brief',
        model: 'gemini-3.8-flash',
        temperature: 0.3,
        maxTokens: 128,
        jsonOutput: true,
      },
    });

    expect(out).toEqual({
      text: 'hi from gemini',
      model: 'gemini-3.8-flash',
      usage: { totalTokenCount: 9 },
    });

    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    const body = req.body as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      systemInstruction?: { parts: Array<{ text: string }> };
      generationConfig: { temperature?: number; maxOutputTokens: number; responseMimeType?: string };
    };
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief' }] });
    expect(body.generationConfig.temperature).toBe(0.3);
    expect(body.generationConfig.maxOutputTokens).toBe(128);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('omits systemInstruction and responseMimeType when unset', async () => {
    const { auth, http, transport } = fake(
      constant({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      }),
    );
    await geminiGenerateText.execute({
      auth,
      http,
      props: { prompt: 'Hi', model: geminiGenerateText.props.model.defaultValue! },
    });
    const req = transport.requests[0]!;
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    );
    const body = req.body as {
      systemInstruction?: unknown;
      generationConfig: { maxOutputTokens: number; responseMimeType?: string };
    };
    expect(body.systemInstruction).toBeUndefined();
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  it.each([
    ['gemini-3.6-flash', 65_536],
    ['gemini-3.8-flash', 65_536],
    ['gemini-3.5-flash-lite', 65_536],
    ['gemini-4-argon', 32_768],
    ['gemini-9-unlisted', 32_768],
  ])('sends %s a blank Max tokens as %i', async (model, maxOutputTokens) => {
    const { auth, http, transport } = fake(
      constant({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    );
    await geminiGenerateText.execute({ auth, http, props: { prompt: 'x', model } });
    expect(transport.requests[0]!.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    );
    expect(transport.requests[0]!.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      generationConfig: { maxOutputTokens },
    });
  });

  it('offers the four models and leaves Max tokens blank, since its default depends on the model', () => {
    expect(geminiGenerateText.props.model.options).toEqual(
      ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-4-argon'].map((m) => ({
        label: m,
        value: m,
      })),
    );
    const maxTokens = geminiGenerateText.toManifest().props.maxTokens!;
    expect(maxTokens).not.toHaveProperty('defaultValue');
    expect(maxTokens.description).toBe(
      "Upper bound on tokens to generate; leave blank for the model's default.",
    );
    for (const action of [openaiGenerateText, claudeGenerateText, mistralGenerateText]) {
      expect(action.toManifest().props.maxTokens).toMatchObject({
        description: 'Upper bound on tokens to generate.',
        defaultValue: 1024,
      });
    }
  });

  it('throws provider_error when candidates are empty', async () => {
    const { auth, http } = fake(constant({ candidates: [] }));
    await expect(
      geminiGenerateText.execute({ auth, http, props: { prompt: 'x', model: 'gemini-3.6-flash' } }),
    ).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('returns the text of a normal STOP unchanged', async () => {
    const { auth, http } = fake(
      constant({
        candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 12 },
      }),
    );
    const out = await geminiGenerateText.execute({
      auth,
      http,
      props: { prompt: 'x', model: 'gemini-3.6-flash' },
    });
    expect(out).toEqual({ text: 'done', model: 'gemini-3.6-flash', usage: { totalTokenCount: 12 } });
  });

  it.each([
    [
      'a signed empty part before it',
      [{ text: '', thoughtSignature: 'c2ln' }, { text: 'The answer' }],
      'MAX_TOKENS',
    ],
    ['a thought part before it', [{ text: 'Weighing it up', thought: true }, { text: 'The answer' }], 'STOP'],
    ['the text split across parts', [{ text: 'The ' }, { text: 'answer' }], 'STOP'],
  ])('returns the text with %s', async (_, parts, finishReason) => {
    const { auth, http } = fake(
      constant({ candidates: [{ content: { role: 'model', parts }, finishReason }] }),
    );
    const out = await geminiGenerateText.execute({
      auth,
      http,
      props: { prompt: 'x', model: 'gemini-3.6-flash' },
    });
    expect(out).toEqual({ text: 'The answer', model: 'gemini-3.6-flash' });
  });

  it.each(['STOP', 'SAFETY'])(
    'still reports missing text when a candidate with no text stopped at %s',
    async (finishReason) => {
      const { auth, http } = fake(constant({ candidates: [{ content: { role: 'model' }, finishReason }] }));
      await expect(
        geminiGenerateText.execute({ auth, http, props: { prompt: 'x', model: 'gemini-3.6-flash' } }),
      ).rejects.toMatchObject({
        code: 'provider_error',
        retryable: false,
        message: 'gemini: response did not contain generated text',
      });
    },
  );
});

describe('generate_text run directly, without the props defaults', () => {
  it.each([
    [
      'openai',
      openaiGenerateText,
      'gpt-4o',
      { choices: [{ message: { content: 'ok' } }] },
      'max_tokens',
      1024,
    ],
    [
      'gemini',
      geminiGenerateText,
      'gemini-4-argon',
      { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
      'generationConfig',
      { maxOutputTokens: 32_768 },
    ],
  ])('%s sends its default Max tokens when none is passed', async (_, action, model, data, field, value) => {
    const { auth, http, transport } = fake(constant(data));
    await action.run({
      auth,
      http,
      props: {
        prompt: 'x',
        model,
        system: undefined,
        temperature: undefined,
        maxTokens: undefined,
        jsonOutput: undefined,
      },
    });
    expect((transport.requests[0]!.body as Record<string, unknown>)[field]).toEqual(value);
  });
});

describe('gemini.generate_text long decode', () => {
  const props = { prompt: 'Write the full report.', model: 'gemini-4-argon', maxTokens: 262_144 };
  const firstBody = {
    contents: [{ role: 'user', parts: [{ text: 'Write the full report.' }] }],
    generationConfig: { maxOutputTokens: 262_144 },
  };
  const hop = (parts: unknown[], finishReason: string, extra: Record<string, unknown> = {}) => ({
    candidates: [{ content: { role: 'model', parts }, finishReason, ...extra }],
  });
  const replay = (hops: unknown[]) => fake((_, i) => ({ status: 200, headers: {}, data: hops[i] }));

  it('resends the same body with each CONTINUATION token, then joins the hops and sums their usage', async () => {
    const { auth, http, transport } = replay([
      {
        ...hop([{ text: '' }], 'CONTINUATION', { continuationToken: 't1' }),
        usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: 32_768, totalTokenCount: 32_778 },
      },
      {
        ...hop([{ text: 'Part one, ' }], 'CONTINUATION', { continuationToken: 't2' }),
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 32_768, totalTokenCount: 32_778 },
      },
      {
        ...hop([{ text: 'part two.' }], 'STOP'),
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    ]);
    const out = await geminiGenerateText.execute({ auth, http, props });
    expect(transport.requests.map((r) => r.body)).toEqual([
      firstBody,
      { ...firstBody, continuationToken: 't1' },
      { ...firstBody, continuationToken: 't2' },
    ]);
    expect(new Set(transport.requests.map((r) => r.url)).size).toBe(1);
    expect(out).toEqual({
      text: 'Part one, part two.',
      model: 'gemini-4-argon',
      usage: {
        promptTokenCount: 30,
        thoughtsTokenCount: 32_768,
        candidatesTokenCount: 32_773,
        totalTokenCount: 65_571,
      },
    });
  });

  it('stops at a MAX_TOKENS hop although it carries a token, and fails naming Max tokens when no text came', async () => {
    const { auth, http, transport } = replay([
      hop([{ text: '' }], 'CONTINUATION', { continuationToken: 't1' }),
      hop([{ text: '' }], 'MAX_TOKENS', { continuationToken: 't2' }),
    ]);
    await expect(geminiGenerateText.execute({ auth, http, props })).rejects.toMatchObject({
      code: 'provider_error',
      retryable: false,
      message:
        'gemini: thinking used the whole Max tokens budget before any text was written; thinking counts toward Max tokens, so raise it',
    });
    expect(transport.requests).toHaveLength(2);
  });

  it('returns the text it got when the last hop stops at MAX_TOKENS, without usage none of the hops sent', async () => {
    const { auth, http, transport } = replay([
      hop([{ text: '' }], 'CONTINUATION', { continuationToken: 't1' }),
      hop([{ text: 'The report so' }], 'MAX_TOKENS', { continuationToken: 't2' }),
    ]);
    const out = await geminiGenerateText.execute({ auth, http, props });
    expect(out).toEqual({ text: 'The report so', model: 'gemini-4-argon' });
    expect(transport.requests).toHaveLength(2);
  });

  it.each([
    ['no token', {}],
    ['an empty token', { continuationToken: '' }],
  ])('fails instead of returning part of the answer when a CONTINUATION hop has %s', async (_, extra) => {
    const { auth, http, transport } = replay([hop([{ text: 'Part one, ' }], 'CONTINUATION', extra)]);
    await expect(geminiGenerateText.execute({ auth, http, props })).rejects.toMatchObject({
      code: 'provider_error',
      retryable: false,
      message:
        'gemini: a CONTINUATION response carried no continuation token, so the rest of the answer cannot be fetched',
    });
    expect(transport.requests).toHaveLength(1);
  });
});

describe('generate_text when thinking used the whole Max tokens', () => {
  it.each([
    [
      'gemini',
      'no parts',
      geminiGenerateText,
      'gemini-3.6-flash',
      { candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS' }] },
    ],
    [
      'gemini',
      'a signed empty text part',
      geminiGenerateText,
      'gemini-3.6-flash',
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: '', thoughtSignature: 'c2ln' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      },
    ],
    [
      'gemini',
      'only a thought part',
      geminiGenerateText,
      'gemini-3.6-flash',
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Weighing it up', thought: true }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      },
    ],
    [
      'claude',
      'only a thinking block',
      claudeGenerateText,
      'claude-sonnet-5',
      { content: [{ type: 'thinking', thinking: '', signature: 'c2ln' }], stop_reason: 'max_tokens' },
    ],
    [
      'claude',
      'an empty text block',
      claudeGenerateText,
      'claude-sonnet-5',
      {
        content: [
          { type: 'thinking', thinking: '', signature: 'c2ln' },
          { type: 'text', text: '' },
        ],
        stop_reason: 'max_tokens',
      },
    ],
  ])('%s fails naming Max tokens and thinking with %s', async (slug, _, action, model, data) => {
    const { auth, http } = fake(constant(data));
    await expect(
      action.execute({
        auth,
        http,
        props: { prompt: 'Write a 300-word analysis of this report.', model, maxTokens: 1024 },
      }),
    ).rejects.toMatchObject({
      code: 'provider_error',
      retryable: false,
      message: `${slug}: thinking used the whole Max tokens budget before any text was written; thinking counts toward Max tokens, so raise it`,
    });
  });
});

describe('generate_text cut off at Max tokens', () => {
  const cut = 'The article argues that the central';

  it.each([
    [
      'gemini',
      geminiGenerateText,
      'gemini-3.6-flash',
      { candidates: [{ content: { role: 'model', parts: [{ text: cut }] }, finishReason: 'MAX_TOKENS' }] },
    ],
    [
      'claude',
      claudeGenerateText,
      'claude-opus-4-8',
      { content: [{ type: 'text', text: cut }], stop_reason: 'max_tokens' },
    ],
    [
      'openai',
      openaiGenerateText,
      'gpt-4o',
      { choices: [{ message: { content: cut }, finish_reason: 'length' }] },
    ],
  ])('%s returns the text it got as a success', async (_, action, model, data) => {
    const { auth, http } = fake(constant(data));
    const out = await action.execute({
      auth,
      http,
      props: { prompt: 'Summarize this article in about 300 words.', model, maxTokens: 16 },
    });
    expect(out).toEqual({ text: cut, model });
  });
});
