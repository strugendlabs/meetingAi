// Meeting orchestrator (Task 8).
//
// Two independent speech-recognition sessions preserve Me/Them attribution.
// Optional spoken translation uses its own session, so interpretation or a
// voice switch cannot interrupt the other participant's original transcript.
// Dedicated STT emits replaceable interim hypotheses and final snapshots;
// legacy models emit deltas, finalized by a completion signal or pause.

import { addSegment, endMeeting, updateSegmentTranslation } from "./db";
import { audioLevel, emptyAudioSource, type AudioSourceHealth } from "./audioHealth";
import { connectLiveWithFallback } from "./gemini/live";
import type { LiveSessionOpts, TranscriptEvent } from "./gemini/live";
import { LIVE_TRANSLATE_MODEL_CHAIN } from "./gemini/models";
import { translateWithProvider } from "./ai";
import { isLocalAI, WHISPER_DEFAULT_URL } from "./localAi";
import { LocalSpeechSession, type SpeechSession } from "./localSpeech";
import { languageLabel } from "./languages";
import { MicCapture } from "./mic";
import { SystemAudioCapture } from "./systemAudio";
import { safeInvoke } from "./tauri";
import type {
  AppSettings,
  Meeting,
  Speaker,
  TranscriptSegment,
  VoiceGenderMode,
} from "./types";
import { pickVoice } from "./voices";

/** Silence gap after which an accumulating transcript segment is finalized. */
export const SEGMENT_PAUSE_MS = 3000;
/** Silence after translated-audio playback before the volume is restored. */
export const DUCK_RESTORE_SILENCE_MS = 400;
/** Gemini Live audio output sample rate. */
export const PLAYBACK_RATE = 24000;

export type MeetingStatus = "connecting" | "live" | "degraded" | "reconnecting" | "error";

/**
 * TS mirror of ducking.rs `ducked_level` — keep the two formulas in sync.
 * Used to size the playback boost to the actual duck ratio.
 */
export function duckedLevel(current: number): number {
  return Math.min(current, Math.max(20, Math.floor(current / 2)));
}

/** Compensation boost for the app's own voice while ducked (clamped 1–3×). */
export function duckCompensationGain(previousVolume: number): number {
  const ducked = duckedLevel(previousVolume);
  if (ducked <= 0 || previousVolume <= 0) return 1;
  return Math.min(3, Math.max(1, previousVolume / ducked));
}

/** Consecutive text-translation failures before the UI is told. */
export const TRANSLATE_FAILURE_NOTICE_AFTER = 3;

export interface MeetingCallbacks {
  onSegment(seg: TranscriptSegment): void;
  onStatus(s: MeetingStatus, detail?: string): void;
  onAudioHealth?(sources: AudioSourceHealth[]): void;
}

type SessionState = "idle" | "starting" | "live" | "stopped";

interface PendingSegment {
  id: string;
  text: string;
  tStart: number;
  tEnd: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Last few raw deltas (most-recent last) — feeds the repetition guard. */
  recentDeltas: string[];
}

/** Consecutive identical non-trivial deltas before further repeats are dropped. */
export const REPEAT_DELTA_THRESHOLD = 3;

/**
 * True when `a` and `b` are the same sentence for display purposes —
 * whitespace/case/trailing-punctuation-insensitive. Used to detect a
 * "translation" that came back identical to the source (the other speaker
 * was already talking in the user's language) so it isn't shown twice.
 */
export function isSameText(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[.!?,;:]+$/g, "").replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

/**
 * Appends a transcript delta, guarding against a stuck turn that repeats the
 * same phrase indefinitely (observed when translated-voice playback leaks
 * back into system-audio capture and Gemini re-transcribes its own output —
 * see sidecar main.swift's self-exclusion fix, the primary fix for that). A
 * `history` array (most-recent last) tracks the last `REPEAT_DELTA_THRESHOLD`
 * raw deltas for the pending segment; once that many in a row are byte-for-
 * -byte identical (and non-trivial — short fillers like "uh" don't count),
 * further repeats are dropped from `text` but still recorded in `history` so
 * the guard keeps holding until a genuinely different delta arrives.
 */
