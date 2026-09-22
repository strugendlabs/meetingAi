import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, Meeting, TranscriptSegment } from "./types";

// ---- hoisted mocks for every native / network dependency -------------------

const h = vi.hoisted(() => {
  interface FakeLiveOpts {
    apiKey: string;
    responseModalities: ("TEXT" | "AUDIO")[];
    systemInstruction?: string;
    voiceName?: string;
    inputTranscription?: boolean;
    onTranscript?: (text: string, event?: { kind: "interim" | "final" | "delta" }) => void;
    onTranscriptFinished?: () => void;
    onAudio?: (pcm24k: Int16Array) => void;
    onOpen?: () => void;
    onError?: (e: Error) => void;
    onClose?: (code: number) => void;
  }

  class FakeLiveSession {
    opts: FakeLiveOpts;
    closed = false;
    audio: Int16Array[] = [];
    constructor(opts: FakeLiveOpts) {
      this.opts = opts;
    }
    get isOpen(): boolean {
      return !this.closed;
    }
    sendAudio(pcm: Int16Array): void {
      this.audio.push(pcm);
    }
    finishInput = vi.fn(async () => {});
    close(): void {
      this.closed = true;
    }
  }

  class MockMicCapture {
    static instances: MockMicCapture[] = [];
    onChunk: ((pcm: Int16Array) => void) | null = null;
    start = vi.fn(async (cb: (pcm: Int16Array) => void) => {
      this.onChunk = cb;
    });
    stop = vi.fn(() => {
      this.onChunk = null;
    });
    constructor() {
      MockMicCapture.instances.push(this);
    }
  }

  class MockSystemAudioCapture {
    static instances: MockSystemAudioCapture[] = [];
    onChunk: ((pcm: Int16Array) => void) | null = null;
    onError: ((message: string) => void) | null = null;
    start = vi.fn(
      async (
        onChunk: (pcm: Int16Array) => void,
        onError?: (message: string) => void,
      ) => {
        this.onChunk = onChunk;
        this.onError = onError ?? null;
      },
    );
    stop = vi.fn(async () => {
      this.onChunk = null;
      this.onError = null;
    });
    constructor() {
      MockSystemAudioCapture.instances.push(this);
    }
  }

  const liveSessions: FakeLiveSession[] = [];
  return {
    FakeLiveSession,
    MockMicCapture,
    MockSystemAudioCapture,
    liveSessions,
    connectLiveWithFallback: vi.fn(),
    translateLine: vi.fn(),
    addSegment: vi.fn(),
    endMeeting: vi.fn(),
    updateSegmentTranslation: vi.fn(),
    safeInvoke: vi.fn(),
  };
});

vi.mock("./mic", () => ({ MicCapture: h.MockMicCapture }));
vi.mock("./systemAudio", () => ({ SystemAudioCapture: h.MockSystemAudioCapture }));
vi.mock("./gemini/live", () => ({ connectLiveWithFallback: h.connectLiveWithFallback }));
vi.mock("./gemini/translateText", () => ({ translateLine: h.translateLine }));
vi.mock("./db", () => ({
  addSegment: h.addSegment,
  endMeeting: h.endMeeting,
  updateSegmentTranslation: h.updateSegmentTranslation,
}));
vi.mock("./tauri", () => ({ safeInvoke: h.safeInvoke }));

import {
  DUCK_RESTORE_SILENCE_MS,
  MeetingSession,
  PLAYBACK_RATE,
  REPEAT_DELTA_THRESHOLD,
  SEGMENT_PAUSE_MS,
  appendTranscriptDelta,
  duckCompensationGain,
  duckedLevel,
  isSameText,
} from "./meetingSession";

// ---- WebAudio mock ---------------------------------------------------------

interface MockSource {
  buffer: unknown;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  currentTime = 0;
  state = "running";
  sampleRate: number;
  destination = { node: "destination" };
  sources: MockSource[] = [];
  buffers: Array<{ length: number; sampleRate: number; data: Float32Array }> = [];
  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? 44100;
    MockAudioContext.instances.push(this);
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    const buf = { length, sampleRate, data, getChannelData: () => data };
    this.buffers.push(buf);
    return buf;
  }
  createBufferSource(): MockSource {
    const src: MockSource = { buffer: null, connect: vi.fn(), start: vi.fn() };
    this.sources.push(src);
    return src;
  }
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
}

// ---- fixtures --------------------------------------------------------------

const BASE_SETTINGS: AppSettings = {
  userLanguage: "en",
  otherLanguage: "auto",
  voiceGenderMode: "auto",
  translationEnabled: true,
  duckingEnabled: true,
  onboarded: true,
  googleClientId: "",
  googleClientSecret: "",
  hasUserGeminiKey: false,
};

function makeSession(patch: Partial<AppSettings> = {}) {
  const cb = { onSegment: vi.fn(), onStatus: vi.fn(), onAudioHealth: vi.fn() };
  const meeting: Meeting = { id: "meet-1", title: "Weekly sync", startedAt: Date.now() };
  const session = new MeetingSession(
    "api-key",
    { ...BASE_SETTINGS, ...patch },
    meeting,
    cb,
  );
  return { session, cb, meeting };
}

