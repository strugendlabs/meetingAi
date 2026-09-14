import type { ReactNode } from "react";

/* Each card carries a small artifact from the product itself —
   a transcript row, a checklist, a keychain path — instead of an icon. */

function CheckboxGlyph() {
  return (
    <span className="mt-[3px] inline-block size-3 shrink-0 rounded-[3px] border border-inksoft/50" />
  );
}

function MiniEq() {
  return (
    <span className="eq shrink-0" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

type Feature = {
  kicker: string;
  title: string;
  copy: string;
  artifact: ReactNode;
};

const features: Feature[] = [
  {
    kicker: "Transcription",
    title: "Both sides, attributed",
    copy: "Two live transcription streams — one for your mic, one for the room — with labels for you and the remote audio source. Group calls do not identify each participant.",
    artifact: (
      <div className="space-y-1.5 font-mono text-[11px] leading-snug">
        <p>
          <span className="text-inksoft/70">THEM 09:14 </span>
          Pero dos cuentas siguen esperando…
        </p>
        <p>
          <span className="text-inksoft/70">YOU&nbsp;&nbsp;09:15 </span>
          I&rsquo;ll take legal this week.
        </p>
      </div>
    ),
  },
  {
    kicker: "Translation",
    title: "Translation when you need it",
    copy: "Translate saved transcript text with Gemini or Ollama. Optional spoken live translation uses Gemini and your API key.",
    artifact: (
      <div className="space-y-1.5 text-[13px] leading-snug">
        <p>El pipeline creció un cuarenta por ciento.</p>
        <p className="flex items-center gap-2">
          <MiniEq />
          <span className="translated">The pipeline grew forty percent.</span>
        </p>
      </div>
    ),
  },
  {
    kicker: "Summaries",
    title: "Notes that hold up",
    copy: "Summaries, action items, and key notes from your chosen provider. Review the results and export as PDF, Word, or Markdown.",
    artifact: (
      <div className="space-y-1.5 text-[12.5px] leading-snug">
        <p className="flex gap-2">
          <CheckboxGlyph />
          <span>Send revised proposal to Vega</span>
        </p>
        <p className="flex gap-2">
          <CheckboxGlyph />
          <span>Unblock legal review — two accounts</span>
        </p>
      </div>
    ),
  },
  {
    kicker: "Calendar",
    title: "Knows your schedule",
    copy: "Optional Google Calendar sync spots the next Zoom, Meet, or Teams call and offers to record — the meeting title becomes the note title.",
    artifact: (
      <div className="flex items-center justify-between font-mono text-[11px]">
        <span>
          <span className="text-inksoft/70">10:30 </span>Q3 pipeline review
        </span>
        <span className="rounded-full bg-wash px-2 py-0.5 text-[10px] font-medium text-accent">
          Record?
        </span>
      </div>
    ),
  },
  {
    kicker: "Privacy",
    title: "Private by design",
    copy: "Choose local Whisper + Ollama, or Gemini with your own key. Transcripts live in SQLite on your device; API keys use the OS credential vault.",
    artifact: (
      <div className="space-y-1.5 font-mono text-[11px] leading-snug text-inksoft">
        <p>vault&nbsp;&nbsp;&nbsp; · com.meetingai.desktop</p>
        <p>storage&nbsp; · local SQLite, on device</p>
      </div>
    ),
  },
  {
    kicker: "Notes",
    title: "Your notes, beside the record",
    copy: "Type your own notes during the call. They autosave next to the transcript and travel with the summary.",
    artifact: (
      <div className="text-[12.5px] leading-snug">
        <p>
          Pricing objection — follow up Thursday
          <span className="type-cursor" aria-hidden="true" />
        </p>
      </div>
    ),
  },
];

export default function FeatureGrid() {
  return (
    <section id="features" className="scroll-mt-20 border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-accent">
          What it does
        </p>
        <h2 className="mt-4 max-w-xl font-display text-3xl font-medium tracking-tight text-balance sm:text-4xl">
          A useful record of the conversation.
        </h2>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <article
              key={f.title}
              className="flex flex-col rounded-2xl border border-line bg-raised p-6 transition-colors hover:border-inksoft/40"
            >
              <div className="min-h-[64px] rounded-xl bg-paper px-4 py-3.5">
                {f.artifact}
              </div>
              <p className="mt-5 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-inksoft/75">
                {f.kicker}
              </p>
              <h3 className="mt-1.5 text-[17px] font-semibold tracking-tight">
                {f.title}
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-inksoft">
                {f.copy}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
