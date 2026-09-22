import { describe, it, expect } from "vitest";
import { audioLevel, describeAudio, emptyAudioSource } from "./audioHealth";

describe("audio diagnostics", () => {
  it("distinguishes silence from received signal without changing PCM", () => {
    expect(audioLevel(new Int16Array(4000))).toBe(0);
    expect(audioLevel(new Int16Array([16384, -16384]))).toBe(0.5);
    expect(audioLevel(new Int16Array())).toBe(0);
  });
  it("does not mistake a quiet participant for a recognition failure", () => {
    const source = { ...emptyAudioSource("them"), capture: "ready" as const, connected: true, lastAudioAt: 10000 };
    expect(describeAudio(source, 10000)).toContain("waiting for speech");
    expect(describeAudio({ ...source, soundSinceTranscriptMs: 13000 }, 10000)).toContain("no words");
    expect(describeAudio({ ...source, connected: false }, 10000)).toContain("disconnected");
  });
  it("reports the capture permission error before recognition state", () => {
    expect(describeAudio({ ...emptyAudioSource("me"), error: "Microphone permission denied" }, 0)).toBe("Microphone permission denied");
  });
  it("suggests another microphone for a silent input without blaming a quiet remote participant", () => {
    const source = { ...emptyAudioSource("me"), capture: "ready" as const, connected: true, captureReadyAt: 0, lastAudioAt: 11000 };
    expect(describeAudio(source, 11000)).toContain("choose another input");
    expect(describeAudio({ ...source, speaker: "them" }, 11000)).toContain("waiting for speech");
    expect(describeAudio({ ...source, lastSoundAt: 10000 }, 11000)).toContain("Sound received");
  });
});
