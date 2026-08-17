import { HttpClient } from '../../core/http/client';
import { DirectTransport } from '../../core/http/transport-direct';
import type { FetchLike, FetchLikeResponse } from '../../core/http/types';
import { fakeResponse, stubAuth } from '../../testing/fakes';
import { slackOAuth } from './common';
import { sendChannelMessage } from './send-channel-message';

const json = (body: unknown): FetchLikeResponse =>
  fakeResponse(200, JSON.stringify(body), { 'content-type': 'application/json' });

const CHANNELS = [
  { id: 'C1', name: 'social', is_private: false, is_archived: false },
  { id: 'C2', name: 'growth-listening', is_private: true, is_archived: false },
];

function slackAuth() {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (input) => {
    calls.push(String(input));
    return Promise.resolve(json({ ok: true, channels: CHANNELS }));
  };
  const transport = new DirectTransport({
    scheme: slackOAuth,
    credential: { type: 'bearer', token: 'xoxb-test-token' },
    fetchImpl,
  });
  return { auth: stubAuth(transport, 'oauth2'), calls, http: new HttpClient() };
}

describe('slack.send_channel_message — the channel picker', () => {
  it('asks Slack for private channels too, and marks them apart from public ones', async () => {
    const { auth, http, calls } = slackAuth();
    const prop = sendChannelMessage.props.channel;
    if (typeof prop.options !== 'function') throw new Error('channel is not a live dropdown');

    const options = await prop.options({ auth, http, props: {} } as never);

    // A private channel is unreachable unless the picker asks for it.
    expect(calls[0]).toContain('types=public_channel%2Cprivate_channel');
    expect(options).toEqual([
      { label: '#social', value: 'C1' },
      { label: '🔒 #growth-listening', value: 'C2' },
    ]);
  });
});
