// Tests for buildSummaryMarkdown — the "Summary — Markdown" export, a
// separate, additional output from the full-meeting Markdown export
// (buildMarkdown) covered by MeetingView.test.ts. Only the summary
// paragraph, action items, and key notes should ever appear here.

import { describe, it, expect } from "vitest";
import { buildSummaryMarkdown } from "./MeetingView";
import type { Meeting, MeetingSummary } from "../lib/types";

const meeting: Meeting = {
  id: "m-1",
  title: "Q3 Budget Review",
  startedAt: Date.UTC(2026, 0, 1, 9, 0, 0),
  endedAt: Date.UTC(2026, 0, 1, 9, 32, 15),
};

describe("buildSummaryMarkdown", () => {
  it("starts with the title and a date/duration line", () => {
    const summary: MeetingSummary = { summary: "s", actionItems: [], keyNotes: [] };
    const md = buildSummaryMarkdown(meeting, summary);
    const lines = md.split("\n");
    expect(lines[0]).toBe("# Q3 Budget Review");
    expect(lines[2]).toContain("·");
  });

  it("omits the duration when the meeting has no endedAt", () => {
    const summary: MeetingSummary = { summary: "s", actionItems: [], keyNotes: [] };
    const md = buildSummaryMarkdown({ ...meeting, endedAt: undefined }, summary);
    expect(md.split("\n")[2]).not.toContain("·");
  });

  it("renders the summary paragraph under a Summary heading", () => {
    const summary: MeetingSummary = {
      summary: "The team agreed to cut travel spend by 20%.",
      actionItems: [],
      keyNotes: [],
    };
    const md = buildSummaryMarkdown(meeting, summary);
    expect(md).toContain("## Summary\n\nThe team agreed to cut travel spend by 20%.");
  });

  it("renders action items as Markdown checkboxes, checked per completedActionItems", () => {
    const summary: MeetingSummary = {
      summary: "s",
      actionItems: ["Send updated budget", "Book follow-up meeting"],
      keyNotes: [],
      completedActionItems: [1],
    };
    const md = buildSummaryMarkdown(meeting, summary);
    expect(md).toContain("## Action items");
    expect(md).toContain("- [ ] Send updated budget");
    expect(md).toContain("- [x] Book follow-up meeting");
  });

  it("treats a missing completedActionItems as none checked", () => {
    const summary: MeetingSummary = { summary: "s", actionItems: ["Ship it"], keyNotes: [] };
    const md = buildSummaryMarkdown(meeting, summary);
    expect(md).toContain("- [ ] Ship it");
  });

  it("renders key notes as a bullet list", () => {
    const summary: MeetingSummary = {
      summary: "s",
      actionItems: [],
      keyNotes: ["Marketing spend is flat YoY", "Renew vendor contract"],
    };
    const md = buildSummaryMarkdown(meeting, summary);
    expect(md).toContain("## Key notes");
    expect(md).toContain("- Marketing spend is flat YoY");
    expect(md).toContain("- Renew vendor contract");
  });

  it("omits Action items / Key notes headings when those lists are empty", () => {
    const summary: MeetingSummary = { summary: "s", actionItems: [], keyNotes: [] };
    const md = buildSummaryMarkdown(meeting, summary);
    expect(md).not.toContain("## Action items");
    expect(md).not.toContain("## Key notes");
  });

  it("never includes a transcript or user-notes section", () => {
    const summary: MeetingSummary = {
      summary: "s",
      actionItems: ["a"],
      keyNotes: ["k"],
    };
    const md = buildSummaryMarkdown(meeting, summary);
    expect(md).not.toContain("## Transcript");
    expect(md).not.toContain("## Your notes");
  });
});
