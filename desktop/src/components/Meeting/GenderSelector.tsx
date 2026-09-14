// Per-meeting "other speaker" gender refinement (spec §2.1 step 4).
// A compact segmented control: Auto / Male / Female. Also reused in Settings
// for the default translated-voice preference.

import type { VoiceGenderMode } from "../../lib/types";

const OPTIONS: ReadonlyArray<{ value: VoiceGenderMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
];

export interface GenderSelectorProps {
  value: VoiceGenderMode;
  onChange: (mode: VoiceGenderMode) => void;
  disabled?: boolean;
  /** Accessible name for the group. */
  ariaLabel?: string;
}

export default function GenderSelector({
  value,
  onChange,
  disabled = false,
  ariaLabel = "Other speaker's voice",
}: GenderSelectorProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      {OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
              selected
                ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-600 dark:text-white"
                : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
            } ${disabled ? "cursor-not-allowed" : ""}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
