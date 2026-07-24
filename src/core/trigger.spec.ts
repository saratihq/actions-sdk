import { newChannel } from '../actions/slack/new-channel.polling';
import { newMessage } from '../actions/slack/new-message.webhook';
import { signSlackRequest } from '../actions/slack/signature';
import { FakeTransport, stubAuth } from '../testing/fakes';
import { MemoryStore } from '../testing/memory-store';
import type { NormalizedResponse } from './http/types';
import type { WebhookRequest } from './trigger';

function slackChannels(channels: Array<{ id: string; name: string }>): NormalizedResponse {
  return {
    status: 200,
    headers: {},
    data: {
      ok: true,
      channels: channels.map((c) => ({ ...c, is_private: false, is_archived: false })),
      response_metadata: { next_cursor: '' },
    },
  };
}

describe('polling trigger (slack.new_channel)', () => {
  it('baselines existing channels on the first poll, then fires only genuinely-new ones (INV-1)', async () => {
    const transport = new FakeTransport(() =>
      slackChannels([
        { id: 'C1', name: 'general' },
        { id: 'C2', name: 'random' },
      ]),
    );
    const auth = stubAuth(transport);
    const store = new MemoryStore();

    // First poll = baseline: the channels present at activation are recorded but
    // emit ZERO events (activation must not fire the whole channel list).
    const first = await newChannel.runPoll({ auth, props: {}, store });
    expect(first.events).toEqual([]);
    expect(typeof first.polledAt).toBe('string');

    // Re-polling the same set still emits nothing.
    const second = await newChannel.runPoll({ auth, props: {}, store });
    expect(second.events).toEqual([]);

    // A genuinely new channel fires on the third poll.
    const transport3 = new FakeTransport(() =>
      slackChannels([
        { id: 'C1', name: 'general' },
        { id: 'C2', name: 'random' },
        { id: 'C3', name: 'new' },
      ]),
    );
    const third = await newChannel.runPoll({ auth: stubAuth(transport3), props: {}, store });
    expect(third.events.map((c) => c.id)).toEqual(['C3']);
  });

  it('dedupes against the full known-set even when the SDK LRU seen has evicted the id', async () => {
    // A large workspace: the trigger recorded C1 in its OWN uncapped known-set, but
    // the SDK's LRU `seen` has since evicted it. Re-listing C1 must NOT re-fire it —
    // the regression the head-window + LRU-only approach caused above DEDUPE_CAP.
    // The known-set is already primed (defined), so this is a post-baseline poll.
    const store = new MemoryStore();
    await store.set('known_channel_ids', ['C1']);
    await store.set('seen', []);
    const transport = new FakeTransport(() => slackChannels([{ id: 'C1', name: 'general' }]));
    const result = await newChannel.runPoll({ auth: stubAuth(transport), props: {}, store });
    expect(result.events).toEqual([]);
  });

  it('baselines the known-set + watermark on first poll, then records new keys in seen', async () => {
    const store = new MemoryStore();
    await newChannel.runPoll({
      auth: stubAuth(new FakeTransport(() => slackChannels([{ id: 'C1', name: 'general' }]))),
      props: {},
      store,
    });
    const seeded = store.snapshot();
    // Baseline poll: the existing channel is recorded in the trigger's OWN known-set
    // (its watermark) and the SDK records lastPolledAt — but nothing fires, so the
    // SDK's `seen` stays empty.
    expect(seeded.known_channel_ids).toEqual(['C1']);
    expect(seeded.seen).toEqual([]);
    expect(typeof seeded.lastPolledAt).toBe('string');

    // A genuinely-new channel now fires and lands in the SDK's `seen`.
    await newChannel.runPoll({
      auth: stubAuth(
        new FakeTransport(() =>
          slackChannels([
            { id: 'C1', name: 'general' },
            { id: 'C2', name: 'random' },
          ]),
        ),
      ),
      props: {},
      store,
    });
    const after = store.snapshot();
    expect(after.seen).toEqual(['C2']);
    expect(after.known_channel_ids).toEqual(['C1', 'C2']);
  });
});

describe('webhook trigger (slack.new_message)', () => {
  const SECRET = 'sign-me';
  const nowSec = String(Math.floor(Date.now() / 1000));

  function signedRequest(body: unknown): WebhookRequest & { secrets: Record<string, string> } {
    const rawBody = JSON.stringify(body);
    return {
      headers: {
        'x-slack-request-timestamp': nowSec,
        'x-slack-signature': signSlackRequest(rawBody, SECRET, nowSec),
      },
      body,
      rawBody,
      secrets: { signingSecret: SECRET },
    };
  }

  it('answers the url_verification handshake', () => {
    const handshake = newMessage.handleHandshake({
      headers: {},
      body: { type: 'url_verification', challenge: 'abc123' },
    });
    expect(handshake).toEqual({ status: 200, body: { challenge: 'abc123' } });
  });

  it('rejects a request with an invalid signature', async () => {
    const request: WebhookRequest = {
      headers: { 'x-slack-request-timestamp': nowSec, 'x-slack-signature': 'v0=forged' },
      body: { event: { type: 'message', ts: '1.1', channel: 'C1' } },
      rawBody: '{}',
    };
    await expect(
      newMessage.handleRequest({
        auth: stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} }))),
        props: {},
        store: new MemoryStore(),
        request,
        secrets: { signingSecret: SECRET },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('transforms a message event into a normalised event', async () => {
    const req = signedRequest({
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C9',
        channel_type: 'channel',
        user: 'U1',
        text: 'hi',
        ts: '1710.1',
      },
    });
    const events = await newMessage.handleRequest({
      auth: stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} }))),
      props: {},
      store: new MemoryStore(),
      request: req,
      secrets: req.secrets,
    });
    expect(events).toEqual([{ channel: 'C9', channelType: 'channel', user: 'U1', text: 'hi', ts: '1710.1' }]);
  });

  it('ignores bot messages when ignoreBots is set, and dedupes retries', async () => {
    const store = new MemoryStore();
    const botReq = signedRequest({ event: { type: 'message', channel: 'C1', ts: '1', bot_id: 'B1' } });
    const botEvents = await newMessage.handleRequest({
      auth: stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} }))),
      props: { ignoreBots: true },
      store,
      request: botReq,
      secrets: botReq.secrets,
    });
    expect(botEvents).toEqual([]);

    // Same human event delivered twice → only fires once.
    const humanReq = signedRequest({
      event: { type: 'message', channel: 'C1', ts: '2', user: 'U1', text: 'yo' },
    });
    const first = await newMessage.handleRequest({
      auth: stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} }))),
      props: { ignoreBots: true },
      store,
      request: humanReq,
      secrets: humanReq.secrets,
    });
    const second = await newMessage.handleRequest({
      auth: stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} }))),
      props: { ignoreBots: true },
      store,
      request: humanReq,
      secrets: humanReq.secrets,
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
