import type { AuthHandle } from '../../core/auth';
import { HttpClient } from '../../core/http/client';
import type { NormalizedResponse } from '../../core/http/types';
import { StalledTransport, stubAuth } from '../../testing/fakes';
import { sendRequest } from '../http/http';
import { sendChannelMessage } from '../slack/send-channel-message';
import { type AgentProvider, callAgentModel } from './agent-model';
import { claudeGenerateText } from './claude';
import { geminiGenerateText } from './gemini';
import { mistralGenerateText } from './mistral';
import { openaiGenerateText } from './openai';

type Call = (auth: AuthHandle, http: HttpClient) => Promise<unknown>;

const MINUTE = 60_000;

async function abandonedAfter(ms: number, call: Call, answers: NormalizedResponse[] = []) {
  const transport = new StalledTransport(answers);
  const outcome = call(stubAuth(transport, 'apiKey'), new HttpClient()).then(
    () => 'answered',
    (err: unknown) => err,
  );
  await jest.advanceTimersByTimeAsync(ms - 1);
  const stalled = transport.requests[answers.length]!;
  expect(stalled.signal?.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(stalled.signal?.aborted).toBe(true);
  return { transport, outcome };
}

async function failsOnceAt(ms: number, call: Call, answers: NormalizedResponse[] = []): Promise<void> {
  const { transport, outcome } = await abandonedAfter(ms, call, answers);
  await jest.advanceTimersByTimeAsync(60 * MINUTE);
  expect(transport.requests).toHaveLength(answers.length + 1);
  await expect(outcome).resolves.toMatchObject({
    code: 'transport_timeout',
    message: `request timed out after ${ms}ms`,
    retryable: true,
  });
}

describe('model calls wait as long as each vendor documents for a non-streaming call', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    ['openai', 10, openaiGenerateText, 'gpt-4o'],
    ['claude', 10, claudeGenerateText, 'claude-sonnet-5'],
    ['gemini', 20, geminiGenerateText, 'gemini-4-argon'],
    ['mistral', 5, mistralGenerateText, 'mistral-large-latest'],
  ] as const)(
    '%s.generate_text waits %i minutes for the model, then fails once without resending',
    async (_, minutes, action, model) => {
      await failsOnceAt(minutes * MINUTE, (auth, http) =>
        action.execute({ auth, http, props: { prompt: 'x', model } }),
      );
    },
  );

  it.each([
    ['openai', 10, 'gpt-4o'],
    ['claude', 10, 'claude-sonnet-5'],
    ['gemini', 20, 'gemini-3.6-flash'],
    ['mistral', 5, 'mistral-large-latest'],
  ] as const)(
    'callAgentModel on %s waits %i minutes for the model, then fails once without resending',
    async (provider: AgentProvider, minutes, model) => {
      await failsOnceAt(minutes * MINUTE, (auth, http) =>
        callAgentModel(
          { provider, model, system: '', messages: [{ role: 'user', content: 'x' }], tools: [] },
          auth,
          http,
        ),
      );
    },
  );

  it('gives each gemini.generate_text long-decode hop the whole 20 minutes of its own', async () => {
    const continuation: NormalizedResponse = {
      status: 200,
      headers: {},
      data: {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: '' }] },
            finishReason: 'CONTINUATION',
            continuationToken: 't1',
          },
        ],
      },
    };
    await failsOnceAt(
      20 * MINUTE,
      (auth, http) =>
        geminiGenerateText.execute({
          auth,
          http,
          props: { prompt: 'x', model: 'gemini-4-argon', maxTokens: 262_144 },
        }),
      [continuation],
    );
  });
});

describe('every other action keeps the HTTP client default of 30 s', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    [
      'slack.send_channel_message',
      (auth: AuthHandle, http: HttpClient) =>
        sendChannelMessage.execute({ auth, http, props: { channel: 'C1', text: 'hi' } }),
    ],
    [
      'http.send_request',
      (auth: AuthHandle, http: HttpClient) =>
        sendRequest.execute({ auth, http, props: { method: 'POST', url: 'https://api.example.com/slow' } }),
    ],
  ])('%s abandons its request after 30 s', async (_, call) => {
    await abandonedAfter(30_000, call);
  });
});
