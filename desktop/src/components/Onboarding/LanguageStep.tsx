import { useMemo, useState } from "react";
import { searchLanguages } from "../../lib/languages";

interface LanguageStepProps {
  title: string;
  subtitle: string;
  /** Selected BCP-47 code, or "auto" when `allowAuto`. */
  value: string;
  onChange: (code: string) => void;
  /** Show a pinned "Auto-detect" option above the search box. */
  allowAuto?: boolean;
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M16.704 5.29a1 1 0 0 1 .006 1.414l-7.2 7.3a1 1 0 0 1-1.42.004L3.29 9.2a1 1 0 1 1 1.42-1.408l2.087 2.104 6.493-6.585a1 1 0 0 1 1.414-.02Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default function LanguageStep({ title, subtitle, value, onChange, allowAuto = false }: LanguageStepProps) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchLanguages(query), [query]);

  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{subtitle}</p>

      {allowAuto && (
        <button
          type="button"
          onClick={() => onChange("auto")}
          className={`mt-5 flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition ${
            value === "auto"
              ? "border-indigo-500/70 bg-indigo-50 dark:border-indigo-400/50 dark:bg-indigo-500/10"
              : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
          }`}
        >
          <span>
            <span className="block text-sm font-medium">Auto-detect</span>
            <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
              Let Gemini detect the language live as they speak — recommended
            </span>
          </span>
          {value === "auto" && <CheckIcon />}
        </button>
      )}

      <div className="relative mt-4">
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
            clipRule="evenodd"
          />
        </svg>
        <input
          type="text"
          id="language-search"
          name="language-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={allowAuto ? "Or search to pin a language…" : "Search languages…"}
          aria-label="Search languages"
          className="w-full rounded-xl border border-neutral-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/30 dark:border-neutral-800 dark:bg-neutral-900 dark:focus:border-indigo-500/60"
        />
      </div>

      <ul className="mt-3 max-h-60 divide-y divide-neutral-100 overflow-y-auto rounded-xl border border-neutral-200 [color-scheme:light] dark:divide-neutral-800/70 dark:border-neutral-800 dark:[color-scheme:dark]">
        {results.map((l) => {
          const selected = value === l.code;
          return (
            <li key={l.code}>
              <button
                type="button"
                onClick={() => onChange(l.code)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition ${
                  selected
                    ? "bg-indigo-50 dark:bg-indigo-500/10"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                }`}
              >
                <span className="min-w-0">
                  <span className="font-medium">{l.nativeName}</span>
                  {l.name !== l.nativeName && (
                    <span className="ml-2 text-neutral-500 dark:text-neutral-400">{l.name}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                    {l.code}
                  </span>
                  {selected && <CheckIcon />}
                </span>
              </button>
            </li>
          );
        })}
        {results.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
            No languages match &ldquo;{query}&rdquo;
          </li>
        )}
      </ul>
    </div>
  );
}