async function startLive(patch: Partial<AppSettings> = {}) {
  const made = makeSession(patch);
  await made.session.start();
  return made;
}

const live = (i: number) => {
  const s = h.liveSessions[i];
  if (!s) throw new Error(`no fake live session at index ${i}`);
  return s;
};
const mic = () => h.MockMicCapture.instances[0];
const sys = () => h.MockSystemAudioCapture.instances[0];
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  h.liveSessions.length = 0;
  h.MockMicCapture.instances.length = 0;
  h.MockSystemAudioCapture.instances.length = 0;
  MockAudioContext.instances.length = 0;
  h.connectLiveWithFallback.mockImplementation(async (opts: unknown) => {
    const session = new h.FakeLiveSession(
      opts as ConstructorParameters<typeof h.FakeLiveSession>[0],
    );
    h.liveSessions.push(session);
    return { session, model: "mock-model" };
  });
  h.translateLine.mockResolvedValue("TRANSLATED");
  h.addSegment.mockResolvedValue(undefined);
  h.endMeeting.mockResolvedValue(undefined);
  h.updateSegmentTranslation.mockResolvedValue(undefined);
  h.safeInvoke.mockImplementation(async (cmd: string) =>
    cmd === "duck_system_volume" ? 42 : undefined,
  );
  vi.stubGlobal("AudioContext", MockAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- start -----------------------------------------------------------------

describe("MeetingSession.start", () => {
  it("connects independent Me/Them STT plus optional translation, reporting connecting→live", async () => {
    const { cb } = await startLive();
    expect(cb.onStatus.mock.calls.map((c) => c[0])).toEqual(["connecting", "live"]);
    expect(h.connectLiveWithFallback).toHaveBeenCalledTimes(3);

    // Every live model is native-audio: STT sessions request AUDIO and
    // discard it, consuming inputTranscription (verified against real API).
    const me = live(0);
    expect(me.opts.apiKey).toBe("api-key");
    expect(me.opts.responseModalities).toEqual(["AUDIO"]);
    expect(me.opts.inputTranscription).toBe(true);
    expect(me.opts.onAudio).toBeUndefined(); // model audio discarded
    expect(me.opts.systemInstruction).toContain("English");

    // Merged session: Them transcription AND translated voice.
    const translate = live(2);
    expect(translate.opts.responseModalities).toEqual(["AUDIO"]);
    expect(translate.opts.voiceName).toBe("Kore"); // auto without detection → Kore
    expect(translate.opts.inputTranscription).toBe(false);
    expect(translate.opts.onTranscript).toBeUndefined();
    expect(live(1).opts.inputTranscription).toBe(true);
    expect(translate.opts.systemInstruction).toMatch(/simultaneous interpreter/i);
    expect(translate.opts.systemInstruction).toMatch(/auto-detect/i);
    expect(translate.opts.systemInstruction).toContain("English");

    expect(mic().start).toHaveBeenCalledTimes(1);
    expect(sys().start).toHaveBeenCalledTimes(1);
  });

  it("hints a pinned other-speaker language on the Them session", async () => {
    await startLive({ otherLanguage: "es" });
    expect(live(1).opts.systemInstruction).toContain("Spanish");
  });

  it("skips the translate session when translation is disabled", async () => {
    await startLive({ translationEnabled: false });
    expect(h.connectLiveWithFallback).toHaveBeenCalledTimes(2);
    expect(h.liveSessions).toHaveLength(2);
  });

  it("routes each source once to recognition and system audio once to translation", async () => {
    await startLive();
    const micChunk = new Int16Array([1, 2, 3]);
    const sysChunk = new Int16Array([4, 5, 6]);
    mic().onChunk!(micChunk);
    sys().onChunk!(sysChunk);
    expect(live(0).audio).toEqual([micChunk]);
    expect(live(1).audio).toEqual([sysChunk]);
    expect(live(2).audio).toEqual([sysChunk]);
    expect(live(0).audio).toHaveLength(1); // no cross-feed
  });

  it("rejects a second start() call", async () => {
    const { session } = await startLive();
    await expect(session.start()).rejects.toThrow(/only be called once/);
  });

  it("an initial recognition failure preserves the healthy source and can be retried", async () => {
    h.connectLiveWithFallback
      .mockImplementationOnce(async (opts: unknown) => {
        const session = new h.FakeLiveSession(
          opts as ConstructorParameters<typeof h.FakeLiveSession>[0],
        );
        h.liveSessions.push(session);
        return { session, model: "mock-model" };
      })
      .mockImplementationOnce(async () => {
        throw new Error("quota exceeded");
      });
    const { session, cb } = makeSession({ translationEnabled: false });
    await session.start();
    expect(cb.onStatus).toHaveBeenCalledWith("error", "quota exceeded");
    expect(live(0).closed).toBe(false);
    expect(mic().start).toHaveBeenCalledOnce();
    expect(sys().start).not.toHaveBeenCalled();
    await session.retryAudio("them");
    expect(sys().start).toHaveBeenCalledOnce();
    expect(live(0).closed).toBe(false);
    await session.stop();
    expect(h.endMeeting).toHaveBeenCalledWith(session["meeting"].id);
  });
});

// ---- transcript segmentation ----------------------------------------------

describe("transcript flow", () => {
  it("accumulates Me deltas as interim segments, finalizes after a fallback pause", async () => {
    vi.useFakeTimers();
    const { cb } = await startLive();
    live(0).opts.onTranscript!("Hello ");
    live(0).opts.onTranscript!("world");

    const interim = cb.onSegment.mock.calls.map((c) => c[0] as TranscriptSegment);
    expect(interim).toHaveLength(2);
    expect(interim[0]).toMatchObject({ speaker: "me", text: "Hello ", final: false });
    expect(interim[1]).toMatchObject({ speaker: "me", text: "Hello world", final: false });
    expect(interim[1].id).toBe(interim[0].id);
    expect(h.addSegment).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS - 1);
    expect(h.addSegment).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(h.addSegment).toHaveBeenCalledTimes(1);
    const seg = h.addSegment.mock.calls[0][0] as TranscriptSegment;
    expect(seg).toMatchObject({
      id: interim[0].id,
      meetingId: "meet-1",
      speaker: "me",
      text: "Hello world",
      final: true,
    });
    expect(seg.tEnd).toBeGreaterThanOrEqual(seg.tStart);
    const final = cb.onSegment.mock.calls[2][0] as TranscriptSegment;
    expect(final.final).toBe(true);
    expect(h.translateLine).not.toHaveBeenCalled(); // never for "me"
  });

  it("translates finalized Them segments into the user language", async () => {
    vi.useFakeTimers();
    const { cb } = await startLive();
    live(1).opts.onTranscript!("hola mundo");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    await vi.advanceTimersByTimeAsync(0); // flush translate microtasks

    expect(h.translateLine).toHaveBeenCalledWith("api-key", "hola mundo", "English");
    const segId = (h.addSegment.mock.calls[0][0] as TranscriptSegment).id;
    expect(h.updateSegmentTranslation).toHaveBeenCalledWith(segId, "TRANSLATED");
    const emitted = cb.onSegment.mock.calls.map((c) => c[0] as TranscriptSegment);
    const withTranslation = emitted[emitted.length - 1];
    expect(withTranslation).toMatchObject({
      id: segId,
      speaker: "them",
      text: "hola mundo",
      translatedText: "TRANSLATED",
      final: true,
    });
  });

  it("marks Them segments with a pinned language and still translates when it differs", async () => {
    vi.useFakeTimers();
    await startLive({ otherLanguage: "es" });
    live(1).opts.onTranscript!("buenos días");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    const seg = h.addSegment.mock.calls[0][0] as TranscriptSegment;
    expect(seg.lang).toBe("es");
    expect(h.translateLine).toHaveBeenCalledWith("api-key", "buenos días", "English");
  });

  it("does not translate Them segments already in the user language", async () => {
    vi.useFakeTimers();
    await startLive({ otherLanguage: "en" });
    live(1).opts.onTranscript!("already english");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    expect(h.addSegment).toHaveBeenCalledTimes(1);
    expect(h.translateLine).not.toHaveBeenCalled();
  });

  it("does not translate when translation is disabled", async () => {
    vi.useFakeTimers();
    await startLive({ translationEnabled: false });
    live(1).opts.onTranscript!("hola");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    expect(h.addSegment).toHaveBeenCalledTimes(1);
    expect(h.translateLine).not.toHaveBeenCalled();
  });

  it("text after a finalize starts a fresh segment with a new id", async () => {
    vi.useFakeTimers();
    const { cb } = await startLive();
    live(0).opts.onTranscript!("first");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    live(0).opts.onTranscript!("second");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    expect(h.addSegment).toHaveBeenCalledTimes(2);
    const [a, b] = h.addSegment.mock.calls.map((c) => c[0] as TranscriptSegment);
    expect(a.text).toBe("first");
    expect(b.text).toBe("second");
    expect(b.id).not.toBe(a.id);
    expect(cb.onSegment).toHaveBeenCalledTimes(4); // 2 interim + 2 final
  });

  it("whitespace-only accumulations are dropped, not persisted", async () => {
    vi.useFakeTimers();
    await startLive();
    live(0).opts.onTranscript!("   ");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    expect(h.addSegment).not.toHaveBeenCalled();
  });
});

