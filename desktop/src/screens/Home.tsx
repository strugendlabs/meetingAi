// Home screen: past-meeting list + "New meeting" + Google Calendar sidebar
// (plan Task 10). Outside the Tauri runtime the SQLite layer is unavailable —
// loads fail soft into friendly notices instead of crashing.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "../App";
import CalendarSidebar from "../components/Calendar/CalendarSidebar";
import { createMeeting, getDb, listMeetings } from "../lib/db";
import { isTauri } from "../lib/tauri";
import type { Meeting } from "../lib/types";
import { STALE_LIVE_MEETING_MS } from "./MeetingView";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Notice for a failed history load. Outside Tauri the DB is unavailable by
 * design — keep the friendly hint. Inside the app a real failure (corrupt
 * meetingai.db, locked file, migration error) must show the actual cause, not
 * a message claiming the user isn't in the desktop app.
 */
export function historyErrorNotice(err: unknown, inTauri: boolean): string {
  return inTauri
    ? `Couldn't load meeting history: ${errorText(err)}`
    : "Meeting history is available in the desktop app.";
}

/** Same split for a failed meeting creation. */
export function createErrorNotice(err: unknown, inTauri: boolean): string {
  return inTauri
    ? `Couldn't start a meeting: ${errorText(err)}`
    : "Couldn't start a meeting — recording needs the MeetingAI desktop app.";
}

/**
 * Stamp ended_at on orphaned "live" rows (a crash or a failed Stop left
 * ended_at NULL). Without this they render as "Live · recording" forever and
 * MeetingView would silently start a brand-new capture when they're opened.
 * The recovered end time is the end of the meeting's last transcript segment
 * (t_start/t_end are ms since started_at), or started_at when it has none.
 */
