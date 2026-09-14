import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  floatTo16,
  downsampleTo16k,
  resetDownsampleTo16k,
  Downsampler,
  int16ToB64,
  b64ToInt16,
} from "./pcm";

describe("floatTo16", () => {
  it("converts 0 to 0", () => {
    const out = floatTo16(new Float32Array([0]));
    expect(out).toBeInstanceOf(Int16Array);
    expect(out[0]).toBe(0);
  });

  it("converts full-scale positive 1.0 to 32767", () => {
    const out = floatTo16(new Float32Array([1.0]));
    expect(out[0]).toBe(32767);
  });

  it("converts full-scale negative -1.0 to -32768", () => {
    const out = floatTo16(new Float32Array([-1.0]));
    expect(out[0]).toBe(-32768);
  });

  it("clamps values beyond [-1, 1]", () => {
    const out = floatTo16(new Float32Array([2.5, -3.0]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  it("scales mid values proportionally", () => {
    const out = floatTo16(new Float32Array([0.5, -0.5]));
    expect(out[0]).toBe(Math.round(0.5 * 32767));
    expect(out[1]).toBe(Math.round(-0.5 * 32768));
  });

  it("preserves length", () => {
    const out = floatTo16(new Float32Array(1000));
    expect(out.length).toBe(1000);
  });
});

describe("downsampleTo16k", () => {
  beforeEach(() => resetDownsampleTo16k());

  it("returns input unchanged when already 16 kHz", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const out = downsampleTo16k(input, 16000);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("downsamples 48 kHz to one third the length", () => {
    const input = new Float32Array(4800); // 100ms @ 48k
    const out = downsampleTo16k(input, 48000);
    expect(out.length).toBe(1600); // 100ms @ 16k
  });

  it("downsamples 44.1 kHz to the right length", () => {
    const input = new Float32Array(4410); // 100ms @ 44.1k
    const out = downsampleTo16k(input, 44100);
    expect(out.length).toBe(1600);
  });

  it("preserves a constant (DC) signal value", () => {
    const input = new Float32Array(480).fill(0.25);
    const out = downsampleTo16k(input, 48000);
    expect(out.length).toBe(160);
    for (const v of out) expect(v).toBeCloseTo(0.25, 5);
  });

  it("averages samples within each window (anti-aliasing box filter)", () => {
    // 48k -> 16k: each output sample covers 3 inputs
    const input = new Float32Array([0, 0.3, 0.6, 1, 1, 1]);
    const out = downsampleTo16k(input, 48000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo((0 + 0.3 + 0.6) / 3, 5);
    expect(out[1]).toBeCloseTo(1, 5);
  });

  it("returns empty output for empty input", () => {
    const out = downsampleTo16k(new Float32Array(0), 48000);
    expect(out.length).toBe(0);
  });
});

describe("downsampleTo16k — stateful carry across worklet blocks", () => {
  beforeEach(() => resetDownsampleTo16k());

  it("drops no samples across 2048-sample blocks at 48 kHz", () => {
    // 3 blocks of 2048 = 6144 inputs = exactly 2048 outputs at ratio 3.
    // The stateless version emitted 682 per block (2046 total), losing
    // 2 samples per block.
    const lens = [0, 1, 2].map(
      (b) => downsampleTo16k(new Float32Array(2048).fill(b / 10), 48000).length,
    );
    expect(lens).toEqual([682, 683, 683]);
    expect(lens[0] + lens[1] + lens[2]).toBe(2048);
  });

  it("the next block's first output consumes the carried trailing samples", () => {
    const a = new Float32Array(2048);
    a[2046] = 0.3;
    a[2047] = 0.6; // discarded entirely by the stateless version
    const b = new Float32Array(2048);
    b[0] = 0.9;
    downsampleTo16k(a, 48000);
    const out = downsampleTo16k(b, 48000);
    // Output window [2046, 2049) = avg(0.3, 0.6, 0.9).
    expect(out[0]).toBeCloseTo((0.3 + 0.6 + 0.9) / 3, 6);
  });

  it("blockwise output equals one-shot output at 44.1 kHz (phase continuity)", () => {
    const total = new Float32Array(44100); // 1 s
    for (let i = 0; i < total.length; i++) {
      total[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
    }
    const oneShot = new Downsampler(44100).process(total);
    expect(oneShot.length).toBe(16000);
    const pieces: number[] = [];
    for (let off = 0; off < total.length; off += 2048) {
      const block = total.subarray(off, Math.min(off + 2048, total.length));
      for (const v of downsampleTo16k(block, 44100)) pieces.push(v);
    }
    expect(pieces.length).toBe(16000);
    let maxDiff = 0;
    for (let i = 0; i < pieces.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(pieces[i] - oneShot[i]));
    }
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it("resets carried state when the input rate changes", () => {
    downsampleTo16k(new Float32Array(2048).fill(1), 48000); // leaves a carry of 1s
    const out = downsampleTo16k(new Float32Array(4410).fill(0.5), 44100);
    expect(out.length).toBe(1600);
    expect(out[0]).toBeCloseTo(0.5, 6); // no 48 kHz carry bled in
  });

  it("resets carried state after an idle gap (capture stop/restart)", () => {
    const spy = vi.spyOn(Date, "now");
    try {
      spy.mockReturnValue(1000);
      expect(downsampleTo16k(new Float32Array(2048), 48000).length).toBe(682);
      spy.mockReturnValue(1043); // next worklet block ~43 ms later — continuous
      expect(downsampleTo16k(new Float32Array(2048), 48000).length).toBe(683);
      spy.mockReturnValue(10_000); // > 1 s gap — treated as a new stream
      expect(downsampleTo16k(new Float32Array(2048), 48000).length).toBe(682);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Downsampler", () => {
  it("passes input through unchanged at 16 kHz or below", () => {
    const d = new Downsampler(16000);
    const input = new Float32Array([0.1, 0.2]);
    expect(d.process(input)).toBe(input);
    expect(d.flush().length).toBe(0);
  });

  it("preserves a constant (DC) signal across many odd-sized blocks without loss", () => {
    const d = new Downsampler(48000);
    let emitted = 0;
    let fed = 0;
    for (const len of [1, 2, 3, 500, 1023, 2048, 7, 999]) {
      const out = d.process(new Float32Array(len).fill(0.25));
      fed += len;
      emitted += out.length;
      for (const v of out) expect(v).toBeCloseTo(0.25, 6);
    }
    // Every fully-covered window was emitted: max n with round(3n) <= fed.
    expect(emitted).toBe(Math.floor(fed / 3));
  });

  it("flush() emits the final partial window average and resets", () => {
    const d = new Downsampler(48000);
    const out = d.process(new Float32Array([0, 0, 0, 0.2, 0.4]));
    expect(out.length).toBe(1); // one full window; 2 samples carried
    const tail = d.flush();
    expect(tail.length).toBe(1);
    expect(tail[0]).toBeCloseTo(0.3, 6);
    expect(d.flush().length).toBe(0); // drained
  });

  it("reset() drops carried state and phase", () => {
    const d = new Downsampler(48000);
    d.process(new Float32Array(2048).fill(1));
    d.reset();
    const out = d.process(new Float32Array(2048).fill(0));
    expect(out.length).toBe(682); // fresh phase — not 683
    expect(out[0]).toBe(0); // no carried 1s
  });
});

describe("int16ToB64 / b64ToInt16", () => {
  it("round-trips arbitrary samples", () => {
    const src = new Int16Array([0, 1, -1, 32767, -32768, 12345, -12345]);
    const b64 = int16ToB64(src);
    const back = b64ToInt16(b64);
    expect(Array.from(back)).toEqual(Array.from(src));
  });

  it("encodes little-endian byte order", () => {
    // 0x0102 LE -> bytes [0x02, 0x01]
    const b64 = int16ToB64(new Int16Array([0x0102]));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(bytes)).toEqual([0x02, 0x01]);
  });

  it("decodes little-endian byte order", () => {
    // bytes [0x02, 0x01] -> 0x0102
    const b64 = btoa(String.fromCharCode(0x02, 0x01));
    const out = b64ToInt16(b64);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(0x0102);
  });

  it("handles empty arrays", () => {
    expect(int16ToB64(new Int16Array(0))).toBe("");
    expect(b64ToInt16("").length).toBe(0);
  });

  it("round-trips a large buffer (chunked encoding paths)", () => {
    const src = new Int16Array(50000);
    for (let i = 0; i < src.length; i++) src[i] = ((i * 7919) % 65536) - 32768;
    const back = b64ToInt16(int16ToB64(src));
    expect(back.length).toBe(src.length);
    expect(Array.from(back.slice(0, 100))).toEqual(Array.from(src.slice(0, 100)));
    expect(back[49999]).toBe(src[49999]);
  });

  it("handles Int16Array views with a non-zero byteOffset", () => {
    const buf = new ArrayBuffer(8);
    const full = new Int16Array(buf);
    full.set([111, 222, 333, 444]);
    const view = new Int16Array(buf, 4, 2); // [333, 444]
    const back = b64ToInt16(int16ToB64(view));
    expect(Array.from(back)).toEqual([333, 444]);
  });
});
