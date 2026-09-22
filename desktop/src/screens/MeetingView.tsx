// Meeting view (plan Task 10): header with editable title, timer, status
// chip, per-meeting gender selector, translation toggle and Stop; left live
// transcript, right notes editor; on Stop the transcript is summarized into a
// SummaryCard with Markdown export.
//
// The screen serves both live meetings (no ended_at yet → a MeetingSession is
// started) and past meetings (read-only transcript + summary + notes).
// Outside the Tauri runtime the db/keychain calls fail or no-op — every path
// degrades to a friendly state instead of crashing.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "../App";
import ExportMenu from "../components/Meeting/ExportMenu";
import {
  buildExportBlocks,
  downloadBlob,
  meetingFileBase,
} from "../components/Meeting/exportData";
import AudioStatus from "../components/Meeting/AudioStatus";
import type { AudioSourceHealth } from "../lib/audioHealth";
import NotesPane from "../components/Meeting/NotesPane";
import StatusBar, { sanitizeDetail } from "../components/Meeting/StatusBar";
import SummaryCard from "../components/Meeting/SummaryCard";
import TranscriptPane, { formatTimestamp } from "../components/Meeting/TranscriptPane";
import { resolveGeminiApiKey } from "../lib/adminConfig";
import { endMeeting, getDb, getMeetingFull, saveSummary, updateSegmentTranslation } from "../lib/db";
import { summarizeWithProvider, translateWithProvider } from "../lib/ai";
import { isLocalAI } from "../lib/localAi";
import { languageLabel } from "../lib/languages";
import { MeetingSession, type MeetingStatus } from "../lib/meetingSession";
import { getSettings } from "../lib/settings";
import { isTauri, safeInvoke } from "../lib/tauri";
import { transcriptTurns } from "../lib/transcript";
import type {
  Meeting,
  MeetingSummary,
  TranscriptSegment,
} from "../lib/types";

type Phase = "loading" | "missing" | "loaderror" | "live" | "ended";
type ExportState = "idle" | "working" | "done" | "copied" | "failed";

const EXPORT_LABEL: Record<ExportState, string> = {
  idle: "Export",
  working: "Exporting…",
  done: "Exported",
  copied: "Copied to clipboard",
  failed: "Export failed",
};

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A live-looking meeting (ended_at NULL) older than this is treated as
 * orphaned — a crash or a failed Stop left it open — and must never
 * auto-start a new recording when opened. Home stamps such rows via
 * reconcileStaleLiveMeetings before rendering; this constant keeps the two
 * sides in sync.
 */
export const STALE_LIVE_MEETING_MS = 5 * 60_000;

/** True when a meeting still has no ended_at but is too old to be live. */
export function isStaleLiveMeeting(meeting: Meeting, now: number): boolean {
  return !meeting.endedAt && now - meeting.startedAt >= STALE_LIVE_MEETING_MS;
}

/**
 * Best plausible end time for a meeting whose ended_at write was lost:
 * the end of its last transcript segment (or its start when empty).
 */
export function recoveredEndedAt(meeting: Meeting, segments: TranscriptSegment[]): number {
  const last = segments.reduce((mx, s) => Math.max(mx, s.tEnd ?? s.tStart), 0);
  return meeting.startedAt + last;
}

/** Meetings the user ended in this app run (even if the DB write failed). */
const endedThisRun = new Set<string>();

