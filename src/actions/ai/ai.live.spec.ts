import type { AuthHandle } from '../../core/auth';
import { createDirectAuth } from '../../core/auth-factories';
import { ActionError } from '../../core/errors';
import { HttpClient } from '../../core/http/client';
import { liveDescribe } from '../../testing/live';
import { claudeGenerateText } from './claude';
import { geminiGenerateText } from './gemini';
import { mistralGenerateText } from './mistral';
import { openaiGenerateText } from './openai';

/**
 * LIVE generate_text smoke tests over the direct transport; gated behind ORCHESTR_LIVE.
 * Each provider self-skips unless OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / MISTRAL_API_KEY is set.
 */
liveDescribe('ai — live generate_text via direct transport', () => {
  const http = new HttpClient();

  const nonEmpty = (text: string): void => {
    expect(typeof text).toBe('string');
    expect(text.trim().length).toBeGreaterThan(0);
  };

  const openaiKey = process.env.OPENAI_API_KEY;
  (openaiKey ? it : it.skip)(
    'openai.generate_text returns text',
    async () => {
      const auth: AuthHandle = createDirectAuth(openaiGenerateText.auth, {
        type: 'apiKey',
        value: openaiKey ?? '',
      });
      const out = await openaiGenerateText.execute({
        auth,
        http,
        props: { prompt: 'Reply with the single word: pong', model: 'gpt-4o-mini', maxTokens: 16 },
      });
      nonEmpty(out.text);
      console.log(`live: openai.generate_text → "${out.text.slice(0, 40)}"`);
    },
    30_000,
  );

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  (anthropicKey ? it : it.skip)(
    'claude.generate_text returns text',
    async () => {
      const auth: AuthHandle = createDirectAuth(claudeGenerateText.auth, {
        type: 'apiKey',
        value: anthropicKey ?? '',
      });
      const out = await claudeGenerateText.execute({
        auth,
        http,
        props: {
          prompt: 'Reply with the single word: pong',
          model: 'claude-haiku-4-5-20251001',
          maxTokens: 16,
        },
      });
      nonEmpty(out.text);
      console.log(`live: claude.generate_text → "${out.text.slice(0, 40)}"`);
    },
    30_000,
  );

  const geminiKey = process.env.GEMINI_API_KEY;
  (geminiKey ? it : it.skip)(
    'gemini.generate_text returns text',
    async () => {
      const auth: AuthHandle = createDirectAuth(geminiGenerateText.auth, {
        type: 'apiKey',
        value: geminiKey ?? '',
      });
      const out = await geminiGenerateText.execute({
        auth,
        http,
        // Gemini 3 counts thinking toward maxOutputTokens, so this runs at the action's default budget.
        props: { prompt: 'Reply with the single word: pong', model: 'gemini-3.6-flash' },
      });
      nonEmpty(out.text);
      console.log(`live: gemini.generate_text → "${out.text.slice(0, 40)}"`);
    },
    30_000,
  );

  // A 1 s client default, so only the action's own model-call timeout lets these answers finish.
  const impatient = new HttpClient({ defaultTimeoutMs: 1_000 });
  const longAnswers = [
    { action: geminiGenerateText, key: geminiKey, model: geminiGenerateText.props.model.defaultValue! },
    { action: geminiGenerateText, key: geminiKey, model: 'gemini-4-argon' },
    { action: claudeGenerateText, key: anthropicKey, model: 'claude-sonnet-5' },
  ];
  for (const { action, key, model } of longAnswers) {
    (key ? it : it.skip)(
      `${action.type} finishes a ~300-word answer on ${model} at its default Max tokens, past a 1 s client default`,
      async () => {
        const auth: AuthHandle = createDirectAuth(action.auth, { type: 'apiKey', value: key ?? '' });
        const started = Date.now();
        const out = await action.execute({
          auth,
          http: impatient,
          props: {
            prompt: 'In about 300 words, explain why the sky is blue and why sunsets are red.',
            model,
          },
        });
        const elapsed = Date.now() - started;
        const words = out.text.trim().split(/\s+/).length;
        console.log(
          `live: ${action.type}, ~300 words on ${model} at its default Max tokens → ${words} words in ${elapsed} ms`,
        );
        expect(words).toBeGreaterThan(150);
        expect(elapsed).toBeGreaterThan(1_000);
      },
      120_000,
    );
  }

  (geminiKey ? it : it.skip)(
    'gemini.generate_text fails naming Max tokens when thinking uses the whole budget',
    async () => {
      const auth: AuthHandle = createDirectAuth(geminiGenerateText.auth, {
        type: 'apiKey',
        value: geminiKey ?? '',
      });
      const outcome: unknown = await geminiGenerateText
        .execute({
          auth,
          http,
          props: {
            prompt: 'In about 300 words, explain why the sky is blue and why sunsets are red.',
            model: geminiGenerateText.props.model.defaultValue!,
            maxTokens: 16,
          },
        })
        .then(
          (out) => out.text,
          (err: unknown) => err,
        );
      console.log(
        `live: gemini.generate_text, Max tokens 16 → ${outcome instanceof ActionError ? outcome.code : JSON.stringify(outcome)}`,
      );
      expect(outcome).toMatchObject({
        code: 'provider_error',
        retryable: false,
        message:
          'gemini: thinking used the whole Max tokens budget before any text was written; thinking counts toward Max tokens, so raise it',
      });
    },
    60_000,
  );

  const mistralKey = process.env.MISTRAL_API_KEY;
  (mistralKey ? it : it.skip)(
    'mistral.generate_text returns text',
    async () => {
      const auth: AuthHandle = createDirectAuth(mistralGenerateText.auth, {
        type: 'apiKey',
        value: mistralKey ?? '',
      });
      const out = await mistralGenerateText.execute({
        auth,
        http,
        props: { prompt: 'Reply with the single word: pong', model: 'mistral-small-latest', maxTokens: 16 },
      });
      nonEmpty(out.text);
      console.log(`live: mistral.generate_text → "${out.text.slice(0, 40)}"`);
    },
    30_000,
  );
});
