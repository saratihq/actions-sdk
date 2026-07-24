import type { NormalizedRequest, NormalizedResponse } from '../../core/http/types';
import { FakeTransport, stubAuth } from '../../testing/fakes';
import { MemoryStore } from '../../testing/memory-store';
import { newRecording } from './new-recording.polling';

/**
 * Real "List all recordings" response shape (Zoom API v2,
 * GET /users/{userId}/recordings) — the meetings[] + recording_files[] envelope
 * from Zoom's public reference. `next_page_token` is "" on the final page and the
 * per-file `status` is "completed" once processing finishes / "processing" while
 * Zoom is still rendering the artifact.
 */
const COMPLETED_MEETING = {
  uuid: 'n0ppXY+tS8eBoORjWM3+Sg==',
  id: 123456789,
  account_id: 'abcAccount',
  host_id: 'hostAbc',
  topic: 'Weekly sync',
  type: 2,
  start_time: '2026-07-20T15:00:00Z',
  timezone: 'America/Los_Angeles',
  duration: 42,
  total_size: 246560,
  recording_count: 2,
  share_url: 'https://zoom.us/rec/share/abc123',
  recording_files: [
    {
      id: 'ffcf7fee-1234-4a1b-9c0d-0011223344ff',
      meeting_id: 'n0ppXY+tS8eBoORjWM3+Sg==',
      recording_start: '2026-07-20T15:00:00Z',
      recording_end: '2026-07-20T15:42:00Z',
      file_type: 'MP4',
      file_extension: 'MP4',
      file_size: 246560,
      play_url: 'https://zoom.us/rec/play/abc123',
      download_url: 'https://zoom.us/rec/download/abc123',
      status: 'completed',
      recording_type: 'shared_screen_with_speaker_view',
    },
    {
      id: 'aa11bb22-5678-4c3d-8e9f-99887766aa00',
      meeting_id: 'n0ppXY+tS8eBoORjWM3+Sg==',
      recording_start: '2026-07-20T15:00:00Z',
      recording_end: '2026-07-20T15:42:00Z',
      file_type: 'TRANSCRIPT',
      file_extension: 'VTT',
      file_size: 1024,
      download_url: 'https://zoom.us/rec/download/abc123.vtt',
      status: 'completed',
      recording_type: 'audio_transcript',
    },
  ],
};

/** Same session while Zoom is still processing the transcript file. */
const PROCESSING_MEETING = {
  ...COMPLETED_MEETING,
  recording_files: [
    COMPLETED_MEETING.recording_files[0],
    { ...COMPLETED_MEETING.recording_files[1], status: 'processing', download_url: undefined },
  ],
};

const page = (meetings: unknown[], nextPageToken = ''): unknown => ({
  from: '2026-07-19',
  to: '2026-07-21',
  page_count: 1,
  page_size: 300,
  total_records: meetings.length,
  next_page_token: nextPageToken,
  meetings,
});

const okResponse = (data: unknown): NormalizedResponse => ({ status: 200, headers: {}, data });

/** A store already past its first poll — forces the "real poll" path (skips self-baseline). */
function seededStore(lastPolledAt = '2026-07-21T09:30:00Z'): MemoryStore {
  const store = new MemoryStore();
  void store.set('lastPolledAt', lastPolledAt);
  return store;
}

