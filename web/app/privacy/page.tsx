import type { Metadata } from "next";
export const metadata: Metadata = { title: "Privacy", description: "MeetingAI data flows: local Whisper + Ollama, or Gemini using your own key." };
const sections = [
  { heading: "Your choice of inference", body: "MeetingAI has no account system, telemetry, or hosted inference backend. You choose local Whisper + Ollama or Google's Gemini API. Open source does not mean every mode is offline." },
  { heading: "Local mode", body: "Audio goes to a whisper.cpp server on this computer. Transcript text goes to a downloaded Ollama model for summaries and requested translations. Only loopback addresses are accepted; the client disables proxies and redirects and rejects cloud-backed Ollama models. Local failures never trigger Gemini requests. Download models first, disable Ollama cloud features, and leave Calendar disconnected for offline inference. Review your local servers' own logging and configuration." },
  { heading: "Gemini mode", body: "Audio goes directly to Google for recognition and optional spoken translation. Transcript text goes to Google for summaries and text translation, using your own Gemini key. Google's API terms, data handling settings, and billing apply. This is cloud processing. There is no MeetingAI service between your app and Google." },
  { heading: "Local storage", body: "Meetings, notes, summaries, and translations are stored in SQLite on your device, without application-level encryption. Device and disk protections apply. MeetingAI buffers audio in memory and does not save raw recordings. Local inference servers or your cloud provider may have their own retention behavior. Exports stay wherever you save them." },
  { heading: "Keys and deletion", body: "Gemini keys and Google OAuth tokens use the OS credential vault and are loaded into memory when needed. Preferences contain server/model settings and Google desktop OAuth client configuration. Builds exclude developer .env credentials. Deleting a meeting removes it from the app, but does not securely erase SQLite remnants, exports, backups, or provider-side records. Uninstalling does not automatically remove app data or credential-vault entries." },
  { heading: "Optional Calendar", body: "Connecting Google Calendar contacts Google even when local AI is selected. The app requests read-only calendar access and basic account profile information. Disconnect in Settings to remove stored connection tokens; access can also be revoked in your Google account." },
  { heading: "This website", body: "The included static site has no app-added analytics or trackers. Its hosting provider and GitHub may retain normal access logs when you visit or download files. External services have their own privacy policies." },
];
export default function PrivacyPage() {
  return <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
    <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">Privacy</p>
    <h1 className="mt-4 font-display text-4xl font-medium tracking-tight sm:text-5xl">Know where your meetings go.</h1>
    <p className="mt-4 text-xs text-inksoft">Updated 14 September 2026</p>
    <div className="mt-12 max-w-2xl space-y-10">{sections.map(s => <section key={s.heading}>
      <h2 className="text-lg font-semibold">{s.heading}</h2><p className="mt-3 text-[14.5px] leading-relaxed text-inksoft">{s.body}</p>
    </section>)}</div>
    <a href="https://github.com/strugendlabs/meetingAi/blob/main/PRIVACY.md" className="mt-10 inline-block text-sm text-accent underline underline-offset-4">Read the privacy document with the source</a>
  </div>;
}
