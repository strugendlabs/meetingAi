import type { VoiceGenderMode } from "../../lib/types";

interface VoiceStepProps {
  value: VoiceGenderMode;
  onChange: (mode: VoiceGenderMode) => void;
}

const OPTIONS: { value: VoiceGenderMode; label: string; desc: string }[] = [
  {
    value: "auto",
    label: "Auto-match gender",
    desc: "Match the other speaker — a male speaker gets a male voice, a female speaker gets a female voice.",
  },
  {
    value: "male",
    label: "Always male",
    desc: "Always use the male voice (Charon), no matter who is speaking.",
  },
  {
    value: "female",
    label: "Always female",
    desc: "Always use the female voice (Kore), no matter who is speaking.",
  },
];

export default function VoiceStep({ value, onChange }: VoiceStepProps) {
  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">Translated voice</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        When MeetingAI speaks the live translation aloud, which voice should it use?
      </p>

      <p className="mt-5 text-sm font-medium">
        Should the translated voice match the other speaker&rsquo;s gender?
      </p>

      <div role="radiogroup" aria-label="Translated voice gender preference" className="mt-3 space-y-2.5">
        {OPTIONS.map((opt) => {
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.value)}
              className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition ${
                selected
                  ? "border-indigo-500/70 bg-indigo-50 dark:border-indigo-400/50 dark:bg-indigo-500/10"
                  : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition ${
                  selected
                    ? "border-indigo-500 bg-indigo-500"
                    : "border-neutral-300 dark:border-neutral-600"
                }`}
              >
                {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
              </span>
              <span>
                <span className="block text-sm font-medium">{opt.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  {opt.desc}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
        You can refine this at the start of every meeting with a quick
        &ldquo;Other speaker: Male / Female / Auto&rdquo; selector.
      </p>
    </div>
  );
}
