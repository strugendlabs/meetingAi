import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Get the MIT-licensed MeetingAI source. Use Gemini BYOK or local Whisper + Ollama.",
};

const macInstallSteps = [
  {
    title: "Open the .dmg and drag MeetingAI to Applications",
    copy: "Open MeetingAI from Applications after copying it. macOS may show a normal first-open confirmation.",
  },
  {
    title: "Allow microphone access",
    copy: "This is how MeetingAI hears your side of the call.",
  },
  {
    title: "Allow Screen & System Audio Recording",
    copy: "macOS gates system-audio capture behind the Screen Recording permission — it's how MeetingAI hears the other side. Your screen itself is never captured or stored.",
  },
  {
    title: "Choose your AI provider",
    copy: "Enter a Gemini key stored in Keychain, or connect local Whisper and Ollama servers in Settings.",
  },
];

const windowsInstallSteps = [
  {
    title: "Open the signed setup file",
    copy: "The installer and every executable are Authenticode-signed and verified during the release build.",
  },
  {
    title: "Allow microphone access",
    copy: "Windows uses this permission only to hear your side of the call.",
  },
  {
    title: "Check system audio",
    copy: "MeetingAI uses Windows WASAPI loopback to hear the other side without joining the call.",
  },
  {
    title: "Choose your AI provider",
    copy: "Enter a Gemini key stored in Credential Manager, or configure local Whisper and Ollama.",
  },
];

interface ReleaseCardProps {
  platform: string;
  architecture: string;
  href?: string;
  checksumHref?: string;
  buttonLabel: string;
  version: string;
  size?: string;
  requirements: string[];
  unavailableCopy: string;
}

