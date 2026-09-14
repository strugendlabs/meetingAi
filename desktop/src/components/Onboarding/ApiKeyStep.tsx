import { useState } from "react";
import { ADMIN_CONFIG } from "../../lib/adminConfig";

interface ApiKeyStepProps {
  value: string;
  onChange: (value: string) => void;
  /** Error from the save attempt (shown inline), if any. */
  error: string | null;
}

export default function ApiKeyStep({ value, onChange, error }: ApiKeyStepProps) {
  const [show, setShow] = useState(false);

  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">Gemini API key</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        MeetingAI talks to Gemini directly with your own key — no middleman servers. The key is
        stored in your operating system&rsquo;s credential vault, never in files or logs.
      </p>

      {ADMIN_CONFIG.geminiApiKey && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-emerald-300/70 bg-emerald-50 px-4 py-3.5 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
              clipRule="evenodd"
            />
          </svg>
          <p className="text-sm text-emerald-800 dark:text-emerald-300">
            A key is already set up by your administrator — you can skip this step. Adding your
            own key below overrides it.
          </p>
        </div>
      )}

      <label htmlFor="gemini-api-key" className="mt-6 block text-sm font-medium">
        API key
      </label>
      <div className="relative mt-1.5">
        <input
          id="gemini-api-key"
          name="gemini-api-key"
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="AIza…"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-xl border border-neutral-200 bg-white py-2.5 pl-3 pr-16 font-mono text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/30 dark:border-neutral-800 dark:bg-neutral-900 dark:focus:border-indigo-500/60"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-medium text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>

      <p className="mt-2.5 text-xs text-neutral-500 dark:text-neutral-400">
        Get a free key at{" "}
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
        >
          Google AI Studio
        </a>
        .
      </p>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">
          Couldn&rsquo;t save the key: {error}
        </p>
      )}

      {ADMIN_CONFIG.geminiApiKey ? (
        <div className="mt-5 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-relaxed text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400">
          Skipping keeps the administrator&rsquo;s key in use; you can add your own key later in
          Settings to override it.
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-700/90 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400/90">
          Skipping this leaves transcription, translation and summaries disabled until you add a
          key in Settings.
        </div>
      )}
    </div>
  );
}
