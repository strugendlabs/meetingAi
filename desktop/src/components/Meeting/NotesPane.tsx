// User notes editor with a 2 s debounced autosave to SQLite (plan Task 10).
// Controlled by the parent (MeetingView needs the current text for export);
// this component owns the debounce + persistence + save-state indicator.
// Persistence failures (e.g. plain browser without the SQL plugin) surface as
// a quiet "Couldn't save" state and never break typing.

import { useCallback, useEffect, useRef, useState } from "react";
import { saveUserNotes } from "../../lib/db";

export const NOTES_AUTOSAVE_MS = 2000;

/**
 * Notes whose save failed, stashed per meeting so the final edits are
 * recovered on the next mount of that meeting instead of silently dropped
 * (the unmount flush has no UI left to surface an error in).
 */
const pendingNotes = new Map<string, string>();

/**
 * Save notes; on failure stash the text for later recovery and return false.
 * A successful save clears any stale stash for the meeting.
 */
export async function saveNotesWithRecovery(meetingId: string, text: string): Promise<boolean> {
  try {
    await saveUserNotes(meetingId, text);
    pendingNotes.delete(meetingId);
    return true;
  } catch {
    pendingNotes.set(meetingId, text);
    return false;
  }
}

/** Take (and clear) the stashed unsaved notes for a meeting, if any. */
export function takePendingNotes(meetingId: string): string | undefined {
  const text = pendingNotes.get(meetingId);
  pendingNotes.delete(meetingId);
  return text;
}

/** Test hook: reset the module-level stash between tests. */
export function __clearPendingNotesForTests(): void {
  pendingNotes.clear();
}

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

const SAVE_LABEL: Record<Exclude<SaveState, "idle">, string> = {
  pending: "Unsaved",
  saving: "Saving…",
  saved: "Saved",
  error: "Couldn't save",
};

export interface NotesPaneProps {
  meetingId: string;
  value: string;
  onChange: (value: string) => void;
}

export default function NotesPane({ meetingId, value, onChange }: NotesPaneProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef(value);
  const dirtyRef = useRef(false);

  const flush = useCallback(async () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setSaveState("saving");
    const ok = await saveNotesWithRecovery(meetingId, latestRef.current);
    if (ok) {
      setSaveState(dirtyRef.current ? "pending" : "saved");
    } else {
      dirtyRef.current = true; // retry on the next edit
      setSaveState("error");
    }
  }, [meetingId]);

  // Recover notes whose final save failed on a previous unmount of this
  // meeting: adopt the stashed text and try persisting it again.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const pending = takePendingNotes(meetingId);
    if (pending === undefined) return;
    latestRef.current = pending;
    dirtyRef.current = true;
    setSaveState("pending");
    onChangeRef.current(pending);
    void flush();
  }, [meetingId, flush]);

  const handleChange = (next: string) => {
    latestRef.current = next;
    dirtyRef.current = true;
    setSaveState("pending");
    onChange(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, NOTES_AUTOSAVE_MS);
  };

  // Flush pending edits on unmount. On failure the text is stashed for
  // recovery on the next mount of this meeting instead of silently dropped.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void saveNotesWithRecovery(meetingId, latestRef.current);
      }
    };
  }, [meetingId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          Your notes
        </h2>
        {saveState !== "idle" && (
          <span
            className={`text-[11px] font-medium ${
              saveState === "error"
                ? "text-red-500"
                : saveState === "saved"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-neutral-400 dark:text-neutral-500"
            }`}
          >
            {SAVE_LABEL[saveState]}
          </span>
        )}
      </div>
      <textarea
        aria-label="Your notes"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Type your notes here — they save automatically."
        spellCheck
        className="min-h-0 w-full flex-1 resize-none bg-transparent px-4 pb-4 text-sm leading-relaxed outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-600"
      />
    </div>
  );
}
