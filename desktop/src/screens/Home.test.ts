// Tests for Home's error surfacing (real DB failures must not be masked as
// "needs the desktop app") and the stale-live-meeting reconciliation that
// stops orphaned rows from rendering as "Live" and re-recording on open.

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  getDb: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  DB_URL: "sqlite:meetingai.db",
  __resetDbForTests: vi.fn(),
  getDb: db.getDb,
  createMeeting: vi.fn(),
  endMeeting: vi.fn(),
  addSegment: vi.fn(),
  updateSegmentTranslation: vi.fn(),
  saveSummary: vi.fn(),
  saveUserNotes: vi.fn(),
  listMeetings: vi.fn(),
  getMeetingFull: vi.fn(),
}));

import { createErrorNotice, historyErrorNotice, reconcileStaleLiveMeetings } from "./Home";
import { STALE_LIVE_MEETING_MS } from "./MeetingView";

beforeEach(() => {
  vi.clearAllMocks();
  db.getDb.mockResolvedValue({ execute: db.execute });
  db.execute.mockResolvedValue({ rowsAffected: 0 });
});

describe("historyErrorNotice", () => {
  it("surfaces the real error inside Tauri instead of blaming the environment", () => {
    const msg = historyErrorNotice(new Error("database disk image is malformed"), true);
    expect(msg).toBe("Couldn't load meeting history: database disk image is malformed");
    expect(msg).not.toContain("desktop app");
  });

  it("stringifies non-Error rejections", () => {
    expect(historyErrorNotice("plugin sql not available", true)).toBe(
      "Couldn't load meeting history: plugin sql not available",
    );
  });

  it("keeps the friendly notice outside Tauri", () => {
    expect(historyErrorNotice(new Error("whatever"), false)).toBe(
      "Meeting history is available in the desktop app.",
    );
  });
});

describe("createErrorNotice", () => {
  it("surfaces the real error inside Tauri", () => {
    expect(createErrorNotice(new Error("database is locked"), true)).toBe(
      "Couldn't start a meeting: database is locked",
    );
  });

  it("keeps the friendly notice outside Tauri", () => {
    expect(createErrorNotice(new Error("whatever"), false)).toBe(
      "Couldn't start a meeting — recording needs the MeetingAI desktop app.",
    );
  });
});

describe("reconcileStaleLiveMeetings", () => {
  it("stamps ended_at only on live rows older than the stale threshold", async () => {
    const now = 10_000_000;
    await reconcileStaleLiveMeetings(now);

    expect(db.execute).toHaveBeenCalledTimes(1);
    const [sql, binds] = db.execute.mock.calls[0];
    expect(sql).toContain("UPDATE meetings SET ended_at");
    expect(sql).toContain("ended_at IS NULL");
    expect(sql).toContain("started_at <= $1");
    // Recovered end time comes from the last transcript segment, not now —
    // stamping "now" would inflate the duration of a day-old orphan.
    expect(sql).toContain("MAX(COALESCE(t_end, t_start))");
    expect(binds).toEqual([now - STALE_LIVE_MEETING_MS]);
  });

  it("propagates DB failures to the caller (Home logs and continues)", async () => {
    db.execute.mockRejectedValue(new Error("database is locked"));
    await expect(reconcileStaleLiveMeetings()).rejects.toThrow("database is locked");
  });
});
