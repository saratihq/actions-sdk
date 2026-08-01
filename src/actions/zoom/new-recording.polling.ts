import { defineTrigger } from '../../core/trigger';
import type { AuthHandle } from '../../core/auth';
import type { HttpClient } from '../../core/http/client';
import type { PropsSchema } from '../../core/props';
import { ZOOM_API_BASE, zoomAuth } from './common';

/** Polling trigger (`zoom.new_recording`) — fires once per cloud recording session, deduped by meeting UUID. */
export const ZOOM_NEW_RECORDING_TYPE = 'zoom.new_recording';

/** `from` filters by meeting START while processing lags, so the window must look back — the uuid dedupe drops the re-listed overlap. */
const LOOKBACK_DAYS = 2;
/** Zoom's max page size for the recordings list. */
const PAGE_SIZE = 300;
/** Safety cap on pages drained per poll (PAGE_SIZE 300 → up to 30k sessions). */
const MAX_PAGES = 100;
/** Milliseconds in one calendar day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** One downloadable artifact of a recording session, trimmed to what workflows use. */
export interface ZoomRecordingFileEvent {
  id: string;
  fileType?: string;
  fileExtension?: string;
  fileSize?: number;
  /** Authenticated download URL (needs the connection's token / a `?access_token=`). */
  downloadUrl?: string;
  playUrl?: string;
  recordingStart?: string;
  recordingEnd?: string;
  recordingType?: string;
  status?: string;
}

/** A normalised "new recording" event — one recording session (a meeting instance) and its files. */
export interface ZoomRecordingEvent {
  /** The meeting-instance UUID — unique per recorded session; the dedup key. */
  uuid: string;
  /** The numeric meeting id (shared across a meeting's occurrences). */
  meetingId: number;
  topic: string;
  startTime?: string;
  timezone?: string;
  /** Meeting duration in minutes. */
  duration?: number;
  /** Total bytes across all files. */
  totalSize?: number;
  recordingCount?: number;
  shareUrl?: string;
  files: ZoomRecordingFileEvent[];
}

/** The `recording_files[]` entry shape (fields read from Zoom's payload). */
interface ZoomRecordingFilePayload {
  id?: string;
  meeting_id?: string;
  recording_start?: string;
  recording_end?: string;
  file_type?: string;
  file_extension?: string;
  file_size?: number;
  play_url?: string;
  download_url?: string;
  status?: string;
  recording_type?: string;
}

/** One `meetings[]` entry (a recording session) in the recordings-list response. */
interface ZoomRecordingMeetingPayload {
  uuid?: string;
  id?: number;
  topic?: string;
  type?: number;
  start_time?: string;
  timezone?: string;
  duration?: number;
  total_size?: number;
  recording_count?: number;
  share_url?: string;
  recording_files?: ZoomRecordingFilePayload[];
}

/** The `GET /users/{userId}/recordings` response envelope (the relevant fields). */
interface ZoomRecordingsResponse {
  from?: string;
  to?: string;
  page_size?: number;
  total_records?: number;
  next_page_token?: string;
  meetings?: ZoomRecordingMeetingPayload[];
}

/** yyyy-mm-dd (Zoom's `from`/`to` format) from an ISO timestamp. */
function toDateParam(iso: string): string {
  return iso.slice(0, 10);
}

/** The `from` date param: {@link LOOKBACK_DAYS} calendar days before `watermark` (UTC). */
function lookbackParam(watermark: Date): string {
  return toDateParam(new Date(watermark.getTime() - LOOKBACK_DAYS * DAY_MS).toISOString());
}

/** A part-processed session must be skipped, not emitted, or it burns into the dedupe set before its files are ready. */
function isFullyProcessed(event: ZoomRecordingEvent): boolean {
  return event.files.length > 0 && event.files.every((f) => f.status === 'completed');
}

