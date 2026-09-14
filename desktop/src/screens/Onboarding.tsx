import { useState, type ReactNode } from "react";
import { useRouter } from "../App";
import { useSettings } from "../lib/settings";
import { safeInvoke } from "../lib/tauri";
import type { VoiceGenderMode } from "../lib/types";
import LanguageStep from "../components/Onboarding/LanguageStep";
import VoiceStep from "../components/Onboarding/VoiceStep";
import GoogleStep from "../components/Onboarding/GoogleStep";
import PermissionsStep from "../components/Onboarding/PermissionsStep";
import AIProviderSettings from "../components/AIProviderSettings";
import { isLocalAI } from "../lib/localAi";
import ApiKeyStep from "../components/Onboarding/ApiKeyStep";

const STEP_COUNT = 7;

function Feature({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <li className="flex items-start gap-3.5">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
        {icon}
      </span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          {desc}
        </span>
      </span>
    </li>
  );
}

function WelcomeStep() {
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.7 } as const;
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Welcome to <span className="text-indigo-600 dark:text-indigo-400">MeetingAI</span>
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
        Your meetings, transcribed live, translated into your language, and summarized the moment
        they end. A minute of setup and you&rsquo;re ready.
      </p>
      <ul className="mt-7 space-y-5">
        <Feature
          icon={
            <svg viewBox="0 0 24 24" {...stroke} className="h-5 w-5" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21m-3.5 0h7" strokeLinecap="round" />
            </svg>
          }
          title="Live transcription"
          desc="Separate microphone and call-audio transcripts, stored on your device."
        />
        <Feature
          icon={
            <svg viewBox="0 0 24 24" {...stroke} className="h-5 w-5" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M3.5 12h17M12 3.5c2.5 2.4 3.75 5.3 3.75 8.5S14.5 18.1 12 20.5c-2.5-2.4-3.75-5.3-3.75-8.5S9.5 5.9 12 3.5Z" />
            </svg>
          }
          title="Live voice translation"
          desc="Optional spoken translation with your Gemini key. Local mode offers text translation."
        />
        <Feature
          icon={
            <svg viewBox="0 0 24 24" {...stroke} className="h-5 w-5" aria-hidden="true">
              <path
                d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6-4.6-1.9 4.6-1.9L12 3.5ZM18.5 15l.95 2.3 2.3.95-2.3.95-.95 2.3-.95-2.3-2.3-.95 2.3-.95.95-2.3Z"
                strokeLinejoin="round"
              />
            </svg>
          }
          title="Summaries & action items"
          desc="A tidy recap with action points and key notes the moment you stop."
        />
        <Feature
          icon={
            <svg viewBox="0 0 24 24" {...stroke} className="h-5 w-5" aria-hidden="true">
              <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
              <path d="M3.5 9.5h17M8 2.75v4M16 2.75v4" strokeLinecap="round" />
            </svg>
          }
          title="Calendar aware"
          desc="See upcoming meetings and start recording with one click."
        />
      </ul>
    </div>
  );
}

