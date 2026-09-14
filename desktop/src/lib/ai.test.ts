import { beforeEach, expect, it, vi } from "vitest";
import { splitTranscript, summarizeWithProvider, translateWithProvider } from "./ai";
import { DEFAULT_SETTINGS } from "./settings";
const mocks = vi.hoisted(() => ({ chat: vi.fn(), geminiSummary: vi.fn(), geminiTranslate: vi.fn() }));
vi.mock("./localAi", () => ({ isLocalAI: (s: { aiProvider?: string }) => s.aiProvider === "ollama", ollamaChat: mocks.chat }));
vi.mock("./gemini/summarize", async (original) => ({ ...await original<object>(), summarizeTranscript: mocks.geminiSummary }));
vi.mock("./gemini/translateText", () => ({ translateLine: mocks.geminiTranslate }));
const local = { ...DEFAULT_SETTINGS, aiProvider: "ollama" as const, ollamaModel: "local:4b" };
beforeEach(() => vi.clearAllMocks());
it("uses Ollama without a Gemini key for summaries and translations", async () => {
  mocks.chat.mockResolvedValueOnce(JSON.stringify({ summary: "Friday report", action_items: ["Alice drafts"], key_notes: [] })).mockResolvedValueOnce("शुक्रवार को रिपोर्ट भेजें।");
  expect((await summarizeWithProvider(null, local, "Alice drafts the report for Friday", "en")).result.actionItems).toEqual(["Alice drafts"]);
  expect(await translateWithProvider(null, local, "Send the report Friday", "hi")).toContain("शुक्रवार");
  expect(mocks.geminiSummary).not.toHaveBeenCalled();
  expect(mocks.geminiTranslate).not.toHaveBeenCalled();
});
it("does not call Gemini if Ollama fails", async () => {
  mocks.chat.mockRejectedValue(new Error("Ollama unavailable"));
  await expect(summarizeWithProvider("unused-cloud-key", local, "meeting", "en")).rejects.toThrow("Ollama unavailable");
  expect(mocks.geminiSummary).not.toHaveBeenCalled();
});
it("preserves all source text when splitting long meetings", () => {
  const transcript = "Alice: first\n".repeat(3000) + "Bob: final decision";
  const chunks = splitTranscript(transcript);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.join("")).toBe(transcript);
  expect(chunks.every(c => c.length <= 10000)).toBe(true);
});
it("summarizes every section, then combines the section summaries", async () => {
  mocks.chat.mockResolvedValue(JSON.stringify({ summary: "section", action_items: [], key_notes: [] }));
  await summarizeWithProvider(null, local, "A".repeat(21000), "en");
  expect(mocks.chat).toHaveBeenCalledTimes(7);
  expect(mocks.chat.mock.calls[5][2]).toHaveLength(1000);
  expect(mocks.chat.mock.calls[6][2]).toContain("Meeting section 6");
});
it("keeps Gemini an explicit provider and requires its key", async () => {
  await expect(summarizeWithProvider(null, DEFAULT_SETTINGS, "meeting", "en")).rejects.toThrow("API key");
  mocks.geminiTranslate.mockResolvedValue("translated");
  expect(await translateWithProvider("user-key", DEFAULT_SETTINGS, "text", "hi")).toBe("translated");
});

it("bounds multilingual UTF-8 chunks without splitting code points", () => {
  const text = "शुक्रवार को रिपोर्ट भेजें। 🙂\n".repeat(500);
  const chunks = splitTranscript(text);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every(c => new TextEncoder().encode(c).length <= 4000)).toBe(true);
  expect(chunks.every(c => !c.includes("\uFFFD"))).toBe(true);
});
