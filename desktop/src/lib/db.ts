// SQLite data layer (Task 6). Schema is created by the Rust-side migrations
// registered in `src-tauri/src/db.rs`; the URL below must stay in sync.

import Database from "@tauri-apps/plugin-sql";
import type {
  Meeting,
  MeetingSummary,
  Speaker,
  TranscriptSegment,
} from "./types";

export const DB_URL = "sqlite:meetingai.db";

export interface MeetingFull {
  meeting: Meeting;
  segments: TranscriptSegment[];
  summary?: MeetingSummary;
  userNotes: string;
}

interface MeetingRow {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  calendar_event_id: string | null;
  summary_json: string | null;
  user_notes: string | null;
}

interface SegmentRow {
  id: string;
  meeting_id: string;
  speaker: string;
  text: string;
  translated_text: string | null;
  lang: string | null;
  t_start: number;
  t_end: number | null;
  final: number;
}

let dbPromise: Promise<Database> | null = null;

/** Lazily open (and cache) the app database connection. */
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL);
    // A failed open must not poison the cache forever — clear it so the next
    // call retries instead of every future DB operation failing instantly.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

/** Test hook: drop the cached connection so mocks can be re-installed. */
export function __resetDbForTests(): void {
  dbPromise = null;
}

function rowToMeeting(row: MeetingRow): Meeting {
  const meeting: Meeting = {
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
  };
  if (row.ended_at !== null) meeting.endedAt = row.ended_at;
  if (row.calendar_event_id !== null) {
    meeting.calendarEventId = row.calendar_event_id;
  }
  return meeting;
}

function rowToSegment(row: SegmentRow): TranscriptSegment {
  const seg: TranscriptSegment = {
    id: row.id,
    meetingId: row.meeting_id,
    speaker: row.speaker as Speaker,
    text: row.text,
    tStart: row.t_start,
    final: row.final !== 0,
  };
  if (row.translated_text !== null) seg.translatedText = row.translated_text;
  if (row.lang !== null) seg.lang = row.lang;
  if (row.t_end !== null) seg.tEnd = row.t_end;
  return seg;
}

export async function createMeeting(
  title: string,
  calendarEventId?: string,
): Promise<Meeting> {
  const db = await getDb();
  const meeting: Meeting = {
    id: crypto.randomUUID(),
    title,
    startedAt: Date.now(),
  };
  if (calendarEventId) meeting.calendarEventId = calendarEventId;
  await db.execute(
    "INSERT INTO meetings (id, title, started_at, calendar_event_id) VALUES ($1, $2, $3, $4)",
    [meeting.id, meeting.title, meeting.startedAt, calendarEventId ?? null],
  );
  return meeting;
}

export async function endMeeting(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE meetings SET ended_at = $1 WHERE id = $2", [
    Date.now(),
    id,
  ]);
}

export async function addSegment(seg: TranscriptSegment): Promise<void> {
  const db = await getDb();
  // OR REPLACE: a segment finalized after an interim insert keeps the same id.
  await db.execute(
    "INSERT OR REPLACE INTO transcript_segments (id, meeting_id, speaker, text, translated_text, lang, t_start, t_end, final) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      seg.id,
      seg.meetingId,
      seg.speaker,
      seg.text,
      seg.translatedText ?? null,
      seg.lang ?? null,
      seg.tStart,
      seg.tEnd ?? null,
      seg.final ? 1 : 0,
    ],
  );
}

export async function updateSegmentTranslation(
  id: string,
  translated: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE transcript_segments SET translated_text = $1 WHERE id = $2",
    [translated, id],
  );
}

export async function saveSummary(
  meetingId: string,
  s: MeetingSummary,
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE meetings SET summary_json = $1 WHERE id = $2", [
    JSON.stringify(s),
    meetingId,
  ]);
}

export async function saveUserNotes(
  meetingId: string,
  notes: string,
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE meetings SET user_notes = $1 WHERE id = $2", [
    notes,
    meetingId,
  ]);
}

export async function listMeetings(): Promise<Meeting[]> {
  const db = await getDb();
  const rows = await db.select<MeetingRow[]>(
    "SELECT id, title, started_at, ended_at, calendar_event_id, summary_json, user_notes FROM meetings ORDER BY started_at DESC",
  );
  return rows.map(rowToMeeting);
}

export async function getMeetingFull(id: string): Promise<MeetingFull | null> {
  const db = await getDb();
  const rows = await db.select<MeetingRow[]>(
    "SELECT id, title, started_at, ended_at, calendar_event_id, summary_json, user_notes FROM meetings WHERE id = $1",
    [id],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const segRows = await db.select<SegmentRow[]>(
    "SELECT id, meeting_id, speaker, text, translated_text, lang, t_start, t_end, final FROM transcript_segments WHERE meeting_id = $1 ORDER BY t_start ASC",
    [id],
  );

  let summary: MeetingSummary | undefined;
  if (row.summary_json) {
    try {
      summary = JSON.parse(row.summary_json) as MeetingSummary;
    } catch {
      summary = undefined; // corrupt JSON must not break meeting load
    }
  }

  const full: MeetingFull = {
    meeting: rowToMeeting(row),
    segments: segRows.map(rowToSegment),
    userNotes: row.user_notes ?? "",
  };
  if (summary) full.summary = summary;
  return full;
}
