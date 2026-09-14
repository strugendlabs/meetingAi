// Tests for the NotesPane save-with-recovery stash: a failed final save must
// not silently drop the user's last edits — the text is stashed per meeting
// and recovered (and re-saved) on the next mount of that meeting.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { saveUserNotes } = vi.hoisted(() => ({ saveUserNotes: vi.fn() }));

vi.mock("../../lib/db", () => ({ saveUserNotes }));

import {
  __clearPendingNotesForTests,
  saveNotesWithRecovery,
  takePendingNotes,
} from "./NotesPane";

beforeEach(() => {
  vi.clearAllMocks();
  __clearPendingNotesForTests();
  saveUserNotes.mockResolvedValue(undefined);
});

describe("saveNotesWithRecovery", () => {
  it("saves and returns true; nothing is stashed", async () => {
    await expect(saveNotesWithRecovery("m-1", "final action item")).resolves.toBe(true);
    expect(saveUserNotes).toHaveBeenCalledWith("m-1", "final action item");
    expect(takePendingNotes("m-1")).toBeUndefined();
  });

  it("stashes the text for recovery when the save fails", async () => {
    saveUserNotes.mockRejectedValue(new Error("database is locked"));
    await expect(saveNotesWithRecovery("m-1", "final action item")).resolves.toBe(false);
    expect(takePendingNotes("m-1")).toBe("final action item");
  });

  it("keeps stashes per meeting", async () => {
    saveUserNotes.mockRejectedValue(new Error("boom"));
    await saveNotesWithRecovery("m-1", "notes one");
    await saveNotesWithRecovery("m-2", "notes two");
    expect(takePendingNotes("m-2")).toBe("notes two");
    expect(takePendingNotes("m-1")).toBe("notes one");
  });

  it("a later successful save clears a stale stash for the meeting", async () => {
    saveUserNotes.mockRejectedValueOnce(new Error("boom"));
    await saveNotesWithRecovery("m-1", "old text");
    await saveNotesWithRecovery("m-1", "newer text");
    expect(takePendingNotes("m-1")).toBeUndefined();
  });

  it("a repeated failure keeps the newest text", async () => {
    saveUserNotes.mockRejectedValue(new Error("boom"));
    await saveNotesWithRecovery("m-1", "old text");
    await saveNotesWithRecovery("m-1", "newer text");
    expect(takePendingNotes("m-1")).toBe("newer text");
  });
});

describe("takePendingNotes", () => {
  it("returns undefined when nothing is stashed", () => {
    expect(takePendingNotes("m-404")).toBeUndefined();
  });

  it("clears the stash on take so recovery runs only once", async () => {
    saveUserNotes.mockRejectedValue(new Error("boom"));
    await saveNotesWithRecovery("m-1", "text");
    expect(takePendingNotes("m-1")).toBe("text");
    expect(takePendingNotes("m-1")).toBeUndefined();
  });
});
