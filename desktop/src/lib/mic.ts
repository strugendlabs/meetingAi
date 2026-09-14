// Mic ("Me") capture: getUserMedia -> AudioWorklet -> Int16 PCM 16 kHz chunks.
// The worklet (src/audio/pcm-worklet.js) posts Float32 blocks at the context's
// native rate; here we downsample to 16 kHz, convert to Int16, and batch to
// ~250 ms chunks (CHUNK_SAMPLES) for Gemini Live.

import { Downsampler, floatTo16 } from "./pcm";

/** ~250 ms of audio at 16 kHz. */
export const CHUNK_SAMPLES = 4000;

const WORKLET_NAME = "pcm-worklet";

/** Thrown when microphone access is denied (permission / TCC / policy). */
export class MicPermissionError extends Error {
  constructor(message = "Microphone permission was denied. Allow microphone access in system privacy settings, then retry audio.") {
    super(message);
    this.name = "MicPermissionError";
  }
}

/**
 * Pure chunk-batching logic (extracted for unit testing).
 * Concatenates carried-over `pending` samples with `incoming`, emits as many
 * full `chunkSize` chunks as possible, and returns the remainder to carry.
 * Inputs are never mutated; ordering is pending-first then incoming.
 */
export function batchSamples(
  pending: Int16Array,
  incoming: Int16Array,
  chunkSize: number = CHUNK_SAMPLES,
): { chunks: Int16Array[]; rest: Int16Array } {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  const total = pending.length + incoming.length;
  if (total < chunkSize) {
    if (incoming.length === 0) return { chunks: [], rest: pending };
    if (pending.length === 0) return { chunks: [], rest: incoming };
    const rest = new Int16Array(total);
    rest.set(pending, 0);
    rest.set(incoming, pending.length);
    return { chunks: [], rest };
  }
  const all = new Int16Array(total);
  all.set(pending, 0);
  all.set(incoming, pending.length);
  const chunks: Int16Array[] = [];
  let off = 0;
  while (total - off >= chunkSize) {
    chunks.push(all.slice(off, off + chunkSize));
    off += chunkSize;
  }
  return { chunks, rest: all.slice(off) };
}

/**
 * Load the worklet module into `ctx`. Vite inlines small assets as
 * `data:text/javascript;base64,...` URIs in production builds; WebKit's
 * `audioWorklet.addModule` is unreliable with data: URLs, so convert those to
 * a Blob URL first. In dev the URL is a plain http(s) path and is used as-is.
 */
async function loadWorkletModule(ctx: AudioContext): Promise<void> {
  const href = new URL("../audio/pcm-worklet.js", import.meta.url).href;
  if (!href.startsWith("data:")) {
    await ctx.audioWorklet.addModule(href);
    return;
  }
  const comma = href.indexOf(",");
  const meta = href.slice(0, comma);
  const payload = href.slice(comma + 1);
  let bytes: Uint8Array;
  if (meta.includes(";base64")) {
    const bin = atob(payload);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  const blobUrl = URL.createObjectURL(
    new Blob([bytes], { type: "text/javascript" }),
  );
  try {
    await ctx.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function isPermissionDenial(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    name === "SecurityError"
  );
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private pending: Int16Array = new Int16Array(0);
  private onChunk: ((pcm16k: Int16Array) => void) | null = null;
  private running = false;
  private resampler: Downsampler | null = null;

  /** Start capturing; `onChunk` receives ~250 ms Int16 16 kHz chunks. */
  async start(onChunk: (pcm16k: Int16Array) => void, onError?: (message: string) => void): Promise<void> {
    if (this.running) throw new Error("MicCapture is already started");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not supported in this environment");
    }
    this.running = true;
    this.onChunk = onChunk;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this.running = false;
      this.onChunk = null;
      if (isPermissionDenial(err)) throw new MicPermissionError();
      throw err instanceof Error ? err : new Error(String(err));
    }
    // stop() may have run while getUserMedia (and its permission prompt) was
    // pending — it cleared `running` but had nothing to release yet. Without
    // this check the capture graph below would be built with no owner and the
    // mic would stay held (orange indicator lit) until the app quits.
    if (!this.running) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    for (const track of stream.getAudioTracks()) {
      track.onended = () => { if (this.running) onError?.("Microphone disconnected. Reconnect it, then retry audio."); };
    }
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.resampler = new Downsampler(ctx.sampleRate);
      await loadWorkletModule(ctx);
      if (!this.running) {
        // stop() ran during worklet load; ctx/stream were visible to
        // teardown() by then, but close explicitly in case it raced ahead.
        this.releaseAcquired();
        return;
      }
      if (ctx.state === "suspended") await ctx.resume();
      if (!this.running) {
        this.releaseAcquired();
        return;
      }
      this.source = ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(ctx, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: "explicit",
      });
      this.node.port.onmessage = (e: MessageEvent) => {
        this.handleFrame(e.data as Float32Array);
      };
      this.node.onprocessorerror = () => onError?.("Microphone processing stopped. Retry audio to resume.");
      // Route through a muted gain so the graph keeps processing without
      // feeding the mic back to the speakers.
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);
    } catch (err) {
      this.teardown();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Stop capturing; flushes any final partial (<250 ms) chunk. */
  stop(): void {
    if (!this.running) return;
    const rest = this.pending;
    const cb = this.onChunk;
    this.teardown();
    if (cb && rest.length > 0) cb(rest);
  }

  /** Release resources acquired mid-start after stop() won the race. */
  private releaseAcquired(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  private handleFrame(f32: Float32Array): void {
    if (!this.running || !this.ctx || !this.onChunk) return;
    const ds = this.resampler!.process(f32);
    const { chunks, rest } = batchSamples(this.pending, floatTo16(ds));
    this.pending = rest;
    for (const chunk of chunks) this.onChunk(chunk);
  }

  private teardown(): void {
    this.running = false;
    this.resampler = null;
    this.pending = new Int16Array(0);
    this.onChunk = null;
    if (this.node) {
      this.node.port.postMessage("stop");
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.sink) {
      this.sink.disconnect();
      this.sink = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

// Manual-verification hook (plan Task 3): in a browser console run
//   const stop = await window.__testMic();  // grants mic, logs chunk sizes
//   stop();
declare global {
  interface Window {
    __testMic?: () => Promise<() => void>;
  }
}

if (typeof window !== "undefined") {
  window.__testMic = async () => {
    const mic = new MicCapture();
    let n = 0;
    await mic.start((chunk) => {
      n += 1;
      const ms = ((chunk.length / 16000) * 1000).toFixed(0);
      console.log(`[__testMic] chunk #${n}: ${chunk.length} samples (~${ms} ms)`);
    });
    console.log("[__testMic] capture started; call the returned fn to stop");
    return () => mic.stop();
  };
}
