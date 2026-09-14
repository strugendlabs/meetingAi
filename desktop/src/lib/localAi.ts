import { safeInvoke } from "./tauri";
import type { AppSettings } from "./types";

export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
export const WHISPER_DEFAULT_URL = "http://127.0.0.1:8080";
export const isLocalAI = (settings: AppSettings) => settings.aiProvider === "ollama";

export function validateLocalUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use a local URL such as http://127.0.0.1:11434. Remote servers are disabled in local mode.");
  }
  return url.origin;
}

export async function ollamaRequest(baseUrl: string, route: "/api/tags" | "/api/show" | "/api/chat", body?: unknown): Promise<any> {
  const result = await safeInvoke("local_ai_request", { baseUrl: validateLocalUrl(baseUrl), route, body: body ?? null });
  if (result === undefined) throw new Error("Local connectors are available in the desktop app. Start Ollama, then test the connection here.");
  return result;
}

function localModel(model: any): boolean {
  return !model?.remote_host && !model?.remote_model && !/(?:^|[:\-])cloud(?:$|:)/i.test(model?.name ?? "")
    && ["gguf", "safetensors"].includes(model?.details?.format);
}

export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const data = await ollamaRequest(baseUrl, "/api/tags");
  if (!Array.isArray(data.models)) throw new Error("Ollama returned an invalid model list.");
  return data.models.filter((m: any) => localModel(m) && typeof m.name === "string").map((m: any) => m.name);
}

export async function checkOllamaModel(settings: AppSettings): Promise<void> {
  const model = settings.ollamaModel?.trim();
  if (!model) throw new Error("Choose an installed Ollama model in Settings.");
  const data = await ollamaRequest(settings.ollamaUrl || OLLAMA_DEFAULT_URL, "/api/show", { model });
  if (!localModel({ ...data, name: model }) || !data.model_info || !Object.keys(data.model_info).length) {
    throw new Error("Choose a downloaded local model. Cloud-backed Ollama models are disabled.");
  }
  if (Array.isArray(data.capabilities) && !data.capabilities.includes("completion")) throw new Error("This Ollama model does not support text generation.");
}

export async function ollamaChat(settings: AppSettings, system: string, text: string, format?: object): Promise<string> {
  await checkOllamaModel(settings);
  const response = await ollamaRequest(settings.ollamaUrl || OLLAMA_DEFAULT_URL, "/api/chat", {
    model: settings.ollamaModel!.trim(), stream: false, think: false,
    messages: [{ role: "system", content: system }, { role: "user", content: text }],
    ...(format ? { format } : {}), options: { temperature: 0, num_ctx: 8192, num_predict: 2048 },
  });
  if (response.done_reason === "length") throw new Error("The local model reached its output limit. Try another model.");
  const content = response.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("Ollama returned an empty response. Check the selected model.");
  return content.trim();
}

export function wavBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const str = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  str(0, "RIFF"); view.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, pcm.length * 2, true);
  pcm.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export async function transcribeLocal(baseUrl: string, pcm: Int16Array): Promise<string> {
  const result = await safeInvoke<{ text?: unknown }>("local_speech_transcribe", { baseUrl: validateLocalUrl(baseUrl), wavBase64: wavBase64(pcm) });
  if (!result || typeof result.text !== "string") throw new Error("Whisper did not return transcript text. Check its URL and model in Settings.");
  return result.text.trim();
}
