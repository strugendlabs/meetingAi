// Gemini Live API client — v1beta BidiGenerateContent over WebSocket.
//
// Protocol (see plan Task 5):
//   URL:    wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage
//           .v1beta.GenerativeService.BidiGenerateContent?key=<apiKey>
//   Client: {"setup":{...}} first, then {"realtimeInput":{"audio":{...}}} frames.
//   Server: {"setupComplete":{}} | {"serverContent":{inputTranscription|modelTurn|turnComplete}}
//   Server messages may arrive as Blob — we request ArrayBuffer delivery via
//   binaryType and additionally serialize any async Blob reads through a
//   per-socket queue so frames are always handled in arrival order.
//
// Reconnect: on close codes != 1000 during an active meeting, exponential
// backoff 0.5s -> 8s for the first RECONNECT_RAMP_ATTEMPTS attempts, then
// steady retries every 8s until close() is called or the server closes
// normally — a transient outage must never permanently kill a direction
// mid-meeting. Terminal states are exposed via the readonly `dead` flag;
// onClose fires exactly once, at the transition to dead, for every session
// whose connect() resolved (never during reconnect attempts).

import { b64ToInt16, int16ToB64 } from "../pcm";
import { isTranscriptionModel, LIVE_STT_MODEL_CHAIN, withModelFallback } from "./models";

const LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const WS_OPEN = 1; // WebSocket.OPEN
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
/** Attempts in the exponential ramp (and with per-attempt onError messages);
 * after these, retries continue every RECONNECT_MAX_MS with one final
 * steady-state onError notice. */
const RECONNECT_RAMP_ATTEMPTS = 5;

export const TRANSCRIPT_DRAIN_MS = 3000;
export const CONNECT_TIMEOUT_MS = 15000;

export interface TranscriptEvent {
  /** Dedicated STT emits replaceable hypotheses followed by a final snapshot. */
  kind: "interim" | "final" | "delta";
  tStart?: number;
  tEnd?: number;
}

export interface LiveSessionOpts {
  apiKey: string;
  model: string;
  responseModalities: ("TEXT" | "AUDIO")[];
  systemInstruction?: string;
  voiceName?: string;
  translationLanguage?: string;
  inputTranscription?: boolean;
  onTranscript?: (text: string, event?: TranscriptEvent) => void;
  onTranscriptFinished?: () => void;
  onOutputTranscript?: (text: string) => void;
  onAudio?: (pcm24k: Int16Array) => void;
  onOpen?: () => void;
  onError?: (e: Error) => void;
  onClose?: (code: number) => void;
}

/** Structural WebSocket surface we rely on (satisfied by browser WS + test mocks). */
interface WsLike {
  readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
}
type WsCtor = new (url: string) => WsLike;

/** Per-socket receive queue: serializes async Blob reads with later frames. */
interface RxQueue {
  chain: Promise<void>;
  pending: number;
}

interface ServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    inputTranscription?: { text?: string; finished?: boolean };
    interimInputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    modelTurn?: {
      parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }>;
    };
    turnComplete?: boolean;
  };
}

