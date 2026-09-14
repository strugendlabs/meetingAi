// Meeting status chip: connecting / live / reconnecting / error / ended.
// Renders a colored pulse dot + label, with an optional truncated detail
// message (full text in the title attribute).

import type { MeetingStatus } from "../../lib/meetingSession";

/**
 * Model IDs from lower layers (connect/fallback errors mention them) must not
 * reach the UI — product copy never names models.
 */
export function sanitizeDetail(detail: string): string {
  return detail
    .replace(/\(?\bmodels?[ /=:]*gemini[\w.-]*\)?/gi, "")
    .replace(/\bgemini[\w.-]+/gi, "the AI engine")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export type StatusBarStatus = MeetingStatus | "ended";

const STYLES: Record<
  StatusBarStatus,
  { label: string; chip: string; dot: string; pulse: boolean }
> = {
  connecting: {
    label: "Connecting",
    chip: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
    dot: "bg-amber-500",
    pulse: true,
  },
  live: {
    label: "Live",
    chip: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
    dot: "bg-emerald-500",
    pulse: true,
  },
  degraded: {
    label: "Needs attention",
    chip: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
    dot: "bg-amber-500",
    pulse: false,
  },
  reconnecting: {
    label: "Reconnecting",
    chip: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
    dot: "bg-amber-500",
    pulse: true,
  },
  error: {
    label: "Issue",
    chip: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
    dot: "bg-red-500",
    pulse: false,
  },
  ended: {
    label: "Completed",
    chip: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
    dot: "bg-neutral-400 dark:bg-neutral-500",
    pulse: false,
  },
};

export interface StatusBarProps {
  status: StatusBarStatus;
  detail?: string | null;
}

export default function StatusBar({ status, detail }: StatusBarProps) {
  const s = STYLES[status];
  const cleanDetail = detail ? sanitizeDetail(detail) : null;
  return (
    <div className="flex min-w-0 items-center gap-2" role="status">
      <span
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${s.chip}`}
      >
        <span className="relative flex h-1.5 w-1.5">
          {s.pulse && (
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${s.dot}`}
            />
          )}
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${s.dot}`} />
        </span>
        {s.label}
      </span>
      {cleanDetail && (
        <span
          title={cleanDetail}
          className="hidden max-w-[16rem] truncate text-xs text-neutral-500 dark:text-neutral-400 lg:inline"
        >
          {cleanDetail}
        </span>
      )}
    </div>
  );
}
