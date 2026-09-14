import { useEffect, useState } from "react";
import { isTauri, safeInvoke } from "../../lib/tauri";

type MicState = "unknown" | "requesting" | "granted" | "denied";
type SystemState = "unknown" | "checking" | "granted" | "denied" | "unavailable" | "error";

export interface SystemCheckResult {
  state: SystemState;
  /** Underlying failure message when the check itself could not run. */
  error: string | null;
}

/**
 * Run the system-audio availability check, keeping a genuine macOS TCC denial
 * (state "denied") distinct from the check failing to run at all (state
 * "error" — e.g. the sidecar binary is missing from a broken install).
 * Collapsing the two would send macOS users to System Settings for a permission
 * the OS never registered, an unresolvable loop. On Windows this verifies that
 * WASAPI loopback capture can initialize; there is no separate user permission.
 */
export async function runSystemAudioCheck(): Promise<SystemCheckResult> {
  try {
    const ok = await safeInvoke<boolean>("check_system_audio_permission");
    if (ok === undefined) return { state: isTauri() ? "denied" : "unavailable", error: null };
    return { state: ok ? "granted" : "denied", error: null };
  } catch (e) {
    console.error("check_system_audio_permission failed", e);
    return { state: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

function StatusChip({ tone, label }: { tone: "neutral" | "busy" | "good" | "bad"; label: string }) {
  const styles = {
    neutral: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
    busy: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300",
    good: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    bad: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[tone]}`}>
      {label}
    </span>
  );
}

export default function PermissionsStep() {
  const [mic, setMic] = useState<MicState>("unknown");
  const [system, setSystem] = useState<SystemState>("unknown");
  const [systemError, setSystemError] = useState<string | null>(null);

  // Best-effort pre-check of the mic permission (unsupported engines just
  // leave the state at "unknown").
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await navigator.permissions?.query({
          name: "microphone" as PermissionName,
        });
        if (cancelled || !status) return;
        if (status.state === "granted") setMic("granted");
        else if (status.state === "denied") setMic("denied");
      } catch {
        // Permissions API not available — user can still request below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const requestMic = async () => {
    setMic("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMic("granted");
    } catch {
      setMic("denied");
    }
  };

  const checkSystem = async () => {
    setSystem("checking");
    setSystemError(null);
    const result = await runSystemAudioCheck();
    setSystem(result.state);
    setSystemError(result.error);
  };

  const micChip =
    mic === "granted" ? (
      <StatusChip tone="good" label="Granted" />
    ) : mic === "denied" ? (
      <StatusChip tone="bad" label="Denied" />
    ) : mic === "requesting" ? (
      <StatusChip tone="busy" label="Asking…" />
    ) : (
      <StatusChip tone="neutral" label="Not requested" />
    );

  const systemChip =
    system === "granted" ? (
      <StatusChip tone="good" label="Granted" />
    ) : system === "denied" ? (
      <StatusChip tone="bad" label="Not granted" />
    ) : system === "error" ? (
      <StatusChip tone="bad" label="Check failed" />
    ) : system === "checking" ? (
      <StatusChip tone="busy" label="Checking…" />
    ) : system === "unavailable" ? (
      <StatusChip tone="neutral" label="Desktop app only" />
    ) : (
      <StatusChip tone="neutral" label="Not checked" />
    );

  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">Permissions</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Two permissions make live transcription work — your microphone for your side, and system
        audio for the other side of the call.
      </p>

      <div className="mt-6 space-y-3.5">
        <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21m-3.5 0h7" strokeLinecap="round" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-medium">Microphone</p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Captures your voice (&ldquo;Me&rdquo;)</p>
              </div>
            </div>
            {micChip}
          </div>
          {mic !== "granted" && (
            <button
              type="button"
              onClick={requestMic}
              disabled={mic === "requesting"}
              className="mt-3 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Allow microphone
            </button>
          )}
          {mic === "denied" && (
            <p className="mt-2.5 text-xs text-neutral-500 dark:text-neutral-400">
              Blocked? Enable it in System Settings &rarr; Privacy &amp; Security &rarr; Microphone,
              then try again.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5" aria-hidden="true">
                  <path d="M4 13a8 8 0 0 1 16 0" strokeLinecap="round" />
                  <rect x="2.5" y="13" width="4.5" height="7" rx="1.8" />
                  <rect x="17" y="13" width="4.5" height="7" rx="1.8" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-medium">System audio</p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Captures the other side of the call (&ldquo;Them&rdquo;)
                </p>
              </div>
            </div>
            {systemChip}
          </div>
          {system !== "granted" && (
            <button
              type="button"
              onClick={checkSystem}
              disabled={system === "checking"}
              className="mt-3 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Check permission
            </button>
          )}
          {system === "denied" && (
            <p className="mt-2.5 text-xs text-neutral-500 dark:text-neutral-400">
              On macOS, grant Screen &amp; System Audio Recording to MeetingAI in System
              Settings &rarr; Privacy &amp; Security. On Windows, confirm that an output audio
              device is connected and enabled, then check again.
            </p>
          )}
          {system === "error" && (
            <p role="alert" className="mt-2.5 break-words text-xs text-red-600 dark:text-red-400">
              Couldn&rsquo;t run the system-audio permission check
              {systemError ? `: ${systemError}` : ""}. Try reconnecting your output audio device
              or reinstalling MeetingAI, then check again.
            </p>
          )}
          {system === "unavailable" && (
            <p className="mt-2.5 text-xs text-neutral-500 dark:text-neutral-400">
              System-audio capture is only available in the MeetingAI desktop app.
            </p>
          )}
        </div>
      </div>

      <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
        You can continue and grant these later — recording will ask again when it needs them.
      </p>
    </div>
  );
}
