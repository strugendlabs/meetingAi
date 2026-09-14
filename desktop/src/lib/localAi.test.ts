import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkOllamaModel, listOllamaModels, ollamaChat, transcribeLocal, validateLocalUrl, wavBase64 } from "./localAi";
import { DEFAULT_SETTINGS } from "./settings";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("./tauri", () => ({ safeInvoke: invoke }));
const settings = { ...DEFAULT_SETTINGS, aiProvider: "ollama" as const, ollamaModel: "local:4b" };
const local = { details: { format: "gguf" }, model_info: { architecture: "test" }, capabilities: ["completion"] };
beforeEach(() => invoke.mockReset());

describe("local inference boundary", () => {
  it.each(["https://ollama.com", "http://192.168.1.2", "http://localhost.evil.test", "http://me:password@localhost", "http://localhost/api", "http://localhost?proxy=x"])("rejects %s before invoking native code", async (url) => {
    await expect(listOllamaModels(url)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("accepts only loopback origins", () => {
    expect(validateLocalUrl(" http://localhost:11434/ ")).toBe("http://localhost:11434");
    expect(validateLocalUrl("http://[::1]:11434")).toBe("http://[::1]:11434");
  });
  it("hides cloud-backed models and checks again before sending meeting text", async () => {
    invoke.mockResolvedValueOnce({ models: [
      { ...local, name: "local:4b" }, { name: "remote:cloud", details: { format: "gguf" } },
      { ...local, name: "proxy", remote_host: "https://ollama.com" }, { name: "missing-metadata" },
    ] });
    expect(await listOllamaModels("http://localhost:11434")).toEqual(["local:4b"]);
    invoke.mockResolvedValueOnce({ ...local, remote_model: "remote" });
    await expect(ollamaChat(settings, "Summarize", "PRIVATE TRANSCRIPT")).rejects.toThrow("Cloud-backed");
    expect(invoke.mock.calls.some(([, args]) => args.route === "/api/chat")).toBe(false);
  });
  it("surfaces server failure without a cloud fallback", async () => {
    invoke.mockRejectedValueOnce(new Error("offline"));
    await expect(checkOllamaModel(settings)).rejects.toThrow("offline");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("uses non-streamed local structured output and rejects truncation", async () => {
    invoke.mockResolvedValueOnce(local).mockResolvedValueOnce({ done_reason: "length", message: { content: "partial" } });
    await expect(ollamaChat(settings, "system", "meeting", { type: "object" })).rejects.toThrow("output limit");
    expect(invoke.mock.calls[1][1].body).toMatchObject({ stream: false, think: false, format: { type: "object" } });
  });
  it("encodes 16kHz mono PCM as an actual WAV", () => {
    const bytes = Uint8Array.from(atob(wavBase64(new Int16Array([-32768, 0, 32767]))), c => c.charCodeAt(0));
    const wav = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(wav.getUint32(24, true)).toBe(16000);
    expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getUint32(40, true)).toBe(6);
    expect(wav.getInt16(44, true)).toBe(-32768);
    expect(wav.getInt16(48, true)).toBe(32767);
  });
  it("requires an actual Whisper response", async () => {
    invoke.mockResolvedValue({ error: "server misconfigured" });
    await expect(transcribeLocal("http://localhost:8080", new Int16Array(3200))).rejects.toThrow("did not return");
  });
});