export async function reconcileStaleLiveMeetings(now: number = Date.now()): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE meetings SET ended_at = started_at + COALESCE((SELECT MAX(COALESCE(t_end, t_start)) FROM transcript_segments WHERE meeting_id = meetings.id), 0) WHERE ended_at IS NULL AND started_at <= $1",
    [now - STALE_LIVE_MEETING_MS],
  );
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayLabel(startedAt: number): string {
  const d = new Date(startedAt);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  };
  if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function durationLabel(m: Meeting): string | null {
  if (!m.endedAt) return null;
  const mins = Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

function defaultTitle(): string {
  const d = new Date();
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Meeting · ${day} ${timeLabel(d.getTime())}`;
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M4 12h2.5M17.5 12H20M8 7v10M12 4.5v15M16 8.5v7" strokeLinecap="round" />
        </svg>
      </span>
      <span className="text-sm font-semibold tracking-tight">MeetingAI</span>
    </div>
  );
}

function MicIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className={className}
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21m-3.5 0h7" strokeLinecap="round" />
    </svg>
  );
}

function MeetingRow({ meeting, onOpen }: { meeting: Meeting; onOpen: () => void }) {
  const live = !meeting.endedAt;
  const duration = durationLabel(meeting);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3.5 rounded-xl border border-transparent px-3 py-3 text-left transition hover:border-neutral-200 hover:bg-neutral-50 dark:hover:border-neutral-800 dark:hover:bg-neutral-900"
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          live
            ? "bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400"
            : "bg-indigo-50 text-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-400"
        }`}
      >
        {live ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path
              d="M7 3.5h7.5L19.5 8.5V20a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5Z"
              strokeLinejoin="round"
            />
            <path d="M14 3.5V9h5.5M8.75 13h6.5m-6.5 3.5h4" strokeLinecap="round" />
          </svg>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{meeting.title}</span>
        <span className="mt-0.5 block text-xs text-neutral-400 dark:text-neutral-500">
          {timeLabel(meeting.startedAt)}
          {duration ? ` · ${duration}` : ""}
          {live ? " · recording" : ""}
        </span>
      </span>
      {live && (
        <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-600 dark:bg-red-500/15 dark:text-red-400">
          Live
        </span>
      )}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-4 w-4 shrink-0 text-neutral-300 transition group-hover:text-neutral-400 dark:text-neutral-700 dark:group-hover:text-neutral-500"
        aria-hidden="true"
      >
        <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export default function Home() {
  const { navigate } = useRouter();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [dbNotice, setDbNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Must finish before the list renders so orphaned rows never show as
        // "Live" (and never re-record when clicked).
        await reconcileStaleLiveMeetings();
      } catch (err) {
        // Best effort — a failed reconcile must not block the history list.
        if (isTauri()) console.error("reconcileStaleLiveMeetings failed", err);
      }
      try {
        const rows = await listMeetings();
        if (!cancelled) setMeetings(rows);
      } catch (err) {
        if (cancelled) return;
        if (isTauri()) console.error("listMeetings failed", err);
        setMeetings([]);
        setDbNotice(historyErrorNotice(err, isTauri()));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startMeeting = useCallback(
    async (title: string, calendarEventId?: string) => {
      if (creating) return;
      setCreating(true);
      setCreateError(null);
      try {
        const meeting = await createMeeting(title, calendarEventId);
        navigate({ name: "meeting", meetingId: meeting.id });
      } catch (err) {
        if (isTauri()) console.error("createMeeting failed", err);
        setCreateError(createErrorNotice(err, isTauri()));
        setCreating(false);
      }
    },
    [creating, navigate],
  );

  // Group meetings (already newest-first from the db) under day labels.
  const groups: Array<{ label: string; items: Meeting[] }> = [];
  for (const m of meetings ?? []) {
    const label = dayLabel(m.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(m);
    else groups.push({ label, items: [m] });
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-neutral-200/80 px-5 py-3 dark:border-neutral-800">
        <Logo />
        <button
          type="button"
          onClick={() => navigate({ name: "settings" })}
          title="Settings"
          aria-label="Settings"
          className="rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.02A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.02a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z" />
          </svg>
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-6 py-8">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Your meetings</h1>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  Transcribed, translated, and summarized — all on your computer.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void startMeeting(defaultTitle())}
                disabled={creating}
                className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <MicIcon className="h-4 w-4" />
                {creating ? "Starting…" : "New meeting"}
              </button>
            </div>

            {createError && (
              <p
                role="alert"
                className="mt-4 rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
              >
                {createError}
              </p>
            )}
            {dbNotice && !createError && (
              <p className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
                {dbNotice}
              </p>
            )}

            <div className="mt-8">
              {meetings === null && (
                <div className="space-y-2.5">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-16 animate-pulse rounded-xl bg-neutral-100 dark:bg-neutral-800/70"
                    />
                  ))}
                </div>
              )}

              {meetings !== null && meetings.length === 0 && (
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-neutral-300 px-6 py-14 text-center dark:border-neutral-700">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-400 dark:bg-indigo-500/10 dark:text-indigo-400">
                    <MicIcon className="h-6 w-6" />
                  </span>
                  <div>
                    <p className="text-sm font-medium">No meetings yet</p>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
                      Start your first meeting and watch the transcript appear live — the
                      summary lands the moment you stop.
                    </p>
                  </div>
                </div>
              )}

              {groups.map((group) => (
                <div key={group.label} className="mb-6">
                  <h2 className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                    {group.label}
                  </h2>
                  <div className="space-y-0.5">
                    {group.items.map((m) => (
                      <MeetingRow
                        key={m.id}
                        meeting={m}
                        onOpen={() => navigate({ name: "meeting", meetingId: m.id })}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>

        <aside className="hidden w-80 shrink-0 border-l border-neutral-200/80 dark:border-neutral-800 md:block">
          <CalendarSidebar
            onRecord={(title, calendarEventId) => void startMeeting(title, calendarEventId)}
            onOpenSettings={() => navigate({ name: "settings" })}
          />
        </aside>
      </div>
    </div>
  );
}