function ReleaseCard({
  platform,
  architecture,
  href,
  checksumHref,
  buttonLabel,
  version,
  size,
  requirements,
  unavailableCopy,
}: ReleaseCardProps) {
  return (
    <div className="rounded-2xl border border-line bg-raised p-8">
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-inksoft/75">
        {platform}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        {href ? (
          <a
            href={href}
            className="rounded-full bg-accent px-7 py-3 text-[15px] font-medium text-paper transition-colors hover:bg-accentstrong"
          >
            {buttonLabel}
          </a>
        ) : (
          <span
            aria-disabled="true"
            className="cursor-not-allowed rounded-full bg-accent px-7 py-3 text-[15px] font-medium text-paper opacity-55"
          >
            Download unavailable
          </span>
        )}
        <span className="font-mono text-[11px] tracking-wide text-inksoft">
          v{version} · {architecture}
          {size ? ` · ${size}` : ""}
        </span>
      </div>
      <p className="mt-5 text-[13.5px] leading-relaxed text-inksoft">
        {href ? "This release is ready to install." : unavailableCopy}
      </p>
      {href && checksumHref && <a href={checksumHref} className="mt-3 inline-block text-xs text-accent underline underline-offset-4">Verify download · SHA-256 checksum</a>}
      <div className="mt-8 border-t border-line pt-6">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-inksoft/75">
          Requirements
        </p>
        <ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-inksoft">
          {requirements.map((requirement) => (
            <li key={requirement}>{requirement}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SetupCard({
  platform,
  steps,
}: {
  platform: string;
  steps: typeof macInstallSteps;
}) {
  return (
    <div className="rounded-2xl border border-line bg-raised p-8">
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-inksoft/75">
        {platform} setup
      </p>
      <ol className="mt-4 space-y-5">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-4">
            <span className="translated text-lg leading-6">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div>
              <p className="text-[14.5px] font-medium tracking-tight">{step.title}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-inksoft">{step.copy}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function DownloadPage() {
  const configuredMacUrl = process.env.NEXT_PUBLIC_DOWNLOAD_URL?.trim();
  const macDownloadUrl = process.env.NEXT_PUBLIC_MAC_NOTARIZED === "true" && configuredMacUrl?.startsWith("https://") ? configuredMacUrl : undefined;
  const macChecksumUrl = process.env.NEXT_PUBLIC_MAC_CHECKSUM_URL?.trim();
  const windowsDownloadUrl = process.env.NEXT_PUBLIC_WINDOWS_DOWNLOAD_URL?.trim();
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "0.1.0";
  const macDownloadSize = process.env.NEXT_PUBLIC_DOWNLOAD_SIZE?.trim();
  const windowsDownloadSize = process.env.NEXT_PUBLIC_WINDOWS_DOWNLOAD_SIZE?.trim();

  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
      <div className="max-w-2xl">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-accent">
          Download
        </p>
        <h1 className="mt-4 font-display text-4xl font-medium tracking-tight text-balance sm:text-5xl">
          MeetingAI for desktop
        </h1>
        <p className="mt-5 text-[16px] leading-relaxed text-inksoft">
          Start with the MIT-licensed source preview. Choose Gemini with your
          own API key, or local speech recognition and summaries with Whisper
          and Ollama. No MeetingAI account required.
        </p>
      </div>

      <div className="mt-8 rounded-2xl border border-accent/40 bg-wash p-7">
        <h2 className="text-lg font-semibold">Build it. Inspect it. Make it yours.</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-inksoft">The source and setup instructions are on GitHub. Apple Silicon is the tested platform. Installable releases will appear below when they have been signed and verified.</p>
        <a href="https://github.com/triyam/meetingAi" className="mt-5 inline-block rounded-full bg-accent px-6 py-3 text-sm font-medium text-paper">Get the source on GitHub</a>
      </div>
      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        <ReleaseCard
          platform="macOS"
          architecture="Apple Silicon"
          href={macDownloadUrl}
          checksumHref={macChecksumUrl?.startsWith("https://") ? macChecksumUrl : undefined}
          buttonLabel="Download .dmg"
          version={appVersion}
          size={macDownloadSize}
          requirements={["macOS 13 Ventura or later", "Apple Silicon (M1 or newer)"]}
          unavailableCopy="The Mac download is being prepared. It will be available here after Apple signing and notarization are complete."
        />
        <ReleaseCard
          platform="Windows"
          architecture="x64"
          href={windowsDownloadUrl}
          buttonLabel="Download setup .exe"
          version={appVersion}
          size={windowsDownloadSize}
          requirements={["Windows 11", "64-bit Intel or AMD processor"]}
          unavailableCopy="A trusted Authenticode-signed Windows release has not been attached yet."
        />
      </div>

      <p className="mt-6 text-[13.5px] leading-relaxed text-inksoft">
        For Gemini mode, bring your own API key —{" "}
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noreferrer"
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          create one in Google AI Studio
        </a>
        . Google bills API usage to your project. Local Whisper + Ollama mode needs no key. Optional Calendar sync requires your Google OAuth desktop client.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SetupCard platform="macOS" steps={macInstallSteps} />
        <SetupCard platform="Windows" steps={windowsInstallSteps} />
      </div>

      <div className="mt-8 rounded-2xl border border-line p-6">
        <h2 className="text-base font-medium">First meeting check</h2>
        <p className="mt-2 text-sm leading-relaxed text-inksoft">Start a short test meeting. Speak and check the microphone meter, then play call audio and check the second meter. If one stays quiet, check the selected microphone or macOS recording permissions and use Retry audio. Headphones help keep the two speakers separate.</p>
        <p className="mt-3 text-sm leading-relaxed text-inksoft">A public Mac release is signed and notarized. You should never need to disable Gatekeeper to install it. Normal first-open and audio permission prompts can still appear.</p>
      </div>

      <p className="mt-10 max-w-2xl text-[13.5px] leading-relaxed text-inksoft">
        In local mode, audio and text go to servers on your computer. Gemini
        mode sends them directly to Google using your key.{" "}
        <Link
          href="/privacy"
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          The full privacy note
        </Link>{" "}
        is a two-minute read.
      </p>
    </div>
  );
}
