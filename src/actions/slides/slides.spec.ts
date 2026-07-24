import { HttpClient } from '../../core/http/client';
import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { createPresentation, getPresentation } from './presentations';

/**
 * Golden offline tests for the Google Slides actions. A {@link FakeTransport}
 * replays canned API v1 responses and records the request. (See
 * slides.live.spec.ts for the live smoke tests.)
 */
function fake(handler: (req: NormalizedRequest, i: number) => NormalizedResponse) {
  const transport = new FakeTransport(handler);
  return { auth: stubAuth(transport, 'oauth2'), http: new HttpClient(), transport };
}

describe('slides.create_presentation', () => {
  it('POSTs the title and returns id + title', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: { presentationId: 'pres1', title: 'Deck' },
    }));
    const out = await createPresentation.execute({ auth, http, props: { title: 'Deck' } });
    expect(out).toEqual({ presentationId: 'pres1', title: 'Deck' });
    expect(transport.requests[0]!.url).toBe('https://slides.googleapis.com/v1/presentations');
    expect(transport.requests[0]!.body).toEqual({ title: 'Deck' });
  });
});

describe('slides.get_presentation', () => {
  it('GETs the presentation and summarises slides', async () => {
    const { auth, http, transport } = fake(() => ({
      status: 200,
      headers: {},
      data: {
        presentationId: 'pres1',
        title: 'Deck',
        revisionId: 'rev9',
        slides: [{ objectId: 'p1' }, { objectId: 'p2' }],
      },
    }));
    const out = await getPresentation.execute({ auth, http, props: { presentationId: 'pres1' } });
    expect(out).toEqual({
      presentationId: 'pres1',
      title: 'Deck',
      revisionId: 'rev9',
      slideCount: 2,
      slideIds: ['p1', 'p2'],
    });
    expect(transport.requests[0]!.url).toBe('https://slides.googleapis.com/v1/presentations/pres1');
  });
});
