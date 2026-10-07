/** G.711 mu-law to 24 kHz PCM16. Telephony is 8 kHz; interpolation cannot restore lost bandwidth. */
export function decodeMuLaw(byte) {
  const value = ~byte & 0xff;
  const magnitude = (((value & 0x0f) << 3) + 0x84) << ((value & 0x70) >> 4);
  return value & 0x80 ? 0x84 - magnitude : magnitude - 0x84;
}

export function muLawToPcm24(input) {
  const output = Buffer.alloc(input.length * 6);
  for (let i = 0; i < input.length; i++) {
    const current = decodeMuLaw(input[i]);
    const next = decodeMuLaw(input[Math.min(i + 1, input.length - 1)]);
    for (let j = 0; j < 3; j++)
      output.writeInt16LE(Math.round(current + ((next - current) * j) / 3), i * 6 + j * 2);
  }
  return output;
}

/** Local energy VAD: commit on 800 ms silence or 20 seconds of continuous speech. */
export class TurnDetector {
  constructor({ onStart = () => {}, onEnd = () => {}, threshold = 0.018, silenceMs = 800 } = {}) {
    Object.assign(this, { onStart, onEnd, threshold, silenceMs });
    this.reset();
  }
  reset() {
    this.speaking = false;
    this.silence = 0;
    this.duration = 0;
    this.voiced = 0;
  }
  push(pcm) {
    if (pcm.length < 2 || pcm.length % 2) return;
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
    const loud = Math.sqrt(sum / (pcm.length / 2)) >= this.threshold;
    const ms = pcm.length / 48;
    if (loud && !this.speaking) {
      this.speaking = true;
      this.onStart();
    }
    if (!this.speaking) return;
    this.duration += ms;
    if (loud) {
      this.silence = 0;
      this.voiced += ms;
    } else this.silence += ms;
    if (this.silence >= this.silenceMs || this.duration >= 20000) {
      const valid = this.voiced >= 120;
      this.reset();
      this.onEnd(valid);
    }
  }
}
