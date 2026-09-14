import { beforeEach, expect, it, vi } from "vitest";
import { LocalSpeechSession } from "./localSpeech";
const transcribe = vi.hoisted(() => vi.fn());
vi.mock("./localAi", () => ({ transcribeLocal: transcribe, WHISPER_DEFAULT_URL: "http://localhost:8080" }));
beforeEach(() => transcribe.mockReset());
const voice = () => new Int16Array(16000).fill(1000);
it("ignores silence and drains the last utterance with capture timestamps", async () => {
  const onTranscript = vi.fn();
  transcribe.mockResolvedValue("Send the draft Friday.");
  const session = new LocalSpeechSession(undefined, { onTranscript }, () => 5000);
  session.sendAudio(new Int16Array(16000));
  expect(transcribe).not.toHaveBeenCalled();
  session.sendAudio(voice());
  await session.finishInput();
  expect(onTranscript).toHaveBeenCalledWith("Send the draft Friday.", { kind: "final", tStart: 4000, tEnd: 5000 });
  expect(session.isOpen).toBe(false);
});
it("processes chunks in order and reports failures while allowing later speech", async () => {
  const onTranscript = vi.fn(), onError = vi.fn();
  transcribe.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("Recovered");
  const session = new LocalSpeechSession(undefined, { onTranscript, onError }, () => 5000);
  session.sendAudio(voice()); session.sendAudio(new Int16Array(12800));
  session.sendAudio(voice());
  await session.finishInput();
  expect(onError.mock.calls[0][0].message).toContain("No cloud fallback");
  expect(onTranscript).toHaveBeenCalledTimes(1);
  expect(onTranscript.mock.calls[0][0]).toBe("Recovered");
});
it("does not publish late transcripts after closing", async () => {
  let resolve!: (s: string) => void;
  transcribe.mockReturnValue(new Promise<string>(r => { resolve = r; }));
  const onTranscript = vi.fn();
  const session = new LocalSpeechSession(undefined, { onTranscript }, () => 1000);
  session.sendAudio(voice());
  const drain = session.finishInput();
  await Promise.resolve();
  session.close(); resolve("late"); await drain;
  expect(onTranscript).not.toHaveBeenCalled();
});
it("bounds the queue and makes skipped audio visible", async () => {
  transcribe.mockResolvedValue("speech");
  const onError = vi.fn();
  const session = new LocalSpeechSession(undefined, { onError }, () => 1000);
  for (let i = 0; i < 8; i++) { session.sendAudio(voice()); session.sendAudio(new Int16Array(12800)); }
  await session.finishInput();
  expect(transcribe).toHaveBeenCalledTimes(6);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][0].message).toContain("Some audio was skipped");
});

it("keeps the chosen spoken language across queued chunks", async () => {
  transcribe.mockResolvedValue("हिंदी");
  const session = new LocalSpeechSession(undefined, {}, () => 1000, "hi");
  session.sendAudio(voice());
  await session.finishInput();
  expect(transcribe).toHaveBeenCalledWith("http://localhost:8080", expect.any(Int16Array), "hi");
});
