import { createDirectAuth } from '../../core/auth-factories';
import { guardedFetch } from '../../core/http/guarded-fetch';
import type { FetchLike } from '../../core/http/types';
import { type LoopbackServer, startLoopbackServer, withAllowedHosts } from '../../testing/loopback-server';
import { MemoryStore } from '../../testing/memory-store';
import { outlookAuth } from './common';
import { newEmail } from './new-email.polling';

interface Mail {
  id: string;
  received: number;
  visibleAt: number;
  deleted: boolean;
}

const GRAPH = 'https://graph.microsoft.com';
const at = (hms: string): number => Date.parse(`2026-10-01T${hms}Z`);
const wholeSecond = (ms: number): string =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000', '');

/** Graph's `/me/messages` on loopback: live `$skip` paging over what is visible and not deleted at the controlled clock. */
describe('outlook.new_email against a live-paging Graph on loopback (controlled clock)', () => {
  let server: LoopbackServer;
  let mails: Mail[];
  let now: number;

  beforeEach(async () => {
    mails = [];
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
    server = await startLoopbackServer((_req, res, hit) => {
      const url = new URL(hit.url, GRAPH);
      const since = Date.parse(url.searchParams.get('$filter')?.replace('receivedDateTime ge ', '') ?? '');
      const desc = url.searchParams.get('$orderby') === 'receivedDateTime desc';
      const top = Number(url.searchParams.get('$top') ?? 10);
      const skip = Number(url.searchParams.get('$skip') ?? 0);
      const listed = mails
        .filter((m) => !m.deleted && m.visibleAt <= now && Math.floor(m.received / 1000) * 1000 >= since)
        .sort((a, b) => (desc ? b.received - a.received : a.received - b.received));
      const page = listed.slice(skip, skip + top);
      const next = new URL(`${GRAPH}${url.pathname}${url.search}`);
      next.searchParams.set('$skip', String(skip + top));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          value: page.map((m) => ({ id: m.id, receivedDateTime: wholeSecond(m.received) })),
          ...(skip + top < listed.length ? { '@odata.nextLink': next.toString() } : {}),
        }),
      );
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await server.close();
  });

  const toLoopback: FetchLike = (input, init) =>
    guardedFetch(String(input).replace(GRAPH, `http://127.0.0.1:${server.port}`), init);

  const mail = (id: string, received: number, lagMs = 0): void => {
    mails.push({ id, received, visibleAt: received + lagMs, deleted: false });
  };

  /** Run each poll at its instant; return every id each poll emitted. */
  async function pollAt(instants: number[]): Promise<string[]> {
    const store = new MemoryStore();
    const auth = createDirectAuth(
      outlookAuth,
      { type: 'bearer', token: 'tok-loopback' },
      { fetchImpl: toLoopback },
    );
    const delivered: string[] = [];
    for (const instant of instants) {
      now = instant;
      jest.setSystemTime(instant);
      const { events } = await withAllowedHosts('127.0.0.1', () =>
        newEmail.runPoll({ auth, props: {}, store }),
      );
      delivered.push(...events.map((e) => e.id));
    }
    expect(server.hits.every((h) => h.headers.authorization === 'Bearer tok-loopback')).toBe(true);
    return delivered;
  }

  const lost = (delivered: string[]): string[] =>
    mails.map((m) => m.id).filter((id) => !delivered.includes(id));
  const everyMinute = (from: number, count: number): number[] =>
    Array.from({ length: count }, (_, i) => from + i * 60_000);

  it('L1: a 1,500-message backlog after a 2 h outage, with 40 delivered messages purged mid-drain, loses nothing', async () => {
    for (let i = 0; i < 1500; i += 1) mail(`m${i}`, at('08:00:01') + Math.floor((i * 7_198_000) / 1500));
    const polls = [at('08:00:00'), ...everyMinute(at('10:00:00'), 6)];
    const store = new MemoryStore();
    const auth = createDirectAuth(
      outlookAuth,
      { type: 'bearer', token: 'tok-loopback' },
      { fetchImpl: toLoopback },
    );
    const delivered: string[] = [];
    for (const instant of polls) {
      if (instant > at('10:00:30')) for (const m of mails.slice(0, 40)) m.deleted = true;
      now = instant;
      jest.setSystemTime(instant);
      const { events } = await withAllowedHosts('127.0.0.1', () =>
        newEmail.runPoll({ auth, props: {}, store }),
      );
      delivered.push(...events.map((e) => e.id));
    }
    expect(lost(delivered)).toEqual([]);
  });

  it('L2: a 1,200-message burst in 90 s plus a message visible 85 s after it was received loses nothing', async () => {
    for (let i = 0; i < 1200; i += 1) mail(`b${i}`, at('09:00:05') + Math.floor((i * 90_000) / 1200));
    mail('late', at('09:00:30'), 85_000);
    expect(lost(await pollAt(everyMinute(at('09:00:00'), 7)))).toEqual([]);
  });

  it('L2b: 2-minute polls whose first read fills the window to the live edge, and a message 3.5 s late, lose nothing', async () => {
    for (let i = 0; i < 490; i += 1) mail(`e${i}`, at('09:00:01') + Math.floor((i * 109_000) / 490));
    for (let i = 0; i < 30; i += 1) mail(`t${i}`, at('09:01:58'));
    mail('late', at('09:01:57'), 3_500);
    const polls = [at('09:00:00'), at('09:02:00'), at('09:04:00'), at('09:06:00'), at('09:08:00')];
    expect(lost(await pollAt(polls))).toEqual([]);
  });
});
