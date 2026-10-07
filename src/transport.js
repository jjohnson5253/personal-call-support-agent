import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export class TwilioTransport {
  constructor(socket, streamSid) {
    this.socket = socket;
    this.streamSid = streamSid;
    this.marks = new Map();
  }
  send(event) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Audio connection closed.');
    if (this.socket.bufferedAmount > 1_000_000) throw new Error('Audio connection is too slow.');
    this.socket.send(JSON.stringify({ ...event, streamSid: this.streamSid }));
  }
  audio(chunk) {
    this.send({ event: 'media', media: { payload: chunk.toString('base64') } });
  }
  clear() {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    for (const resolve of this.marks.values()) resolve();
    this.marks.clear();
  }
  drain(signal) {
    return new Promise((resolve) => {
      const name = randomUUID();
      const finish = () => {
        clearTimeout(timer);
        this.marks.delete(name);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, 35000);
      this.marks.set(name, finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) {
        finish();
        return;
      }
      this.send({ event: 'mark', mark: { name } });
    });
  }
  mark(name) {
    this.marks.get(name)?.();
  }
  close() {
    this.clear();
    this.socket.close();
  }
}

export class BrowserTransport {
  constructor(socket) {
    this.socket = socket;
    this.marks = new Map();
  }
  audio(chunk) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Audio connection closed.');
    if (this.socket.bufferedAmount > 1_000_000) throw new Error('Audio connection is too slow.');
    this.socket.send(chunk);
  }
  drain(signal) {
    return new Promise((resolve) => {
      const name = randomUUID();
      const finish = () => {
        clearTimeout(timer);
        this.marks.delete(name);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, 35000);
      this.marks.set(name, finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted || this.socket.readyState !== WebSocket.OPEN) {
        finish();
        return;
      }
      this.socket.send(JSON.stringify({ type: 'mark', name }));
    });
  }
  mark(name) {
    this.marks.get(name)?.();
  }
  clear() {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: 'clear' }));
    for (const resolve of this.marks.values()) resolve();
    this.marks.clear();
  }
  close() {
    this.clear();
    this.socket.close();
  }
}
