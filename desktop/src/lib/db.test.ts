import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TranscriptSegment, MeetingSummary } from "./types";

const { load, execute, select } = vi.hoisted(() => ({
  load: vi.fn(),
  execute: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load },
}));

import {
  DB_URL,
  __resetDbForTests,
  addSegment,
  createMeeting,
  endMeeting,
  getMeetingFull,
  getDb,
  listMeetings,
  saveSummary,
  saveUserNotes,
  updateSegmentTranslation,
} from "./db";

beforeEach(() => {
  vi.clearAllMocks();
  __resetDbForTests();
  load.mockResolvedValue({ execute, select });
  execute.mockResolvedValue({ rowsAffected: 1 });
  select.mockResolvedValue([]);
});

describe("getDb", () => {
  it("loads the database once at the plan-specified URL", async () => {
    await getDb();
    await getDb();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("sqlite:meetingai.db");
    expect(DB_URL).toBe("sqlite:meetingai.db");
  });
});

describe("createMeeting", () => {
  it("inserts a row and returns a Meeting", async () => {
    const before = Date.now();
    const m = await createMeeting("Standup");
    const after = Date.now();

    expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.title).toBe("Standup");
    expect(m.startedAt).toBeGreaterThanOrEqual(before);
    expect(m.startedAt).toBeLessThanOrEqual(after);
    expect(m.calendarEventId).toBeUndefined();
    expect(m.endedAt).toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, binds] = execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO meetings");
    expect(binds).toEqual([m.id, "Standup", m.startedAt, null]);
  });

  it("passes calendarEventId through when given", async () => {
    const m = await createMeeting("Sync", "cal-evt-42");
    expect(m.calendarEventId).toBe("cal-evt-42");
    const [, binds] = execute.mock.calls[0];
    expect(binds[3]).toBe("cal-evt-42");
  });
});

describe("endMeeting", () => {
  it("updates ended_at for the meeting", async () => {
    const before = Date.now();
    await endMeeting("m-1");
    const [sql, binds] = execute.mock.calls[0];
    expect(sql).toContain("UPDATE meetings SET ended_at");
    expect(binds[0]).toBeGreaterThanOrEqual(before);
    expect(binds[1]).toBe("m-1");
  });
});

describe("addSegment", () => {
  const seg: TranscriptSegment = {
    id: "s-1",
    meetingId: "m-1",
    speaker: "them",
    text: "Hola",
    translatedText: "Hello",
    lang: "es",
    tStart: 1000,
    tEnd: 2500,
    final: true,
  };

  it("inserts all columns mapped snake_case", async () => {
    await addSegment(seg);
    const [sql, binds] = execute.mock.calls[0];
    expect(sql).toContain("INSERT OR REPLACE INTO transcript_segments");
    expect(binds).toEqual([
      "s-1",
      "m-1",
      "them",
      "Hola",
      "Hello",
      "es",
      1000,
      2500,
      1,
    ]);
  });

  it("maps missing optionals to null and final:false to 0", async () => {
    await addSegment({
      id: "s-2",
      meetingId: "m-1",
      speaker: "me",
      text: "partial…",
      tStart: 3000,
      final: false,
    });
    const [, binds] = execute.mock.calls[0];
    expect(binds).toEqual(["s-2", "m-1", "me", "partial…", null, null, 3000, null, 0]);
  });
});

describe("updateSegmentTranslation", () => {
  it("updates translated_text by id", async () => {
    await updateSegmentTranslation("s-1", "Bonjour");
    const [sql, binds] = execute.mock.calls[0];
    expect(sql).toContain("UPDATE transcript_segments SET translated_text");
    expect(binds).toEqual(["Bonjour", "s-1"]);
  });
});

describe("saveSummary", () => {
  it("serializes the summary as JSON onto the meeting row", async () => {
    const s: MeetingSummary = {
      summary: "We agreed.",
      actionItems: ["ship it"],
      keyNotes: ["deadline friday"],
    };
    await saveSummary("m-1", s);
    const [sql, binds] = execute.mock.calls[0];
    expect(sql).toContain("UPDATE meetings SET summary_json");
    expect(JSON.parse(binds[0] as string)).toEqual(s);
    expect(binds[1]).toBe("m-1");
  });
});

