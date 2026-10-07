class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.position = 0;
    this.previous = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    // Linear streaming resampling, including fractional positions across worklet blocks.
    const step = sampleRate / 24000;
    while (this.position < channel.length) {
      const index = Math.floor(this.position),
        fraction = this.position - index;
      const left = index < 0 ? this.previous : channel[index];
      const right = channel[Math.min(index + 1, channel.length - 1)];
      const value = Math.max(-1, Math.min(1, left + (right - left) * fraction));
      this.samples.push(Math.round(value * (value < 0 ? 32768 : 32767)));
      this.position += step;
    }
    this.position -= channel.length;
    this.previous = channel.at(-1);
    if (this.samples.length >= 480) {
      const buffer = new ArrayBuffer(this.samples.length * 2),
        view = new DataView(buffer);
      this.samples.forEach((value, index) => view.setInt16(index * 2, value, true));
      this.port.postMessage(buffer, [buffer]);
      this.samples = [];
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
