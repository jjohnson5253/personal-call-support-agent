import test from 'node:test';
import assert from 'node:assert/strict';
import { TwilioTransport, BrowserTransport } from '../src/transport.js';

function socket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(value) {
      this.sent.push(typeof value === 'string' ? JSON.parse(value) : value);
    },
    close() {
      this.readyState = 3;
    },
  };
}
test('Twilio audio waits for a playback mark and clear aborts pending playback', async () => {
  const ws = socket(),
    transport = new TwilioTransport(ws, 'MZ123');
  transport.audio(Buffer.from([255]));
  assert.deepEqual(ws.sent[0], { event: 'media', media: { payload: '/w==' }, streamSid: 'MZ123' });
  const draining = transport.drain();
  transport.mark(ws.sent.at(-1).mark.name);
  await draining;
  const cleared = transport.drain();
  transport.clear();
  await cleared;
  assert.equal(ws.sent.at(-1).event, 'clear');
  assert.equal(transport.marks.size, 0);
  transport.close();
});
test('browser binary PCM is streamed, and playback acknowledgement or interruption releases drain', async () => {
  const ws = socket(),
    transport = new BrowserTransport(ws),
    data = Buffer.from([0, 0, 255, 127]);
  transport.audio(data);
  assert.equal(ws.sent[0], data);
  const draining = transport.drain();
  const mark = ws.sent.at(-1);
  assert.equal(mark.type, 'mark');
  transport.mark(mark.name);
  await draining;
  const controller = new AbortController(),
    interrupted = transport.drain(controller.signal);
  controller.abort();
  await interrupted;
  assert.equal(transport.marks.size, 0);
  transport.close();
});
test('slow or closed transports do not enqueue unlimited audio', () => {
  const ws = socket(),
    transport = new TwilioTransport(ws, 'MZ123');
  ws.bufferedAmount = 1_000_001;
  assert.throws(() => transport.audio(Buffer.alloc(2)), /too slow/);
  ws.readyState = 3;
  assert.throws(() => transport.audio(Buffer.alloc(2)), /closed/);
});
