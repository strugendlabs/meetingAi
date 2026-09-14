import Link from "next/link";
import TranscriptDemo from "@/components/TranscriptDemo";

export default function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-5 pt-16 pb-20 sm:px-8 sm:pt-24 sm:pb-28">
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-accent">
            Open source · MIT licensed · Your choice of AI
          </p>
          <h1 className="mt-5 font-display text-[2.6rem] leading-[1.06] font-medium tracking-tight text-balance sm:text-6xl">
            Your meetings.{" "}
            <span className="translated font-normal">Your models.</span>
          </h1>
          <p className="mt-6 max-w-md text-[16.5px] leading-relaxed text-inksoft">
            Meeting notes that stay in your hands. Capture both sides of a call,
            get a readable transcript, and leave with clear next steps.
            Bring your own Gemini key, or keep inference on your Mac with
            Whisper and Ollama.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href="https://github.com/strugendlabs/meetingAi"
              className="rounded-full bg-accent px-6 py-3 text-[15px] font-medium text-paper transition-colors hover:bg-accentstrong"
            >
              Get the source on GitHub
            </Link>
            <Link
              href="/#providers"
              className="rounded-full border border-line bg-raised px-6 py-3 text-[15px] font-medium text-ink transition-colors hover:border-inksoft/50"
            >
              See how it works
            </Link>
          </div>
          <p className="mt-7 font-mono text-[11px] tracking-wide text-inksoft/80">
            Apple Silicon preview · no MeetingAI account · no subscription
          </p>
        </div>

        <TranscriptDemo />
      </div>
    </section>
  );
}
