import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMuLaw, muLawToPcm24, TurnDetector } from '../src/audio.js';

function pcm(value, ms = 20) {
  const data = Buffer.alloc(ms * 48);
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(value, i);
  return data;
}
test('mu-law silence and extreme values decode with correct sign and sample count', () => {
  assert.equal(decodeMuLaw(0xff), 0);
  assert.equal(decodeMuLaw(0x7f), 0);
  assert.equal(decodeMuLaw(0x00), -32124);
  assert.equal(decodeMuLaw(0x80), 32124);
  const converted = muLawToPcm24(Buffer.from([0xff, 0x80]));
  assert.equal(converted.length, 12);
  assert.equal(converted.readInt16LE(0), 0);
  assert.equal(converted.readInt16LE(6), 32124);
});
test('local VAD commits meaningful speech after silence and ignores brief clicks', () => {
  let starts = 0;
  const ends = [];
  const detector = new TurnDetector({
    onStart: () => starts++,
    onEnd: (valid) => ends.push(valid),
  });
  for (let i = 0; i < 100; i++) detector.push(pcm(0));
  assert.equal(starts, 0);
  for (let i = 0; i < 10; i++) detector.push(pcm(5000));
  for (let i = 0; i < 39; i++) detector.push(pcm(0));
  assert.deepEqual(ends, []);
  detector.push(pcm(0));
  assert.deepEqual(ends, [true]);
  detector.push(pcm(5000));
  for (let i = 0; i < 40; i++) detector.push(pcm(0));
  assert.deepEqual(ends, [true, false]);
});
test('VAD bounds continuous speech turns to twenty seconds', () => {
  let ended = false;
  const detector = new TurnDetector({
    onEnd: (valid) => {
      ended = valid;
    },
  });
  for (let i = 0; i < 1000; i++) detector.push(pcm(5000));
  assert.equal(ended, true);
  assert.equal(detector.speaking, false);
});
