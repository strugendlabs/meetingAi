// Lightweight, renderer-agnostic export helpers. Keep this module free of
// jsPDF/docx imports so opening a meeting does not download the export engines;
// the heavy renderers are loaded only after the user chooses PDF or Word.

import { formatTimestamp, transcriptTurns } from "../../lib/transcript";
import type { Meeting, MeetingSummary, TranscriptSegment } from "../../lib/types";

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Filesystem-safe base name for exported files, shared across every format. */
export function meetingFileBase(title: string): string {
  return (
    title
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "meeting"
  );
}

/** Trigger a browser download for an in-memory blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type ExportBlock =
  | { kind: "title"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "checkbox"; text: string; checked: boolean }
  | { kind: "transcriptLine"; text: string; speaker: string; timestamp: string }
  | { kind: "translationLine"; text: string };

export type ExportScope = "full" | "summary";

/**
 * Shapes a meeting's data into an ordered list of layout-agnostic blocks —
 * the single source of truth used by the PDF and Word renderers.
 */
export function buildExportBlocks(
  meeting: Meeting,
  summary: MeetingSummary | null,
  notes: string,
  segments: TranscriptSegment[],
  scope: ExportScope,
): ExportBlock[] {
  const blocks: ExportBlock[] = [{ kind: "title", text: meeting.title || "Untitled meeting" }];

  const started = new Date(meeting.startedAt).toLocaleString();
  const duration = meeting.endedAt
    ? ` · ${formatDuration(meeting.endedAt - meeting.startedAt)}`
    : "";
  blocks.push({ kind: "meta", text: `${started}${duration}` });

  if (summary) {
    blocks.push({ kind: "heading", text: "Summary" });
    blocks.push({ kind: "paragraph", text: summary.summary });

    if (summary.actionItems.length > 0) {
      const completed = new Set(summary.completedActionItems ?? []);
      blocks.push({ kind: "heading", text: "Action items" });
      summary.actionItems.forEach((item, i) => {
        blocks.push({ kind: "checkbox", text: item, checked: completed.has(i) });
      });
    }

    if (summary.keyNotes.length > 0) {
      blocks.push({ kind: "heading", text: "Key notes" });
      for (const note of summary.keyNotes) blocks.push({ kind: "bullet", text: note });
    }
  }

  if (scope === "full") {
    if (notes.trim().length > 0) {
      blocks.push({ kind: "heading", text: "Your notes" });
      blocks.push({ kind: "paragraph", text: notes.trim() });
    }

    const finals = transcriptTurns(segments.filter((s) => s.final));
    if (finals.length > 0) {
      blocks.push({ kind: "heading", text: "Transcript" });
      for (const s of finals) {
        blocks.push({
          kind: "transcriptLine",
          text: s.text.trim(),
          speaker: s.speaker === "me" ? "Me" : "Them",
          timestamp: formatTimestamp(s.tStart),
        });
        if (s.translatedText) blocks.push({ kind: "translationLine", text: s.translatedText });
      }
    }
  }

  return blocks;
}
