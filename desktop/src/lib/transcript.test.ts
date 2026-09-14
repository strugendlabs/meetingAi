import { describe, expect, it } from "vitest";
import { transcriptPlainText, transcriptTurns } from "./transcript";
import type { TranscriptSegment } from "./types";
const seg = (id: string, text: string, start: number, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id, text, meetingId: "m", speaker: "me", tStart: start, tEnd: start + 1000, final: true, ...extra,
});

describe("readable transcript turns", () => {
  it("joins Hindi fragments without changing originals or dropping repetitions", () => {
    const originals = [seg("a", "ठीक है।", 0), seg("b", "ठीक है।", 2500)];
    const turns = transcriptTurns(originals);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("ठीक है। ठीक है।");
    expect(originals[0].text).toBe("ठीक है।");
  });
  it("sorts chronologically and never merges across another speaker", () => {
    const turns = transcriptTurns([seg("c", "Continue", 3000), seg("a", "Hello", 0), seg("b", "Yes", 1500, { speaker: "them" })]);
    expect(turns.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
  it("preserves long pauses, language changes, and incomplete translations", () => {
    expect(transcriptTurns([seg("a", "one", 0), seg("b", "two", 20000)])).toHaveLength(2);
    expect(transcriptTurns([seg("a", "one", 0), seg("b", "दो", 2000, { lang: "hi" })])).toHaveLength(2);
    expect(transcriptTurns([seg("a", "one", 0, { translatedText: "एक" }), seg("b", "two", 2000)])).toHaveLength(2);
  });
  it("only copies final words with timestamps and optional translations", () => {
    const source = [seg("a", "नमस्ते", 0, { translatedText: "Hello" }), seg("b", "unfinished", 2000, { final: false })];
    expect(transcriptPlainText(source)).toBe("0:00  You\nनमस्ते");
    expect(transcriptPlainText(source, true)).toContain("नमस्ते\nHello");
  });
});
