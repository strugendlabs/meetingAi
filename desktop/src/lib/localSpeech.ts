import { audioLevel } from "./audioHealth";
import { transcribeLocal, WHISPER_DEFAULT_URL } from "./localAi";
import type { LiveSessionOpts, TranscriptEvent } from "./gemini/live";

export interface SpeechSession {
  readonly isOpen: boolean;
  readonly dead: boolean;
  sendAudio(pcm: Int16Array): void;
  finishInput(): Promise<void>;
  close(): void;
}

/** Local speech is chunked, not token-streamed: pause or a 10 s window commits a turn. */
export class LocalSpeechSession implements SpeechSession {
  private closed = false;
  private finishing = false;
  private samples: Int16Array[] = [];
  private count = 0;
  private voiced = 0;
  private silence = 0;
  private start = 0;
  private queued = 0;
  private work = Promise.resolve();
  private overflowReported = false;
  constructor(private baseUrl: string = WHISPER_DEFAULT_URL, private opts: Pick<LiveSessionOpts, "onTranscript" | "onError" | "onClose">, private elapsed: () => number, private language = "auto") {}
  get isOpen() { return !this.closed && !this.finishing; }
  get dead() { return this.closed; }

  sendAudio(pcm: Int16Array): void {
    if (!this.isOpen || !pcm.length) return;
    const sound = audioLevel(pcm) > 0.006;
    // Keep quiet frames inside an utterance, but never ask Whisper to decode silence.
    if (!sound && this.count === 0) return;
    if (this.count === 0) this.start = Math.max(0, this.elapsed() - pcm.length / 16);
    this.samples.push(pcm.slice()); this.count += pcm.length;
    if (sound) { this.voiced += pcm.length; this.silence = 0; }
    else this.silence += pcm.length;
    if (this.count >= 160000 || this.silence >= 12800) this.flush();
  }

  private flush(): void {
    const count = this.count;
    const voiced = this.voiced;
    const samples = this.samples;
    const start = this.start;
    this.samples = []; this.count = 0; this.voiced = 0; this.silence = 0;
    if (voiced < 2400) return;
    if (this.queued >= 6) {
      if (!this.overflowReported) this.opts.onError?.(new Error("Local recognition cannot keep up. Some audio was skipped; use a smaller Whisper model, then retry audio."));
      this.overflowReported = true;
      return;
    }
    const pcm = new Int16Array(count);
    let offset = 0;
    for (const chunk of samples) { pcm.set(chunk, offset); offset += chunk.length; }
    this.queued++;
    this.work = this.work.then(async () => {
      if (this.closed) return;
      const text = await transcribeLocal(this.baseUrl, pcm, this.language);
      if (text && !this.closed) {
        const event: TranscriptEvent = { kind: "final", tStart: start, tEnd: start + count / 16 };
        this.opts.onTranscript?.(text, event);
      }
    }).catch((error: unknown) => {
      if (!this.closed) this.opts.onError?.(new Error(`Local speech recognition failed: ${error instanceof Error ? error.message : String(error)} No cloud fallback was used.`));
    }).finally(() => { this.queued--; });
  }

  async finishInput(): Promise<void> { this.finishing = true; this.flush(); await this.work; }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.samples = []; this.count = 0;
    this.opts.onClose?.(1000);
  }
}