// ---- translated audio playback + ducking -----------------------------------

describe("translated audio playback + ducking", () => {
  it("plays 24k chunks through a 24kHz WebAudio queue", async () => {
    await startLive();
    const pcm = new Int16Array([16384, -16384, 32767]);
    live(2).opts.onAudio!(pcm);

    expect(MockAudioContext.instances).toHaveLength(1);
    const ctx = MockAudioContext.instances[0];
    expect(ctx.sampleRate).toBe(PLAYBACK_RATE);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].start).toHaveBeenCalledWith(0);
    expect(ctx.sources[0].connect).toHaveBeenCalledWith(ctx.destination);
    const data = ctx.buffers[0].data;
    expect(data[0]).toBeCloseTo(0.5, 5);
    expect(data[1]).toBeCloseTo(-0.5, 5);
    expect(ctx.buffers[0].sampleRate).toBe(PLAYBACK_RATE);
  });

  it("queues consecutive chunks back-to-back", async () => {
    await startLive();
    live(2).opts.onAudio!(new Int16Array(2400)); // 100 ms
    live(2).opts.onAudio!(new Int16Array(2400)); // next 100 ms
    const ctx = MockAudioContext.instances[0];
    expect(ctx.sources[0].start).toHaveBeenCalledWith(0);
    expect(ctx.sources[1].start).toHaveBeenCalledWith(0.1);
  });

  it("ducks once on playback and restores 400ms after the queue drains", async () => {
    vi.useFakeTimers();
    await startLive();
    live(2).opts.onAudio!(new Int16Array(2400)); // 100 ms of audio
    live(2).opts.onAudio!(new Int16Array(2400)); // 100 ms more
    await vi.advanceTimersByTimeAsync(0);

    const duckCalls = h.safeInvoke.mock.calls.filter((c) => c[0] === "duck_system_volume");
    expect(duckCalls).toHaveLength(1); // second chunk sees already-ducked state

    // queue drains at 200ms; restore at 200 + DUCK_RESTORE_SILENCE_MS
    await vi.advanceTimersByTimeAsync(200 + DUCK_RESTORE_SILENCE_MS - 1);
    expect(h.safeInvoke).not.toHaveBeenCalledWith("restore_system_volume", { previous: 42 });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.safeInvoke).toHaveBeenCalledWith("restore_system_volume", { previous: 42 });
  });

  it("re-ducks for a new utterance after a restore", async () => {
    vi.useFakeTimers();
    await startLive();
    live(2).opts.onAudio!(new Int16Array(2400));
    await vi.advanceTimersByTimeAsync(100 + DUCK_RESTORE_SILENCE_MS);
    live(2).opts.onAudio!(new Int16Array(2400));
    await vi.advanceTimersByTimeAsync(0);
    const duckCalls = h.safeInvoke.mock.calls.filter((c) => c[0] === "duck_system_volume");
    expect(duckCalls).toHaveLength(2);
  });

  it("never ducks when duckingEnabled is false, but still plays", async () => {
    vi.useFakeTimers();
    await startLive({ duckingEnabled: false });
    live(2).opts.onAudio!(new Int16Array(2400));
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockAudioContext.instances[0].sources).toHaveLength(1);
    expect(h.safeInvoke).not.toHaveBeenCalledWith("duck_system_volume");
    expect(h.safeInvoke).not.toHaveBeenCalledWith(
      "restore_system_volume",
      expect.anything(),
    );
  });
});