export function appendTranscriptDelta(
  accumulated: string,
  delta: string,
  history: string[],
): { text: string; history: string[]; loopDetected: boolean } {
  const nextHistory = [...history, delta].slice(-REPEAT_DELTA_THRESHOLD);
  const isTrivial = delta.trim().length < 3;
  const loopDetected =
    !isTrivial &&
    nextHistory.length === REPEAT_DELTA_THRESHOLD &&
    nextHistory.every((d) => d === delta);
  return {
    text: loopDetected ? accumulated : accumulated + delta,
    history: nextHistory,
    loopDetected,
  };
}

/**
 * WebAudio playback queue for 24 kHz PCM16 chunks. Chunks are scheduled
 * back-to-back on a dedicated AudioContext; `play` returns the milliseconds
 * until the queue drains (or null when WebAudio is unavailable).
 */
class PcmPlayer {
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  private gain: GainNode | null = null;
  private boost = 1;

  /**
   * Louden the app's own playback while the master volume is ducked — master
   * volume attenuates our translated voice exactly like the meeting audio, so
   * without compensation ducking would mute the very thing it exists to make
   * audible. A compressor after the gain limits clipping.
   */
  setBoost(factor: number): void {
    this.boost = factor;
    if (this.gain) this.gain.gain.value = factor;
  }

  play(pcm24k: Int16Array): number | null {
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor || pcm24k.length === 0) return null;
    if (!this.ctx) this.ctx = new Ctor({ sampleRate: PLAYBACK_RATE });
    const ctx = this.ctx;
    if (ctx.state === "suspended") void ctx.resume();
    const f32 = new Float32Array(pcm24k.length);
    for (let i = 0; i < pcm24k.length; i++) f32[i] = pcm24k[i] / 32768;
    const buffer = ctx.createBuffer(1, f32.length, PLAYBACK_RATE);
    buffer.getChannelData(0).set(f32);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.output(ctx));
    const startAt = Math.max(ctx.currentTime, this.nextStart);
    src.start(startAt);
    this.nextStart = startAt + f32.length / PLAYBACK_RATE;
    return Math.max(0, (this.nextStart - ctx.currentTime) * 1000);
  }

  /** Gain → compressor → destination when supported; destination otherwise. */
  private output(ctx: AudioContext): AudioNode {
    if (this.gain) return this.gain;
    if (typeof ctx.createGain !== "function") return ctx.destination;
    const gain = ctx.createGain();
    gain.gain.value = this.boost;
    if (typeof ctx.createDynamicsCompressor === "function") {
      const limiter = ctx.createDynamicsCompressor();
      gain.connect(limiter);
      limiter.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    this.gain = gain;
    return gain;
  }

  async close(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = null;
    this.gain = null;
    this.nextStart = 0;
    this.boost = 1;
    if (ctx) await ctx.close().catch(() => {});
  }
}

export class MeetingSession {
  private readonly apiKey: string;
  private readonly settings: AppSettings;
  private readonly meeting: Meeting;
  private readonly cb: MeetingCallbacks;

  private state: SessionState = "idle";
  private stopCalled = false;
  private stopPromise: Promise<void> | null = null;
  private draining = false;
  private writes = new Set<Promise<void>>();
  private everStarted = false;
  private readonly mic = new MicCapture();
  private readonly system = new SystemAudioCapture();
  private liveMe: SpeechSession | null = null;
  private liveThem: SpeechSession | null = null;
  private liveTranslate: SpeechSession | null = null;
  private audioSources = { me: emptyAudioSource("me"), them: emptyAudioSource("them") };
  private audioTimer: ReturnType<typeof setInterval> | null = null;
  private retrying = new Set<Speaker>();
  /** Every session we opened, so error paths can close them all. */
  private openedSessions: SpeechSession[] = [];

