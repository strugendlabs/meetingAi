import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { GeminiLiveSession, connectLiveWithFallback, CONNECT_TIMEOUT_MS } from "./live";
import type { LiveSessionOpts } from "./live";
import { LIVE_STT_MODEL_CHAIN, LIVE_TRANSLATE_MODEL_CHAIN } from "./models";
import { int16ToB64 } from "../pcm";

const EXPECTED_URL_PREFIX =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  binaryType?: string;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closedWith = { code, reason };
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // ---- test drivers ----
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  openAndComplete(): void {
    this.open();
    this.message(JSON.stringify({ setupComplete: {} }));
  }
}

function mock(i: number): MockWebSocket {
  const inst = MockWebSocket.instances[i];
  if (!inst) throw new Error(`no MockWebSocket instance at index ${i}`);
  return inst;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface Spies {
  onTranscript: Mock;
  onAudio: Mock;
  onOpen: Mock;
  onError: Mock;
  onClose: Mock;
}

function makeSession(overrides: Partial<LiveSessionOpts> = {}): {
  session: GeminiLiveSession;
  spies: Spies;
} {
  const spies: Spies = {
    onTranscript: vi.fn(),
    onAudio: vi.fn(),
    onOpen: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const session = new GeminiLiveSession({
    apiKey: "test-key",
    model: "m-test",
    responseModalities: ["TEXT"],
    ...spies,
    ...overrides,
  });
  return { session, spies };
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GeminiLiveSession — connect + setup", () => {
  it("bounds a stalled setup even when the socket never emits close", async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const settled = expect(session.connect()).rejects.toThrow(/timed out/i);
    mock(0).close = vi.fn();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await settled;
    expect(session.dead).toBe(true);
  });

  it("uses the verified translation protocol with a target language", async () => {
    const { session } = makeSession({ model: LIVE_TRANSLATE_MODEL_CHAIN[0], translationLanguage: "hi", inputTranscription: true, onOutputTranscript: vi.fn(), systemInstruction: "unused", voiceName: "unused" });
    const ready = session.connect();
    mock(0).openAndComplete();
    await ready;
    expect(JSON.parse(mock(0).sent[0]).setup).toEqual({
      model: `models/${LIVE_TRANSLATE_MODEL_CHAIN[0]}`,
      generationConfig: { responseModalities: ["AUDIO"], translationConfig: { targetLanguageCode: "hi", echoTargetLanguage: false } },
      inputAudioTranscription: {}, outputAudioTranscription: {},
    });
    session.close();
  });
  it("opens the WS to the BidiGenerateContent URL with the api key", async () => {
    const { session } = makeSession();
    const p = session.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(mock(0).url).toBe(`${EXPECTED_URL_PREFIX}test-key`);
    mock(0).openAndComplete();
    await p;
  });

  it("sends the exact setup message on open (all options)", async () => {
    const { session } = makeSession({
      responseModalities: ["AUDIO"],
      voiceName: "Kore",
      systemInstruction: "You are a simultaneous interpreter.",
      inputTranscription: true,
    });
    const p = session.connect();
    mock(0).open();
    expect(mock(0).sent).toHaveLength(1);
    expect(JSON.parse(mock(0).sent[0])).toEqual({
      setup: {
        model: "models/m-test",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
        },
        systemInstruction: { parts: [{ text: "You are a simultaneous interpreter." }] },
        inputAudioTranscription: {},
      },
    });
    mock(0).message(JSON.stringify({ setupComplete: {} }));
    await p;
  });

  it("omits optional setup fields when not configured", async () => {
    const { session } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;
    const setup = JSON.parse(mock(0).sent[0]).setup;
    expect(setup).toEqual({
      model: "models/m-test",
      generationConfig: { responseModalities: ["TEXT"] },
    });
    expect(setup.generationConfig).not.toHaveProperty("speechConfig");
    expect(setup).not.toHaveProperty("systemInstruction");
    expect(setup).not.toHaveProperty("inputAudioTranscription");
  });

  it("resolves connect and fires onOpen only after setupComplete", async () => {
    const { session, spies } = makeSession();
    const p = session.connect();
    mock(0).open();
    expect(session.isOpen).toBe(false);
    expect(spies.onOpen).not.toHaveBeenCalled();
    mock(0).message(JSON.stringify({ setupComplete: {} }));
    await p;
    expect(session.isOpen).toBe(true);
    expect(spies.onOpen).toHaveBeenCalledTimes(1);
  });

  it("rejects connect when the socket closes before setupComplete", async () => {
    const { session } = makeSession();
    const p = session.connect();
    mock(0).serverClose(1008, "policy violation");
    await expect(p).rejects.toThrow(/code=1008.*policy violation/);
  });

  it("rejects a second connect() call", async () => {
    const { session } = makeSession();
    const p = session.connect();
    await expect(session.connect()).rejects.toThrow(/already called/);
    mock(0).openAndComplete();
    await p;
  });
});