// ---- gender / voice switching ----------------------------------------------

describe("setOtherGender", () => {
  it("reconnects the translate session without interrupting recognition with the male voice", async () => {
    const { session } = await startLive();
    const oldTranslate = live(2);
    session.setOtherGender("male");
    await flush();

    expect(oldTranslate.closed).toBe(true);
    expect(h.liveSessions).toHaveLength(4);
    const next = live(3);
    expect(next.opts.voiceName).toBe("Charon");
    expect(next.opts.responseModalities).toEqual(["AUDIO"]);
    expect(next.opts.inputTranscription).toBe(false);
    expect(live(1).closed).toBe(false);

    // system audio now feeds the replacement session, exactly once
    const chunk = new Int16Array([9]);
    sys().onChunk!(chunk);
    expect(next.audio).toEqual([chunk]);
    expect(oldTranslate.audio).toEqual([]);
  });

  it("is a no-op when the mapped voice does not change", async () => {
    const { session } = await startLive();
    session.setOtherGender("female"); // auto default already maps to Kore
    await flush();
    expect(live(2).closed).toBe(false);
    expect(h.liveSessions).toHaveLength(3);
  });

  it("keeps a forced voice mode regardless of detected gender", async () => {
    const { session } = await startLive({ voiceGenderMode: "male" });
    expect(live(2).opts.voiceName).toBe("Charon");
    session.setOtherGender("female");
    await flush();
    expect(live(2).closed).toBe(false);
    expect(h.liveSessions).toHaveLength(3);
  });

  it("does nothing when translation is disabled", async () => {
    const { session } = await startLive({ translationEnabled: false });
    session.setOtherGender("male");
    await flush();
    expect(h.liveSessions).toHaveLength(2);
  });
});

// ---- status mapping ---------------------------------------------------------

describe("status mapping", () => {
  it("maps live-session backoff errors to 'reconnecting' and recovery to 'live'", async () => {
    const { cb } = await startLive();
    cb.onStatus.mockClear();
    live(1).opts.onError!(
      new Error("Gemini Live connection lost (code=1006); reconnecting in 500ms (attempt 1/5)"),
    );
    expect(cb.onStatus).toHaveBeenCalledWith(
      "reconnecting",
      expect.stringContaining("reconnecting in 500ms"),
    );
    live(1).opts.onOpen!();
    expect(cb.onStatus).toHaveBeenLastCalledWith("live");
  });

  it("maps give-up errors to 'error'", async () => {
    const { cb } = await startLive();
    cb.onStatus.mockClear();
    live(0).opts.onError!(
      new Error("Gemini Live connection lost (code=1006); giving up after 5 reconnect attempts"),
    );
    expect(cb.onStatus).toHaveBeenCalledWith("error", expect.stringContaining("giving up"));
  });

  it("surfaces system-audio errors without silencing the microphone", async () => {
    const { cb } = await startLive();
    cb.onStatus.mockClear();
    sys().onError!("sidecar died");
    expect(cb.onStatus).toHaveBeenCalledWith("degraded", "sidecar died");
  });
});

