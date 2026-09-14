import { useState } from "react";
import { describeAudio, emptyAudioSource, type AudioSourceHealth } from "../../lib/audioHealth";
import type { Speaker } from "../../lib/types";
import { sanitizeDetail } from "./StatusBar";

export default function AudioStatus({ sources, onRetry }: {
  sources: AudioSourceHealth[];
  onRetry: (speaker: Speaker) => Promise<void>;
}) {
  const [retrying, setRetrying] = useState<Speaker[]>([]);
  const items = sources.length ? sources : [emptyAudioSource("me"), emptyAudioSource("them")];
  return <div className="grid shrink-0 grid-cols-2 gap-3 border-b border-neutral-200/70 bg-neutral-50/70 px-5 py-3 dark:border-neutral-800 dark:bg-neutral-900/30" aria-label="Audio sources">
    {items.map((source) => {
      const busy = retrying.includes(source.speaker);
      const stale = source.capture !== "ready" || source.lastAudioAt === null || Date.now() - source.lastAudioAt > 1500;
      const level = stale ? 0 : Math.min(1, Math.sqrt(source.level) * 2);
      return <div key={source.speaker} className="min-w-0 rounded-xl border border-neutral-200/80 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900/70">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold">{source.speaker === "me" ? "Your microphone" : "Call audio"}</span>
          <button type="button" disabled={busy} onClick={async () => {
            setRetrying((prev) => [...prev, source.speaker]);
            try { await onRetry(source.speaker); } finally { setRetrying((prev) => prev.filter((s) => s !== source.speaker)); }
          }} aria-label={`Retry ${source.speaker === "me" ? "microphone" : "call audio"}`} className="text-[11px] font-medium text-indigo-600 disabled:opacity-40 dark:text-indigo-400">{busy ? "Retrying…" : "Retry audio"}</button>
        </div>
        <div role="meter" aria-label={`${source.speaker === "me" ? "Microphone" : "Call audio"} level`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className="mb-2 h-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          <div className="h-full rounded-full bg-indigo-500 transition-[width] duration-300" style={{ width: `${level * 100}%` }} />
        </div>
        <p className={`break-words text-[11px] leading-relaxed ${source.error ? "text-amber-600 dark:text-amber-400" : "text-neutral-500 dark:text-neutral-400"}`}>{sanitizeDetail(describeAudio(source, Date.now()))}</p>
      </div>;
    })}
  </div>;
}
