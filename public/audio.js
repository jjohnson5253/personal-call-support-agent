export class BrowserAudio {
  constructor(onState) {
    this.onState = onState;
    this.sources = new Set();
    this.nextTime = 0;
    this.remainder = new Uint8Array();
  }
  async init() {
    if (!this.context || this.context.state === 'closed')
      this.context = new AudioContext({ sampleRate: 24000 });
    await this.context.resume();
  }
  async connect(id) {
    await this.init();
    this.closeSocket();
    this.socket = new WebSocket(`${location.origin.replace('http', 'ws')}/browser/${id}`);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const data = JSON.parse(event.data);
        if (data.type === 'clear') this.clear();
        if (data.type === 'ready') this.onState('Audio connected');
        if (data.type === 'mark') {
          const socket = this.socket;
          const remaining = Math.max(0, this.nextTime - this.context.currentTime) * 1000;
          setTimeout(() => {
            if (socket?.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: 'mark', name: data.name }));
          }, remaining + 20);
        }
      } else this.play(new Uint8Array(event.data));
    };
    this.socket.onclose = () => {
      this.stopMicrophone();
      this.onState('Audio disconnected');
    };
    this.socket.onerror = () => this.onState('Audio connection failed');
  }
  play(bytes) {
    if (!this.context || this.context.state !== 'running') return;
    const combined = new Uint8Array(this.remainder.length + bytes.length);
    combined.set(this.remainder);
    combined.set(bytes, this.remainder.length);
    const length = combined.length - (combined.length % 2);
    this.remainder = combined.slice(length);
    if (!length) return;
    const view = new DataView(combined.buffer),
      buffer = this.context.createBuffer(1, length / 2, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + 0.025, this.nextTime);
    if (start > this.context.currentTime + 35) {
      this.clear();
      return;
    }
    source.start(start);
    this.nextTime = start + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
  }
  clear() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* Already stopped. */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.remainder = new Uint8Array();
  }
  async startMicrophone() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('Browser audio is not connected yet.');
    await this.init();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    try {
      await this.context.audioWorklet.addModule('/microphone-worklet.js');
      this.input = this.context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.context, 'pcm-capture');
      this.worklet.port.onmessage = (event) => {
        if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 240000)
          this.socket.send(event.data);
      };
      this.input.connect(this.worklet);
      this.worklet.connect(this.context.destination);
    } catch (error) {
      this.stopMicrophone();
      throw error;
    }
  }
  stopMicrophone() {
    if (this.worklet && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: 'flush' }));
    this.stream?.getTracks().forEach((track) => track.stop());
    this.input?.disconnect();
    this.worklet?.disconnect();
    this.stream = null;
    this.input = null;
    this.worklet = null;
  }
  closeSocket() {
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }
  stop() {
    this.stopMicrophone();
    this.closeSocket();
    this.clear();
  }
}
