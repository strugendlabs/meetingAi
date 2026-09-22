import type { Speaker } from "./types";

export interface AudioSourceHealth {
  speaker: Speaker;
  capture: "starting" | "ready" | "error";
  connected: boolean;
  level: number;
  lastAudioAt: number | null;
  lastSoundAt: number | null;
  lastTranscriptAt: number | null;
  soundSinceTranscriptMs: number;
  error?: string;
  inputLabel?: string;
  captureReadyAt?: number;
}

export function emptyAudioSource(speaker: Speaker): AudioSourceHealth {
  return { speaker, capture: "starting", connected: false, level: 0,
    lastAudioAt: null, lastSoundAt: null, lastTranscriptAt: null, soundSinceTranscriptMs: 0 };
}

/** Signal amplitude is diagnostic; it does not claim to detect speech. */
export function audioLevel(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (const sample of pcm) sum += (sample / 32768) ** 2;
  return Math.sqrt(sum / pcm.length);
}

export function describeAudio(source: AudioSourceHealth, now: number): string {
  if (source.error) return source.error;
  if (source.capture === "starting") return "Connecting audio…";
  if (!source.connected) return "Recognition disconnected · retry audio";
  if (source.lastAudioAt === null || now - source.lastAudioAt > 5000) {
    return source.speaker === "me" ? "No microphone signal · check your input" : "Waiting for call audio · play sound in your meeting";
  }
  if (source.soundSinceTranscriptMs > 12000) return "Sound received, but no words · retry audio if you are speaking";
  if (source.speaker === "me" && source.lastSoundAt === null && source.captureReadyAt !== undefined && now - source.captureReadyAt > 10000) {
    return "No sound from this microphone · check mute or choose another input";
  }
  if (source.lastTranscriptAt !== null && now - source.lastTranscriptAt < 5000) return "Recognizing speech";
  if (source.lastSoundAt !== null && now - source.lastSoundAt < 1500) return "Sound received · listening for words";
  return "Connected · waiting for speech";
}
