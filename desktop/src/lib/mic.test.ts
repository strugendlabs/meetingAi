import { describe, it, expect } from "vitest";
import { batchSamples, CHUNK_SAMPLES } from "./mic";

/** Int16Array [start, start+1, ..., start+len-1] for order-sensitive checks. */
function seq(start: number, len: number): Int16Array {
  const a = new Int16Array(len);
  for (let i = 0; i < len; i++) a[i] = start + i;
  return a;
}

describe("CHUNK_SAMPLES", () => {
  it("is ~250 ms at 16 kHz (4000 samples)", () => {
    expect(CHUNK_SAMPLES).toBe(4000);
    expect((CHUNK_SAMPLES / 16000) * 1000).toBe(250);
  });
});

describe("batchSamples", () => {
  it("emits no chunk while below the chunk size and carries the remainder", () => {
    const { chunks, rest } = batchSamples(new Int16Array(0), seq(0, 10), 16);
    expect(chunks).toEqual([]);
    expect(Array.from(rest)).toEqual(Array.from(seq(0, 10)));
  });

  it("accumulates across calls and emits once the boundary is crossed", () => {
    const first = batchSamples(new Int16Array(0), seq(0, 10), 16);
    expect(first.chunks.length).toBe(0);
    const second = batchSamples(first.rest, seq(10, 10), 16);
    expect(second.chunks.length).toBe(1);
    expect(Array.from(second.chunks[0])).toEqual(Array.from(seq(0, 16)));
    expect(Array.from(second.rest)).toEqual(Array.from(seq(16, 4)));
  });

  it("preserves ordering: pending samples come before incoming ones", () => {
    const { chunks } = batchSamples(seq(0, 3), seq(3, 5), 8);
    expect(chunks.length).toBe(1);
    expect(Array.from(chunks[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("emits multiple chunks when incoming spans several chunk sizes", () => {
    const { chunks, rest } = batchSamples(new Int16Array(0), seq(0, 26), 8);
    expect(chunks.length).toBe(3);
    expect(Array.from(chunks[0])).toEqual(Array.from(seq(0, 8)));
    expect(Array.from(chunks[1])).toEqual(Array.from(seq(8, 8)));
    expect(Array.from(chunks[2])).toEqual(Array.from(seq(16, 8)));
    expect(Array.from(rest)).toEqual([24, 25]);
  });

  it("leaves an empty remainder on an exact multiple", () => {
    const { chunks, rest } = batchSamples(seq(0, 4), seq(4, 12), 8);
    expect(chunks.length).toBe(2);
    expect(rest.length).toBe(0);
  });

  it("handles empty incoming with existing pending", () => {
    const pending = seq(5, 6);
    const { chunks, rest } = batchSamples(pending, new Int16Array(0), 8);
    expect(chunks).toEqual([]);
    expect(Array.from(rest)).toEqual(Array.from(pending));
  });

  it("handles both inputs empty", () => {
    const { chunks, rest } = batchSamples(new Int16Array(0), new Int16Array(0), 8);
    expect(chunks).toEqual([]);
    expect(rest.length).toBe(0);
  });

  it("does not mutate its inputs", () => {
    const pending = seq(0, 4);
    const incoming = seq(4, 8);
    batchSamples(pending, incoming, 8);
    expect(Array.from(pending)).toEqual([0, 1, 2, 3]);
    expect(Array.from(incoming)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("emitted chunks are independent copies (safe to transfer/encode)", () => {
    const { chunks } = batchSamples(new Int16Array(0), seq(0, 8), 8);
    chunks[0][0] = 999;
    const again = batchSamples(new Int16Array(0), seq(0, 8), 8);
    expect(again.chunks[0][0]).toBe(0);
  });

  it("uses CHUNK_SAMPLES (4000) as the default chunk size", () => {
    const { chunks, rest } = batchSamples(new Int16Array(0), new Int16Array(9000));
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4000);
    expect(chunks[1].length).toBe(4000);
    expect(rest.length).toBe(1000);
  });

  it("rejects a non-positive or non-integer chunk size", () => {
    expect(() => batchSamples(new Int16Array(0), seq(0, 4), 0)).toThrow(RangeError);
    expect(() => batchSamples(new Int16Array(0), seq(0, 4), -8)).toThrow(RangeError);
    expect(() => batchSamples(new Int16Array(0), seq(0, 4), 2.5)).toThrow(RangeError);
  });
});
