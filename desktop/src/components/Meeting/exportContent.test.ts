// Tests for the export data-shaping / rendering logic behind the meeting
// export menu (Markdown/PDF/Word, full meeting + summary-only). buildExportBlocks
// is the single source of truth both renderers build from, so it gets the
// deepest coverage; renderExportPdf/buildExportDocx get lighter smoke tests
// (real pagination / real docx bytes) since asserting exact binary output
// isn't meaningful here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  buildExportBlocks,
  buildExportDocx,
  docxToBlob,
  meetingFileBase,
  renderExportPdf,
  type ExportBlock,
} from "./exportContent";
import type { Meeting, MeetingSummary, TranscriptSegment } from "../../lib/types";

const meeting: Meeting = {
  id: "m-1",
  title: "Q3 Budget Review",
  startedAt: Date.UTC(2026, 0, 1, 9, 0, 0),
  endedAt: Date.UTC(2026, 0, 1, 9, 32, 15),
};

const summary: MeetingSummary = {
  summary: "The team agreed to cut travel spend by 20%.",
  actionItems: ["Send updated budget", "Book follow-up meeting"],
  keyNotes: ["Marketing spend is flat YoY"],
  completedActionItems: [1],
};

const segments: TranscriptSegment[] = [
  { id: "s-1", meetingId: "m-1", speaker: "me", text: "Let's start.", tStart: 0, tEnd: 2000, final: true },
  {
    id: "s-2",
    meetingId: "m-1",
    speaker: "them",
    text: "Sounds good.",
    translatedText: "Suena bien.",
    tStart: 2000,
    tEnd: 4000,
    final: true,
  },
  { id: "s-3", meetingId: "m-1", speaker: "me", text: "(interim, not final)", tStart: 4000, final: false },
  { id: "s-4", meetingId: "m-1", speaker: "them", text: "   ", tStart: 5000, tEnd: 6000, final: true },
];

describe("meetingFileBase", () => {
  it("collapses non-alphanumeric runs into single hyphens", () => {
    expect(meetingFileBase("Q3 Budget: Review!!")).toBe("Q3-Budget-Review");
  });

  it("trims leading/trailing hyphens", () => {
    expect(meetingFileBase("  --Standup--  ")).toBe("Standup");
  });

  it("truncates to 60 characters", () => {
    const long = "a".repeat(120);
    expect(meetingFileBase(long)).toBe("a".repeat(60));
  });

  it("falls back to 'meeting' when nothing alphanumeric remains", () => {
    expect(meetingFileBase("!!! ???")).toBe("meeting");
    expect(meetingFileBase("")).toBe("meeting");
  });

  it("keeps unicode letters", () => {
    expect(meetingFileBase("Réunion café")).toBe("Réunion-café");
  });
});

