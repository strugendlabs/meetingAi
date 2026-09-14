// Tests for the persistence / recovery helpers extracted from MeetingView
// (silent-failure findings: swallowed endMeeting on Stop, swallowed
// saveSummary, keychain errors collapsed into "no key", swallowed rename).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MeetingSession } from "../lib/meetingSession";
import type { Meeting, TranscriptSegment } from "../lib/types";

const db = vi.hoisted(() => ({
  getDb: vi.fn(),
  execute: vi.fn(),
  endMeeting: vi.fn(),
  saveSummary: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  DB_URL: "sqlite:meetingai.db",
  __resetDbForTests: vi.fn(),
  getDb: db.getDb,
  createMeeting: vi.fn(),
  endMeeting: db.endMeeting,
  addSegment: vi.fn(),
  updateSegmentTranslation: vi.fn(),
  saveSummary: db.saveSummary,
  saveUserNotes: vi.fn(),
  listMeetings: vi.fn(),
  getMeetingFull: vi.fn(),
}));

import {
  STALE_LIVE_MEETING_MS,
  actionItemMarkdownLine,
  isStaleLiveMeeting,
  persistMeetingEnd,
  persistSummary,
  persistTitle,
  readGeminiKey,
  recoveredEndedAt,
  stampMeetingEnd,
  toggleCompletedIndex,
} from "./MeetingView";

interface TestWindow {
  __TAURI_INTERNALS__?: unknown;
  __TAURI_MOCK__?: { invoke: (cmd: string) => unknown };
}
type GlobalWithWindow = { window?: TestWindow };
const g = globalThis as unknown as GlobalWithWindow;

beforeEach(() => {
  vi.clearAllMocks();
  db.getDb.mockResolvedValue({ execute: db.execute });
  db.execute.mockResolvedValue({ rowsAffected: 1 });
  db.endMeeting.mockResolvedValue(undefined);
  db.saveSummary.mockResolvedValue(undefined);
});

afterEach(() => {
  delete g.window;
});

function fakeSession(stop: () => Promise<void>): Pick<MeetingSession, "stop"> {
  return { stop };
}

describe("persistMeetingEnd", () => {
  it("stops the session AND writes ended_at itself (teardown cannot skip the write)", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    await expect(persistMeetingEnd(fakeSession(stop), "m-1")).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    // Even a successful session.stop() must not be trusted to have persisted
    // (it early-returns when the session never started).
    expect(db.endMeeting).toHaveBeenCalledWith("m-1");
  });

  it("still persists ended_at when session teardown throws", async () => {
    const stop = vi.fn().mockRejectedValue(new Error("sidecar dead"));
    await expect(persistMeetingEnd(fakeSession(stop), "m-1")).resolves.toBe(true);
    expect(db.endMeeting).toHaveBeenCalledWith("m-1");
  });

  it("returns false (instead of swallowing) when the ended_at write fails", async () => {
    db.endMeeting.mockRejectedValue(new Error("database is locked"));
    await expect(persistMeetingEnd(null, "m-1")).resolves.toBe(false);
  });

  it("works without a session (no-key meetings)", async () => {
    await expect(persistMeetingEnd(null, "m-2")).resolves.toBe(true);
    expect(db.endMeeting).toHaveBeenCalledWith("m-2");
  });
});

describe("stampMeetingEnd", () => {
  it("writes the explicit ended_at timestamp", async () => {
    await expect(stampMeetingEnd("m-1", 12345)).resolves.toBe(true);
    const [sql, binds] = db.execute.mock.calls[0];
    expect(sql).toContain("UPDATE meetings SET ended_at");
    expect(binds).toEqual([12345, "m-1"]);
  });

  it("reports failure instead of throwing", async () => {
    db.execute.mockRejectedValue(new Error("disk I/O error"));
    await expect(stampMeetingEnd("m-1", 12345)).resolves.toBe(false);
  });
});

describe("persistSummary", () => {
  const summary = { summary: "s", actionItems: [], keyNotes: [] };

  it("returns true when the write succeeds", async () => {
    await expect(persistSummary("m-1", summary)).resolves.toBe(true);
    expect(db.saveSummary).toHaveBeenCalledWith("m-1", summary);
  });

  it("returns false when the write fails so the UI can warn the user", async () => {
    db.saveSummary.mockRejectedValue(new Error("database is locked"));
    await expect(persistSummary("m-1", summary)).resolves.toBe(false);
  });
});

