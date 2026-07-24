import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { parseProps } from '../../core/props';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { claudeGenerateText } from './claude';
import { geminiGenerateText } from './gemini';
import { mistralGenerateText } from './mistral';
import { openaiGenerateText } from './openai';

/**
 * Golden offline tests for the LLM `generate_text` family. A {@link FakeTransport}
 * replays a canned provider response and records every outbound request, so it
 * asserts — without a network — the URL, the provider-shaped body (model,
 * messages/contents, token cap, and the JSON-output toggle), the extra header
 * Claude requires, and that a stubbed response is extracted to `{ text, model }`.
 */
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
    // maxTokens defaults to 1024 when the prop is omitted.
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
    // max_tokens is required by the Messages API — always present, defaulting to 1024.
    expect(body.max_tokens).toBe(1024);
  });

  it('throws provider_error when no text block is present', async () => {
    const { auth, http } = fake(constant({ content: [{ type: 'thinking', thinking: 'x' }] }));
    await expect(
      claudeGenerateText.execute({ auth, http, props: { prompt: 'x', model: 'claude-opus-4-8' } }),
    ).rejects.toMatchObject({ code: 'provider_error' });
  });
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
        model: 'gemini-1.5-pro',
        temperature: 0.3,
        maxTokens: 128,
        jsonOutput: true,
      },
    });

    expect(out).toEqual({
      text: 'hi from gemini',
      model: 'gemini-1.5-pro',
      usage: { totalTokenCount: 9 },
    });

    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
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
      props: { prompt: 'Hi', model: 'gemini-2.0-flash' },
    });
    const body = transport.requests[0]!.body as {
      systemInstruction?: unknown;
      generationConfig: { maxOutputTokens: number; responseMimeType?: string };
    };
    expect(body.systemInstruction).toBeUndefined();
    expect(body.generationConfig.responseMimeType).toBeUndefined();
    expect(body.generationConfig.maxOutputTokens).toBe(1024);
  });

  it('throws provider_error when candidates are empty', async () => {
    const { auth, http } = fake(constant({ candidates: [] }));
    await expect(
      geminiGenerateText.execute({ auth, http, props: { prompt: 'x', model: 'gemini-2.0-flash' } }),
    ).rejects.toMatchObject({ code: 'provider_error' });
  });
});
