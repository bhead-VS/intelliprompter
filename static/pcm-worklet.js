// Converts mic audio to 16-bit PCM and posts ~100 ms chunks to the main thread.
// The AudioContext runs at 24 kHz, which is what the OpenAI Realtime API expects.
class Pcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(2400);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.chunk[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer.slice(0));
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16-capture", Pcm16Capture);
