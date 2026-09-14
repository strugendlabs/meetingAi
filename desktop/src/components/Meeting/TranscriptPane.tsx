import { useEffect, useMemo, useRef, useState } from "react";
import { formatTimestamp, transcriptPlainText, transcriptTurns } from "../../lib/transcript";
import type { TranscriptSegment } from "../../lib/types";

export { formatTimestamp } from "../../lib/transcript";

export interface TranscriptPaneProps {
  segments: TranscriptSegment[];
  showTranslations: boolean;
  live: boolean;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts = [];
  let from = 0;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    parts.push(text.slice(from, index));
    parts.push(<mark key={index} className="rounded bg-amber-200/80 text-neutral-950">{text.slice(index, index + query.length)}</mark>);
    from = index + query.length;
    index = lower.indexOf(needle, from);
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

export default function TranscriptPane({ segments, showTranslations, live }: TranscriptPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(live);
  const [query, setQuery] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [following, setFollowing] = useState(true);
  const turns = useMemo(() => transcriptTurns(segments), [segments]);
  const search = query.trim();
  const visible = useMemo(() => {
    const needle = search.toLowerCase();
    return needle ? turns.filter((s) => s.text.toLowerCase().includes(needle) ||
      (showTranslations && s.translatedText?.toLowerCase().includes(needle))) : turns;
  }, [turns, search, showTranslations]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current && !search) el.scrollTop = el.scrollHeight;
  }, [segments, search]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(transcriptPlainText(segments, showTranslations));
      setCopyState("copied");
    } catch { setCopyState("failed"); }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col" aria-label="Transcript">
      <div className="shrink-0 border-b border-neutral-200/70 px-5 py-4 dark:border-neutral-800/80">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-semibold">Transcript</h2>
            <span className="text-xs text-neutral-400">{turns.length} turns</span>
            {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-label="Live" />}
          </div>
          <button type="button" onClick={() => void copy()} disabled={!segments.some((s) => s.final && s.text.trim())}
            className="rounded-lg px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800">
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy transcript"}
          </button>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 dark:border-neutral-800 dark:bg-neutral-900/60">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input type="search" aria-label="Search transcript" placeholder="Search transcript…" value={query}
            onChange={(e) => { setQuery(e.target.value); if (scrollRef.current) scrollRef.current.scrollTop = 0; }}
            className="min-w-0 flex-1 bg-transparent py-2 text-xs outline-none" />
          {search && <span className="shrink-0 text-xs text-neutral-400" role="status">{visible.length} {visible.length === 1 ? "result" : "results"}</span>}
        </div>
      </div>
      <div ref={scrollRef} onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        setFollowing(stickRef.current);
      }} className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
        {visible.length === 0 ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center">
            <p className="text-sm font-medium text-neutral-600 dark:text-neutral-300">{search ? "No matching text" : live ? "Listening…" : "No transcript captured"}</p>
            <p className="mt-2 text-xs text-neutral-400">{search ? "Try a different word or clear the search." : live ? "Your conversation will appear here as you speak." : "This meeting has no recorded transcript."}</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl divide-y divide-neutral-100 dark:divide-neutral-800/60">
            {visible.map((seg) => (
              <article key={seg.id} className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-3 py-5">
                <div className="pt-0.5">
                  <p className={`text-xs font-semibold ${seg.speaker === "me" ? "text-indigo-600 dark:text-indigo-400" : "text-neutral-600 dark:text-neutral-300"}`}>{seg.speaker === "me" ? "You" : "Them"}</p>
                  <time className="mt-1 block font-mono text-[11px] tabular-nums text-neutral-400">{formatTimestamp(seg.tStart)}</time>
                </div>
                <div className="min-w-0">
                  <p dir="auto" className={`whitespace-pre-wrap break-words text-[15px] leading-[1.85] ${seg.final ? "text-neutral-800 dark:text-neutral-200" : "text-neutral-500 dark:text-neutral-400"}`}>
                    <Highlight text={seg.text} query={search} />
                    {!seg.final && <span className="ml-1 inline-block h-4 w-0.5 animate-pulse bg-indigo-500 align-middle" aria-label="Transcribing" />}
                  </p>
                  {showTranslations && seg.translatedText && seg.translatedText.trim() !== seg.text.trim() && <div className="mt-2 border-l-2 border-indigo-200 pl-3 dark:border-indigo-500/30">
                    <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-500">Translation</p>
                    <p dir="auto" className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-500 dark:text-neutral-400"><Highlight text={seg.translatedText} query={search} /></p>
                  </div>}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      {live && !following && !search && <button type="button" onClick={() => {
        stickRef.current = true; setFollowing(true);
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }} className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-4 py-2 text-xs font-medium text-white shadow-lg">Jump to latest ↓</button>}
    </div>
  );
}