export class GeminiLiveSession {
  private readonly opts: LiveSessionOpts;
  private ws: WsLike | null = null;
  private setupDone = false;
  private everConnected = false;
  private userClosed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private _dead = false;
  private drainPromise: Promise<void> | null = null;
  private resolveDrain: (() => void) | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: LiveSessionOpts) {
    this.opts = opts;
  }

  get isOpen(): boolean {
    return this.setupDone && this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /**
   * True once the session is permanently terminal — it will never (re)connect
   * again and sendAudio() is a no-op, so callers should stop feeding audio.
   * Transitions to dead: (1) close() was called (dead is true synchronously
   * on return); (2) the server closed normally (code 1000) after a successful
   * connect; (3) the initial connect() failed (the rejection is the signal —
   * onClose does not fire for sessions that never connected); (4) WebSocket
   * is unavailable in the environment. Abnormal mid-meeting closes are NOT
   * terminal: the session retries forever (throttled) until one of the above.
   * For every session whose connect() resolved, onClose fires exactly once,
   * at the moment dead becomes true — never during reconnect attempts.
   */
  get dead(): boolean {
    return this._dead;
  }

  /** Opens the WS, sends setup, resolves once the server confirms setupComplete. */
  connect(): Promise<void> {
    if (this._dead) {
      return Promise.reject(new Error("GeminiLiveSession is dead (closed or failed)"));
    }
    if (this.ws || this.pending) {
      return Promise.reject(new Error("GeminiLiveSession.connect() already called"));
    }
    this.userClosed = false;
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.openSocket();
    });
  }

  /** Sends one PCM16 LE mono 16 kHz chunk. Dropped silently while not open —
   * callers should stop feeding audio once `dead` is true. */
  sendAudio(pcm16k: Int16Array): void {
    if (!this.isOpen || !this.ws || this.drainPromise) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: int16ToB64(pcm16k), mimeType: "audio/pcm;rate=16000" },
        },
      }),
    );
  }

  /** Stop sending audio, but allow late transcriptions to arrive before close.
   * Input transcription is independent of model turnComplete, so always allow
   * a bounded drain window rather than closing on the model's response turn.
   */
  finishInput(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    if (!this.isOpen || !this.ws) return Promise.resolve();
    this.drainPromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveDrain = null;
        resolve();
      }, TRANSCRIPT_DRAIN_MS);
      this.resolveDrain = () => { clearTimeout(timer); this.resolveDrain = null; resolve(); };
    });
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch {
      this.resolveDrain?.();
    }
    return this.drainPromise;
  }

  /** Intentional close — no reconnect. Idempotent; `dead` is true on return. */
  close(): void {
    this.clearSetupTimer();
    this.resolveDrain?.();
    if (this._dead) return; // already terminal; onClose already delivered
    this.userClosed = true;
    this._dead = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    if (ws && ws.readyState <= WS_OPEN) {
      ws.close(1000); // onclose handler forwards to opts.onClose
    } else {
      this.ws = null;
      this.setupDone = false;
      const pending = this.pending;
      this.pending = null;
      pending?.reject(new Error("GeminiLiveSession closed by user"));
      this.opts.onClose?.(1000);
    }
  }

  private openSocket(): void {
    const Ctor = (globalThis as { WebSocket?: unknown }).WebSocket as WsCtor | undefined;
    if (!Ctor) {
      this._dead = true;
      const err = new Error("WebSocket is not available in this environment");
      const pending = this.pending;
      this.pending = null;
      if (pending) {
        pending.reject(err);
      } else {
        // Mid-meeting (reconnect) — surface the terminal transition.
        this.opts.onError?.(err);
        this.opts.onClose?.(1006);
      }
      return;
    }
    this.setupDone = false;
    const ws = new Ctor(`${LIVE_WS_URL}?key=${encodeURIComponent(this.opts.apiKey)}`);
    this.ws = ws;
    this.setupTimer = setTimeout(() => {
      if (this.ws !== ws || this.setupDone) return;
      // Detach before closing: some WebViews never deliver onclose for a
      // stalled handshake. Settle the attempt ourselves exactly once.
      ws.onclose = null;
      ws.close();
      this.handleClose(1006, "Recognition connection timed out. Check your connection and retry.");
    }, CONNECT_TIMEOUT_MS);
    // Ask for ArrayBuffer delivery so binary frames are handled synchronously
    // in event order (WebKit otherwise hands us Blobs needing async reads).
    ws.binaryType = "arraybuffer";
    // Each socket gets its own receive queue so a pending Blob read from a
    // replaced socket can never block or reorder the next socket's frames.
    const rx: RxQueue = { chain: Promise.resolve(), pending: 0 };
    ws.onopen = () => {
      ws.send(JSON.stringify({ setup: this.buildSetup() }));
    };
    ws.onmessage = (ev) => {
      this.receive(ws, rx, ev.data);
    };
    ws.onerror = () => {
      // Close (with a code) always follows an error; only surface mid-meeting.
      if (this.everConnected) this.opts.onError?.(new Error("Gemini Live WebSocket error"));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.handleClose(ev.code ?? 1006, ev.reason ?? "");
    };
  }

  private buildSetup(): Record<string, unknown> {
    if (this.opts.model === "gemini-3.5-live-translate-preview") {
      const language = this.opts.translationLanguage ?? "en";
      const targetLanguageCode = ({ "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" } as Record<string, string>)[language] ?? language;
      return {
        model: `models/${this.opts.model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: { targetLanguageCode, echoTargetLanguage: false },
        },
        // These are setup fields, not GenerationConfig fields (the live
        // endpoint rejects the nesting in the translation guide's example).
        ...(this.opts.onOutputTranscript ? { outputAudioTranscription: {} } : {}),
        ...(this.opts.inputTranscription ? { inputAudioTranscription: {} } : {}),
      };
    }
    if (isTranscriptionModel(this.opts.model)) {
      return {
        model: `models/${this.opts.model}`,
        generationConfig: { responseModalities: ["TEXT"] },
        // Auto detection preserves Hindi/English code-switching even when
        // the user's preferred summary/translation language is English.
        inputAudioTranscription: { languageCodes: [], mode: "SMART" },
      };
    }
    const generationConfig: Record<string, unknown> = {
      responseModalities: this.opts.responseModalities,
    };
    if (this.opts.voiceName) {
      generationConfig.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.opts.voiceName } },
      };
    }
    const setup: Record<string, unknown> = {
      model: `models/${this.opts.model}`,
      generationConfig,
    };
    if (this.opts.systemInstruction) {
      setup.systemInstruction = { parts: [{ text: this.opts.systemInstruction }] };
    }
    if (this.opts.inputTranscription) setup.inputAudioTranscription = {};
    return setup;
  }

  /**
   * Frame handling preserves arrival order: synchronous frames (string /
   * ArrayBuffer) are handled inline only while no async Blob read is pending;
   * otherwise every frame — synchronous ones included — is chained onto the
   * socket's promise queue so a later frame can never overtake an in-flight
   * Blob read (transcript deltas must be applied in arrival order). Frames
   * from a socket that is no longer current (e.g. a Blob read resolving after
   * a reconnect swapped the socket) are dropped.
   */
  private receive(ws: WsLike, rx: RxQueue, raw: unknown): void {
    let sync: string | null = null;
    if (typeof raw === "string") {
      sync = raw;
    } else if (raw instanceof ArrayBuffer) {
      sync = new TextDecoder().decode(raw);
    }
    const blobish = raw as { text?: () => Promise<string> } | null;
    const readable = sync === null && typeof blobish?.text === "function";
    if (sync === null && !readable) {
      this.opts.onError?.(new Error("Gemini Live: unrecognized WebSocket message type"));
      return;
    }
    if (sync !== null && rx.pending === 0) {
      if (this.ws === ws) this.handleText(sync);
      return;
    }
    rx.pending += 1;
    rx.chain = rx.chain
      .then(async () => {
        const text = sync !== null ? sync : await blobish!.text!();
        if (this.ws === ws) this.handleText(text);
      })
      .catch((e: unknown) => {
        if (this.ws === ws) {
          this.opts.onError?.(e instanceof Error ? e : new Error(String(e)));
        }
      })
      .finally(() => {
        rx.pending -= 1;
      });
  }

  private handleText(text: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      this.opts.onError?.(new Error("Gemini Live: failed to parse server message as JSON"));
      return;
    }
    if (msg.setupComplete !== undefined) {
      this.clearSetupTimer();
      this.setupDone = true;
      this.everConnected = true;
      this.reconnectAttempts = 0;
      const pending = this.pending;
      this.pending = null;
      pending?.resolve();
      this.opts.onOpen?.();
      return;
    }
    const sc = msg.serverContent;
    if (!sc) return;
    const dedicated = isTranscriptionModel(this.opts.model);
    if (dedicated && typeof sc.interimInputTranscription?.text === "string") {
      this.opts.onTranscript?.(sc.interimInputTranscription.text, { kind: "interim" });
    }
    const transcript = sc.inputTranscription?.text;
    if (typeof transcript === "string" && transcript.length > 0) {
      if (dedicated) this.opts.onTranscript?.(transcript, { kind: "final" });
      else this.opts.onTranscript?.(transcript);
    }
    if (sc.inputTranscription?.finished) this.opts.onTranscriptFinished?.();
    if (sc.outputTranscription?.text) this.opts.onOutputTranscript?.(sc.outputTranscription.text);
    const parts = sc.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        const inline = part?.inlineData;
        if (
          inline?.data &&
          typeof inline.mimeType === "string" &&
          inline.mimeType.startsWith("audio/pcm")
        ) {
          this.opts.onAudio?.(b64ToInt16(inline.data));
        }
      }
    }
    // turnComplete carries no payload we need at this layer.
  }

  private clearSetupTimer(): void {
    if (this.setupTimer !== null) clearTimeout(this.setupTimer);
    this.setupTimer = null;
  }

  private handleClose(code: number, reason: string): void {
    this.clearSetupTimer();
    this.resolveDrain?.();
    this.setupDone = false;
    this.ws = null;
    if (this.userClosed) {
      this._dead = true;
      const pending = this.pending;
      this.pending = null;
      pending?.reject(new Error("GeminiLiveSession closed by user"));
      this.opts.onClose?.(code);
      return;
    }
    if (!this.everConnected) {
      // Initial connect failed — terminal; reject connect(); reason text
      // (e.g. NOT_FOUND) lets connectLiveWithFallback advance the model chain.
      this._dead = true;
      const pending = this.pending;
      this.pending = null;
      pending?.reject(
        new Error(
          `Gemini Live connect failed (model ${this.opts.model}): code=${code}${
            reason ? ` reason=${reason}` : ""
          }`,
        ),
      );
      return;
    }
    if (code === 1000) {
      // Server ended the stream normally — terminal.
      this._dead = true;
      this.opts.onClose?.(code);
      return;
    }
    if (this.drainPromise) {
      this._dead = true;
      this.opts.onClose?.(code);
      return;
    }
    // Abnormal close during an active meeting → reconnect. Exponential ramp
    // for the first RECONNECT_RAMP_ATTEMPTS, then keep retrying forever at
    // RECONNECT_MAX_MS — a transient outage (even one longer than the ramp)
    // must not kill this direction for the rest of the meeting. onError fires
    // once per ramp attempt, once more on entering steady-state retry, then
    // stays quiet until recovery (attempts reset on setupComplete) or close.
    this.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts - 1, 10),
    );
    if (this.reconnectAttempts <= RECONNECT_RAMP_ATTEMPTS) {
      this.opts.onError?.(
        new Error(
          `Gemini Live connection lost (code=${code}); reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
        ),
      );
    } else if (this.reconnectAttempts === RECONNECT_RAMP_ATTEMPTS + 1) {
      this.opts.onError?.(
        new Error(
          `Gemini Live still disconnected (code=${code}); continuing to retry every ${RECONNECT_MAX_MS}ms`,
        ),
      );
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.userClosed) this.openSocket();
    }, delay);
  }
}

/**
 * Connects walking `chain` (default: the STT chain). Advances to the next
 * model only when the connection fails with a model-unusable error — doesn't
 * exist, or rejects the requested modalities (per withModelFallback).
 */
export async function connectLiveWithFallback(
  opts: Omit<LiveSessionOpts, "model">,
  chain: string[] = LIVE_STT_MODEL_CHAIN,
): Promise<{ session: GeminiLiveSession; model: string }> {
  const { model, result } = await withModelFallback(chain, async (candidate) => {
    const session = new GeminiLiveSession({ ...opts, model: candidate });
    await session.connect();
    return session;
  });
  return { session: result, model };
}
