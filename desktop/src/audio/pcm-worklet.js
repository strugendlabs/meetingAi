// AudioWorkletProcessor for mic capture.
// Runs on the audio rendering thread: accumulates mono Float32 samples at the
// AudioContext's native sample rate and posts them to the main thread in
// ~2048-sample blocks (transferred, zero-copy). The main thread (src/lib/mic.ts)
// downsamples to 16 kHz, converts to Int16, and batches to ~250 ms chunks.

const BLOCK_SIZE = 2048;

class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(BLOCK_SIZE);
    this._len = 0;
    this._stopped = false;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this._stopped = true;
    };
  }

  process(inputs) {
    if (this._stopped) return false; // allow the processor to be reclaimed
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true; // no input connected yet
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, BLOCK_SIZE - this._len);
      this._buf.set(channel.subarray(offset, offset + take), this._len);
      this._len += take;
      offset += take;
      if (this._len === BLOCK_SIZE) {
        const out = this._buf;
        this.port.postMessage(out, [out.buffer]);
        this._buf = new Float32Array(BLOCK_SIZE);
        this._len = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorkletProcessor);