describe("persistTitle", () => {
  it("updates the title row and reports success", async () => {
    await expect(persistTitle("m-1", "Q3 budget review")).resolves.toBe(true);
    const [sql, binds] = db.execute.mock.calls[0];
    expect(sql).toContain("UPDATE meetings SET title");
    expect(binds).toEqual(["Q3 budget review", "m-1"]);
  });

  it("reports failure so the rename can be reverted and surfaced", async () => {
    db.execute.mockRejectedValue(new Error("readonly database"));
    await expect(persistTitle("m-1", "Q3 budget review")).resolves.toBe(false);
  });
});

describe("readGeminiKey", () => {
  it("returns the key with no error on success", async () => {
    g.window = {
      __TAURI_MOCK__: {
        invoke: (cmd: string) => (cmd === "keychain_get" ? "sk-live-123" : undefined),
      },
    };
    await expect(readGeminiKey()).resolves.toEqual({ key: "sk-live-123", error: null });
  });

  it("returns key null / error null when no key is stored", async () => {
    g.window = {
      __TAURI_MOCK__: { invoke: () => null },
    };
    await expect(readGeminiKey()).resolves.toEqual({ key: null, error: null });
  });

  it("captures a keychain failure instead of collapsing it into 'no key'", async () => {
    g.window = {
      __TAURI_MOCK__: {
        invoke: () => {
          throw new Error("errSecAuthFailed");
        },
      },
    };
    await expect(readGeminiKey()).resolves.toEqual({ key: null, error: "errSecAuthFailed" });
  });

  it("degrades to key null / error null outside Tauri", async () => {
    await expect(readGeminiKey()).resolves.toEqual({ key: null, error: null });
  });
});

describe("isStaleLiveMeeting", () => {
  const base: Meeting = { id: "m-1", title: "t", startedAt: 1_000_000 };

  it("is false for ended meetings regardless of age", () => {
    expect(
      isStaleLiveMeeting({ ...base, endedAt: 1_000_500 }, base.startedAt + STALE_LIVE_MEETING_MS * 10),
    ).toBe(false);
  });

  it("is false for a freshly created live meeting", () => {
    expect(isStaleLiveMeeting(base, base.startedAt + 1_000)).toBe(false);
  });

  it("is true for a live-looking meeting older than the threshold", () => {
    expect(isStaleLiveMeeting(base, base.startedAt + STALE_LIVE_MEETING_MS)).toBe(true);
  });
});

describe("toggleCompletedIndex", () => {
  it("adds an index that isn't checked yet", () => {
    expect(toggleCompletedIndex([], 1)).toEqual([1]);
    expect(toggleCompletedIndex([0], 2)).toEqual([0, 2]);
  });

  it("removes an index that is already checked (strike-through toggles off)", () => {
    expect(toggleCompletedIndex([0, 1, 2], 1)).toEqual([0, 2]);
  });

  it("keeps the result sorted regardless of insertion order", () => {
    expect(toggleCompletedIndex([2, 0], 1)).toEqual([0, 1, 2]);
  });

  it("is idempotent-safe: toggling twice returns the original set", () => {
    const start = [0, 3];
    expect(toggleCompletedIndex(toggleCompletedIndex(start, 1), 1)).toEqual(start);
  });
});

describe("actionItemMarkdownLine", () => {
  it("renders an unchecked box for incomplete items", () => {
    expect(actionItemMarkdownLine("Ship it", false)).toBe("- [ ] Ship it");
  });

  it("renders a checked box for completed items", () => {
    expect(actionItemMarkdownLine("Ship it", true)).toBe("- [x] Ship it");
  });
});

describe("recoveredEndedAt", () => {
  const meeting: Meeting = { id: "m-1", title: "t", startedAt: 50_000 };

  it("falls back to startedAt when there are no segments", () => {
    expect(recoveredEndedAt(meeting, [])).toBe(50_000);
  });

  it("uses the end of the last segment (tEnd, else tStart)", () => {
    const segments: TranscriptSegment[] = [
      { id: "s-1", meetingId: "m-1", speaker: "me", text: "a", tStart: 1_000, tEnd: 2_000, final: true },
      { id: "s-2", meetingId: "m-1", speaker: "them", text: "b", tStart: 9_000, final: true },
      { id: "s-3", meetingId: "m-1", speaker: "me", text: "c", tStart: 3_000, tEnd: 4_000, final: true },
    ];
    expect(recoveredEndedAt(meeting, segments)).toBe(50_000 + 9_000);
  });
});
