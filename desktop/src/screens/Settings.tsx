// Settings screen (plan Task 10): languages, translated-voice preference,
// translation/ducking toggles, Gemini API key (Keychain), Google OAuth client
// + connection. Model selection is internal (fallback chains in lib/gemini)
// and deliberately not surfaced in the UI.
//
// Keychain-backed rows detect the non-Tauri browser case (safeInvoke resolves
// `undefined` instead of the command's Option<String>) and show an
// "available in the desktop app" state instead of pretending to save.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "../App";
import AIProviderSettings from "../components/AIProviderSettings";
import { isLocalAI } from "../lib/localAi";
import GenderSelector from "../components/Meeting/GenderSelector";
import { ADMIN_CONFIG, resolveGoogleClient } from "../lib/adminConfig";
import { describeGoogleAuthError } from "../lib/googleAuthErrors";
import { LANGUAGES } from "../lib/languages";
import { useSettings } from "../lib/settings";
import { isTauri, safeInvoke } from "../lib/tauri";

type KeyState = "checking" | "set" | "unset" | "unavailable";

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 dark:border-neutral-700 dark:bg-neutral-950";

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-neutral-200/80 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {desc && (
        <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          {desc}
        </p>
      )}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  desc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  desc?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {desc && (
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            {desc}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition ${
          checked ? "bg-indigo-600" : "bg-neutral-300 dark:bg-neutral-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  allowAuto = false,
}: {
  label: string;
  value: string;
  onChange: (code: string) => void;
  allowAuto?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS}>
        {allowAuto && <option value="auto">Auto-detect</option>}
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name} — {l.nativeName}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function Settings() {
  const { navigate } = useRouter();
  const settings = useSettings();

  // ---- Gemini API key (Keychain) ----
  const [keyState, setKeyState] = useState<KeyState>("checking");
  const [newKey, setNewKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // ---- Google connection ----
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [googleErrorCopied, setGoogleErrorCopied] = useState(false);

  const copyGoogleError = useCallback(() => {
    if (!googleError) return;
    void navigator.clipboard?.writeText(googleError).then(() => {
      setGoogleErrorCopied(true);
      setTimeout(() => setGoogleErrorCopied(false), 2000);
    });
  }, [googleError]);

  // Derive key state from the non-secret settings flag — NOT from a Keychain
  // read. Reading the key here just to show "set/unset" used to pop the macOS
  // Keychain prompt on every Settings open; the flag tells us the same thing
  // without touching the Keychain.
  useEffect(() => {
    if (!isTauri()) setKeyState("unavailable");
    else setKeyState(settings.hasUserGeminiKey ? "set" : "unset");
  }, [settings.hasUserGeminiKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // google_tokens is written by THIS (stable-signed) app, so reading it
        // back does not prompt; absent tokens simply leave us disconnected.
        const raw = await safeInvoke<string | null>("keychain_get", { key: "google_tokens" });
        if (cancelled || !raw) return;
        const parsed = JSON.parse(raw) as { email?: string };
        setGoogleEmail(parsed.email || "your Google account");
      } catch {
        // No stored tokens (or unreadable) — stay disconnected.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveKey = useCallback(async () => {
    const key = newKey.trim();
    if (!key || keyBusy) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      await safeInvoke("keychain_set", { key: "gemini_api_key", value: key });
      settings.update({ hasUserGeminiKey: true });
      setKeyState("set");
      setNewKey("");
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : String(e));
    } finally {
      setKeyBusy(false);
    }
  }, [newKey, keyBusy, settings]);

  const removeKey = useCallback(async () => {
    if (keyBusy) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      await safeInvoke("keychain_delete", { key: "gemini_api_key" });
      settings.update({ hasUserGeminiKey: false });
      setKeyState("unset");
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : String(e));
    } finally {
      setKeyBusy(false);
    }
  }, [keyBusy, settings]);

  const connectGoogle = useCallback(async () => {
    setGoogleError(null);
    if (!isTauri()) {
      setGoogleError("Google sign-in opens your browser and is only available in the desktop app.");
      return;
    }
    setGoogleBusy(true);
    try {
      const client = resolveGoogleClient(settings);
      const raw = await safeInvoke<string>("google_oauth_start", {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      });
      let email = "your Google account";
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { email?: string };
          if (parsed.email) email = parsed.email;
        } catch {
          // Non-JSON response — keep the generic label.
        }
      }
      setGoogleEmail(email);
    } catch (e) {
      setGoogleError(e instanceof Error ? e.message : String(e));
    } finally {
      setGoogleBusy(false);
    }
  }, [settings.googleClientId, settings.googleClientSecret]);

  const disconnectGoogle = useCallback(async () => {
    setGoogleError(null);
    try {
      await safeInvoke("keychain_delete", { key: "google_tokens" });
      setGoogleEmail(null);
    } catch (e) {
      setGoogleError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200/80 px-5 py-3 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => navigate({ name: "home" })}
          title="Back to home"
          aria-label="Back to home"
          className="rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="text-base font-semibold tracking-tight">Settings</h1>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-5 px-6 py-8">
          <Section title="Your AI, your choice" desc="MeetingAI stores your notes on this device. Choose where audio and AI processing happen.">
            <AIProviderSettings />
          </Section>
          <Section
            title="Languages"
            desc="Transcripts, the translated voice, and summaries use your language. The other speaker can be pinned or auto-detected live."
          >
            <LabeledSelect
              label="Your language"
              value={settings.userLanguage}
              onChange={(code) => settings.update({ userLanguage: code })}
            />
            <LabeledSelect
              label="Other speaker's language"
              value={settings.otherLanguage}
              onChange={(code) => settings.update({ otherLanguage: code })}
              allowAuto
            />
          </Section>

          {!isLocalAI(settings) && <Section
            title="Translated voice"
            desc="Auto matches the translated voice to the other speaker's gender (male speaker → male voice, female → female voice); or always use one."
          >
            <GenderSelector
              value={settings.voiceGenderMode}
              onChange={(mode) => settings.update({ voiceGenderMode: mode })}
              ariaLabel="Translated voice preference"
            />
            <Toggle
              checked={settings.translationEnabled}
              onChange={(v) => settings.update({ translationEnabled: v })}
              label="Live voice translation"
              desc="Speak the other side's words aloud in your language during meetings."
            />
            <Toggle
              checked={settings.duckingEnabled}
              onChange={(v) => settings.update({ duckingEnabled: v })}
              label="Duck original voice"
              desc="Lower the system volume while translated speech plays. This reduces — but doesn't fully remove — the original voice."
            />
          </Section>}

          {!isLocalAI(settings) && <Section
            title="Gemini API key"
            desc="Powers transcription, translation, and summaries. Stored only in your operating system's credential vault — never in files or logs."
          >
            {keyState === "unavailable" ? (
              <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400">
                {ADMIN_CONFIG.geminiApiKey
                  ? "A key pre-configured by your administrator is in use. Secure key storage is available in the desktop app."
                  : "Secure key storage is available in the desktop app."}
              </p>
            ) : (
              <>
                {keyState === "unset" && ADMIN_CONFIG.geminiApiKey && (
                  <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400">
                    A key is pre-configured by your administrator. Adding your own below overrides
                    it.
                  </p>
                )}
                {keyState === "set" && (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-300/70 bg-emerald-50 px-4 py-3 dark:border-emerald-500/30 dark:bg-emerald-500/10">
                    <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                      API key saved securely
                    </p>
                    <button
                      type="button"
                      onClick={() => void removeKey()}
                      disabled={keyBusy}
                      className="shrink-0 text-xs font-medium text-red-600 transition hover:underline disabled:opacity-60 dark:text-red-400"
                    >
                      Remove
                    </button>
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder={
                      keyState === "set" ? "Replace with a new key…" : "Paste your Gemini API key"
                    }
                    aria-label="Gemini API key"
                    autoComplete="off"
                    className={INPUT_CLASS}
                  />
                  <button
                    type="button"
                    onClick={() => void saveKey()}
                    disabled={keyBusy || newKey.trim().length === 0}
                    className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {keyBusy ? "Saving…" : "Save"}
                  </button>
                </div>
                {keyState === "checking" && (
                  <p className="text-xs text-neutral-400 dark:text-neutral-500">Checking Keychain…</p>
                )}
                {keyError && (
                  <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                    {keyError}
                  </p>
                )}
              </>
            )}
          </Section>}

          <Section
            title="Google Calendar"
            desc={
              ADMIN_CONFIG.googleClientId
                ? "Sign in for read-only calendar sync. Tokens live in the Keychain."
                : "Add your Google OAuth desktop client, then sign in for read-only calendar sync. Tokens live in the Keychain."
            }
          >
            {ADMIN_CONFIG.googleClientId && !settings.googleClientId.trim() ? (
              <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400">
                The Google connection is pre-configured by your administrator — just sign in below.
              </p>
            ) : (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">OAuth Client ID</span>
                  <input
                    value={settings.googleClientId}
                    onChange={(e) => settings.update({ googleClientId: e.target.value })}
                    placeholder="xxxxxxxx.apps.googleusercontent.com"
                    autoComplete="off"
                    className={INPUT_CLASS}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">OAuth Client Secret</span>
                  <input
                    type="password"
                    value={settings.googleClientSecret}
                    onChange={(e) => settings.update({ googleClientSecret: e.target.value })}
                    placeholder="GOCSPX-…"
                    autoComplete="off"
                    className={INPUT_CLASS}
                  />
                </label>
              </>
            )}

            {googleEmail ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-300/70 bg-emerald-50 px-4 py-3 dark:border-emerald-500/30 dark:bg-emerald-500/10">
                <p className="min-w-0 truncate text-sm font-medium text-emerald-800 dark:text-emerald-300">
                  Connected as {googleEmail}
                </p>
                <button
                  type="button"
                  onClick={() => void disconnectGoogle()}
                  className="shrink-0 text-xs font-medium text-red-600 transition hover:underline dark:text-red-400"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void connectGoogle()}
                disabled={googleBusy || resolveGoogleClient(settings).clientId.length === 0}
                className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                {googleBusy ? "Waiting for browser…" : "Sign in with Google"}
              </button>
            )}
            {googleError && (
              <div>
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {describeGoogleAuthError(googleError)}
                </p>
                <button
                  type="button"
                  onClick={copyGoogleError}
                  className="mt-1 text-[11px] font-medium text-neutral-500 underline-offset-2 transition hover:text-neutral-700 hover:underline dark:text-neutral-400 dark:hover:text-neutral-200"
                >
                  {googleErrorCopied ? "Copied" : "Copy error details"}
                </button>
              </div>
            )}
          </Section>

        </div>
      </main>
    </div>
  );
}
