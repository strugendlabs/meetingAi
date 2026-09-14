import { useCallback, useState } from "react";
import { resolveGoogleClient } from "../../lib/adminConfig";
import { describeGoogleAuthError } from "../../lib/googleAuthErrors";
import { useSettings } from "../../lib/settings";
import { isTauri, safeInvoke } from "../../lib/tauri";

interface GoogleStepProps {
  connectedEmail: string | null;
  onConnected: (email: string) => void;
}

function CalendarIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className} aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.5h17M8 2.75v4M16 2.75v4" strokeLinecap="round" />
      <path d="M7.5 13.5h3m3 0h3m-9 3.5h3m3 0h3" strokeLinecap="round" />
    </svg>
  );
}

export default function GoogleStep({ connectedEmail, onConnected }: GoogleStepProps) {
  const settingsClientId = useSettings((s) => s.googleClientId);
  const settingsClientSecret = useSettings((s) => s.googleClientSecret);
  const { clientId, clientSecret } = resolveGoogleClient({
    googleClientId: settingsClientId,
    googleClientSecret: settingsClientSecret,
  });
  const configured = clientId.length > 0;

  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyError = useCallback(() => {
    if (!error) return;
    void navigator.clipboard?.writeText(error).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [error]);

  const connect = async () => {
    setError(null);
    if (!isTauri()) {
      setError("Google sign-in opens your browser and is only available in the desktop app.");
      return;
    }
    setConnecting(true);
    try {
      const raw = await safeInvoke<string>("google_oauth_start", { clientId, clientSecret });
      let email = "your Google account";
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { email?: string };
          if (parsed.email) email = parsed.email;
        } catch {
          // Non-JSON response — keep the generic label.
        }
      }
      onConnected(email);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">Google Calendar</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Sign in to see your upcoming meetings on the home screen and auto-title recordings from
        the calendar event.
      </p>

      {connectedEmail ? (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-emerald-300/70 bg-emerald-50 px-4 py-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
              clipRule="evenodd"
            />
          </svg>
          <div>
            <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
              Connected as {connectedEmail}
            </p>
            <p className="mt-0.5 text-xs text-emerald-700/80 dark:text-emerald-400/80">
              Your upcoming meetings will appear on the home screen.
            </p>
          </div>
        </div>
      ) : configured ? (
        <div className="mt-6">
          <button
            type="button"
            onClick={connect}
            disabled={connecting}
            className="inline-flex items-center gap-2.5 rounded-xl border border-neutral-300 bg-white px-5 py-2.5 text-sm font-medium shadow-sm transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.87c2.27-2.09 3.58-5.17 3.58-8.81Z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3a7.24 7.24 0 0 1-10.8-3.8H1.28v3.09A12 12 0 0 0 12 24Z"
              />
              <path
                fill="#FBBC05"
                d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.28a12.02 12.02 0 0 0 0 10.74l3.99-3.09Z"
              />
              <path
                fill="#EA4335"
                d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.43-3.44A11.53 11.53 0 0 0 12 0 12 12 0 0 0 1.28 6.63l3.99 3.09A7.17 7.17 0 0 1 12 4.77Z"
              />
            </svg>
            {connecting ? "Waiting for browser…" : "Sign in with Google"}
          </button>
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
            A browser window will open to sign in. Read-only calendar access; tokens stay in your
            operating system&rsquo;s credential vault.
          </p>
        </div>
      ) : (
        <div className="mt-6 flex items-start gap-3.5 rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-4 dark:border-amber-500/30 dark:bg-amber-500/10">
          <CalendarIcon className="mt-0.5 h-6 w-6 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              Google sign-in isn&rsquo;t configured yet
            </p>
            <p className="mt-1 text-xs leading-relaxed text-amber-700/90 dark:text-amber-400/80">
              Calendar sync needs a Google OAuth Client ID. Add yours any time in Settings &rarr;
              Google — everything else works without it. Skip this step for now.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {describeGoogleAuthError(error)}
          </p>
          <button
            type="button"
            onClick={copyError}
            className="mt-1.5 text-xs font-medium text-neutral-500 underline-offset-2 transition hover:text-neutral-700 hover:underline dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            {copied ? "Copied" : "Copy error details"}
          </button>
        </div>
      )}
    </div>
  );
}