describe("buildExportBlocks — full scope", () => {
  it("always starts with a title block and a meta block", () => {
    const blocks = buildExportBlocks(meeting, null, "", [], "full");
    expect(blocks[0]).toEqual({ kind: "title", text: "Q3 Budget Review" });
    expect(blocks[1].kind).toBe("meta");
    expect((blocks[1] as { text: string }).text).toContain("·");
  });

  it("omits the duration from meta when the meeting has no endedAt", () => {
    const blocks = buildExportBlocks({ ...meeting, endedAt: undefined }, null, "", [], "full");
    expect((blocks[1] as { text: string }).text).not.toContain("·");
  });

  it("includes no summary/action/key-note blocks when summary is null", () => {
    const blocks = buildExportBlocks(meeting, null, "", [], "full");
    expect(blocks.some((b) => b.kind === "heading")).toBe(false);
  });

  it("renders the summary paragraph under a Summary heading", () => {
    const blocks = buildExportBlocks(meeting, summary, "", [], "full");
    const headingIdx = blocks.findIndex((b) => b.kind === "heading" && b.text === "Summary");
    expect(headingIdx).toBeGreaterThanOrEqual(0);
    expect(blocks[headingIdx + 1]).toEqual({ kind: "paragraph", text: summary.summary });
  });

  it("renders action items as checkboxes, checked per completedActionItems", () => {
    const blocks = buildExportBlocks(meeting, summary, "", [], "full");
    const checkboxes = blocks.filter((b) => b.kind === "checkbox");
    expect(checkboxes).toEqual([
      { kind: "checkbox", text: "Send updated budget", checked: false },
      { kind: "checkbox", text: "Book follow-up meeting", checked: true },
    ]);
  });

  it("treats a missing completedActionItems as none checked", () => {
    const { completedActionItems: _drop, ...rest } = summary;
    const blocks = buildExportBlocks(meeting, rest, "", [], "full");
    const checkboxes = blocks.filter((b): b is Extract<ExportBlock, { kind: "checkbox" }> => b.kind === "checkbox");
    expect(checkboxes.every((c) => c.checked === false)).toBe(true);
  });

  it("omits Action items / Key notes headings when those lists are empty", () => {
    const blocks = buildExportBlocks(
      meeting,
      { summary: "s", actionItems: [], keyNotes: [] },
      "",
      [],
      "full",
    );
    const headings = blocks.filter((b) => b.kind === "heading").map((b) => (b as { text: string }).text);
    expect(headings).toEqual(["Summary"]);
  });

  it("renders key notes as bullets", () => {
    const blocks = buildExportBlocks(meeting, summary, "", [], "full");
    expect(blocks).toContainEqual({ kind: "bullet", text: "Marketing spend is flat YoY" });
  });

  it("includes trimmed user notes under a 'Your notes' heading", () => {
    const blocks = buildExportBlocks(meeting, null, "  Follow up next week.  ", [], "full");
    const headingIdx = blocks.findIndex((b) => b.kind === "heading" && b.text === "Your notes");
    expect(headingIdx).toBeGreaterThanOrEqual(0);
    expect(blocks[headingIdx + 1]).toEqual({ kind: "paragraph", text: "Follow up next week." });
  });

  it("omits 'Your notes' when notes are blank/whitespace", () => {
    const blocks = buildExportBlocks(meeting, null, "   ", [], "full");
    expect(blocks.some((b) => b.kind === "heading" && b.text === "Your notes")).toBe(false);
  });

  it("only includes final, non-blank segments in the transcript, in given order", () => {
    const blocks = buildExportBlocks(meeting, null, "", segments, "full");
    const lines = blocks.filter(
      (b): b is Extract<ExportBlock, { kind: "transcriptLine" }> => b.kind === "transcriptLine",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ speaker: "Me", text: "Let's start." });
    expect(lines[1]).toMatchObject({ speaker: "Them", text: "Sounds good." });
  });

  it("emits a translationLine immediately after a transcriptLine that has one", () => {
    const blocks = buildExportBlocks(meeting, null, "", segments, "full");
    const idx = blocks.findIndex((b) => b.kind === "transcriptLine" && b.text === "Sounds good.");
    expect(blocks[idx + 1]).toEqual({ kind: "translationLine", text: "Suena bien." });
  });

  it("omits the Transcript heading entirely when there are no usable segments", () => {
    const blocks = buildExportBlocks(meeting, null, "", [], "full");
    expect(blocks.some((b) => b.kind === "heading" && b.text === "Transcript")).toBe(false);
  });
});

