import type { AuthHandle } from '../../core/auth';
import { createDirectAuth } from '../../core/auth-factories';
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
        props: { prompt: 'Reply with the single word: pong', model: 'gemini-1.5-flash', maxTokens: 16 },
      });
      nonEmpty(out.text);
      console.log(`live: gemini.generate_text → "${out.text.slice(0, 40)}"`);
    },
    30_000,
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
