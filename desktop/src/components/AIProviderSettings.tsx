import { useState } from "react";
import { checkOllamaModel, isLocalAI, listOllamaModels, OLLAMA_DEFAULT_URL, transcribeLocal, WHISPER_DEFAULT_URL, whisperLanguageCode } from "../lib/localAi";
import { LANGUAGES } from "../lib/languages";
import { getSettings, useSettings } from "../lib/settings";

const inputClass = "w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-neutral-700";

export default function AIProviderSettings() {
  const settings = useSettings();
  const local = isLocalAI(settings);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const run = async (action: () => Promise<string>) => {
    setBusy(true); setMessage(""); setError("");
    try { setMessage(await action()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <fieldset className="grid grid-cols-2 gap-3" disabled={busy}>
      <legend className="mb-2 text-sm font-medium">AI provider</legend>
      {(["gemini", "ollama"] as const).map((provider) => <label key={provider} className={`cursor-pointer rounded-xl border p-3 ${((settings.aiProvider ?? "gemini") === provider) ? "border-indigo-500 bg-indigo-500/5" : "border-neutral-200 dark:border-neutral-700"}`}>
        <span className="flex items-center gap-2 text-sm font-medium"><input type="radio" name="ai-provider" value={provider} checked={(settings.aiProvider ?? "gemini") === provider} onChange={() => { settings.update({ aiProvider: provider }); setMessage(""); setError(""); }} />{provider === "gemini" ? "Gemini · BYOK" : "Local · Ollama"}</span>
        <span className="mt-1.5 block text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{provider === "gemini" ? "Audio and AI requests go directly to Google using your key." : "Whisper handles audio; Ollama handles text on this computer."}</span>
      </label>)}
    </fieldset>
    {local && <>
      <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">No Gemini key needed. Run Ollama and a whisper.cpp server locally. Recognition arrives in short chunks; summaries and text translation use your selected model. Spoken translation is available in Gemini mode.</p>
      <label className="block text-sm">Ollama URL<input aria-label="Ollama URL" className={`${inputClass} mt-1`} value={settings.ollamaUrl ?? OLLAMA_DEFAULT_URL} onChange={(e) => settings.update({ ollamaUrl: e.target.value })} /></label>
      <label className="block text-sm">Ollama model<input aria-label="Ollama model" list="ollama-models" placeholder="Choose a downloaded model" className={`${inputClass} mt-1`} value={settings.ollamaModel ?? ""} onChange={(e) => settings.update({ ollamaModel: e.target.value })} /></label>
      <datalist id="ollama-models">{models.map((model) => <option key={model} value={model} />)}</datalist>
      <div className="flex gap-3">
        <button type="button" disabled={busy} className="text-xs font-medium text-indigo-600 disabled:opacity-50 dark:text-indigo-400" onClick={() => void run(async () => {
          const available = await listOllamaModels(getSettings().ollamaUrl || OLLAMA_DEFAULT_URL);
          setModels(available);
          if (!available.length) throw new Error("No local models found. Download one with ollama pull, then refresh.");
          if (!getSettings().ollamaModel) settings.update({ ollamaModel: available[0] });
          return `${available.length} local model${available.length === 1 ? "" : "s"} found.`;
        })}>Refresh models</button>
        <button type="button" disabled={busy} className="text-xs font-medium text-indigo-600 disabled:opacity-50 dark:text-indigo-400" onClick={() => void run(async () => { await checkOllamaModel(getSettings()); return "Ollama connected · local model ready."; })}>Test Ollama</button>
      </div>
      <label className="block text-sm">Whisper server URL<input aria-label="Whisper server URL" className={`${inputClass} mt-1`} value={settings.whisperUrl ?? WHISPER_DEFAULT_URL} onChange={(e) => settings.update({ whisperUrl: e.target.value })} /></label>
      <label className="block text-sm">Spoken language · Whisper
        <select aria-label="Spoken language · Whisper" className={`${inputClass} mt-1 bg-white dark:bg-neutral-900`} value={settings.whisperLanguage || "auto"} onChange={(e) => settings.update({ whisperLanguage: e.target.value })}>
          <option value="auto">Auto-detect</option>
          {LANGUAGES.filter((language) => !["pt-PT", "zh-TW"].includes(language.code)).map((language) => <option key={language.code} value={whisperLanguageCode(language.code)}>{language.code.startsWith("pt") ? "Portuguese" : language.code.startsWith("zh") ? "Chinese" : language.name} — {language.nativeName}</option>)}
        </select>
      </label>
      <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">Choose the main spoken language for both audio sources. Choose Hindi for Devanagari output with a multilingual model. Small models can still make recognition errors. This does not change your summary or translation language.</p>
      <button type="button" disabled={busy} className="text-xs font-medium text-indigo-600 disabled:opacity-50 dark:text-indigo-400" onClick={() => void run(async () => { await transcribeLocal(getSettings().whisperUrl || WHISPER_DEFAULT_URL, new Int16Array(16000), getSettings().whisperLanguage || "auto"); return "Whisper connected · audio endpoint ready. Test speech in a short meeting."; })}>Test Whisper</button>
      <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">Only loopback URLs and downloaded Ollama models are accepted. Disable Ollama cloud features with OLLAMA_NO_CLOUD=1. Local failures stay local; MeetingAI never switches to Gemini automatically.</p>
    </>}
    {busy && <p role="status" className="text-xs text-neutral-500">Checking local server…</p>}
    {message && <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">{message}</p>}
    {error && <p role="alert" className="text-xs leading-relaxed text-red-600 dark:text-red-400">{error}</p>}
  </div>;
}