describe("GeminiLiveSession — audio in", () => {
  it("sends the exact realtimeInput frame with base64 pcm16 @ 16k", async () => {
    const { session } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;
    const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
    session.sendAudio(pcm);
    expect(mock(0).sent).toHaveLength(2); // setup + audio
    expect(JSON.parse(mock(0).sent[1])).toEqual({
      realtimeInput: {
        audio: { data: int16ToB64(pcm), mimeType: "audio/pcm;rate=16000" },
      },
    });
  });

  it("drops audio silently while not open", async () => {
    const { session } = makeSession();
    session.sendAudio(new Int16Array([1, 2, 3])); // before connect
    const p = session.connect();
    session.sendAudio(new Int16Array([1, 2, 3])); // connecting
    mock(0).open();
    session.sendAudio(new Int16Array([1, 2, 3])); // open but setup not complete
    expect(mock(0).sent).toHaveLength(1); // only setup
    mock(0).message(JSON.stringify({ setupComplete: {} }));
    await p;
  });
});

describe("GeminiLiveSession — server messages", () => {
  async function openSession() {
    const made = makeSession();
    const p = made.session.connect();
    mock(0).openAndComplete();
    await p;
    return made;
  }

  it("routes inputTranscription text to onTranscript", async () => {
    const { spies } = await openSession();
    mock(0).message(
      JSON.stringify({ serverContent: { inputTranscription: { text: "hola mundo" } } }),
    );
    expect(spies.onTranscript).toHaveBeenCalledWith("hola mundo");
  });

  it("handles Blob messages by awaiting data.text()", async () => {
    const { spies } = await openSession();
    const payload = JSON.stringify({
      serverContent: { inputTranscription: { text: "from blob" } },
    });
    mock(0).message(new Blob([payload]));
    await flush();
    expect(spies.onTranscript).toHaveBeenCalledWith("from blob");
  });

  it("decodes modelTurn inlineData audio to Int16Array via onAudio", async () => {
    const { spies } = await openSession();
    const samples = new Int16Array([100, -200, 300, -32768, 32767]);
    mock(0).message(
      JSON.stringify({
        serverContent: {
          modelTurn: {
            parts: [
              { inlineData: { mimeType: "audio/pcm;rate=24000", data: int16ToB64(samples) } },
            ],
          },
        },
      }),
    );
    expect(spies.onAudio).toHaveBeenCalledTimes(1);
    const got = spies.onAudio.mock.calls[0][0] as Int16Array;
    expect(got).toBeInstanceOf(Int16Array);
    expect(Array.from(got)).toEqual(Array.from(samples));
  });

  it("ignores turnComplete and unrelated messages without errors", async () => {
    const { spies } = await openSession();
    mock(0).message(JSON.stringify({ serverContent: { turnComplete: true } }));
    mock(0).message(JSON.stringify({ usageMetadata: { totalTokenCount: 5 } }));
    expect(spies.onTranscript).not.toHaveBeenCalled();
    expect(spies.onAudio).not.toHaveBeenCalled();
    expect(spies.onError).not.toHaveBeenCalled();
  });
});

