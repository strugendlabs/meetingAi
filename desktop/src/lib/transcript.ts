import type { TranscriptSegment } from "./types";

/** mm:ss (h:mm:ss past an hour), measured from the meeting start. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(total % 60).padStart(2, "0")}`;
}

/** Join complete fragments, never individual streaming tokens. */
function joinFragments(a: string, b: string): string {
  return `${a.trimEnd()} ${b.trimStart()}`;
}

/**
 * Readable speaker turns shared by the UI, summaries and every export.
 * Raw segments remain untouched in storage. Never merge across a speaker
 * change, a long pause, or a paragraph of more than a minute / 1,200 chars.
 */
export function transcriptTurns(segments: TranscriptSegment[]): TranscriptSegment[] {
  const turns: TranscriptSegment[] = [];
  const ordered = segments.filter((s) => s.text.trim()).slice().sort((a, b) => a.tStart - b.tStart);
  for (const segment of ordered) {
    const previous = turns[turns.length - 1];
    const gap = segment.tStart - (previous?.tEnd ?? previous?.tStart ?? 0);
    if (
      previous && previous.final && previous.speaker === segment.speaker &&
      previous.meetingId === segment.meetingId && previous.lang === segment.lang &&
      gap >= 0 && gap <= 8000 && segment.tStart - previous.tStart <= 60000 &&
      previous.text.length + segment.text.length < 1200 &&
      Boolean(previous.translatedText) === Boolean(segment.translatedText)
    ) {
      previous.text = joinFragments(previous.text, segment.text);
      previous.tEnd = segment.tEnd ?? segment.tStart;
      previous.final = segment.final;
      if (previous.translatedText && segment.translatedText) {
        previous.translatedText = joinFragments(previous.translatedText, segment.translatedText);
      }
    } else {
      turns.push({ ...segment, text: segment.text.trim() });
    }
  }
  return turns;
}

export function transcriptPlainText(segments: TranscriptSegment[], translations = false): string {
  return transcriptTurns(segments.filter((s) => s.final)).map((s) =>
    `${formatTimestamp(s.tStart)}  ${s.speaker === "me" ? "You" : "Them"}\n${s.text}${translations && s.translatedText ? `\n${s.translatedText}` : ""}`,
  ).join("\n\n");
}