describe('zoom.new_recording polling trigger', () => {
  it('transforms a real fully-processed recordings payload into a normalised event', async () => {
    const transport = new FakeTransport(() => okResponse(page([COMPLETED_MEETING])));
    const { events } = await newRecording.runPoll({
      auth: stubAuth(transport),
      props: {},
      store: seededStore(),
    });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.uuid).toBe('n0ppXY+tS8eBoORjWM3+Sg==');
    expect(event.meetingId).toBe(123456789);
    expect(event.topic).toBe('Weekly sync');
    expect(event.duration).toBe(42);
    expect(event.shareUrl).toBe('https://zoom.us/rec/share/abc123');
    expect(event.files).toHaveLength(2);
    expect(event.files[0]).toEqual({
      id: 'ffcf7fee-1234-4a1b-9c0d-0011223344ff',
      fileType: 'MP4',
      fileExtension: 'MP4',
      fileSize: 246560,
      downloadUrl: 'https://zoom.us/rec/download/abc123',
      playUrl: 'https://zoom.us/rec/play/abc123',
      recordingStart: '2026-07-20T15:00:00Z',
      recordingEnd: '2026-07-20T15:42:00Z',
      recordingType: 'shared_screen_with_speaker_view',
      status: 'completed',
    });
    expect(event.files[1]!.fileType).toBe('TRANSCRIPT');
  });

  it('self-baselines on an empty watermark: records existing uuids, emits nothing', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport(() => okResponse(page([COMPLETED_MEETING])));

    const { events } = await newRecording.runPoll({ auth: stubAuth(transport), props: {}, store });
    expect(events).toEqual([]);

    const snapshot = store.snapshot();
    expect(snapshot.seen).toContain('n0ppXY+tS8eBoORjWM3+Sg==');
    expect(snapshot.lastPolledAt).toBeDefined();

    // The pre-existing session, seen at baseline, never fires on the next poll.
    const second = await newRecording.runPoll({
      auth: stubAuth(new FakeTransport(() => okResponse(page([COMPLETED_MEETING])))),
      props: {},
      store,
    });
    expect(second.events).toEqual([]);
  });

  it('anchors `from` to a 2-day lookback before the watermark and drains every page', async () => {
    const secondMeeting = { ...COMPLETED_MEETING, uuid: 'ZZ22+other==', id: 987654321 };
    const transport = new FakeTransport((_req: NormalizedRequest, i: number) =>
      i === 0 ? okResponse(page([COMPLETED_MEETING], 'PAGE2')) : okResponse(page([secondMeeting], '')),
    );

    const { events } = await newRecording.runPoll({
      auth: stubAuth(transport),
      props: {},
      store: seededStore('2026-07-21T09:30:00Z'),
    });

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.uuid)).toEqual(['n0ppXY+tS8eBoORjWM3+Sg==', 'ZZ22+other==']);

    // Watermark 2026-07-21 minus LOOKBACK_DAYS (2) → from=2026-07-19.
    const first = transport.requests[0]!.url;
    expect(first).toContain('https://api.zoom.us/v2/users/me/recordings');
    expect(first).toContain('page_size=300');
    expect(first).toContain('from=2026-07-19');
    expect(first).not.toContain('next_page_token');
    // Second page carries the token returned by the first.
    expect(transport.requests[1]!.url).toContain('next_page_token=PAGE2');
  });

  it('skips a still-processing session, then fires it exactly once when completed', async () => {
    const store = seededStore();

    const first = await newRecording.runPoll({
      auth: stubAuth(new FakeTransport(() => okResponse(page([PROCESSING_MEETING])))),
      props: {},
      store,
    });
    expect(first.events).toEqual([]);
    // Not burned into the dedupe set — it can still fire later.
    expect(store.snapshot().seen ?? []).not.toContain('n0ppXY+tS8eBoORjWM3+Sg==');

    const second = await newRecording.runPoll({
      auth: stubAuth(new FakeTransport(() => okResponse(page([COMPLETED_MEETING])))),
      props: {},
      store,
    });
    expect(second.events).toHaveLength(1);

    const third = await newRecording.runPoll({
      auth: stubAuth(new FakeTransport(() => okResponse(page([COMPLETED_MEETING])))),
      props: {},
      store,
    });
    expect(third.events).toEqual([]);
  });

  it('dedupes a fully-processed session across polls by meeting uuid', async () => {
    const store = seededStore();
    const firstPoll = await newRecording.runPoll({
      auth: stubAuth(new FakeTransport(() => okResponse(page([COMPLETED_MEETING])))),
      props: {},
      store,
    });
    expect(firstPoll.events).toHaveLength(1);

    const secondPoll = await newRecording.runPoll({
      auth: stubAuth(new FakeTransport(() => okResponse(page([COMPLETED_MEETING])))),
      props: {},
      store,
    });
    expect(secondPoll.events).toEqual([]);
  });

  it('drops meetings missing a uuid or numeric id', async () => {
    const malformed = page([{ topic: 'no ids', recording_files: [] }]);
    const { events } = await newRecording.runPoll({
      auth: stubAuth(new FakeTransport(() => okResponse(malformed))),
      props: {},
      store: seededStore(),
    });
    expect(events).toEqual([]);
  });
});
