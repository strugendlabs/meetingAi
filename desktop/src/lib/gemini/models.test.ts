import { describe, it, expect } from "vitest";
import {
  LIVE_STT_MODEL_CHAIN,
  LIVE_TRANSLATE_MODEL_CHAIN,
  TEXT_MODEL_CHAIN,
  withModelFallback,
} from "./models";

describe("model chains", () => {
  it("LIVE_STT_MODEL_CHAIN leads with the verified transcribing model", () => {
    expect(LIVE_STT_MODEL_CHAIN).toEqual([
      "gemini-3.5-transcribe-live",
      "gemini-2.5-flash-native-audio-preview-12-2025",
      "gemini-2.5-flash-native-audio-latest",
    ]);
  });

  it("LIVE_TRANSLATE_MODEL_CHAIN leads with the verified translate model", () => {
    expect(LIVE_TRANSLATE_MODEL_CHAIN).toEqual([
      "gemini-3.5-live-translate-preview",
      "gemini-3.1-flash-live-preview",
    ]);
  });

  it("TEXT_MODEL_CHAIN matches the spec order", () => {
    expect(TEXT_MODEL_CHAIN).toEqual([
      "gemini-3.5-flash-lite",
      "gemini-flash-lite-latest",
      "gemini-2.5-flash-lite",
    ]);
  });
});

describe("withModelFallback", () => {
  it("returns first model's result when it succeeds", async () => {
    const calls: string[] = [];
    const { model, result } = await withModelFallback(["a", "b"], async (m) => {
      calls.push(m);
      return `ok-${m}`;
    });
    expect(model).toBe("a");
    expect(result).toBe("ok-a");
    expect(calls).toEqual(["a"]);
  });

  it("advances to the next model on a 404 status error", async () => {
    const calls: string[] = [];
    const { model, result } = await withModelFallback(["a", "b", "c"], async (m) => {
      calls.push(m);
      if (m === "a") {
        const e = new Error("Requested entity was not found.") as Error & { status: number };
        e.status = 404;
        throw e;
      }
      return `ok-${m}`;
    });
    expect(model).toBe("b");
    expect(result).toBe("ok-b");
    expect(calls).toEqual(["a", "b"]);
  });

  it("advances on a NOT_FOUND message error", async () => {
    const { model } = await withModelFallback(["a", "b"], async (m) => {
      if (m === "a") throw new Error("models/a is not found for API version v1beta (NOT_FOUND)");
      return m;
    });
    expect(model).toBe("b");
  });

  it("advances on a message containing 404", async () => {
    const { model } = await withModelFallback(["a", "b"], async (m) => {
      if (m === "a") throw new Error("HTTP 404 from server");
      return m;
    });
    expect(model).toBe("b");
  });

  it("advances on an unsupported-response-modalities rejection (WS 1007)", async () => {
    const calls: string[] = [];
    const { model } = await withModelFallback(["native-audio", "half-cascade"], async (m) => {
      calls.push(m);
      if (m === "native-audio") {
        throw new Error(
          "Gemini Live connect failed (model native-audio): code=1007 reason=The requested combination of response modalities (TEXT) is not supported by the model.",
        );
      }
      return "ok";
    });
    expect(model).toBe("half-cascade");
    expect(calls).toEqual(["native-audio", "half-cascade"]);
  });

  it("does NOT advance on non-404 errors — rethrows immediately", async () => {
    const calls: string[] = [];
    await expect(
      withModelFallback(["a", "b"], async (m) => {
        calls.push(m);
        const e = new Error("Internal error") as Error & { status: number };
        e.status = 500;
        throw e;
      }),
    ).rejects.toThrow("Internal error");
    expect(calls).toEqual(["a"]);
  });

  it("throws the last 404 error when the whole chain is exhausted", async () => {
    const calls: string[] = [];
    await expect(
      withModelFallback(["a", "b"], async (m) => {
        calls.push(m);
        throw new Error(`model ${m} NOT_FOUND`);
      }),
    ).rejects.toThrow("model b NOT_FOUND");
    expect(calls).toEqual(["a", "b"]);
  });

  it("throws on an empty chain", async () => {
    await expect(withModelFallback([], async () => "x")).rejects.toThrow();
  });
});
