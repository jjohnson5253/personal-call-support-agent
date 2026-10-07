import test from 'node:test';
import assert from 'node:assert/strict';
import { callSchema, decisionSchema, settingsSchema } from '../src/validation.js';
import { streamTwiml } from '../src/providers/twilio.js';

const brief = {
  mode: 'phone',
  company: 'Clinic',
  goal: 'Cancel my appointment',
  to: '+13125550123',
  confirmed: true,
};
test('real call requires explicit approval and a valid international destination', () => {
  assert.equal(callSchema.parse(brief).maxMinutes, 45);
  for (const patch of [
    { confirmed: false },
    { confirmed: undefined },
    { to: '' },
    { to: '911' },
    { to: '+abc' },
    { to: '+0123456789' },
    { maxMinutes: 61 },
  ]) {
    assert.equal(callSchema.safeParse({ ...brief, ...patch }).success, false);
  }
});
test('only known modes and bounded user brief fields are accepted', () => {
  assert.equal(callSchema.safeParse({ ...brief, mode: 'demo', to: '' }).success, true);
  assert.equal(callSchema.safeParse({ ...brief, mode: 'sip' }).success, false);
  assert.equal(callSchema.safeParse({ ...brief, goal: 'a'.repeat(6001) }).success, false);
  assert.equal(callSchema.safeParse({ ...brief, arbitrary: 'secret' }).success, false);
  assert.equal(callSchema.safeParse({ ...brief, record: true }).success, true);
  assert.equal(callSchema.safeParse({ ...brief, mode: 'demo', record: true }).success, false);
  assert.equal(callSchema.safeParse({ ...brief, record: 'yes' }).success, false);
});
test('public callback URL requires HTTPS root without userinfo, path, or query', () => {
  assert.equal(
    settingsSchema.safeParse({ publicUrl: 'https://example.ngrok-free.app' }).success,
    true,
  );
  for (const publicUrl of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com?key=secret',
    'https://example.com#hash',
    'not-a-url',
  ]) {
    assert.equal(settingsSchema.safeParse({ publicUrl }).success, false, publicUrl);
  }
});
test('agent decisions require action data and disallow malformed keypad input', () => {
  const base = { action: 'wait', text: '', digits: '', summary: '', outcome: 'unknown' };
  assert.equal(decisionSchema.safeParse(base).success, true);
  for (const patch of [
    { action: 'speak' },
    { action: 'ask_user' },
    { action: 'finish' },
    { action: 'dtmf', digits: '<Hangup/>' },
    { action: 'dtmf', digits: '' },
    { text: 'a'.repeat(2001) },
  ]) {
    assert.equal(decisionSchema.safeParse({ ...base, ...patch }).success, false);
  }
});
test('DTMF uses TwiML Play followed by a bidirectional stream reconnect', () => {
  const xml = streamTwiml({ publicUrl: 'https://example.com' }, 'session', 'token', 'ww1#');
  assert.match(xml, /<Play digits="ww1#"\/>/);
  assert.match(
    xml,
    /<Connect><Stream url="wss:\/\/example.com\/media\/session\/token"\/><\/Connect>/,
  );
  assert.ok(xml.indexOf('<Play') < xml.indexOf('<Connect'));
  assert.throws(() => streamTwiml({ publicUrl: 'https://example.com' }, 'id', 'token', 'bad'));
});