describe("saveUserNotes", () => {
  it("updates user_notes by meeting id", async () => {
    await saveUserNotes("m-1", "my notes");
    const [sql, binds] = execute.mock.calls[0];
    expect(sql).toContain("UPDATE meetings SET user_notes");
    expect(binds).toEqual(["my notes", "m-1"]);
  });
});

describe("listMeetings", () => {
  it("maps rows to Meetings, newest first query", async () => {
    select.mockResolvedValue([
      {
        id: "m-2",
        title: "Later",
        started_at: 200,
        ended_at: 250,
        calendar_event_id: "evt-9",
        summary_json: null,
        user_notes: "",
      },
      {
        id: "m-1",
        title: "Earlier",
        started_at: 100,
        ended_at: null,
        calendar_event_id: null,
        summary_json: null,
        user_notes: "",
      },
    ]);

    const meetings = await listMeetings();
    const [sql] = select.mock.calls[0];
    expect(sql).toContain("ORDER BY started_at DESC");
    expect(meetings).toEqual([
      {
        id: "m-2",
        title: "Later",
        startedAt: 200,
        endedAt: 250,
        calendarEventId: "evt-9",
      },
      { id: "m-1", title: "Earlier", startedAt: 100 },
    ]);
  });
});

describe("getMeetingFull", () => {
  const meetingRow = {
    id: "m-1",
    title: "Sync",
    started_at: 100,
    ended_at: 900,
    calendar_event_id: null,
    summary_json: JSON.stringify({
      summary: "Done.",
      actionItems: ["a"],
      keyNotes: ["k"],
    }),
    user_notes: "remember X",
  };
  const segmentRow = {
    id: "s-1",
    meeting_id: "m-1",
    speaker: "them",
    text: "Hola",
    translated_text: "Hello",
    lang: "es",
    t_start: 10,
    t_end: 20,
    final: 1,
  };

  it("returns null when the meeting does not exist", async () => {
    select.mockResolvedValueOnce([]);
    expect(await getMeetingFull("missing")).toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("returns meeting, ordered segments, parsed summary and notes", async () => {
    select
      .mockResolvedValueOnce([meetingRow])
      .mockResolvedValueOnce([segmentRow]);

    const full = await getMeetingFull("m-1");
    expect(full).not.toBeNull();
    expect(full!.meeting).toEqual({
      id: "m-1",
      title: "Sync",
      startedAt: 100,
      endedAt: 900,
    });
    expect(full!.summary).toEqual({
      summary: "Done.",
      actionItems: ["a"],
      keyNotes: ["k"],
    });
    expect(full!.userNotes).toBe("remember X");
    expect(full!.segments).toEqual([
      {
        id: "s-1",
        meetingId: "m-1",
        speaker: "them",
        text: "Hola",
        translatedText: "Hello",
        lang: "es",
        tStart: 10,
        tEnd: 20,
        final: true,
      },
    ]);

    const segSql = select.mock.calls[1][0] as string;
    expect(segSql).toContain("WHERE meeting_id = $1");
    expect(segSql).toContain("ORDER BY t_start ASC");
  });

  it("tolerates corrupt summary_json (summary undefined)", async () => {
    select
      .mockResolvedValueOnce([{ ...meetingRow, summary_json: "{not json" }])
      .mockResolvedValueOnce([]);
    const full = await getMeetingFull("m-1");
    expect(full!.summary).toBeUndefined();
    expect(full!.meeting.id).toBe("m-1");
  });

  it("defaults userNotes to empty string when null", async () => {
    select
      .mockResolvedValueOnce([
        { ...meetingRow, user_notes: null, summary_json: null },
      ])
      .mockResolvedValueOnce([]);
    const full = await getMeetingFull("m-1");
    expect(full!.userNotes).toBe("");
    expect(full!.summary).toBeUndefined();
  });
});
