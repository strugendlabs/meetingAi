import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { summarizeTranscript } from "./summarize";
import { translateLine } from "./translateText";
import { TEXT_MODEL_CHAIN } from "./models";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function okJson(obj: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

function errRes(status: number, body = "") {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

function candidates(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

const SUMMARY_JSON = JSON.stringify({
  summary: "Team agreed to ship v1 next week.",
  action_items: ["Alice: finalize the changelog", "Bob: cut the release"],
  key_notes: ["Launch date is 2026-07-29"],
});

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestBody(call = 0): Record<string, any> {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("summarizeTranscript", () => {
  it("POSTs the first text model with a JSON response schema and maps the result", async () => {
    fetchMock.mockResolvedValueOnce(okJson(candidates(SUMMARY_JSON)));

    const { model, result } = await summarizeTranscript(
      "my-key",
      "Alice: hello\nBob: let's ship",
      "Spanish",
    );

    expect(model).toBe(TEXT_MODEL_CHAIN[0]);
    expect(result).toEqual({
      summary: "Team agreed to ship v1 next week.",
      actionItems: ["Alice: finalize the changelog", "Bob: cut the release"],
      keyNotes: ["Launch date is 2026-07-29"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/${TEXT_MODEL_CHAIN[0]}:generateContent?key=my-key`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = requestBody();
    const prompt: string = body.contents[0].parts[0].text;
    expect(prompt).toContain("Alice: hello");
    expect(prompt).toContain("Spanish");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.required).toEqual([
      "summary",
      "action_items",
      "key_notes",
    ]);
    expect(body.generationConfig.responseSchema.properties.action_items.type).toBe("ARRAY");
  });

  it("walks the chain to the second model on 404", async () => {
    fetchMock
      .mockResolvedValueOnce(errRes(404, "model not found"))
      .mockResolvedValueOnce(okJson(candidates(SUMMARY_JSON)));

    const { model } = await summarizeTranscript("k", "t", "English");
    expect(model).toBe(TEXT_MODEL_CHAIN[1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE}/${TEXT_MODEL_CHAIN[1]}:generateContent?key=k`,
    );
  });

  it("walks the whole chain of 404s then rejects", async () => {
    fetchMock.mockResolvedValue(errRes(404, "gone"));
    await expect(summarizeTranscript("k", "t", "English")).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(TEXT_MODEL_CHAIN.length);
  });

  it("does NOT fall back on non-404 errors", async () => {
    fetchMock.mockResolvedValueOnce(errRes(500, "boom"));
    await expect(summarizeTranscript("k", "t", "English")).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when the model returns unparseable JSON", async () => {
    fetchMock.mockResolvedValueOnce(okJson(candidates("this is not json")));
    await expect(summarizeTranscript("k", "t", "English")).rejects.toThrow(/unparseable/);
  });

  it("rejects when the response has no candidates", async () => {
    fetchMock.mockResolvedValueOnce(okJson({}));
    await expect(summarizeTranscript("k", "t", "English")).rejects.toThrow(/empty response/);
  });

  it("tolerates markdown code fences around the JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson(candidates("```json\n" + SUMMARY_JSON + "\n```")),
    );
    const { result } = await summarizeTranscript("k", "t", "English");
    expect(result.summary).toBe("Team agreed to ship v1 next week.");
  });

  it("defaults missing arrays to empty", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson(candidates(JSON.stringify({ summary: "S", action_items: null }))),
    );
    const { result } = await summarizeTranscript("k", "t", "English");
    expect(result).toEqual({ summary: "S", actionItems: [], keyNotes: [] });
  });
});

describe("translateLine", () => {
  it("returns the trimmed translation from the first text model", async () => {
    fetchMock.mockResolvedValueOnce(okJson(candidates("  Hola mundo \n")));
    const out = await translateLine("my-key", "Hello world", "Spanish");
    expect(out).toBe("Hola mundo");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/${TEXT_MODEL_CHAIN[0]}:generateContent?key=my-key`,
    );
    const prompt: string = requestBody().contents[0].parts[0].text;
    expect(requestBody().systemInstruction.parts[0].text).toContain("Spanish");
    expect(prompt).toContain("Hello world");
  });

  it("short-circuits empty input without a network call", async () => {
    expect(await translateLine("k", "   ", "Spanish")).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the next model on 404", async () => {
    fetchMock
      .mockResolvedValueOnce(errRes(404, "NOT_FOUND"))
      .mockResolvedValueOnce(okJson(candidates("Bonjour")));
    expect(await translateLine("k", "Hello", "French")).toBe("Bonjour");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${BASE}/${TEXT_MODEL_CHAIN[1]}:generateContent?key=k`,
    );
  });

  it("does not fall back on non-404 errors", async () => {
    fetchMock.mockResolvedValueOnce(errRes(429, "rate limited"));
    await expect(translateLine("k", "Hello", "French")).rejects.toThrow(/HTTP 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
