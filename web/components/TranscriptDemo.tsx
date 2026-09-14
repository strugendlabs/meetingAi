"use client";

import { useEffect, useRef, useState } from "react";

type Line = {
  speaker: "them" | "me";
  time: string;
  text: string;
  trans?: string;
};

const SCRIPT: Line[] = [
  {
    speaker: "them",
    time: "00:12",
    text: "Buenos días a todos. Empecemos con los números del tercer trimestre.",
    trans: "Good morning, everyone. Let's start with the third-quarter numbers.",
  },
  {
    speaker: "me",
    time: "00:19",
    text: "Sounds good — pipeline first, then hiring.",
  },
  {
    speaker: "them",
    time: "00:26",
    text: "El pipeline creció un cuarenta por ciento desde julio.",
    trans: "The pipeline grew forty percent since July.",
  },
  {
    speaker: "them",
    time: "00:33",
    text: "Pero dos cuentas grandes siguen esperando la revisión legal.",
    trans: "But two large accounts are still waiting on legal review.",
  },
  {
    speaker: "me",
    time: "00:41",
    text: "I'll take legal — we can unblock both this week.",
  },
  {
    speaker: "them",
    time: "00:47",
    text: "Perfecto. Entonces cerramos el trimestre por encima del objetivo.",
    trans: "Perfect. Then we close the quarter above target.",
  },
];

const wordsOf = (t: string) => t.split(" ");

function Eq() {
  return (
    <span className="eq shrink-0 translate-y-[1px]" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

export default function TranscriptDemo() {
  const [cycle, setCycle] = useState(0);
  const [lineIdx, setLineIdx] = useState(0);
  const [wordCount, setWordCount] = useState(0);
  // Highest line index whose translation is on screen (translations arrive in order).
  const [transUpTo, setTransUpTo] = useState(-1);
  const [staticMode, setStaticMode] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStaticMode(true);
      setLineIdx(SCRIPT.length - 1);
      setWordCount(wordsOf(SCRIPT[SCRIPT.length - 1].text).length);
      setTransUpTo(SCRIPT.length - 1);
    }
  }, []);

  useEffect(() => {
    if (staticMode) return;
    const line = SCRIPT[lineIdx];
    const words = wordsOf(line.text);
    let t: number;
    if (wordCount < words.length) {
      // Deterministic jitter so the typing feels human, not metronomic.
      const jitter = 70 + ((lineIdx * 7 + wordCount * 13) % 90);
      t = window.setTimeout(() => setWordCount((c) => c + 1), jitter);
    } else if (line.trans && transUpTo < lineIdx) {
      t = window.setTimeout(() => setTransUpTo(lineIdx), 500);
    } else if (lineIdx < SCRIPT.length - 1) {
      t = window.setTimeout(
        () => {
          setLineIdx((i) => i + 1);
          setWordCount(0);
        },
        line.trans ? 1500 : 750,
      );
    } else {
      t = window.setTimeout(() => {
        setCycle((c) => c + 1);
        setLineIdx(0);
        setWordCount(0);
        setTransUpTo(-1);
      }, 3600);
    }
    return () => window.clearTimeout(t);
  }, [lineIdx, wordCount, transUpTo, staticMode, cycle]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: staticMode ? "auto" : "smooth" });
    }
  });

  return (
    <div className="w-full">
      <p className="sr-only">
        Illustrative transcript preview: a Spanish speaker&rsquo;s words appear in the
        transcript, each line followed by its English translation, while
        MeetingAI speaks the translation aloud in a matched voice.
      </p>

      <div
        aria-hidden="true"
        className="overflow-hidden rounded-2xl border border-line bg-raised shadow-[0_24px_60px_-24px_rgba(20,24,60,0.28)]"
      >
        {/* Window chrome */}
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-[#ff5f57]/90" />
            <span className="size-2.5 rounded-full bg-[#febc2e]/90" />
            <span className="size-2.5 rounded-full bg-[#28c840]/90" />
          </div>
          <span className="hidden font-mono text-[10.5px] tracking-wide text-inksoft sm:inline">
            Q3 pipeline review · Acme × Vega
          </span>
          <span className="flex items-center gap-1.5 rounded-full bg-wash px-2.5 py-1 font-mono text-[10px] font-medium tracking-wide text-accent">
            <span className="live-dot size-1.5 rounded-full bg-live" />
            INTERPRETING&nbsp;ES&nbsp;→&nbsp;EN
          </span>
        </div>

        {/* Transcript */}
        <div className="relative">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8"
            style={{
              background: "linear-gradient(var(--raised), transparent)",
            }}
          />
          <div
            ref={scrollRef}
            className="h-[330px] overflow-hidden px-5 pt-6 pb-4 sm:h-[360px] sm:px-6"
          >
            <div key={cycle} className="space-y-5">
              {SCRIPT.slice(0, lineIdx + 1).map((line, i) => {
                const isCurrent = i === lineIdx;
                const words = wordsOf(line.text);
                const shown = isCurrent
                  ? words.slice(0, wordCount).join(" ")
                  : line.text;
                const typing = isCurrent && wordCount < words.length;
                const transVisible = line.trans && i <= transUpTo;
                const speaking = transVisible && i === lineIdx;
                return (
                  <div
                    key={i}
                    className={`fade-up ${line.speaker === "me" ? "text-right" : ""}`}
                  >
                    <div
                      className={`flex items-baseline gap-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-inksoft/75 ${
                        line.speaker === "me" ? "justify-end" : ""
                      }`}
                    >
                      <span>{line.time}</span>
                      <span>{line.speaker === "them" ? "Them · ES" : "You · EN"}</span>
                    </div>
                    <p className="mt-1 text-[14.5px] leading-relaxed sm:text-[15px]">
                      {shown}
                      {typing && <span className="type-cursor" />}
                    </p>
                    {transVisible && (
                      <div className="fade-up mt-1.5 flex items-center gap-2">
                        {speaking && <Eq />}
                        <p className="translated text-[15px] leading-relaxed sm:text-[15.5px]">
                          {line.trans}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Voice status bar */}
        <div className="flex items-center justify-between border-t border-line px-5 py-2.5 font-mono text-[10px] tracking-wide text-inksoft sm:px-6">
          <span className="flex items-center gap-2">
            <Eq />
            <span>
              Gemini mode · <span className="text-accent">translation preview</span>
            </span>
          </span>
          <span>sample conversation</span>
        </div>
      </div>
    </div>
  );
}