describe("GeminiLiveSession — close + reconnect", () => {
  it("close() sends code 1000, fires onClose, and never reconnects", async () => {
    vi.useFakeTimers();
    const { session, spies } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;
    session.close();
    expect(mock(0).closedWith).toEqual({ code: 1000, reason: "" });
    expect(spies.onClose).toHaveBeenCalledWith(1000);
    expect(session.isOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("normal server close (1000) fires onClose without reconnect", async () => {
    vi.useFakeTimers();
    const { session, spies } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;
    mock(0).serverClose(1000);
    expect(spies.onClose).toHaveBeenCalledWith(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("abnormal close reconnects after 500ms and surfaces onError", async () => {
    vi.useFakeTimers();
    const { session, spies } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;

    mock(0).serverClose(1011, "server hiccup");
    expect(spies.onError).toHaveBeenCalledTimes(1);
    expect((spies.onError.mock.calls[0][0] as Error).message).toMatch(/reconnecting in 500ms/);
    expect(spies.onClose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    mock(1).openAndComplete();
    expect(session.isOpen).toBe(true);
    expect(spies.onOpen).toHaveBeenCalledTimes(2);
    // resent setup on the new socket
    expect(JSON.parse(mock(1).sent[0])).toHaveProperty("setup");
    // audio flows to the new socket
    session.sendAudio(new Int16Array([7]));
    expect(mock(1).sent).toHaveLength(2);
  });

  it("backoff doubles 500ms→8s, then keeps retrying every 8s (never terminal)", async () => {
    vi.useFakeTimers();
    const { session, spies } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;

    const delays = [500, 1000, 2000, 4000, 8000];
    mock(0).serverClose(1006);
    for (let i = 0; i < delays.length; i++) {
      expect(MockWebSocket.instances).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(delays[i] - 1);
      expect(MockWebSocket.instances).toHaveLength(i + 1); // not yet
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(i + 2); // reconnect attempt i+1
      mock(i + 1).serverClose(1006); // fail this attempt too
    }

    // Ramp exhausted → NOT terminal: no onClose, not dead, one steady-state
    // notice (5 ramp messages + 1 "continuing to retry"), retries continue.
    expect(spies.onClose).not.toHaveBeenCalled();
    expect(session.dead).toBe(false);
    expect(spies.onError).toHaveBeenCalledTimes(6);
    const steady = spies.onError.mock.calls[5][0] as Error;
    expect(steady.message).toMatch(/continuing to retry every 8000ms/);

    // Steady state: another attempt every 8s, no further onError spam.
    await vi.advanceTimersByTimeAsync(8000);
    expect(MockWebSocket.instances).toHaveLength(7);
    mock(6).serverClose(1006);
    expect(spies.onError).toHaveBeenCalledTimes(6);

    // Connectivity returns after the old cap would have given up → recovers.
    await vi.advanceTimersByTimeAsync(8000);
    expect(MockWebSocket.instances).toHaveLength(8);
    mock(7).openAndComplete();
    expect(session.isOpen).toBe(true);
    expect(session.dead).toBe(false);
    expect(spies.onClose).not.toHaveBeenCalled();

    // Audio flows again on the recovered socket.
    session.sendAudio(new Int16Array([7]));
    expect(mock(7).sent).toHaveLength(2); // setup + audio
  });

  it("a successful reconnect resets the backoff counter", async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;

    mock(0).serverClose(1006);
    await vi.advanceTimersByTimeAsync(500);
    mock(1).openAndComplete(); // recovery resets attempts

    mock(1).serverClose(1006);
    await vi.advanceTimersByTimeAsync(500); // back to the base 500ms delay
    expect(MockWebSocket.instances).toHaveLength(3);
    mock(2).openAndComplete();
    expect(session.isOpen).toBe(true);
  });
});

describe("GeminiLiveSession — message ordering", () => {
  async function openSession() {
    const made = makeSession();
    const p = made.session.connect();
    mock(0).openAndComplete();
    await p;
    return made;
  }

  const seg = (text: string) =>
    JSON.stringify({ serverContent: { inputTranscription: { text } } });

  it("requests arraybuffer binary delivery on every socket", async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const p = session.connect();
    expect(mock(0).binaryType).toBe("arraybuffer");
    mock(0).openAndComplete();
    await p;
    mock(0).serverClose(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(mock(1).binaryType).toBe("arraybuffer"); // reconnect socket too
  });

  it("handles ArrayBuffer frames synchronously", async () => {
    const { spies } = await openSession();
    const bytes = new TextEncoder().encode(seg("ab frame"));
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    mock(0).message(buf);
    expect(spies.onTranscript).toHaveBeenCalledWith("ab frame");
  });

  it("preserves arrival order when a slow Blob read is followed by faster frames", async () => {
    const { spies } = await openSession();
    let resolveFirst!: (s: string) => void;
    mock(0).message({
      text: () => new Promise<string>((r) => (resolveFirst = r)),
    });
    mock(0).message({ text: () => Promise.resolve(seg(" world")) });
    mock(0).message(seg("!")); // string frame arriving while Blobs are pending
    await flush();
    // Nothing may jump ahead of the first (still unresolved) frame.
    expect(spies.onTranscript).not.toHaveBeenCalled();
    resolveFirst(seg("Hello"));
    await flush();
    expect(spies.onTranscript.mock.calls.map((c) => c[0])).toEqual([
      "Hello",
      " world",
      "!",
    ]);
  });

  it("drops Blob frames that resolve after the socket was replaced", async () => {
    vi.useFakeTimers();
    const { session, spies } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;
    let resolveStale!: (s: string) => void;
    mock(0).message({
      text: () => new Promise<string>((r) => (resolveStale = r)),
    });
    mock(0).serverClose(1006);
    await vi.advanceTimersByTimeAsync(500);
    // New socket works immediately — the stale pending read cannot block it.
    mock(1).openAndComplete();
    expect(session.isOpen).toBe(true);
    mock(1).message(seg("fresh"));
    expect(spies.onTranscript).toHaveBeenCalledWith("fresh");
    resolveStale(seg("stale"));
    await vi.advanceTimersByTimeAsync(0);
    expect(spies.onTranscript).toHaveBeenCalledTimes(1); // "stale" was dropped
  });

  it("surfaces a Blob read failure via onError without stalling later frames", async () => {
    const { spies } = await openSession();
    mock(0).message({ text: () => Promise.reject(new Error("read failed")) });
    mock(0).message(seg("after"));
    await flush();
    expect(spies.onError).toHaveBeenCalledTimes(1);
    expect((spies.onError.mock.calls[0][0] as Error).message).toBe("read failed");
    expect(spies.onTranscript).toHaveBeenCalledWith("after");
  });
});

describe("GeminiLiveSession — terminal state (dead)", () => {
  it("close() marks the session dead synchronously and is idempotent", async () => {
    const { session, spies } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;
    expect(session.dead).toBe(false);
    session.close();
    expect(session.dead).toBe(true);
    expect(spies.onClose).toHaveBeenCalledTimes(1);
    session.close(); // idempotent — no second onClose
    expect(spies.onClose).toHaveBeenCalledTimes(1);
    session.sendAudio(new Int16Array([1]));
    expect(mock(0).sent).toHaveLength(1); // setup only — audio dropped
  });

  it("normal server close (1000) marks the session dead", async () => {
    const { session, spies } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;
    mock(0).serverClose(1000);
    expect(session.dead).toBe(true);
    expect(spies.onClose).toHaveBeenCalledTimes(1);
  });

  it("initial connect failure marks the session dead without firing onClose", async () => {
    const { session, spies } = makeSession();
    const p = session.connect();
    mock(0).serverClose(1008, "denied");
    await expect(p).rejects.toThrow(/code=1008/);
    expect(session.dead).toBe(true);
    expect(spies.onClose).not.toHaveBeenCalled();
  });

  it("abnormal mid-meeting closes never mark the session dead", async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;
    mock(0).serverClose(1011);
    expect(session.dead).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.dead).toBe(false);
  });

  it("connect() on a dead session rejects", async () => {
    const { session } = makeSession();
    const p = session.connect();
    mock(0).openAndComplete();
    await p;
    session.close();
    await expect(session.connect()).rejects.toThrow(/dead/);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

describe("connectLiveWithFallback", () => {
  it("returns the first live model when it connects", async () => {
    const spies = { onTranscript: vi.fn() };
    const p = connectLiveWithFallback({
      apiKey: "k",
      responseModalities: ["TEXT"],
      inputTranscription: true,
      ...spies,
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    mock(0).openAndComplete();
    const { session, model } = await p;
    expect(model).toBe(LIVE_STT_MODEL_CHAIN[0]);
    expect(session.isOpen).toBe(true);
    expect(JSON.parse(mock(0).sent[0]).setup.model).toBe(`models/${LIVE_STT_MODEL_CHAIN[0]}`);
  });

  it("falls back to the next model on a NOT_FOUND close", async () => {
    const p = connectLiveWithFallback({ apiKey: "k", responseModalities: ["TEXT"] });
    mock(0).serverClose(1008, `models/${LIVE_STT_MODEL_CHAIN[0]} NOT_FOUND`);
    await flush();
    expect(MockWebSocket.instances).toHaveLength(2);
    mock(1).openAndComplete();
    const { session, model } = await p;
    expect(model).toBe(LIVE_STT_MODEL_CHAIN[1]);
    expect(session.isOpen).toBe(true);
    expect(JSON.parse(mock(1).sent[0]).setup.model).toBe(`models/${LIVE_STT_MODEL_CHAIN[1]}`);
  });

  it("does not fall back on non-NOT_FOUND connect failures", async () => {
    const p = connectLiveWithFallback({ apiKey: "k", responseModalities: ["TEXT"] });
    mock(0).serverClose(1011, "internal error");
    await expect(p).rejects.toThrow(/code=1011/);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

describe("connectLiveWithFallback chain selection", () => {
  it("defaults to the STT chain", async () => {
    const p = connectLiveWithFallback({ apiKey: "k", responseModalities: ["AUDIO"] });
    mock(0).openAndComplete();
    const { model } = await p;
    expect(model).toBe(LIVE_STT_MODEL_CHAIN[0]);
  });

  it("uses an explicitly passed chain (translate)", async () => {
    const p = connectLiveWithFallback(
      { apiKey: "k", responseModalities: ["AUDIO"], voiceName: "Kore" },
      LIVE_TRANSLATE_MODEL_CHAIN,
    );
    mock(0).openAndComplete();
    const { model } = await p;
    expect(model).toBe(LIVE_TRANSLATE_MODEL_CHAIN[0]);
  });

  it("falls back on a 1007 modality rejection", async () => {
    const p = connectLiveWithFallback({ apiKey: "k", responseModalities: ["AUDIO"] });
    mock(0).serverClose(
      1007,
      "The requested combination of response modalities is not supported by the model.",
    );
    await flush();
    expect(MockWebSocket.instances).toHaveLength(2);
    mock(1).openAndComplete();
    const { model } = await p;
    expect(model).toBe(LIVE_STT_MODEL_CHAIN[1]);
  });
});

// Recognition snapshots and stop-drain regressions: model output turns do
// not guarantee that the independently streamed input transcript is done.
describe("dedicated transcription and draining", () => {
  it("uses a transcription-only setup and preserves mixed-language detection", async () => {
    const onTranscript = vi.fn();
    const { session } = makeSession({ model: "gemini-3.5-transcribe-live", onTranscript, systemInstruction: "fallback interpreter", voiceName: "Kore" });
    const connected = session.connect();
    mock(0).openAndComplete();
    await connected;
    const setup = JSON.parse(mock(0).sent[0]).setup;
    expect(setup.generationConfig).toEqual({ responseModalities: ["TEXT"] });
    expect(setup.inputAudioTranscription).toEqual({ languageCodes: [], mode: "SMART" });
    expect(setup.systemInstruction).toBeUndefined();
    mock(0).message(JSON.stringify({ serverContent: { interimInputTranscription: { text: "हिंदी" } } }));
    mock(0).message(JSON.stringify({ serverContent: { inputTranscription: { text: "हिंदी और English।" } } }));
    expect(onTranscript.mock.calls).toEqual([
      ["हिंदी", { kind: "interim" }], ["हिंदी और English।", { kind: "final" }],
    ]);
    session.close();
  });

  it("signals end of audio and accepts transcripts arriving after turnComplete", async () => {
    vi.useFakeTimers();
    const { session, spies } = makeSession();
    const connected = session.connect();
    mock(0).openAndComplete();
    await connected;
    const drained = vi.fn();
    const finish = session.finishInput().then(drained);
    expect(JSON.parse(mock(0).sent[1])).toEqual({ realtimeInput: { audioStreamEnd: true } });
    mock(0).message(JSON.stringify({ serverContent: { turnComplete: true } }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(drained).not.toHaveBeenCalled();
    mock(0).message(JSON.stringify({ serverContent: { inputTranscription: { text: "Last words." } } }));
    expect(spies.onTranscript).toHaveBeenCalledWith("Last words.");
    await vi.advanceTimersByTimeAsync(1500);
    await finish;
    expect(drained).toHaveBeenCalledOnce();
    session.close();
  });

  it("releases a drain immediately on close and never reconnects while draining", async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const connected = session.connect();
    mock(0).openAndComplete();
    await connected;
    const finish = session.finishInput();
    mock(0).serverClose(1006);
    await finish;
    await vi.advanceTimersByTimeAsync(10000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(session.dead).toBe(true);
  });
});