// ---- stop -------------------------------------------------------------------

describe("MeetingSession.stop", () => {
  it("stops captures, closes all sessions and ends the meeting", async () => {
    const { session, meeting } = await startLive();
    await session.stop();
    expect(mic().stop).toHaveBeenCalledTimes(1);
    expect(sys().stop).toHaveBeenCalledTimes(1);
    for (const s of h.liveSessions) expect(s.closed).toBe(true);
    expect(h.endMeeting).toHaveBeenCalledWith(meeting.id);
    const ctxs = MockAudioContext.instances;
    for (const ctx of ctxs) expect(ctx.close).toHaveBeenCalled();
  });

  it("flushes a pending partial segment as final before closing", async () => {
    vi.useFakeTimers();
    const { session } = await startLive();
    live(0).opts.onTranscript!("unfinished thought");
    await session.stop();
    expect(h.addSegment).toHaveBeenCalledTimes(1);
    const seg = h.addSegment.mock.calls[0][0] as TranscriptSegment;
    expect(seg).toMatchObject({ text: "unfinished thought", final: true, speaker: "me" });
  });

  it("restores the volume when stopped while ducked", async () => {
    vi.useFakeTimers();
    const { session } = await startLive();
    live(2).opts.onAudio!(new Int16Array(2400));
    await vi.advanceTimersByTimeAsync(0); // duck happens
    await session.stop(); // before the 500ms silence timer fires
    expect(h.safeInvoke).toHaveBeenCalledWith("restore_system_volume", { previous: 42 });
    await vi.advanceTimersByTimeAsync(60_000);
    const restores = h.safeInvoke.mock.calls.filter(
      (c) => c[0] === "restore_system_volume",
    );
    expect(restores).toHaveLength(1); // silence timer was cancelled
  });

  it("is idempotent — second stop() does nothing", async () => {
    const { session } = await startLive();
    await session.stop();
    await session.stop();
    expect(h.endMeeting).toHaveBeenCalledTimes(1);
    expect(sys().stop).toHaveBeenCalledTimes(1);
  });

  it("ignores late transcripts and audio after stop", async () => {
    const { session, cb } = await startLive();
    await session.stop();
    cb.onSegment.mockClear();
    live(0).opts.onTranscript!("too late");
    live(2).opts.onAudio!(new Int16Array(2400));
    expect(cb.onSegment).not.toHaveBeenCalled();
    expect(MockAudioContext.instances.flatMap((c) => c.sources)).toHaveLength(0);
  });

  it("does not end the meeting if start() was never called", async () => {
    const { session } = makeSession();
    await session.stop();
    expect(h.endMeeting).not.toHaveBeenCalled();
  });
});

// ---- review-fix regressions -------------------------------------------------

describe("review-fix regressions", () => {
  it("stop() during connect aborts start: no captures, sessions closed, never 'live'", async () => {
    const resolvers: Array<() => void> = [];
    h.connectLiveWithFallback.mockImplementation(
      (opts: unknown) =>
        new Promise((resolve) => {
          const session = new h.FakeLiveSession(
            opts as ConstructorParameters<typeof h.FakeLiveSession>[0],
          );
          h.liveSessions.push(session);
          resolvers.push(() => resolve({ session, model: "mock-model" }));
        }),
    );
    const { session, cb } = makeSession({ translationEnabled: false });
    const startP = session.start();
    const stopP = session.stop(); // user hits Stop/Back while connecting
    resolvers.forEach((r) => r());
    await startP;
    await stopP;
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(mic().start).not.toHaveBeenCalled();
    expect(sys().start).not.toHaveBeenCalled();
    for (const s of h.liveSessions) expect(s.closed).toBe(true);
    expect(cb.onStatus.mock.calls.map((c) => c[0])).not.toContain("live");
    expect(h.endMeeting).toHaveBeenCalledTimes(1);
  });

  it("a failed restore keeps the ducked state and stop() retries it", async () => {
    vi.useFakeTimers();
    const { session } = await startLive();
    h.safeInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "duck_system_volume") return 42;
      if (cmd === "restore_system_volume") throw new Error("osascript failed");
      return undefined;
    });
    live(2).opts.onAudio!(new Int16Array(2400)); // 100 ms of audio
    await vi.advanceTimersByTimeAsync(100 + DUCK_RESTORE_SILENCE_MS);
    const failed = h.safeInvoke.mock.calls.filter(
      (c) => c[0] === "restore_system_volume",
    );
    expect(failed).toHaveLength(1); // tried and failed — state kept

    h.safeInvoke.mockImplementation(async (cmd: string) =>
      cmd === "duck_system_volume" ? 42 : undefined,
    );
    await session.stop();
    const restores = h.safeInvoke.mock.calls.filter(
      (c) => c[0] === "restore_system_volume",
    );
    expect(restores).toHaveLength(2);
    expect(restores[1][1]).toEqual({ previous: 42 }); // retried with real value
  });

  it("a segment write failure surfaces once and retries on the next write", async () => {
    vi.useFakeTimers();
    const { cb } = await startLive({ translationEnabled: false });
    cb.onStatus.mockClear();
    h.addSegment.mockRejectedValueOnce(new Error("disk full"));

    live(0).opts.onTranscript!("hello");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    expect(cb.onStatus).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("not being saved"),
    );

    live(0).opts.onTranscript!("world");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    expect(h.addSegment).toHaveBeenCalledTimes(3); // fail, second write, retry
    expect(cb.onStatus).toHaveBeenLastCalledWith("live"); // storage recovered
  });

  it("one session recovering does not mask another's permanent failure", async () => {
    const { cb } = await startLive({ translationEnabled: false });
    cb.onStatus.mockClear();
    live(1).opts.onError!(
      new Error("Gemini Live connection lost (code=1006); giving up after 5 reconnect attempts"),
    );
    live(0).opts.onOpen!(); // the other session recovers
    expect(cb.onStatus).toHaveBeenLastCalledWith(
      "error",
      expect.stringContaining("giving up"),
    );
  });

  it("an unexpected terminal close is surfaced, an intentional one is not", async () => {
    const { cb } = await startLive({ translationEnabled: false });
    cb.onStatus.mockClear();
    live(1).opts.onClose?.(1000); // server closed the STT stream
    expect(cb.onStatus).toHaveBeenLastCalledWith(
      "error",
      expect.stringContaining("connection closed"),
    );
  });
});