/** Drain every page of `GET /users/me/recordings` from `from`, up to the {@link MAX_PAGES} guard. */
async function listRecordings(
  http: HttpClient,
  auth: AuthHandle,
  from: string,
): Promise<ZoomRecordingMeetingPayload[]> {
  const collected: ZoomRecordingMeetingPayload[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await http.get<ZoomRecordingsResponse>(`${ZOOM_API_BASE}/users/me/recordings`, {
      auth,
      query: { page_size: PAGE_SIZE, from, ...(pageToken ? { next_page_token: pageToken } : {}) },
    });
    collected.push(...(res.data.meetings ?? []));
    // Zoom returns "" (not a missing field) on the last page.
    pageToken = res.data.next_page_token || undefined;
    if (!pageToken) break;
  }
  return collected;
}

/** Transform a Zoom meeting-recording payload into the normalised event, or null if unusable. */
function toEvent(meeting: ZoomRecordingMeetingPayload): ZoomRecordingEvent | null {
  if (!meeting.uuid || typeof meeting.id !== 'number') return null;
  const files = (meeting.recording_files ?? [])
    .filter((f): f is ZoomRecordingFilePayload & { id: string } => typeof f.id === 'string')
    .map((f) => ({
      id: f.id,
      ...(f.file_type !== undefined ? { fileType: f.file_type } : {}),
      ...(f.file_extension !== undefined ? { fileExtension: f.file_extension } : {}),
      ...(f.file_size !== undefined ? { fileSize: f.file_size } : {}),
      ...(f.download_url !== undefined ? { downloadUrl: f.download_url } : {}),
      ...(f.play_url !== undefined ? { playUrl: f.play_url } : {}),
      ...(f.recording_start !== undefined ? { recordingStart: f.recording_start } : {}),
      ...(f.recording_end !== undefined ? { recordingEnd: f.recording_end } : {}),
      ...(f.recording_type !== undefined ? { recordingType: f.recording_type } : {}),
      ...(f.status !== undefined ? { status: f.status } : {}),
    }));
  return {
    uuid: meeting.uuid,
    meetingId: meeting.id,
    topic: meeting.topic ?? '',
    ...(meeting.start_time !== undefined ? { startTime: meeting.start_time } : {}),
    ...(meeting.timezone !== undefined ? { timezone: meeting.timezone } : {}),
    ...(meeting.duration !== undefined ? { duration: meeting.duration } : {}),
    ...(meeting.total_size !== undefined ? { totalSize: meeting.total_size } : {}),
    ...(meeting.recording_count !== undefined ? { recordingCount: meeting.recording_count } : {}),
    ...(meeting.share_url !== undefined ? { shareUrl: meeting.share_url } : {}),
    files,
  };
}

export const newRecording = defineTrigger({
  type: ZOOM_NEW_RECORDING_TYPE,
  strategy: 'polling',
  name: 'New recording',
  description: 'Fires when a new cloud recording is available in the connected Zoom account.',
  auth: zoomAuth,
  props: {} satisfies PropsSchema,
  sampleData: {
    uuid: 'n0ppXY+tS8eBoORjWM3+Sg==',
    meetingId: 123456789,
    topic: 'Weekly sync',
    startTime: '2026-07-20T15:00:00Z',
    timezone: 'America/Los_Angeles',
    duration: 42,
    totalSize: 246560,
    recordingCount: 2,
    shareUrl: 'https://zoom.us/rec/share/abc123',
    files: [
      {
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
      },
    ],
  },
  async poll({ auth, http, store, lastPolledAt }): Promise<ZoomRecordingEvent[]> {
    // Self-baseline: on an empty watermark, record existing uuids into the dedupe set
    // and emit nothing, so pre-enable sessions never fire.
    if (!lastPolledAt) {
      const existing = await listRecordings(http, auth, lookbackParam(new Date()));
      const seen = existing.map((m) => m.uuid).filter((u): u is string => typeof u === 'string');
      if (seen.length > 0) await store.set('seen', seen);
      return [];
    }

    const meetings = await listRecordings(http, auth, lookbackParam(new Date(lastPolledAt)));
    return meetings
      .map(toEvent)
      .filter((e): e is ZoomRecordingEvent => e !== null)
      .filter(isFullyProcessed);
  },
  /** Each recorded session has a unique meeting-instance UUID — dedupe on it. */
  dedupeKey: (event): string => event.uuid,
});
