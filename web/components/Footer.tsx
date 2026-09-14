import Link from "next/link";
import { Wordmark } from "@/components/Nav";

export default function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="flex flex-col justify-between gap-10 sm:flex-row">
          <div className="max-w-xs">
            <Wordmark />
            <p className="mt-3 text-[13.5px] leading-relaxed text-inksoft">
              Open-source meeting notes. Local storage, your choice of AI,
              and a transcript you can take with you.
            </p>
          </div>

          <div className="flex gap-16">
            <div>
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-inksoft/70">
                Product
              </p>
              <ul className="mt-3 space-y-2 text-[13.5px]">
                <li>
                  <Link href="/download" className="text-inksoft transition-colors hover:text-ink">
                    Download
                  </Link>
                </li>
                <li>
                  <Link href="/#features" className="text-inksoft transition-colors hover:text-ink">
                    Features
                  </Link>
                </li>
                <li>
                  <Link href="/#faq" className="text-inksoft transition-colors hover:text-ink">
                    FAQ
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-inksoft/70">
                Legal
              </p>
              <ul className="mt-3 space-y-2 text-[13.5px]">
                <li><a href="https://github.com/strugendlabs/meetingAi" className="text-inksoft hover:text-ink">Source · MIT</a></li>
                <li>
                  <Link href="/privacy" className="text-inksoft transition-colors hover:text-ink">
                    Privacy
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-2 border-t border-line pt-6 font-mono text-[11px] tracking-wide text-inksoft/70 sm:flex-row sm:justify-between">
          <span>© 2026 MeetingAI · MIT licensed</span>
          <span>Gemini BYOK · local Whisper + Ollama</span>
        </div>
      </div>
    </footer>
  );
}
