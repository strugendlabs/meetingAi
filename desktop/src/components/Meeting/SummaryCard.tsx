// AI summary card: summary paragraph, action-items checklist, key notes, and
// an optional regenerate action. Rendered in the meeting view once the
// meeting has been stopped and summarized.
//
// The checked state is controlled from outside (MeetingView owns and
// persists it) so it survives closing and reopening a meeting — this
// component only renders it and reports toggles.

import type { MeetingSummary } from "../../lib/types";

export interface SummaryCardProps {
  summary: MeetingSummary;
  completedIndices: ReadonlySet<number>;
  onToggle: (index: number) => void;
  onRegenerate?: () => void;
  regenerating?: boolean;
}

function SparkleIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6-4.6-1.9 4.6-1.9L12 3.5ZM18.5 15l.95 2.3 2.3.95-2.3.95-.95 2.3-.95-2.3-2.3-.95 2.3-.95.95-2.3Z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
      {children}
    </h3>
  );
}

export default function SummaryCard({
  summary,
  completedIndices,
  onToggle,
  onRegenerate,
  regenerating = false,
}: SummaryCardProps) {
  return (
    <section
      aria-label="AI summary"
      className="rounded-2xl border border-indigo-200/70 bg-indigo-50/50 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/[.07]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SparkleIcon className="h-4 w-4 text-indigo-500 dark:text-indigo-400" />
          <h2 className="text-sm font-semibold tracking-tight">AI summary</h2>
        </div>
        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating}
            className="rounded-md px-2 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60 dark:text-indigo-400 dark:hover:bg-indigo-500/15"
          >
            {regenerating ? "Regenerating…" : "Regenerate"}
          </button>
        )}
      </div>

      <p className="mt-3 text-sm leading-relaxed text-neutral-700 dark:text-neutral-200">
        {summary.summary}
      </p>

      {summary.actionItems.length > 0 && (
        <div className="mt-4">
          <SectionTitle>Action items</SectionTitle>
          <ul className="mt-2 space-y-1.5">
            {summary.actionItems.map((item, i) => {
              const done = completedIndices.has(i);
              return (
                <li key={i}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={done}
                    onClick={() => onToggle(i)}
                    className="group flex w-full items-start gap-2.5 rounded-lg px-1.5 py-1 text-left transition hover:bg-indigo-100/60 dark:hover:bg-indigo-500/10"
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                        done
                          ? "border-indigo-600 bg-indigo-600 text-white"
                          : "border-neutral-300 bg-white text-transparent dark:border-neutral-600 dark:bg-neutral-900"
                      }`}
                    >
                      <svg
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="h-2.5 w-2.5"
                        aria-hidden="true"
                      >
                        <path d="M2.5 6.5l2.25 2.25L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span
                      className={`text-sm leading-snug ${
                        done
                          ? "text-neutral-400 line-through dark:text-neutral-500"
                          : "text-neutral-700 dark:text-neutral-200"
                      }`}
                    >
                      {item}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {summary.keyNotes.length > 0 && (
        <div className="mt-4">
          <SectionTitle>Key notes</SectionTitle>
          <ul className="mt-2 space-y-1.5">
            {summary.keyNotes.map((note, i) => (
              <li key={i} className="flex items-start gap-2.5 px-1.5">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400 dark:bg-indigo-500" />
                <span className="text-sm leading-snug text-neutral-700 dark:text-neutral-200">
                  {note}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
