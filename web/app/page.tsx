import Link from "next/link";
import Hero from "@/components/Hero";
import FeatureGrid from "@/components/FeatureGrid";
import Faq from "@/components/Faq";

function Providers() {
  return <section id="providers" className="scroll-mt-20 border-t border-line">
    <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-accent">You decide where AI runs</p>
      <h2 className="mt-4 max-w-2xl font-display text-3xl font-medium tracking-tight sm:text-4xl">Keep it local. Or bring your own key.</h2>
      <div className="mt-10 grid gap-6 md:grid-cols-2">
        <article className="rounded-2xl border border-accent/40 bg-wash p-7 sm:p-9">
          <p className="font-mono text-[11px] uppercase tracking-widest text-accent">On your computer</p>
          <h3 className="mt-4 text-2xl font-semibold tracking-tight">Whisper + Ollama</h3>
          <p className="mt-4 text-[15px] leading-relaxed text-inksoft">Whisper transcribes the audio. Your downloaded Ollama model writes the summary and translates text. MeetingAI accepts local servers only and never falls back to the cloud.</p>
          <p className="mt-6 rounded-lg border border-accent/20 bg-paper px-4 py-3 font-mono text-xs leading-relaxed">Audio → local Whisper → local Ollama → your notes</p>
          <p className="mt-5 text-sm leading-relaxed text-inksoft">Two local servers to set up. No API key. Download models first; keep optional Calendar disconnected for offline use.</p>
          <a href="https://github.com/strugendlabs/meetingAi/blob/main/docs/LOCAL-AI.md" className="mt-6 inline-block text-sm font-medium text-accent underline underline-offset-4">Set up local AI</a>
        </article>
        <article className="rounded-2xl border border-line bg-raised p-7 sm:p-9">
          <p className="font-mono text-[11px] uppercase tracking-widest text-inksoft">Your Google account</p>
          <h3 className="mt-4 text-2xl font-semibold tracking-tight">Gemini · BYOK</h3>
          <p className="mt-4 text-[15px] leading-relaxed text-inksoft">Use your own Gemini API key for live recognition, summaries, and translation. Optional spoken translation reads the other side in your language. Requests go directly to Google.</p>
          <p className="mt-6 rounded-lg border border-line bg-paper px-4 py-3 font-mono text-xs leading-relaxed">Audio + text → Google Gemini → your notes</p>
          <p className="mt-5 text-sm leading-relaxed text-inksoft">Your key lives in the OS credential vault. Google handles inference and bills your API usage. This mode uses the cloud.</p>
          <Link href="/privacy" className="mt-6 inline-block text-sm font-medium text-accent underline underline-offset-4">Read the data flows</Link>
        </article>
      </div>
    </div>
  </section>;
}
const steps = [
  { title: "Choose your provider", copy: "Connect local Whisper and Ollama, or enter your Gemini key. Check both audio meters before the first call." },
  { title: "Follow the conversation", copy: "Capture your microphone and call audio. Read timestamped turns and add your own notes alongside them." },
  { title: "Take the record with you", copy: "Review the summary and action items. Export your transcript and notes as PDF, Word, or Markdown." },
];
export default function Home() {
  return <>
    <Hero /><Providers /><FeatureGrid />
    <section id="how-it-works" className="scroll-mt-20 border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">From call to useful notes</p>
        <div className="mt-10 grid gap-10 sm:grid-cols-3">{steps.map((step, i) => <div key={step.title} className="border-t border-line pt-6">
          <p className="translated text-2xl">0{i + 1}</p><h2 className="mt-3 text-lg font-semibold">{step.title}</h2>
          <p className="mt-3 text-sm leading-relaxed text-inksoft">{step.copy}</p>
        </div>)}</div>
      </div>
    </section>
    <Faq />
    <section className="border-t border-line px-5 py-20 sm:px-8">
      <div className="mx-auto max-w-6xl rounded-3xl bg-wash px-6 py-14 text-center">
        <h2 className="font-display text-4xl tracking-tight">Your notes belong to you.</h2>
        <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-inksoft">MIT licensed. No MeetingAI subscription. Local storage and an explicit choice of where inference happens.</p>
        <a href="https://github.com/strugendlabs/meetingAi" className="mt-7 inline-block rounded-full bg-accent px-7 py-3 text-sm font-medium text-paper">Explore the source</a>
      </div>
    </section>
  </>;
}