  private pending: Record<Speaker, PendingSegment | null> = { me: null, them: null };
  /** Segments whose DB write failed — retried on later writes and at teardown. */
  private failedSegments: TranscriptSegment[] = [];
  private translateFailStreak = 0;
  /**
   * Per-source health ("mic", "system audio", "translation", …). The status
   * reported to the UI is the worst entry, so one source recovering can never
   * mask another source's standing failure. `terminal` entries are latched.
   */
  private readonly health = new Map<
    string,
    { level: "live" | "degraded" | "reconnecting" | "error"; detail?: string; terminal?: boolean }
  >();
  /** Per-label count of pending intentional closes we initiated (a Set would
   *  let one stale entry swallow a later REAL failure's onClose). */
  private readonly expectIntentionalClose = new Map<string, number>();

  private translateVoice: string;
  private readonly player = new PcmPlayer();
  private prevVolume: number | null = null;
  /** Serializes duck/restore invokes so they can never race each other. */
  private volumeOps: Promise<void> = Promise.resolve();
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    apiKey: string,
    settings: AppSettings,
    meeting: Meeting,
    cb: MeetingCallbacks,
  ) {
    this.apiKey = apiKey;
    this.settings = settings;
    this.meeting = meeting;
    this.cb = cb;
    this.translateVoice = pickVoice(settings.voiceGenderMode);
  }

  /** Connect all Gemini sessions, then start mic + system captures. */
  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error("MeetingSession.start() may only be called once");
    }
    this.state = "starting";
    this.everStarted = true;
    this.cb.onStatus("connecting");
    try {
      // Sessions resolving after stop() ran must be closed, not leaked.
      const track = (p: Promise<{ session: SpeechSession; model: string }>) =>
        p.then((r) => {
          if ((this.state as SessionState) === "stopped") r.session.close();
          else this.openedSessions.push(r.session);
          return r;
        });
      const startVoice = this.translateVoice;
      const wantTranslate = this.settings.translationEnabled && !isLocalAI(this.settings);
      const me = track(this.connectRecognition("me"));
      const them = track(this.connectRecognition("them"));
      const translation = wantTranslate
        ? track(connectLiveWithFallback(this.translateOpts(startVoice), LIVE_TRANSLATE_MODEL_CHAIN))
          .then((result) => {
            if (this.state !== "stopped") this.liveTranslate = result.session;
            return result;
          })
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            this.setHealth("translation", "degraded", `Spoken translation unavailable: ${detail}`);
            return null;
          })
        : Promise.resolve(null);
      // Optional voice setup never holds microphone recognition hostage.
      void translation;
      const results = await Promise.allSettled([me, them]);
      // stop() may have run during any await below/above; a stopped session
      // must never go on to open the mic, spawn the sidecar, or flip back to
      // "live" — that would keep recording after the user ended the meeting.
      if (this.abortedDuringStart()) return;
      this.liveMe = results[0].status === "fulfilled" ? results[0].value.session : null;
      this.liveThem = results[1].status === "fulfilled" ? results[1].value.session : null;
      for (const [index, speaker] of (["me", "them"] as const).entries()) {
        const result = results[index];
        if (result.status !== "rejected") continue;
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.audioSources[speaker].capture = "error";
        this.audioSources[speaker].error = message;
        this.setHealth(speaker === "me" ? "mic transcription" : "them transcription", "error", message);
      }

      // A missing permission on one source must not silence the other.
      await Promise.all([
        this.liveMe ? this.startCapture("me") : Promise.resolve(),
        this.liveThem ? this.startCapture("them") : Promise.resolve(),
      ]);
      if (this.abortedDuringStart()) return;
      this.state = "live";
      this.audioTimer = setInterval(() => this.emitAudioHealth(), 500);
      this.emitAudioHealth();
      this.emitStatus();
      // A gender picked while we were still connecting was recorded but not
      // applied (reconnectTranslate no-ops before "live") — reconcile now.
      if (wantTranslate && this.translateVoice !== startVoice) {
        void this.reconnectTranslate(this.translateVoice);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // If the user already stopped, stop() handled teardown + ended_at; a
      // late connect failure must not re-report or re-stamp anything.
      if (this.stopCalled) throw err;
      this.cb.onStatus("error", err.message);
      await this.teardown();
      // A meeting that never went live must still be closed out in the DB,
      // or it stays "Live" forever and auto-records when reopened.
      await endMeeting(this.meeting.id).catch(() => {});
      throw err;
    }
  }

  /** True when stop() ran mid-start(); re-runs teardown to catch stragglers. */
  private abortedDuringStart(): boolean {
    if ((this.state as SessionState) !== "stopped") return false;
    void this.teardown();
    return true;
  }

  private receiveAudio(speaker: Speaker, chunk: Int16Array): void {
    const source = this.audioSources[speaker];
    source.level = audioLevel(chunk);
    source.lastAudioAt = Date.now();
    if (source.level > 0.008) {
      source.lastSoundAt = Date.now();
      source.soundSinceTranscriptMs += chunk.length / 16;
    }
    if (speaker === "me") this.liveMe?.sendAudio(chunk);
    else {
      this.liveThem?.sendAudio(chunk);
      this.liveTranslate?.sendAudio(chunk);
    }
  }

  private emitAudioHealth(): void {
    this.cb.onAudioHealth?.((["me", "them"] as const).map((speaker) => ({
      ...this.audioSources[speaker],
      connected: !!(speaker === "me" ? this.liveMe : this.liveThem)?.isOpen,
    })));
  }

  private async startCapture(speaker: Speaker): Promise<void> {
    const label = speaker === "me" ? "microphone" : "system audio";
    const error = (message: string) => {
      this.audioSources[speaker].capture = "error";
      this.audioSources[speaker].error = message;
      this.setHealth(label, "degraded", message);
      this.emitAudioHealth();
    };
    try {
      if (speaker === "me") await this.mic.start((pcm) => this.receiveAudio(speaker, pcm), error);
      else await this.system.start((pcm) => this.receiveAudio(speaker, pcm), error);
      if (this.state === "stopped") return;
      // An error event can arrive while the native start call is resolving.
      if (this.audioSources[speaker].capture !== "error") {
        this.audioSources[speaker].capture = "ready";
        this.setHealth(label, "live");
      }
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  }

  /** Recover one source without interrupting the other participant. */
  async retryAudio(speaker: Speaker): Promise<void> {
    if (this.state !== "live" || this.retrying.has(speaker)) return;
    this.retrying.add(speaker);
    const label = speaker === "me" ? "mic transcription" : "them transcription";
    const old = speaker === "me" ? this.liveMe : this.liveThem;
    try {
      if (speaker === "me") this.mic.stop();
      else await this.system.stop().catch(() => {});
      await this.finalizeSegment(speaker);
      if (this.state !== "live") return;
      if (old && !old.dead) {
        this.expectIntentionalClose.set(label, (this.expectIntentionalClose.get(label) ?? 0) + 1);
        old.close();
      }
      this.openedSessions = this.openedSessions.filter((s) => s !== old);
      this.health.delete(label);
      this.audioSources[speaker] = emptyAudioSource(speaker);
      this.emitAudioHealth();
      const { session } = await this.connectRecognition(speaker);
      if (this.state !== "live") { session.close(); return; }
      this.openedSessions.push(session);
      if (speaker === "me") this.liveMe = session;
      else this.liveThem = session;
      await this.startCapture(speaker);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.audioSources[speaker].capture = "error";
      this.audioSources[speaker].error = message;
      this.setHealth(label, "error", message);
    } finally {
      this.retrying.delete(speaker);
      this.emitAudioHealth();
    }
  }

  /**
   * Refine the other speaker's gender for this meeting; when the mapped voice
   * changes, the translate session is reconnected with the new voice.
   */
  setOtherGender(g: VoiceGenderMode): void {
    const voice = pickVoice(
      this.settings.voiceGenderMode,
      g === "auto" ? undefined : g,
    );
    if (voice === this.translateVoice) return;
    this.translateVoice = voice;
    if (!this.settings.translationEnabled || isLocalAI(this.settings) || this.state !== "live") return;
    void this.reconnectTranslate(voice);
  }

  /**
   * Stop captures, close sessions, restore volume, mark the meeting ended.
   * Idempotent via a dedicated flag (not the state machine) so a stop() after
   * a failed start() still persists ended_at exactly once.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopCalled = true;
    this.stopPromise = (async () => {
      if (this.state !== "stopped") await this.teardown();
      if (this.everStarted) await endMeeting(this.meeting.id);
    })();
    return this.stopPromise;
  }

  // ---- session option builders -------------------------------------------

  private async connectRecognition(speaker: Speaker): Promise<{ session: SpeechSession; model: string }> {
    const opts = this.sttOpts(speaker);
    if (!isLocalAI(this.settings)) return connectLiveWithFallback(opts);
    const session = new LocalSpeechSession(this.settings.whisperUrl || WHISPER_DEFAULT_URL, opts, () => this.elapsed());
    opts.onOpen?.();
    return { session, model: "local-whisper" };
  }

  private sttOpts(speaker: Speaker): Omit<LiveSessionOpts, "model"> {
    // This is the native-audio fallback setup. GeminiLiveSession substitutes
    // TEXT + SMART recognition for the dedicated transcription model.
    const langHint =
      speaker === "me"
        ? `The speaker talks in ${languageLabel(this.settings.userLanguage)}.`
        : this.settings.otherLanguage === "auto"
          ? "Auto-detect the speaker's language."
          : `The speaker talks in ${languageLabel(this.settings.otherLanguage)}.`;
    return {
      apiKey: this.apiKey,
      responseModalities: ["AUDIO"],
      inputTranscription: true,
      systemInstruction:
        `You are a simultaneous interpreter. ${langHint} ` +
        `Speak ONLY the translation of what you hear into ${languageLabel(this.settings.userLanguage)}. ` +
        `Never add commentary, questions, or explanations.`,
      onTranscript: (text, event) => this.handleTranscript(speaker, text, event),
      onTranscriptFinished: () => { void this.finalizeSegment(speaker); },
      // Distinct health keys: "system audio" belongs to the sidecar capture;
      // the Them STT stream must not share (and overwrite) its entry.
      ...this.liveHandlers(speaker === "me" ? "mic transcription" : "them transcription"),
    };
  }

  private translateOpts(voice: string): Omit<LiveSessionOpts, "model"> {
    const otherHint =
      this.settings.otherLanguage === "auto"
        ? "Auto-detect their language."
        : `They talk in ${languageLabel(this.settings.otherLanguage)}.`;
    return {
      apiKey: this.apiKey,
      responseModalities: ["AUDIO"],
      voiceName: voice,
      translationLanguage: this.settings.userLanguage,
      inputTranscription: false,
      systemInstruction:
        `You are a simultaneous interpreter. You hear another meeting participant. ${otherHint} ` +
        `Speak ONLY the translation of what they say into ${languageLabel(this.settings.userLanguage)}. ` +
        `Never add commentary, questions, or explanations.`,
      onAudio: (pcm24k) => this.handleTranslatedAudio(pcm24k),
      ...this.liveHandlers("translation"),
    };
  }

  private liveHandlers(
    label: string,
  ): Pick<LiveSessionOpts, "onOpen" | "onError" | "onClose"> {
    return {
      onOpen: () => {
        // Fires again after a successful mid-meeting reconnect.
        this.setHealth(label, "live");
      },
      onError: (e: Error) => {
        if (this.state === "stopped") return;
        const reconnecting = e.message.includes("reconnecting in");
        // The give-up path is permanent — latch it so a sibling session's
        // recovery can never flip the status back to "live" and mask it.
        this.setHealth(
          label,
          reconnecting ? "reconnecting" : "error",
          `${label}: ${e.message}`,
          e.message.includes("giving up"),
        );
      },
      onClose: () => {
        // Fires once, at the session's terminal transition (live.ts contract).
        const pending = this.expectIntentionalClose.get(label) ?? 0;
        if (pending > 0) {
          this.expectIntentionalClose.set(label, pending - 1);
          return;
        }
        if (this.state === "stopped") return;
        this.setHealth(label, "error", `${label}: connection closed`, true);
      },
    };
  }

  // ---- per-source health → single UI status --------------------------------

  private setHealth(
    label: string,
    level: "live" | "degraded" | "reconnecting" | "error",
    detail?: string,
    terminal = false,
  ): void {
    if (this.state === "stopped") return;
    const current = this.health.get(label);
    if (current?.terminal && !terminal) return; // latched failures stay
    this.health.set(label, { level, detail, terminal });
    this.emitStatus();
  }

  /** Report the worst source's condition; detail comes from that source. */
  private emitStatus(): void {
    if (this.state !== "live") return; // start() owns "connecting"/failure
    const rank = { live: 0, degraded: 1, reconnecting: 2, error: 3 } as const;
    let worst: keyof typeof rank = "live";
    let detail: string | undefined;
    for (const entry of this.health.values()) {
      if (rank[entry.level] > rank[worst]) {
        worst = entry.level;
        detail = entry.detail;
      }
    }
    if (worst === "live") this.cb.onStatus("live");
    else this.cb.onStatus(worst, detail);
  }

  // ---- transcript segmentation -------------------------------------------

  private elapsed(): number {
    return Math.max(0, Date.now() - this.meeting.startedAt);
  }

  private segmentLang(speaker: Speaker): string | undefined {
    // Preferred output language is not evidence of the language spoken.
    if (speaker === "me") return undefined;
    // "them": unknown when auto-detecting.
    return this.settings.otherLanguage === "auto"
      ? undefined
      : this.settings.otherLanguage;
  }

  private toSegment(
    speaker: Speaker,
    pending: PendingSegment,
    final: boolean,
  ): TranscriptSegment {
    const seg: TranscriptSegment = {
      id: pending.id,
      meetingId: this.meeting.id,
      speaker,
      text: pending.text,
      tStart: pending.tStart,
      final,
    };
    const lang = this.segmentLang(speaker);
    if (lang) seg.lang = lang;
    seg.tEnd = pending.tEnd;
    return seg;
  }

  private handleTranscript(speaker: Speaker, text: string, event?: TranscriptEvent): void {
    if ((this.state === "stopped" && !this.draining) || text.length === 0) return;
    this.audioSources[speaker].lastTranscriptAt = Date.now();
    this.audioSources[speaker].soundSinceTranscriptMs = 0;
    let pending = this.pending[speaker];
    if (!pending) {
      pending = {
        id: crypto.randomUUID(),
        text: "",
        tStart: this.elapsed(),
        tEnd: this.elapsed(),
        timer: null,
        recentDeltas: [],
      };
      this.pending[speaker] = pending;
    }
    const appended = event && event.kind !== "delta"
      ? { text, history: [], loopDetected: false }
      : appendTranscriptDelta(pending.text, text, pending.recentDeltas);
    pending.text = appended.text;
    pending.tStart = event?.tStart ?? pending.tStart;
    pending.tEnd = event?.tEnd ?? this.elapsed();
    pending.recentDeltas = appended.history;
    if (appended.loopDetected) {
      console.warn(`meetingSession: dropped a repeated ${speaker} transcript delta`, text);
    }
    if (pending.timer !== null) clearTimeout(pending.timer);
    // Dedicated STT hypotheses are replacements, not tokens; committing an
    // interim on a short timeout would duplicate its later final snapshot.
    pending.timer = event?.kind === "interim" ? null
      : setTimeout(() => void this.finalizeSegment(speaker), SEGMENT_PAUSE_MS);
    this.cb.onSegment(this.toSegment(speaker, pending, false));
    if (event?.kind === "final") void this.finalizeSegment(speaker);
  }

  /** Resolves when the segment's persist attempt settled (never rejects). */
  private finalizeSegment(speaker: Speaker): Promise<void> {
    const pending = this.pending[speaker];
    if (!pending) return Promise.resolve();
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.pending[speaker] = null;
    if (pending.text.trim().length === 0) return Promise.resolve();
    const seg = this.toSegment(speaker, pending, true);
    this.cb.onSegment(seg);
    const persisted = this.persistSegment(seg);
    this.writes.add(persisted);
    void persisted.finally(() => this.writes.delete(persisted));
    if (speaker === "them" && this.shouldTranslateText(seg.lang)) {
      void translateWithProvider(this.apiKey, this.settings, seg.text, languageLabel(this.settings.userLanguage))
        .then(async (translated) => {
          this.translateFailStreak = 0;
          this.setHealth("text translation", "live");
          // With Auto-detect (the default), seg.lang is unknown, so a segment
          // ALREADY in the user's language still gets sent to translateLine —
          // there's no cheaper way to know in advance. But when the result
          // comes back identical to the source, showing it as a "translation"
          // just duplicates the same sentence — skip displaying/persisting it.
          if (!translated || isSameText(translated, seg.text)) return;
          await persisted;
          // A retry must include the translation too if the initial insert failed.
          const retry = this.failedSegments.find((item) => item.id === seg.id);
          if (retry) retry.translatedText = translated;
          await updateSegmentTranslation(seg.id, translated).catch((e: unknown) => {
            console.error("updateSegmentTranslation failed", e);
          });
          this.cb.onSegment({ ...seg, translatedText: translated });
        })
        .catch((e: unknown) => {
          // Best-effort per line — but systematic failure must reach the UI,
          // or the user sits in a meeting silently missing all translations.
          console.error("translateLine failed", e);
          this.translateFailStreak += 1;
          if (this.translateFailStreak >= TRANSLATE_FAILURE_NOTICE_AFTER) {
            const msg = e instanceof Error ? e.message : String(e);
            this.setHealth("text translation", "degraded", `text translation unavailable: ${msg}`);
          }
        });
    }
    return persisted;
  }

  /**
   * Persist a finalized segment. Failures queue for retry (before later
   * writes and at teardown) and surface once via health — a transcript that
   * silently never saves is data loss the user must hear about.
   */
  private async persistSegment(seg: TranscriptSegment): Promise<void> {
    try {
      await addSegment(seg);
      await this.flushFailedSegments();
      // Only report recovery when the retry queue actually drained.
      if (this.failedSegments.length === 0) {
        this.setHealth("transcript storage", "live");
      } else {
        this.setHealth(
          "transcript storage",
          "degraded",
          `${this.failedSegments.length} transcript segment(s) not yet saved; retrying`,
        );
      }
    } catch (e) {
      console.error("addSegment failed", e);
      this.failedSegments.push(seg);
      const msg = e instanceof Error ? e.message : String(e);
      this.setHealth("transcript storage", "error", `transcript is not being saved: ${msg}`);
    }
  }

  /** Retry previously failed segment writes; keeps whatever still fails. */
  private async flushFailedSegments(): Promise<void> {
    if (this.failedSegments.length === 0) return;
    const retry = this.failedSegments.splice(0);
    for (const seg of retry) {
      try {
        await addSegment(seg);
      } catch {
        this.failedSegments.push(seg);
      }
    }
  }

  private shouldTranslateText(lang: string | undefined): boolean {
    if (!this.settings.translationEnabled || isLocalAI(this.settings)) return false;
    // Unknown language (auto-detect) → translate; matching language → skip.
    return lang === undefined || lang !== this.settings.userLanguage;
  }

  // ---- translated-audio playback + ducking -------------------------------

  private handleTranslatedAudio(pcm24k: Int16Array): void {
    if (this.state === "stopped" || this.stopCalled) return;
    const tailMs = this.player.play(pcm24k);
    if (tailMs === null) return;
    if (this.settings.duckingEnabled) this.queueDuck();
    if (this.restoreTimer !== null) clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      void this.queueRestore();
    }, tailMs + DUCK_RESTORE_SILENCE_MS);
  }

  private queueDuck(): void {
    this.volumeOps = this.volumeOps
      .then(async () => {
        if (this.prevVolume !== null) return; // already ducked
        const previous = await safeInvoke<number>("duck_system_volume");
        if (typeof previous === "number") {
          this.prevVolume = previous;
          // Master-volume ducking attenuates our own translated voice too —
          // boost the app's playback by the actual duck ratio so the
          // translation stays at roughly its original loudness.
          this.player.setBoost(duckCompensationGain(previous));
        }
      })
      .catch(() => {
        // Ducking is best-effort; playback continues regardless.
      });
  }

  private queueRestore(): Promise<void> {
    this.volumeOps = this.volumeOps
      .then(async () => {
        if (this.prevVolume === null) return; // not ducked
        // Clear the recorded volume only after the restore succeeds — on
        // failure the system really is still ducked, and keeping the value
        // makes the next restore (or teardown's) a natural retry instead of
        // leaving the Mac stuck quiet.
        await safeInvoke("restore_system_volume", { previous: this.prevVolume });
        this.prevVolume = null;
        this.player.setBoost(1);
      })
      .catch((e: unknown) => {
        console.error("restore_system_volume failed (will retry)", e);
      });
    return this.volumeOps;
  }

  // ---- voice switching ----------------------------------------------------

  private async reconnectTranslate(voice: string): Promise<void> {
    const old = this.liveTranslate;
    // The dedicated Them transcriber stays connected throughout voice changes.
    this.liveTranslate = null;
    if (old) {
      this.openedSessions = this.openedSessions.filter((s) => s !== old);
      // This close is ours — its terminal onClose must not read as a failure.
      // Only count it when the session will actually deliver one (an already
      // -dead session's close() is a no-op and fires nothing).
      if (!old.dead) {
        this.expectIntentionalClose.set(
          "translation",
          (this.expectIntentionalClose.get("translation") ?? 0) + 1,
        );
      }
      old.close();
    }
    try {
      const { session } = await connectLiveWithFallback(
        this.translateOpts(voice),
        LIVE_TRANSLATE_MODEL_CHAIN,
      );
      // Voice changed again (or meeting stopped) while connecting → discard.
      if (this.state !== "live" || this.translateVoice !== voice) {
        session.close();
        return;
      }
      this.openedSessions.push(session);
      this.liveTranslate = session;
    } catch (e) {
      if (this.state === "stopped") return;
      const msg = e instanceof Error ? e.message : String(e);
      // Through the health map (latched) so a sibling source recovering
      // can never mask the dead translation session.
      this.setHealth("translation", "error", `translation voice switch failed: ${msg}`, true);
    }
  }

  // ---- teardown -----------------------------------------------------------

  private async teardown(): Promise<void> {
    if (this.audioTimer !== null) clearInterval(this.audioTimer);
    this.audioTimer = null;
    this.draining = this.state === "live";
    this.state = "stopped";
    this.mic.stop();
    try {
      await this.system.stop();
    } catch {
      // Sidecar may already be dead; stopping must not fail the teardown.
    }
    if (this.draining) {
      await Promise.allSettled(this.openedSessions.map((session) => session.finishInput()));
    }
    this.draining = false;
    // Flush partial transcripts before closing sessions, and only then run
    // the last-chance retry — flushing before the final writes settle would
    // miss any of them that fail.
    await Promise.all([this.finalizeSegment("me"), this.finalizeSegment("them")]);
    await Promise.allSettled([...this.writes]);
    await this.flushFailedSegments().catch(() => {});
    for (const session of this.openedSessions.splice(0)) session.close();
    this.liveMe = null;
    this.liveThem = null;
    this.liveTranslate = null;
    if (this.restoreTimer !== null) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    await this.queueRestore();
    await this.player.close();
  }
}
