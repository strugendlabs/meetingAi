const faqs: { q: string; a: string }[] = [
  { q: "Is it really open source?", a: "Yes. MeetingAI's source is available on GitHub under the MIT license. You can inspect, modify, build, and redistribute it under those terms. Third-party libraries and models retain their own licenses." },
  { q: "Where does my audio go?", a: "You choose. Gemini mode sends audio directly to Google using your API key. Local mode sends audio to whisper.cpp and transcript text to Ollama on this computer. Local failures never switch to Gemini. Optional Google Calendar sync still contacts Google." },
  { q: "Can I use Ollama for everything?", a: "Ollama handles summaries and text translation. Speech recognition needs a separate local whisper.cpp server. Download models first, connect both servers in Settings, and leave Calendar disconnected for offline inference. Spoken live translation is a Gemini feature." },
  { q: "What does BYOK mean?", a: "Bring your own key: enter your Gemini API key in the app. It is stored in the operating system's credential vault, and Google bills your API usage directly. Local Whisper + Ollama mode requires no Gemini key." },
  { q: "Does it join the call as a bot?", a: "No. MeetingAI captures microphone and system audio on your computer. Let participants know and get their agreement before recording. You and Them labels distinguish the two audio sources, not every person on a group call." },
  { q: "Can I download a Mac app today?", a: "The source preview is available now for Apple Silicon Macs on macOS 13 or later. A signed, notarized DMG is not available yet. Windows source is included but still needs testing on real hardware." },
  { q: "What does it cost?", a: "The MeetingAI source is free under MIT, with no MeetingAI subscription. Gemini usage is billed by Google. Local inference uses your own hardware and separately downloaded models." },
  { q: "How accurate is recognition?", a: "It depends on your model, language, microphone, and background noise. For Hindi, use a multilingual Whisper model rather than an English-only .en model. Review names, decisions, and action items before relying on them." },
];

export default function Faq() {
  return (
    <section id="faq" className="scroll-mt-20 border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-accent">
              FAQ
            </p>
            <h2 className="mt-4 font-display text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              Fair questions, straight answers.
            </h2>
          </div>

          <div className="divide-y divide-line border-y border-line">
            {faqs.map((f) => (
              <details key={f.q} className="group">
                <summary className="flex cursor-pointer list-none items-baseline justify-between gap-6 py-5 text-[16px] font-medium tracking-tight marker:hidden [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span
                    aria-hidden="true"
                    className="font-display text-xl leading-none text-inksoft transition-transform duration-200 group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="-mt-1 max-w-xl pb-6 text-[14.5px] leading-relaxed text-inksoft">
                  {f.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