describe("contract regressions (second review round)", () => {
  it("three translate failures degrade status; a success restores 'live'", async () => {
    vi.useFakeTimers();
    const { cb } = await startLive(); // translation enabled
    cb.onStatus.mockClear();
    h.translateLine.mockRejectedValue(new Error("quota"));
    for (let i = 0; i < 3; i++) {
      live(1).opts.onTranscript!(`hola ${i}`);
      await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    }
    expect(cb.onStatus).toHaveBeenCalledWith(
      "degraded",
      expect.stringContaining("text translation unavailable"),
    );

    h.translateLine.mockResolvedValue("TRANSLATED");
    live(1).opts.onTranscript!("hola otra vez");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    expect(cb.onStatus).toHaveBeenLastCalledWith("live");
  });

  it("duck math mirrors ducking.rs and never boosts when not ducked lower", () => {
    expect(duckedLevel(100)).toBe(50);
    expect(duckedLevel(42)).toBe(21);
    expect(duckedLevel(40)).toBe(20);
    expect(duckedLevel(20)).toBe(20);
    expect(duckedLevel(10)).toBe(10);
    expect(duckedLevel(0)).toBe(0);
    expect(duckCompensationGain(100)).toBe(2);
    expect(duckCompensationGain(42)).toBe(2);
    expect(duckCompensationGain(30)).toBeCloseTo(1.5);
    expect(duckCompensationGain(10)).toBe(1); // not actually ducked
    expect(duckCompensationGain(0)).toBe(1);
  });
});

describe("appendTranscriptDelta (repetition guard)", () => {
  it("appends normally when deltas differ", () => {
    let r = appendTranscriptDelta("", "Hello ", []);
    expect(r).toEqual({ text: "Hello ", history: ["Hello "], loopDetected: false });
    r = appendTranscriptDelta(r.text, "world", r.history);
    expect(r.text).toBe("Hello world");
    expect(r.loopDetected).toBe(false);
  });

  it(`drops a delta once it repeats ${REPEAT_DELTA_THRESHOLD} times in a row`, () => {
    let text = "";
    let history: string[] = [];
    const delta = "Möchten Sie mir die Bestellnummer sagen, damit ich nach mit einer Bestellung. ";
    for (let i = 0; i < REPEAT_DELTA_THRESHOLD; i++) {
      const r = appendTranscriptDelta(text, delta, history);
      text = r.text;
      history = r.history;
      // Only the guard's LAST iteration (the Nth repeat) is where it fires.
      expect(r.loopDetected).toBe(i === REPEAT_DELTA_THRESHOLD - 1);
    }
    const occurrences = text.split(delta).length - 1;
    expect(occurrences).toBe(REPEAT_DELTA_THRESHOLD - 1); // capped, not unbounded

    // Further identical repeats keep being dropped (the loop stays latched).
    const r2 = appendTranscriptDelta(text, delta, history);
    expect(r2.loopDetected).toBe(true);
    expect(r2.text).toBe(text); // unchanged — repeat suppressed

    // A genuinely different delta breaks the guard and resumes appending.
    const r3 = appendTranscriptDelta(r2.text, "damit ich", r2.history);
    expect(r3.loopDetected).toBe(false);
    expect(r3.text).toBe(r2.text + "damit ich");
  });

  it("does not treat short filler repeats (e.g. 'uh') as a loop", () => {
    let text = "";
    let history: string[] = [];
    for (let i = 0; i < REPEAT_DELTA_THRESHOLD + 2; i++) {
      const r = appendTranscriptDelta(text, "uh", history);
      text = r.text;
      history = r.history;
      expect(r.loopDetected).toBe(false);
    }
    expect(text).toBe("uh".repeat(REPEAT_DELTA_THRESHOLD + 2));
  });
});