describe("buildExportBlocks — summary scope", () => {
  it("excludes user notes and transcript even when both are present", () => {
    const blocks = buildExportBlocks(meeting, summary, "Some private notes", segments, "summary");
    expect(blocks.some((b) => b.kind === "heading" && b.text === "Your notes")).toBe(false);
    expect(blocks.some((b) => b.kind === "heading" && b.text === "Transcript")).toBe(false);
    expect(blocks.some((b) => b.kind === "transcriptLine")).toBe(false);
  });

  it("still includes the summary, action items, and key notes", () => {
    const blocks = buildExportBlocks(meeting, summary, "", [], "summary");
    expect(blocks.some((b) => b.kind === "heading" && b.text === "Summary")).toBe(true);
    expect(blocks.filter((b) => b.kind === "checkbox")).toHaveLength(2);
    expect(blocks.some((b) => b.kind === "bullet")).toBe(true);
  });

  it("is just title + meta when there is no summary", () => {
    const blocks = buildExportBlocks(meeting, null, "notes", segments, "summary");
    expect(blocks.map((b) => b.kind)).toEqual(["title", "meta"]);
  });
});

describe("renderExportPdf", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string) => {
      const bytes = await readFile(new URL(`../../assets/fonts/${url.split("/").pop()}`, import.meta.url));
      return new Response(bytes);
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("produces a single-page PDF for short content", async () => {
    const blocks = buildExportBlocks(meeting, summary, "A couple lines of notes.", [], "full");
    const blob = await renderExportPdf(blocks);
    const pdf = await blob.text();
    expect(blob.type).toBe("application/pdf");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(1);
  });

  it("paginates across multiple pages for a long transcript", async () => {
    const longSegments: TranscriptSegment[] = Array.from({ length: 200 }, (_, i) => ({
      id: `s-${i}`,
      meetingId: "m-1",
      speaker: i % 2 === 0 ? "me" : "them",
      text: `This is transcript line number ${i} with enough words to wrap across more than one line of the page.`,
      tStart: i * 1000,
      tEnd: i * 1000 + 900,
      final: true,
    }));
    const blocks = buildExportBlocks(meeting, summary, "", longSegments, "full");
    const pdf = await (await renderExportPdf(blocks)).text();
    expect(pdf.match(/\/Type \/Page\b/g)!.length).toBeGreaterThan(1);
  });

  it("embeds shaped Hindi and Latin fonts with searchable Unicode mappings", async () => {
    const pdf = await (await renderExportPdf([
      { kind: "title", text: "बैठक की समीक्षा" },
      { kind: "paragraph", text: "हिंदी transcription: कृपया शुक्रवार को प्रोजेक्ट की समीक्षा करें।" },
    ])).text();
    expect(pdf).toContain("Hind");
    expect(pdf).toContain("NotoSans");
    expect(pdf).toContain("/ToUnicode");
    expect(pdf).toContain("/FontFile2");
  });

  it("handles empty content", async () => {
    expect((await renderExportPdf([])).size).toBeGreaterThan(0);
  });

  it("flows a single very long utterance across pages without dropping its row", async () => {
    const pdf = await (await renderExportPdf([
      { kind: "title", text: "Long utterance" },
      { kind: "transcriptLine", speaker: "Me", timestamp: "0:00", text: "A long uninterrupted statement must remain complete across page boundaries. ".repeat(350) + "END_OF_TRANSCRIPT" },
    ])).text();
    // An oversized unbreakable table row previously disappeared, leaving
    // just a title page and an empty page instead of the full transcript.
    expect(pdf.match(/\/Type \/Page\b/g)!.length).toBeGreaterThan(5);
  });
});

describe("buildExportDocx / docxToBlob", () => {
  it("produces a non-empty .docx blob for a full-meeting export", async () => {
    const blocks = buildExportBlocks(meeting, summary, "Notes here.", segments, "full");
    const blob = await docxToBlob(buildExportDocx(blocks));
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain("wordprocessingml");
  });

  it("produces a non-empty .docx blob for a summary-only export", async () => {
    const blocks = buildExportBlocks(meeting, summary, "", [], "summary");
    const blob = await docxToBlob(buildExportDocx(blocks));
    expect(blob.size).toBeGreaterThan(0);
  });

  it("does not throw building a document from an empty block list", async () => {
    const blob = await docxToBlob(buildExportDocx([]));
    expect(blob.size).toBeGreaterThan(0);
  });
});
