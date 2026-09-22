import { useEffect, useState } from "react";
import { describeAudio, emptyAudioSource, type AudioSourceHealth } from "../../lib/audioHealth";
import type { Speaker } from "../../lib/types";
import { sanitizeDetail } from "./StatusBar";
import { safeInvoke } from "../../lib/tauri";
import { useSettings } from "../../lib/settings";

export default function AudioStatus({ sources, onRetry, onMicrophoneChange }: {
  sources: AudioSourceHealth[];
  onRetry: (speaker: Speaker) => Promise<void>;
  onMicrophoneChange: (deviceId: string) => Promise<void>;
}) {
  const [retrying, setRetrying] = useState<Speaker[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const deviceId = useSettings((s) => s.microphoneDeviceId ?? "");
  const updateSettings = useSettings((s) => s.update);
  const items = sources.length ? sources : [emptyAudioSource("me"), emptyAudioSource("them")];
  const micReady = sources.some((s) => s.speaker === "me" && s.capture === "ready");
  useEffect(() => {
    let cancelled = false;
    const media = navigator.mediaDevices;
    const refresh = async () => {
      try {
        const all = await media?.enumerateDevices();
        if (!cancelled) setDevices((all ?? []).filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default"));
      } catch { /* The input selector remains available with system default. */ }
    };
    void refresh();
    media?.addEventListener?.("devicechange", refresh);
    return () => { cancelled = true; media?.removeEventListener?.("devicechange", refresh); };
  }, [micReady]);
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
            setActionError(null);
            try { await onRetry(source.speaker); }
            catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
            finally { setRetrying((prev) => prev.filter((s) => s !== source.speaker)); }
          }} aria-label={`Retry ${source.speaker === "me" ? "microphone" : "call audio"}`} className="text-[11px] font-medium text-indigo-600 disabled:opacity-40 dark:text-indigo-400">{busy ? "Retrying…" : "Retry audio"}</button>
        </div>
        <div role="meter" aria-label={`${source.speaker === "me" ? "Microphone" : "Call audio"} level`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className="mb-2 h-1 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          <div className="h-full rounded-full bg-indigo-500 transition-[width] duration-300" style={{ width: `${level * 100}%` }} />
        </div>
        <p className={`break-words text-[11px] leading-relaxed ${source.error ? "text-amber-600 dark:text-amber-400" : "text-neutral-500 dark:text-neutral-400"}`}>{sanitizeDetail(describeAudio(source, Date.now()))}</p>
        {source.speaker === "me" && <div className="mt-2">
          <label htmlFor="meeting-microphone" className="mb-1 block text-[10px] text-neutral-500">Microphone input</label>
          <select id="meeting-microphone" value={deviceId} disabled={busy} onChange={async (event) => {
            const next = event.target.value;
            updateSettings({ microphoneDeviceId: next });
            setActionError(null);
            setRetrying((prev) => [...prev, "me"]);
            try { await onMicrophoneChange(next); }
            catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
            finally { setRetrying((prev) => prev.filter((s) => s !== "me")); }
          }} className="w-full min-w-0 truncate rounded-md border border-neutral-200 bg-transparent px-2 py-1.5 text-[11px] dark:border-neutral-700 dark:bg-neutral-900">
            <option value="">System default{!deviceId && source.inputLabel ? ` · ${source.inputLabel}` : ""}</option>
            {deviceId && !devices.some((d) => d.deviceId === deviceId) && <option value={deviceId}>Selected microphone unavailable</option>}
            {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
          </select>
        </div>}
        {source.error && <button type="button" onClick={async () => {
          setActionError(null);
          const permission = /permission|user declined|not permitted/i.test(source.error ?? "");
          try { await safeInvoke("open_audio_settings", { source: permission ? (source.speaker === "me" ? "microphone" : "system") : "input" }); }
          catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
        }} className="mt-2 text-[11px] font-semibold text-indigo-600 underline underline-offset-2 dark:text-indigo-400">
          {/permission|user declined|not permitted/i.test(source.error) ? "Open recording settings" : "Open sound settings"}
        </button>}
      </div>;
    })}
    {actionError && <p role="alert" className="col-span-2 text-xs text-amber-600 dark:text-amber-400">{sanitizeDetail(actionError)}</p>}
  </div>;
}