export default function Onboarding() {
  const { navigate } = useRouter();
  const settings = useSettings();

  const [step, setStep] = useState(0);
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const next = () => setStep((s) => Math.min(s + 1, STEP_COUNT - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const finish = async (saveKey: boolean) => {
    setKeyError(null);
    const key = apiKey.trim();
    if (saveKey && key && !isLocalAI(settings)) {
      setSavingKey(true);
      try {
        await safeInvoke("keychain_set", { key: "gemini_api_key", value: key });
        settings.update({ hasUserGeminiKey: true });
      } catch (e) {
        setKeyError(e instanceof Error ? e.message : String(e));
        setSavingKey(false);
        return;
      }
      setSavingKey(false);
    }
    settings.update({ onboarded: true });
    navigate({ name: "home" });
  };

  let body: ReactNode;
  let primaryLabel = "Continue";
  let onPrimary: () => void = next;
  let primaryBusy = false;
  let onSkip: (() => void) | null = null;

  switch (step) {
    case 0:
      body = <WelcomeStep />;
      primaryLabel = "Get started";
      break;
    case 1:
      body = (
        <LanguageStep
          key="your-language"
          title="Your language"
          subtitle="Summaries and translations use this language. Speech recognition keeps the original words."
          value={settings.userLanguage}
          onChange={(code) => settings.update({ userLanguage: code })}
        />
      );
      break;
    case 2:
      body = (
        <LanguageStep
          key="other-language"
          title="Other speaker's language"
          subtitle="What will the person on the other side speak? Auto-detect handles it live if you're not sure."
          allowAuto
          value={settings.otherLanguage}
          onChange={(code) => settings.update({ otherLanguage: code })}
        />
      );
      break;
    case 3:
      body = (
        <VoiceStep
          value={settings.voiceGenderMode}
          onChange={(mode: VoiceGenderMode) => settings.update({ voiceGenderMode: mode })}
        />
      );
      break;
    case 4:
      body = <GoogleStep connectedEmail={googleEmail} onConnected={setGoogleEmail} />;
      primaryLabel = googleEmail ? "Continue" : "Skip for now";
      break;
    case 5:
      body = <PermissionsStep />;
      break;
    case 6:
      body = <div className="space-y-6"><AIProviderSettings />{!isLocalAI(settings) && <ApiKeyStep value={apiKey} onChange={setApiKey} error={keyError} />}</div>;
      primaryLabel = savingKey ? "Saving…" : "Finish setup";
      primaryBusy = savingKey || (!isLocalAI(settings) && apiKey.trim().length === 0);
      onPrimary = () => void finish(true);
      onSkip = () => void finish(false);
      break;
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-10">
      {/* Background flourish */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-indigo-500/10 blur-3xl dark:bg-indigo-500/15"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-48 right-[-10rem] h-96 w-96 rounded-full bg-violet-500/10 blur-3xl dark:bg-violet-500/10"
      />

      <div className="relative z-10 w-full max-w-xl">
        {/* Brand + progress */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                <path d="M4 12h2.5M17.5 12H20M8 7v10M12 4.5v15M16 8.5v7" strokeLinecap="round" />
              </svg>
            </span>
            <span className="text-sm font-semibold tracking-tight">MeetingAI</span>
          </div>
          <div className="flex items-center gap-1.5" role="group" aria-label={`Step ${step + 1} of ${STEP_COUNT}`}>
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Go to step ${i + 1}`}
                disabled={i >= step}
                onClick={() => setStep(i)}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === step
                    ? "w-6 bg-indigo-500"
                    : i < step
                      ? "w-1.5 cursor-pointer bg-indigo-400/70 hover:bg-indigo-500"
                      : "w-1.5 bg-neutral-300 dark:bg-neutral-700"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-neutral-200/80 bg-white/85 p-7 shadow-xl shadow-neutral-900/5 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/70 dark:shadow-black/30 sm:p-8">
          {body}

          {/* Footer */}
          <div className="mt-8 flex items-center justify-between">
            <button
              type="button"
              onClick={back}
              className={`rounded-lg px-3 py-2 text-sm font-medium text-neutral-500 transition hover:text-neutral-800 dark:hover:text-neutral-200 ${
                step === 0 ? "invisible" : ""
              }`}
            >
              Back
            </button>
            <div className="flex items-center gap-4">
              {onSkip && (
                <button
                  type="button"
                  onClick={onSkip}
                  className="text-sm font-medium text-neutral-500 transition hover:text-neutral-800 dark:hover:text-neutral-200"
                >
                  Skip for now
                </button>
              )}
              <button
                type="button"
                onClick={onPrimary}
                disabled={primaryBusy}
                className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {primaryLabel}
              </button>
            </div>
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-neutral-400 dark:text-neutral-500">
          Everything runs on your computer — transcripts stay local, secrets stay in its secure credential vault.
        </p>
      </div>
    </div>
  );
}
