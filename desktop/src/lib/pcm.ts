// PCM utilities: Float32 -> Int16 conversion, 16 kHz downsampling, base64 framing.
// Gemini Live expects PCM16 LE mono 16 kHz ("audio/pcm;rate=16000").

const TARGET_RATE = 16000;

/** Convert Float32 samples in [-1, 1] to Int16 (clamped, symmetric scaling). */
export function floatTo16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = Math.round(s < 0 ? s * 32768 : s * 32767);
  }
  return out;
}

/**
 * Stateful 16 kHz downsampler (box/averaging filter per output window).
 *
 * Worklet audio arrives in fixed-size blocks (2048 samples); at 48 kHz a
 * block is not a whole number of output windows, so a stateless per-block
 * downsampler drops the trailing partial window every block (~2 samples per
 * 2048 at 48 kHz = ~0.1 % cumulative time loss) and resets the filter phase.
 * This class carries the unconsumed input samples and the absolute output
 * index across process() calls, so block boundaries are seamless and the
 * fractional phase stays continuous at non-integer ratios (44.1 kHz).
 *
 * Input at 16 kHz or below is passed through unchanged (upsampling is out of
 * scope — mic/system audio contexts run at 44.1/48 kHz).
 */
export class Downsampler {
  readonly inRate: number;
  private readonly ratio: number;
  /** Unconsumed raw input samples (always < ratio + 1 samples). */
  private carry: Float32Array = new Float32Array(0);
  /** Absolute input-stream index of carry[0]. */
  private carryStart = 0;
  /** Total output samples emitted so far (absolute output index). */
  private outCount = 0;

  constructor(inRate: number) {
    this.inRate = inRate;
    this.ratio = inRate <= TARGET_RATE ? 1 : inRate / TARGET_RATE;
  }

  /**
   * Downsample the next block. Output window i covers input range
   * [round(i*ratio), round((i+1)*ratio)) measured from the start of the
   * stream; a trailing partial window is carried into the next call.
   */
  process(f32: Float32Array): Float32Array {
    if (this.ratio === 1) return f32;
    let buf: Float32Array;
    if (this.carry.length === 0) {
      buf = f32;
    } else {
      buf = new Float32Array(this.carry.length + f32.length);
      buf.set(this.carry, 0);
      buf.set(f32, this.carry.length);
    }
    const absEnd = this.carryStart + buf.length; // absolute end of buffered input
    // Upper bound on how many outputs this call can emit (proven >= actual).
    const maxOut = Math.max(0, Math.ceil(absEnd / this.ratio) - this.outCount);
    const out = new Float32Array(maxOut);
    let n = 0;
    let start = Math.round(this.outCount * this.ratio);
    while (n < maxOut) {
      const end = Math.round((this.outCount + n + 1) * this.ratio);
      if (end > absEnd) break;
      let accum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        accum += buf[j - this.carryStart];
        count++;
      }
      out[n] = count > 0 ? accum / count : 0;
      n++;
      start = end;
    }
    this.outCount += n;
    // `start` is now the absolute start of the next (unfinished) window.
    this.carry = buf.slice(start - this.carryStart);
    this.carryStart = start;
    return n === maxOut ? out : out.subarray(0, n);
  }

  /** Emit the final partial window (if any buffered input remains) and reset. */
  flush(): Float32Array {
    const carry = this.carry;
    this.reset();
    if (this.ratio === 1 || carry.length === 0) return new Float32Array(0);
    let accum = 0;
    for (let j = 0; j < carry.length; j++) accum += carry[j];
    return new Float32Array([accum / carry.length]);
  }

  /** Drop all carried state (start of a new, unrelated stream). */
  reset(): void {
    this.carry = new Float32Array(0);
    this.carryStart = 0;
    this.outCount = 0;
  }
}

// downsampleTo16k keeps its historical (f32, inRate) signature for existing
// callers (mic.ts handleFrame) but is stateful across calls: consecutive
// calls at the same rate are treated as one continuous stream so no samples
// are dropped at block boundaries. State resets when the rate changes or the
// stream goes idle (no call for > IDLE_RESET_MS — worklet blocks arrive every
// ~43 ms, so a gap that long means capture stopped and restarted).
const IDLE_RESET_MS = 1000;
let sharedDownsampler: Downsampler | null = null;
let sharedLastCallMs = -Infinity;

/**
 * Downsample audio to 16 kHz using a box (averaging) filter per output sample.
 * Stateful: carries the fractional window position and unconsumed samples
 * across calls (same rate, < 1 s apart) so per-block trailing samples are not
 * dropped. Input at exactly 16 kHz (or below) is returned unchanged.
 */
export function downsampleTo16k(f32: Float32Array, inRate: number): Float32Array {
  if (inRate <= TARGET_RATE) return f32;
  const now = Date.now();
  if (
    sharedDownsampler === null ||
    sharedDownsampler.inRate !== inRate ||
    now - sharedLastCallMs > IDLE_RESET_MS
  ) {
    sharedDownsampler = new Downsampler(inRate);
  }
  sharedLastCallMs = now;
  return sharedDownsampler.process(f32);
}

/** Drop the carried downsampleTo16k state (stream teardown / tests). */
export function resetDownsampleTo16k(): void {
  sharedDownsampler = null;
  sharedLastCallMs = -Infinity;
}

/** Encode Int16 samples as base64 of their little-endian bytes. */
export function int16ToB64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i], true);
  let bin = "";
  const CHUNK = 0x8000; // keep String.fromCharCode arg count within engine limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Decode base64 of little-endian PCM16 bytes back to Int16 samples. */
export function b64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer);
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}