describe("isSameText", () => {
  it("matches ignoring case, whitespace and trailing punctuation", () => {
    expect(isSameText("Yes, of course.", "yes, of course")).toBe(true);
    expect(isSameText("  Hello   world  ", "Hello world")).toBe(true);
    expect(isSameText("No problem. Let me", "no problem.  let me")).toBe(true);
  });

  it("does not match genuinely different text", () => {
    expect(isSameText("Yes, of course.", "Yes, indeed.")).toBe(false);
    expect(isSameText("hola mundo", "hello world")).toBe(false);
  });
});

describe("live session: same-language translation is not surfaced as a duplicate", () => {
  it("with Auto-detect, a segment that comes back identical from translateLine is not shown/persisted as a translation", async () => {
    vi.useFakeTimers();
    const { cb } = await startLive(); // otherLanguage defaults to "auto"
    h.translateLine.mockResolvedValue("Yes, of course. We can help you.");
    live(1).opts.onTranscript!("Yes, of course. We can help you.");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    await vi.advanceTimersByTimeAsync(0); // flush translate microtasks

    expect(h.translateLine).toHaveBeenCalledTimes(1); // still called — lang unknown under auto-detect
    expect(h.updateSegmentTranslation).not.toHaveBeenCalled();
    const withTranslation = cb.onSegment.mock.calls
      .map((c) => c[0] as TranscriptSegment)
      .filter((s) => s.translatedText !== undefined);
    expect(withTranslation).toHaveLength(0);
  });

  it("still surfaces a genuinely different translation", async () => {
    vi.useFakeTimers();
    const { cb } = await startLive();
    h.translateLine.mockResolvedValue("Yes, of course.");
    live(1).opts.onTranscript!("Ja, natürlich.");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    await vi.advanceTimersByTimeAsync(0); // flush translate microtasks

    expect(h.updateSegmentTranslation).toHaveBeenCalledWith(
      expect.any(String),
      "Yes, of course.",
    );
    const withTranslation = cb.onSegment.mock.calls
      .map((c) => c[0] as TranscriptSegment)
      .filter((s) => s.translatedText === "Yes, of course.");
    expect(withTranslation).toHaveLength(1);
  });
});

describe("live session: self-audio feedback repetition is capped end-to-end", () => {
  it("a stuck Gemini turn repeating the same phrase does not balloon the segment", async () => {
    vi.useFakeTimers();
    await startLive({ translationEnabled: false });
    const loopedPhrase = "Möchten Sie mir die Bestellnummer sagen, damit ich ";
    for (let i = 0; i < 6; i++) {
      live(1).opts.onTranscript!(loopedPhrase);
    }
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);

    const finalSeg = h.addSegment.mock.calls
      .map((c) => c[0] as TranscriptSegment)
      .find((s) => s.final);
    expect(finalSeg).toBeDefined();
    const occurrences = finalSeg!.text.split(loopedPhrase).length - 1;
    expect(occurrences).toBe(REPEAT_DELTA_THRESHOLD - 1);
  });
});

describe("complete transcript capture", () => {
  it("replaces interim hypotheses with the final recognized sentence under the same ID", async () => {
    vi.useFakeTimers();
    const { cb, session } = await startLive();
    live(0).opts.onTranscript!("मुझे प्रोडक्ट", { kind: "interim" });
    const first = cb.onSegment.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.addSegment).not.toHaveBeenCalled();
    live(0).opts.onTranscript!("मुझे यह प्रोजेक्ट अच्छा लगा।", { kind: "final" });
    expect(h.addSegment).toHaveBeenCalledWith(expect.objectContaining({ id: first.id, text: "मुझे यह प्रोजेक्ट अच्छा लगा।", final: true }));
    await session.stop();
  });

  it("persists late final text delivered during stop before resolving", async () => {
    const { session, cb } = await startLive();
    live(0).opts.onTranscript!("We should ");
    live(0).finishInput.mockImplementationOnce(async () => {
      live(0).opts.onTranscript!("call back tomorrow.");
    });
    await session.stop();
    expect(h.addSegment).toHaveBeenCalledWith(expect.objectContaining({ text: "We should call back tomorrow.", final: true }));
    expect(cb.onSegment.mock.calls.map((c) => c[0]).filter((s) => s.final)).toHaveLength(1);
    expect(live(0).closed).toBe(true);
  });

  it("waits for an already-running database write when stopping", async () => {
    vi.useFakeTimers();
    const { session } = await startLive();
    let finishWrite!: () => void;
    h.addSegment.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    live(0).opts.onTranscript!("Saved before summary.");
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);
    const stopped = vi.fn();
    const stop = session.stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    finishWrite();
    await stop;
    expect(stopped).toHaveBeenCalledOnce();
  });
});

describe("transcription independent of interpretation", () => {
  it("records both participants even when the optional voice connection fails", async () => {
    const connect = h.connectLiveWithFallback.getMockImplementation()!;
    h.connectLiveWithFallback.mockImplementation((opts, chain) => opts.voiceName
      ? Promise.reject(new Error("voice quota exceeded"))
      : connect(opts, chain));
    const { session, cb } = await startLive();
    expect(cb.onStatus).toHaveBeenLastCalledWith("degraded", expect.stringContaining("Spoken translation unavailable"));
    live(0).opts.onTranscript!("नमस्ते।", { kind: "final" });
    live(1).opts.onTranscript!("Hello.", { kind: "final" });
    await session.stop();
    expect(h.addSegment).toHaveBeenCalledWith(expect.objectContaining({ speaker: "me", text: "नमस्ते।" }));
    expect(h.addSegment).toHaveBeenCalledWith(expect.objectContaining({ speaker: "them", text: "Hello." }));
  });
});