/** Write ended_at with an explicit timestamp; false when persistence failed. */
export async function stampMeetingEnd(meetingId: string, endedAt: number): Promise<boolean> {
  try {
    const db = await getDb();
    await db.execute("UPDATE meetings SET ended_at = $1 WHERE id = $2", [endedAt, meetingId]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the live session (if any) and persist the meeting end.
 * Teardown and the ended_at write are separated so a capture-teardown failure
 * can never silently skip the DB write — otherwise the row stays "Live"
 * forever and re-records when reopened. Returns whether ended_at was saved.
 */
export async function persistMeetingEnd(
  session: Pick<MeetingSession, "stop"> | null,
  meetingId: string,
): Promise<boolean> {
  try {
    if (session) await session.stop();
  } catch {
    // Teardown failure must not block persisting the end time below.
  }
  try {
    await endMeeting(meetingId);
    return true;
  } catch {
    return false;
  }
}

/** Persist the generated summary; false when the write failed. */
export async function persistSummary(
  meetingId: string,
  summary: MeetingSummary,
): Promise<boolean> {
  try {
    await saveSummary(meetingId, summary);
    return true;
  } catch {
    return false;
  }
}

/** Flip `index` in a sorted list of completed action-item indices. */
export function toggleCompletedIndex(current: number[], index: number): number[] {
  const set = new Set(current);
  if (set.has(index)) set.delete(index);
  else set.add(index);
  return Array.from(set).sort((a, b) => a - b);
}

/** Persist a meeting rename; false when the write failed. */
export async function persistTitle(meetingId: string, title: string): Promise<boolean> {
  try {
    const db = await getDb();
    await db.execute("UPDATE meetings SET title = $1 WHERE id = $2", [title, meetingId]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the Gemini API key: Keychain (user-entered) first, then the
 * admin-provisioned .env default. Distinguishes "no key anywhere" (key null,
 * error null) from "the Keychain read itself failed with no admin fallback"
 * (error set) — e.g. the user denied the macOS Keychain access prompt. The
 * two need different remediation, so the error must not be collapsed into
 * "no key". A Keychain failure is irrelevant when an admin key covers it.
 */
export async function readGeminiKey(): Promise<{ key: string | null; error: string | null }> {
  if (isLocalAI(getSettings())) return { key: null, error: null };
  const resolved = await resolveGeminiApiKey(getSettings().hasUserGeminiKey);
  if (resolved.key) return { key: resolved.key, error: null };
  return { key: null, error: resolved.keychainError ?? null };
}

/** Render one action item as a Markdown checkbox line, checked when done. */
export function actionItemMarkdownLine(item: string, done: boolean): string {
  return `- [${done ? "x" : " "}] ${item}`;
}

function buildMarkdown(
  meeting: Meeting,
  summary: MeetingSummary | null,
  notes: string,
  segments: TranscriptSegment[],
): string {
  const lines: string[] = [`# ${meeting.title}`, ""];
  const started = new Date(meeting.startedAt).toLocaleString();
  const duration = meeting.endedAt
    ? ` · ${formatDuration(meeting.endedAt - meeting.startedAt)}`
    : "";
  lines.push(`*${started}${duration}*`, "");
  if (summary) {
    lines.push("## Summary", "", summary.summary, "");
    if (summary.actionItems.length > 0) {
      const completed = new Set(summary.completedActionItems ?? []);
      lines.push(
        "## Action items",
        "",
        ...summary.actionItems.map((a, i) => actionItemMarkdownLine(a, completed.has(i))),
        "",
      );
    }
    if (summary.keyNotes.length > 0) {
      lines.push("## Key notes", "", ...summary.keyNotes.map((k) => `- ${k}`), "");
    }
  }
  if (notes.trim().length > 0) lines.push("## Your notes", "", notes.trim(), "");
  const finals = transcriptTurns(segments.filter((s) => s.final));
  if (finals.length > 0) {
    lines.push("## Transcript", "");
    for (const s of finals) {
      const who = s.speaker === "me" ? "Me" : "Them";
      lines.push(`- **${who}** \`${formatTimestamp(s.tStart)}\` ${s.text.trim()}`);
      if (s.translatedText) lines.push(`  - _${s.translatedText}_`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Markdown containing only the AI summary (summary paragraph, action items,
 * key notes) — no user notes, no transcript. A separate, additional export
 * from buildMarkdown's full-meeting output, not a truncated version of it.
 */
export function buildSummaryMarkdown(meeting: Meeting, summary: MeetingSummary): string {
  const lines: string[] = [`# ${meeting.title}`, ""];
  const started = new Date(meeting.startedAt).toLocaleString();
  const duration = meeting.endedAt
    ? ` · ${formatDuration(meeting.endedAt - meeting.startedAt)}`
    : "";
  lines.push(`*${started}${duration}*`, "");
  lines.push("## Summary", "", summary.summary, "");
  if (summary.actionItems.length > 0) {
    const completed = new Set(summary.completedActionItems ?? []);
    lines.push(
      "## Action items",
      "",
      ...summary.actionItems.map((a, i) => actionItemMarkdownLine(a, completed.has(i))),
      "",
    );
  }
  if (summary.keyNotes.length > 0) {
    lines.push("## Key notes", "", ...summary.keyNotes.map((k) => `- ${k}`), "");
  }
  return lines.join("\n");
}

function GlobeIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 3.75 5.3 3.75 8.5S14.5 18.1 12 20.5c-2.5-2.4-3.75-5.3-3.75-8.5S9.5 5.9 12 3.5Z" />
    </svg>
  );
}

function CenteredMessage({
  title,
  body,
  onBack,
}: {
  title: string;
  body: string;
  onBack: () => void;
}) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 px-8 text-center">
      <div>
        <p className="text-base font-semibold">{title}</p>
        <p className="mt-1.5 max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{body}</p>
      </div>
      <button
        type="button"
        onClick={onBack}
        className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500"
      >
        Back to home
      </button>
    </div>
  );
}

export default function MeetingView({ meetingId }: { meetingId: string }) {
  const { navigate } = useRouter();

  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [title, setTitle] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<MeetingStatus>("connecting");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [audioSources, setAudioSources] = useState<AudioSourceHealth[]>([]);
  const [sideTab, setSideTab] = useState<"summary" | "notes">("summary");
  const [translationProgress, setTranslationProgress] = useState<string | null>(null);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const translatingRef = useRef(false);
  const translationRunRef = useRef(0);
  useEffect(() => () => { translationRunRef.current += 1; }, [meetingId]);
  const [showTranslations, setShowTranslations] = useState(
    () => getSettings().translationEnabled,
  );
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [endSaveFailed, setEndSaveFailed] = useState(false);
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summarySaveFailed, setSummarySaveFailed] = useState(false);
  const [titleSaveFailed, setTitleSaveFailed] = useState(false);
  const [exportState, setExportState] = useState<ExportState>("idle");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const sessionRef = useRef<MeetingSession | null>(null);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const apiKeyRef = useRef<string | null>(null);

  // Saved meetings are readable without credentials. Resolve a key only when
  // starting capture or when the user asks for an AI operation.
  const ensureGeminiKey = useCallback(async () => {
    if (apiKeyRef.current) return { key: apiKeyRef.current, error: null };
    const resolved = await readGeminiKey();
    apiKeyRef.current = resolved.key;
    setApiKey(resolved.key);
    setApiKeyError(resolved.error);
    return resolved;
  }, []);

  const upsertSegment = useCallback((seg: TranscriptSegment) => {
    // Update the ref synchronously so Stop's summary includes final callbacks
    // even before React renders their state updates.
    const prev = segmentsRef.current;
    const idx = prev.findIndex((s) => s.id === seg.id);
    const next = idx === -1 ? [...prev, seg] : prev.map((s, i) => (i === idx ? seg : s));
    next.sort((a, b) => a.tStart - b.tStart);
    segmentsRef.current = next;
    setSegments(next);
  }, []);

  // Load the meeting; when it has not ended, start the live session.
  // StrictMode-safe: the cleanup of a cancelled mount runs before the session
  // is created, so no spurious stop()/endMeeting() fires in dev double-mount.
  useEffect(() => {
    let cancelled = false;
    let localSession: MeetingSession | null = null;

    (async () => {
      apiKeyRef.current = null;
      setApiKey(null);
      setApiKeyError(null);

      let full: Awaited<ReturnType<typeof getMeetingFull>>;
      try {
        full = await getMeetingFull(meetingId);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setPhase("loaderror");
        }
        return;
      }
      if (cancelled) return;
      if (!full) {
        setPhase("missing");
        return;
      }

      setMeeting(full.meeting);
      setTitle(full.meeting.title);
      segmentsRef.current = full.segments;
      setSegments(full.segments);
      setNotes(full.userNotes);
      setSummary(full.summary ?? null);

      const locallyEnded = endedThisRun.has(meetingId);
      if (full.meeting.endedAt || locallyEnded || isStaleLiveMeeting(full.meeting, Date.now())) {
        if (!full.meeting.endedAt) {
          // The row still says live but the meeting is over (a failed Stop or
          // a crash left ended_at unset) — show it as ended instead of
          // silently starting a brand-new recording for it.
          setMeeting({
            ...full.meeting,
            endedAt: recoveredEndedAt(full.meeting, full.segments),
          });
          if (locallyEnded && isTauri()) setEndSaveFailed(true);
        }
        setPhase("ended");
        return;
      }

      const { key, error: keyErr } = await readGeminiKey();
      if (cancelled) return;
      apiKeyRef.current = key;
      setApiKey(key);
      setApiKeyError(keyErr);
      setPhase("live");
      setSideTab("notes");
      if (!key && !isLocalAI(getSettings())) {
        setStatus("error");
        setStatusDetail(
          keyErr
            ? `Couldn't read the Gemini API key from the Keychain (${keyErr}).`
            : "No Gemini API key — add one in Settings to enable transcription.",
        );
        return;
      }
      const session = new MeetingSession(key ?? "", getSettings(), full.meeting, {
        onAudioHealth: (sources) => { if (!cancelled) setAudioSources(sources); },
        onSegment: (seg) => {
          if (!cancelled) upsertSegment(seg);
        },
        onStatus: (s, detail) => {
          if (cancelled) return;
          setStatus(s);
          setStatusDetail(detail ?? null);
        },
      });
      localSession = session;
      sessionRef.current = session;
      try {
        await session.start();
      } catch {
        // The session already surfaced the failure via onStatus("error").
      }
    })();

    return () => {
      cancelled = true;
      if (localSession) {
        if (sessionRef.current === localSession) sessionRef.current = null;
        void localSession.stop();
      }
    };
  }, [meetingId, upsertSegment, loadAttempt]);

  /** Re-run the load effect (used to retry a failed Keychain key read). */
  const retryLoad = useCallback(() => {
    setPhase("loading");
    setStatus("connecting");
    setStatusDetail(null);
    setLoadAttempt((n) => n + 1);
  }, []);

  const unlockAndRetry = useCallback(async () => {
    try {
      await safeInvoke<boolean>("keychain_unlock", { key: "gemini_api_key" });
      retryLoad();
    } catch (e) {
      setApiKeyError(e instanceof Error ? e.message : String(e));
    }
  }, [retryLoad]);

  // Meeting timer tick.
  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const runSummarize = useCallback(async () => {
    const finals = transcriptTurns(segmentsRef.current.filter((s) => s.final));
    if (finals.length === 0) return;
    setSummarizing(true);
    setSummaryError(null);
    setSummarySaveFailed(false);
    const transcript = finals
      .map((s) => `${s.speaker === "me" ? "Me" : "Them"}: ${s.text.trim()}`)
      .join("\n");
    const language = languageLabel(getSettings().userLanguage);
    try {
      const { key, error } = await ensureGeminiKey();
      if (!key && !isLocalAI(getSettings())) {
        throw new Error(error ? "Unlock your saved Gemini key in Settings to generate summaries." : "Add a Gemini API key in Settings to generate summaries.");
      }
      let out: Awaited<ReturnType<typeof summarizeWithProvider>>;
      try {
        out = await summarizeWithProvider(key, getSettings(), transcript, language);
      } catch {
        // Spec §5: retry once, then give up (raw transcript stays persisted).
        out = await summarizeWithProvider(key, getSettings(), transcript, language);
      }
      setSummary(out.result);
      // Surface a failed write: the summary renders from state either way, but
      // it would silently vanish on reopen if the user is never told.
      const saved = await persistSummary(meetingId, out.result);
      setSummarySaveFailed(!saved && isTauri());
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : String(e));
    } finally {
      setSummarizing(false);
    }
  }, [meetingId, ensureGeminiKey]);

  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    const session = sessionRef.current;
    sessionRef.current = null;
    const persisted = await persistMeetingEnd(session, meetingId);
    endedThisRun.add(meetingId);
    // Outside Tauri persistence is unavailable by design — stay quiet there,
    // but inside the app a failed write must be surfaced: the meeting would
    // show as "Live" in history and re-record when reopened.
    setEndSaveFailed(!persisted && isTauri());
    const endedAt = Date.now();
    setMeeting((m) => (m ? { ...m, endedAt } : m));
    setPhase("ended");
    setSideTab("summary");
    setStopping(false);
    void runSummarize();
  }, [stopping, meetingId, runSummarize]);

  const retryEndSave = useCallback(async () => {
    const ok = await stampMeetingEnd(meetingId, meeting?.endedAt ?? Date.now());
    if (ok) setEndSaveFailed(false);
  }, [meetingId, meeting?.endedAt]);

  const commitTitle = useCallback(() => {
    if (!meeting) return;
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setTitle(meeting.title);
      return;
    }
    if (trimmed === meeting.title) {
      setTitle(trimmed);
      return;
    }
    const prev = meeting.title;
    const id = meeting.id;
    setMeeting({ ...meeting, title: trimmed });
    setTitle(trimmed);
    void persistTitle(id, trimmed).then((ok) => {
      // Outside Tauri the write always fails by design; keep the local rename.
      if (ok || !isTauri()) return;
      // Revert the optimistic rename and tell the user it didn't stick —
      // otherwise the old title silently reappears on reopen.
      setMeeting((m) => (m && m.id === id ? { ...m, title: prev } : m));
      setTitle(prev);
      setTitleSaveFailed(true);
      setTimeout(() => setTitleSaveFailed(false), 3000);
    });
  }, [meeting, title]);

  // Checked state must survive closing and reopening the meeting, so every
  // toggle is persisted immediately (lists are short — no debounce needed).
  // A failed write gets the same honest-failure treatment as a failed
  // summary save: it renders locally but a banner says it won't stick.
  const toggleActionItem = useCallback(
    (index: number) => {
      if (!summary) return;
      const next: MeetingSummary = {
        ...summary,
        completedActionItems: toggleCompletedIndex(summary.completedActionItems ?? [], index),
      };
      setSummary(next);
      void persistSummary(meetingId, next).then((ok) => {
        setSummarySaveFailed(!ok && isTauri());
      });
    },
    [summary, meetingId],
  );

  const flashExportState = useCallback((state: ExportState) => {
    setExportState(state);
    setTimeout(() => setExportState("idle"), 2500);
  }, []);

  const handleExportFullMarkdown = useCallback(() => {
    if (!meeting) return;
    const md = buildMarkdown(meeting, summary, notes, segmentsRef.current);
    const base = meetingFileBase(meeting.title);
    try {
      downloadBlob(new Blob([md], { type: "text/markdown" }), `${base}.md`);
      flashExportState("done");
    } catch {
      void navigator.clipboard?.writeText(md).then(
        () => flashExportState("copied"),
        () => flashExportState("failed"),
      );
    }
  }, [meeting, summary, notes, flashExportState]);

  const handleExportFullPdf = useCallback(async () => {
    if (!meeting) return;
    setExportState("working");
    try {
      const { renderExportPdf } = await import("../components/Meeting/exportPdf");
      const base = meetingFileBase(meeting.title);
      const blocks = buildExportBlocks(meeting, summary, notes, segmentsRef.current, "full");
      downloadBlob(await renderExportPdf(blocks), `${base}.pdf`);
      flashExportState("done");
    } catch {
      flashExportState("failed");
    }
  }, [meeting, summary, notes, flashExportState]);

  const handleExportFullDocx = useCallback(async () => {
    if (!meeting) return;
    try {
      const { buildExportDocx, docxToBlob } = await import(
        "../components/Meeting/exportDocx"
      );
      const base = meetingFileBase(meeting.title);
      const blocks = buildExportBlocks(meeting, summary, notes, segmentsRef.current, "full");
      const blob = await docxToBlob(buildExportDocx(blocks));
      downloadBlob(blob, `${base}.docx`);
      flashExportState("done");
    } catch {
      flashExportState("failed");
    }
  }, [meeting, summary, notes, flashExportState]);

  const handleExportSummaryMarkdown = useCallback(() => {
    if (!meeting || !summary) return;
    const md = buildSummaryMarkdown(meeting, summary);
    const base = meetingFileBase(meeting.title);
    try {
      downloadBlob(new Blob([md], { type: "text/markdown" }), `${base}-summary.md`);
      flashExportState("done");
    } catch {
      void navigator.clipboard?.writeText(md).then(
        () => flashExportState("copied"),
        () => flashExportState("failed"),
      );
    }
  }, [meeting, summary, flashExportState]);

  const handleExportSummaryPdf = useCallback(async () => {
    if (!meeting || !summary) return;
    setExportState("working");
    try {
      const { renderExportPdf } = await import("../components/Meeting/exportPdf");
      const base = meetingFileBase(meeting.title);
      const blocks = buildExportBlocks(meeting, summary, "", [], "summary");
      downloadBlob(await renderExportPdf(blocks), `${base}-summary.pdf`);
      flashExportState("done");
    } catch {
      flashExportState("failed");
    }
  }, [meeting, summary, flashExportState]);

  const translateTranscript = useCallback(async () => {
    if (translatingRef.current) return;
    const pending = segmentsRef.current.filter((s) => s.final && s.text.trim() && !s.translatedText);
    const translationRun = ++translationRunRef.current;
    translatingRef.current = true;
    setTranslationError(null);
    setShowTranslations(true);
    let completed = 0;
    try {
      const { key, error } = await ensureGeminiKey();
      if (!key && !isLocalAI(getSettings())) {
        throw new Error(error ? "Unlock your saved Gemini key in Settings to translate this meeting." : "Add your Gemini API key in Settings to translate this meeting.");
      }
      for (const segment of pending) {
        setTranslationProgress(`Translating ${completed + 1} of ${pending.length}…`);
        const translatedText = await translateWithProvider(key, getSettings(), segment.text, languageLabel(getSettings().userLanguage));
        if (translationRun !== translationRunRef.current) return;
        await updateSegmentTranslation(segment.id, translatedText);
        upsertSegment({ ...segment, translatedText });
        completed += 1;
      }
    } catch (e) {
      setTranslationError(`Translation paused after ${completed} lines. Completed lines are saved; retry to continue. ${sanitizeDetail(e instanceof Error ? e.message : String(e))}`);
    } finally {
      translatingRef.current = false;
      setTranslationProgress(null);
    }
  }, [upsertSegment, ensureGeminiKey]);

  if (phase === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-indigo-600 dark:border-neutral-700 dark:border-t-indigo-400" />
      </div>
    );
  }
  if (phase === "missing") {
    return (
      <CenteredMessage
        title="Meeting not found"
        body="This meeting doesn't exist anymore — it may have been deleted."
        onBack={() => navigate({ name: "home" })}
      />
    );
  }
  if (phase === "loaderror" || !meeting) {
    return (
      <CenteredMessage
        title="Couldn't open this meeting"
        body={loadError ?? "Meeting storage is available in the desktop app."}
        onBack={() => navigate({ name: "home" })}
      />
    );
  }

  const live = phase === "live";
  const local = isLocalAI(getSettings());
  const elapsedMs = (meeting.endedAt ?? (live ? now : meeting.startedAt)) - meeting.startedAt;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200/80 px-5 py-4 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => navigate({ name: "home" })}
          title="Back to home"
          aria-label="Back to home"
          className="shrink-0 rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="Untitled meeting"
          aria-label="Meeting title"
          className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1 py-0.5 text-base font-semibold tracking-tight outline-none transition focus:bg-neutral-100 dark:focus:bg-neutral-800/70"
        />

        {titleSaveFailed && (
          <span role="alert" className="shrink-0 text-xs font-medium text-red-600 dark:text-red-400">
            Couldn't save title
          </span>
        )}

        <StatusBar status={live ? status : segments.length ? "ended" : "empty"} />
        <span className="shrink-0 font-mono text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
          {formatDuration(elapsedMs)}
        </span>


        {live ? (
          <button
            type="button"
            onClick={() => void handleStop()}
            disabled={stopping}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-red-500 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="h-2.5 w-2.5 rounded-[3px] bg-white" aria-hidden="true" />
            {stopping ? "Finishing transcript…" : "Stop"}
          </button>
        ) : (
          <ExportMenu
            disabled={exportState === "working"}
            label={EXPORT_LABEL[exportState]}
            groups={[
              {
                items: [
                  { key: "full-md", label: "Full meeting — Markdown", onSelect: handleExportFullMarkdown },
                  { key: "full-pdf", label: "Full meeting — PDF", onSelect: handleExportFullPdf },
                  { key: "full-docx", label: "Full meeting — Word", onSelect: handleExportFullDocx },
                ],
              },
              ...(summary
                ? [
                    {
                      items: [
                        {
                          key: "summary-md",
                          label: "Summary — Markdown",
                          onSelect: handleExportSummaryMarkdown,
                        },
                        { key: "summary-pdf", label: "Summary — PDF", onSelect: handleExportSummaryPdf },
                      ],
                    },
                  ]
                : []),
            ]}
          />
        )}
      </header>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-neutral-200/70 px-5 py-2.5 text-xs dark:border-neutral-800">
        <span className="text-neutral-500 dark:text-neutral-400">{new Date(meeting.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} · {live ? (local ? "Local speech · Whisper + Ollama" : "Gemini · your API key") : "Saved on this device"}</span>
        <div className="flex items-center gap-3">
          {live && !local && <span className="text-neutral-500">Voice translation {getSettings().translationEnabled ? `→ ${languageLabel(getSettings().userLanguage)}` : "off"}</span>}
          {segments.some((s) => s.translatedText) && <button type="button" aria-pressed={showTranslations} onClick={() => setShowTranslations((v) => !v)} className="font-medium text-indigo-600 dark:text-indigo-400">{showTranslations ? "Hide translations" : "Show translations"}</button>}
          {!live && segments.some((s) => s.final && !s.translatedText) && <button type="button" disabled={!!translationProgress} onClick={() => void translateTranscript()} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 px-2.5 py-1.5 font-medium text-indigo-600 disabled:opacity-60 dark:bg-indigo-500/10 dark:text-indigo-400"><GlobeIcon className="h-3.5 w-3.5" />{translationProgress ?? `Translate to ${languageLabel(getSettings().userLanguage)}`}</button>}
        </div>
      </div>
      {live && (apiKey || local) && statusDetail && <div role="status" className="shrink-0 border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-xs leading-relaxed text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">{sanitizeDetail(statusDetail)}</div>}
      {translationError && <p role="alert" className="shrink-0 bg-amber-50 px-5 py-2.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{translationError}</p>}

      {live && !apiKey && !local && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300/60 bg-amber-50 px-4 py-2 dark:border-amber-500/20 dark:bg-amber-500/10">
          <p className="text-xs text-amber-800 dark:text-amber-300" title={apiKeyError ?? undefined}>
            {apiKeyError
              ? "Your saved Gemini key needs access. Unlock it to start transcription. If macOS asks, choose Always Allow to remember this app."
              : "No Gemini API key — transcription and translation are off for this meeting."}
          </p>
          {apiKeyError ? (
            <button
              type="button"
              onClick={() => void unlockAndRetry()}
              className="shrink-0 text-xs font-semibold text-amber-800 underline-offset-2 hover:underline dark:text-amber-300"
            >
              Unlock saved key
            </button>
          ) : (
            <button
              type="button"
              onClick={() => navigate({ name: "settings" })}
              className="shrink-0 text-xs font-semibold text-amber-800 underline-offset-2 hover:underline dark:text-amber-300"
            >
              Open Settings
            </button>
          )}
        </div>
      )}

      {phase === "ended" && endSaveFailed && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300/60 bg-amber-50 px-4 py-2 dark:border-amber-500/20 dark:bg-amber-500/10">
          <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">
            Couldn't save the meeting end time — this meeting may still show as Live in your
            history.
          </p>
          <button
            type="button"
            onClick={() => void retryEndSave()}
            className="shrink-0 text-xs font-semibold text-amber-800 underline-offset-2 hover:underline dark:text-amber-300"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col" aria-label="Live transcript">
          {live && <AudioStatus sources={audioSources}
            onRetry={async (speaker) => { await sessionRef.current?.retryAudio(speaker); }}
            onMicrophoneChange={async (deviceId) => { await sessionRef.current?.selectMicrophone(deviceId); }} />}
          <div className="min-h-0 flex-1">
          <TranscriptPane segments={segments} showTranslations={showTranslations} live={live} />
          </div>
        </section>

        <aside className="flex w-[20rem] shrink-0 flex-col bg-neutral-50/50 dark:bg-neutral-900/20 border-l border-neutral-200/80 dark:border-neutral-800 xl:w-[24rem]">
          <div className="flex shrink-0 gap-1 border-b border-neutral-200/70 p-3 dark:border-neutral-800" aria-label="Meeting details">
            {(["summary", "notes"] as const).map((tab) => <button key={tab} type="button" aria-pressed={sideTab === tab} onClick={() => setSideTab(tab)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium transition ${sideTab === tab ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-white" : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"}`}>{tab === "summary" ? "AI summary" : "Your notes"}</button>)}
          </div>
          {sideTab === "summary" && phase === "live" && <div className="p-6 text-center"><p className="text-sm font-medium">Stay in the conversation</p><p className="mt-2 text-xs leading-relaxed text-neutral-500">Your summary, decisions and action items will appear here when you finish the meeting.</p></div>}
          {phase === "ended" && sideTab === "summary" && (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {summary ? (
                <>
                  <SummaryCard
                    summary={summary}
                    completedIndices={new Set(summary.completedActionItems ?? [])}
                    onToggle={toggleActionItem}
                    onRegenerate={() => void runSummarize()}
                    regenerating={summarizing}
                  />
                  {summarySaveFailed && (
                    <p
                      role="alert"
                      className="mt-2 rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                    >
                      Summary couldn't be saved — recent changes won't be here when you
                      reopen this meeting. Export .md to keep a copy.
                    </p>
                  )}
                </>
              ) : summarizing ? (
                <div
                  className="space-y-2.5 rounded-2xl border border-indigo-200/70 bg-indigo-50/50 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/[.07]"
                  aria-label="Generating summary"
                >
                  <p className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
                    Summarizing your meeting…
                  </p>
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="h-3 animate-pulse rounded bg-indigo-200/70 dark:bg-indigo-500/20"
                      style={{ width: `${90 - i * 18}%` }}
                    />
                  ))}
                </div>
              ) : summaryError ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-500/20 dark:bg-red-500/10">
                  <p className="text-sm font-medium text-red-700 dark:text-red-300">
                    Summary failed
                  </p>
                  <p className="mt-1 break-words text-xs leading-relaxed text-red-600/90 dark:text-red-400/90">
                    {summaryError}
                  </p>
                  <button
                    type="button"
                    onClick={() => void runSummarize()}
                    className="mt-2.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500"
                  >
                    Try again
                  </button>
                </div>
              ) : segments.some((s) => s.final && s.text.trim().length > 0) ? (
                <button
                  type="button"
                  onClick={() => void runSummarize()}
                  className="w-full rounded-2xl border border-dashed border-indigo-300 px-4 py-3 text-sm font-medium text-indigo-600 transition hover:bg-indigo-50 dark:border-indigo-500/40 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
                >
                  Generate AI summary
                </button>
              ) : (
                <p className="rounded-2xl border border-dashed border-neutral-300 px-4 py-3 text-center text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
                  No transcript captured — nothing to summarize.
                </p>
              )}
            </div>
          )}
          <div className={sideTab === "notes" ? "min-h-0 flex-1" : "hidden"}><NotesPane meetingId={meeting.id} value={notes} onChange={setNotes} /></div>
        </aside>
      </div>
    </div>
  );
}
