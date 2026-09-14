// Google Calendar sidebar (spec §2.4): upcoming events from the primary
// calendar, join links, and one-click "record this meeting".
//
// Token flow: stored tokens live in the Keychain under `google_tokens`
// ({access_token, refresh_token, expires_at, email} — see oauth.rs). Expired
// tokens refresh via the `google_oauth_refresh` command, which rewrites the
// Keychain entry. Outside Tauri every invoke no-ops via safeInvoke, so the
// sidebar gracefully lands in the "not connected" state.

import { useCallback, useEffect, useState } from "react";
import { resolveGoogleClient } from "../../lib/adminConfig";
import { listUpcomingEvents, type CalendarEvent } from "../../lib/calendar";
import { describeGoogleAuthError } from "../../lib/googleAuthErrors";
import { useSettings } from "../../lib/settings";
import { isTauri, safeInvoke } from "../../lib/tauri";

interface StoredGoogleTokens {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
  email: string;
}

type SidebarState =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "disconnected" }
  | { kind: "error"; message: string }
  | { kind: "ready"; events: CalendarEvent[]; email: string };

export interface CalendarSidebarProps {
  /** Start recording a meeting for this calendar event. */
  onRecord: (title: string, calendarEventId: string) => void;
  onOpenSettings?: () => void;
}

const EXPIRY_MARGIN_MS = 60_000;

async function openLink(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

function isAllDay(start: string): boolean {
  return start.length > 0 && !start.includes("T");
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayLabel(start: string): string {
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return "Upcoming";
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, tomorrow)) return "Tomorrow";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function timeLabel(ev: CalendarEvent): string {
  if (isAllDay(ev.start)) return "All day";
  const d = new Date(ev.start);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function CalendarIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.5h17M8 2.75v4M16 2.75v4" strokeLinecap="round" />
    </svg>
  );
}

function VideoIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="6.5" width="13" height="11" rx="2.5" />
      <path d="M16 10.5l5-2.5v8l-5-2.5" strokeLinejoin="round" />
    </svg>
  );
}

function RecordIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </svg>
  );
}

function Placeholder({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center dark:border-neutral-700">
      <CalendarIcon className="h-7 w-7 text-neutral-300 dark:text-neutral-600" />
      <div>
        <p className="text-sm font-medium text-neutral-600 dark:text-neutral-300">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
          {body}
        </p>
      </div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-1 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium transition hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export default function CalendarSidebar({ onRecord, onOpenSettings }: CalendarSidebarProps) {
  const settingsClientId = useSettings((s) => s.googleClientId);
  const settingsClientSecret = useSettings((s) => s.googleClientSecret);
  const { clientId, clientSecret } = resolveGoogleClient({
    googleClientId: settingsClientId,
    googleClientSecret: settingsClientSecret,
  });
  const [state, setState] = useState<SidebarState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const raw = await safeInvoke<string | null>("keychain_get", {
        key: "google_tokens",
      });
      if (!raw) {
        setState(clientId ? { kind: "disconnected" } : { kind: "unconfigured" });
        return;
      }
      let tokens = JSON.parse(raw) as StoredGoogleTokens;
      const refresh = async (): Promise<string> => {
        const json = await safeInvoke<string>("google_oauth_refresh", {
          clientId,
          clientSecret,
          refreshToken: tokens.refresh_token,
        });
        if (!json) throw new Error("token refresh unavailable");
        tokens = JSON.parse(json) as StoredGoogleTokens;
        return tokens.access_token;
      };
      let accessToken = tokens.access_token;
      if (tokens.expires_at * 1000 < Date.now() + EXPIRY_MARGIN_MS) {
        accessToken = await refresh();
      }
      const events = await listUpcomingEvents(accessToken, 12, refresh);
      setState({ kind: "ready", events, email: tokens.email });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [clientId, clientSecret]);

  useEffect(() => {
    void load();
  }, [load]);

  // Group consecutive events under day labels (events arrive time-sorted).
  const groups: Array<{ label: string; events: CalendarEvent[] }> = [];
  if (state.kind === "ready") {
    for (const ev of state.events) {
      const label = dayLabel(ev.start);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.events.push(ev);
      else groups.push({ label, events: [ev] });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          Calendar
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          title="Refresh calendar"
          aria-label="Refresh calendar"
          className="rounded-md p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            className={`h-4 w-4 ${state.kind === "loading" ? "animate-spin" : ""}`}
            aria-hidden="true"
          >
            <path
              d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 3.5v3.8h-3.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {state.kind === "loading" && (
          <div className="space-y-2.5 pt-1">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-xl bg-neutral-100 dark:bg-neutral-800/70"
              />
            ))}
          </div>
        )}

        {state.kind === "unconfigured" && (
          <Placeholder
            title="Calendar isn't set up"
            body="Add your Google OAuth client in Settings to see upcoming meetings here."
            action={
              onOpenSettings ? { label: "Open Settings", onClick: onOpenSettings } : undefined
            }
          />
        )}

        {state.kind === "disconnected" && (
          <Placeholder
            title="Google not connected"
            body="Sign in with Google in Settings to sync your upcoming meetings."
            action={
              onOpenSettings ? { label: "Open Settings", onClick: onOpenSettings } : undefined
            }
          />
        )}

        {state.kind === "error" && (
          <Placeholder
            title="Couldn't load calendar"
            body={describeGoogleAuthError(state.message)}
            action={{ label: "Try again", onClick: () => void load() }}
          />
        )}

        {state.kind === "ready" && state.events.length === 0 && (
          <Placeholder
            title="Nothing coming up"
            body="Upcoming events from your primary calendar will show here."
          />
        )}

        {state.kind === "ready" &&
          groups.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                {group.label}
              </p>
              <ul className="space-y-1.5">
                {group.events.map((ev) => (
                  <li
                    key={ev.id}
                    className="group rounded-xl border border-neutral-200/80 bg-white px-3 py-2.5 transition hover:border-indigo-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-indigo-500/40"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium" title={ev.title}>
                          {ev.title}
                        </p>
                        <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
                          {timeLabel(ev)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {ev.meetLink && (
                          <button
                            type="button"
                            title="Open meeting link"
                            aria-label={`Open meeting link for ${ev.title}`}
                            onClick={() => void openLink(ev.meetLink as string)}
                            className="rounded-md p-1.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                          >
                            <VideoIcon className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          title="Record this meeting"
                          aria-label={`Record ${ev.title}`}
                          onClick={() => onRecord(ev.title, ev.id)}
                          className="rounded-md p-1.5 text-neutral-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                        >
                          <RecordIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>

      {state.kind === "ready" && (
        <p className="shrink-0 border-t border-neutral-200/80 px-4 py-2.5 text-[11px] text-neutral-400 dark:border-neutral-800 dark:text-neutral-500">
          Connected as <span className="font-medium">{state.email || "Google"}</span>
        </p>
      )}
    </div>
  );
}