describe("audio recovery", () => {
  it("keeps microphone transcription working through denied call-audio startup and retry", async () => {
    const { session, cb } = makeSession({ translationEnabled: false });
    const denied = "Screen recording permission denied. Enable MeetingAI in System Settings.";
    sys().start.mockRejectedValueOnce(new Error(denied));
    await session.start();
    expect(cb.onStatus).toHaveBeenLastCalledWith("degraded", denied);
    mic().onChunk!(new Int16Array([1000, -1000]));
    expect(live(0).audio).toHaveLength(1);
    live(0).opts.onTranscript!("The microphone still works.", { kind: "final" });
    await session.retryAudio("them");
    expect(cb.onStatus).toHaveBeenLastCalledWith("live");
    expect(live(0).closed).toBe(false);
    sys().onChunk!(new Int16Array([500]));
    expect(live(2).audio).toHaveLength(1);
    await session.stop();
    expect(h.addSegment).toHaveBeenCalledWith(expect.objectContaining({ text: "The microphone still works.", speaker: "me" }));
  });

  it("switches microphones without restarting or closing call audio", async () => {
    const { session } = await startLive({ translationEnabled: false, microphoneDeviceId: "headset" });
    expect(mic().start).toHaveBeenLastCalledWith(expect.any(Function), expect.any(Function), "headset");
    await session.selectMicrophone("built-in");
    expect(mic().start).toHaveBeenLastCalledWith(expect.any(Function), expect.any(Function), "built-in");
    expect(sys().start).toHaveBeenCalledTimes(1);
    expect(sys().stop).not.toHaveBeenCalled();
    expect(live(1).closed).toBe(false);
    mic().onChunk!(new Int16Array([200]));
    expect(live(2).audio).toHaveLength(1);
    await session.stop();
  });

  it("keeps call recognition working when the microphone permission is denied", async () => {
    const { session, cb } = makeSession({ translationEnabled: false });
    mic().start.mockRejectedValueOnce(new Error("Microphone permission denied"));
    await session.start();
    expect(cb.onStatus).toHaveBeenLastCalledWith("degraded", "Microphone permission denied");
    sys().onChunk!(new Int16Array([100, 200]));
    expect(live(1).audio).toHaveLength(1);
    await session.retryAudio("me");
    mic().onChunk!(new Int16Array([300]));
    expect(live(2).audio).toHaveLength(1);
    expect(live(1).closed).toBe(false);
    expect(cb.onAudioHealth.mock.calls[cb.onAudioHealth.mock.calls.length - 1][0][0].capture).toBe("ready");
    await session.stop();
  });

  it("starts recognition without waiting for spoken translation setup", async () => {
    const { session } = makeSession();
    h.connectLiveWithFallback.mockImplementationOnce(async (opts) => {
      const connection = new h.FakeLiveSession(opts); h.liveSessions.push(connection);
      return { session: connection, model: "stt" };
    }).mockImplementationOnce(async (opts) => {
      const connection = new h.FakeLiveSession(opts); h.liveSessions.push(connection);
      return { session: connection, model: "stt" };
    }).mockImplementationOnce(() => new Promise(() => {}));
    await session.start();
    expect(mic().start).toHaveBeenCalledOnce();
    expect(sys().start).toHaveBeenCalledOnce();
    await session.stop();
  });

  it("does not reopen capture when Stop wins a retry race", async () => {
    const { session } = await startLive({ translationEnabled: false });
    let resolve!: (value: unknown) => void;
    h.connectLiveWithFallback.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const retry = session.retryAudio("me");
    await flush();
    await session.stop();
    const late = new h.FakeLiveSession(live(0).opts);
    resolve({ session: late, model: "stt" });
    await retry;
    expect(late.closed).toBe(true);
    expect(mic().start).toHaveBeenCalledTimes(1);
  });
});

describe("local provider meeting lifecycle", () => {
  it("drains both audio sources into saved segments without opening Gemini", async () => {
    h.safeInvoke.mockImplementation(async (cmd: string) => cmd === "local_speech_transcribe" ? { text: "A local spoken sentence." } : undefined);
    const { session } = await startLive({ aiProvider: "ollama", whisperUrl: "http://localhost:8080", ollamaModel: "local:4b", whisperLanguage: "hi", translationEnabled: true });
    mic().onChunk!(new Int16Array(16000).fill(1000));
    sys().onChunk!(new Int16Array(16000).fill(1000));
    await session.stop();
    expect(h.connectLiveWithFallback).not.toHaveBeenCalled();
    expect(h.translateLine).not.toHaveBeenCalled();
    const saved = h.addSegment.mock.calls.map(([segment]) => segment as TranscriptSegment);
    expect(saved).toHaveLength(2);
    expect(saved.map(s => s.speaker).sort()).toEqual(["me", "them"]);
    expect(saved.every(s => s.text === "A local spoken sentence." && s.final && s.lang === "hi")).toBe(true);
    expect(h.endMeeting).toHaveBeenCalledOnce();
  });
});
