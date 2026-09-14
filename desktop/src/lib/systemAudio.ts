// System-audio ("Them") capture bridge (Task 8; consumes the Task 4 contract).
//
// The Rust side (src-tauri/src/audio_bridge.rs) spawns the Swift sidecar and
// re-emits its PCM frames to the webview as Tauri events:
//   "system-audio-chunk"  { data: <base64 PCM16 LE mono 16 kHz> }
//   "system-audio-error"  { message: string }
// This module subscribes to those events, decodes base64 -> Int16Array via
// pcm.ts, and starts/stops the native capture via the
// start_system_capture / stop_system_capture commands.

import { b64ToInt16 } from "./pcm";
import { safeInvoke, safeListen } from "./tauri";

export interface SystemAudioChunkPayload {
  data: string;
}

export interface SystemAudioErrorPayload {
  message: string;
}

export class SystemAudioCapture {
  private unlisteners: Array<() => void> = [];
  private running = false;

  /**
   * Subscribe to the sidecar events, then start the native capture.
   * `onChunk` receives Int16 PCM 16 kHz chunks; `onError` receives sidecar
   * error messages (capture may keep running or die — Rust side decides).
   */
  async start(
    onChunk: (pcm16k: Int16Array) => void,
    onError?: (message: string) => void,
  ): Promise<void> {
    if (this.running) throw new Error("SystemAudioCapture is already started");
    this.running = true;
    try {
      // Listeners first so no frame emitted right after start is lost.
      const unChunk = await safeListen<SystemAudioChunkPayload>(
        "system-audio-chunk",
        (payload) => {
          if (!this.running || !payload?.data) return;
          try {
            onChunk(b64ToInt16(payload.data));
          } catch {
            onError?.("system audio: failed to decode PCM chunk");
          }
        },
      );
      this.unlisteners.push(unChunk);
      // stop() may run during any await here. It clears `running`, so re-check
      // after every suspension — otherwise the start command would be sent
      // AFTER the stop command and the sidecar would record forever.
      if (this.abortedMidStart()) return;
      const unError = await safeListen<SystemAudioErrorPayload>(
        "system-audio-error",
        (payload) => {
          if (!this.running) return;
          onError?.(payload?.message ?? "unknown system audio error");
        },
      );
      this.unlisteners.push(unError);
      if (this.abortedMidStart()) return;
      await safeInvoke("start_system_capture");
      if (!this.running) {
        // stop() landed while the start invoke was in flight — its
        // stop_system_capture preceded our start, so send another.
        this.teardownListeners();
        await safeInvoke("stop_system_capture").catch(() => {});
      }
    } catch (err) {
      this.running = false;
      this.teardownListeners();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** True when stop() won a race against start(); cleans up what start made. */
  private abortedMidStart(): boolean {
    if (this.running) return false;
    this.teardownListeners();
    return true;
  }

  /** Unsubscribe and stop the native capture. Safe to call when not running. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.teardownListeners();
    await safeInvoke("stop_system_capture");
  }

  private teardownListeners(): void {
    for (const un of this.unlisteners.splice(0)) {
      try {
        un();
      } catch {
        // unlisten failures must never propagate
      }
    }
  }
}
