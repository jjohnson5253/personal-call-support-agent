import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import twilio from 'twilio';
import { createApp } from '../src/app.js';
import { ConfigStore } from '../src/config.js';
import { CallSession } from '../src/session.js';
import { DemoBrain } from '../src/providers/demo.js';

test('local API and signed telephony routes preserve authorization boundaries', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'call-app-'));
  const configStore = await new ConfigStore(directory, {}).load();
  const port = randomInt(20000, 50000),
    base = `http://127.0.0.1:${port}`,
    origin = `http://localhost:${port}`;
  let hangups = 0;
  const inputEvents = new EventEmitter();
  const { server, store, sockets } = createApp({
    configStore,
    port,
    sessionFactory: (brief, config) =>
      new CallSession(brief, config, {
        brain: new DemoBrain(),
        voice: null,
        ...(brief.mode === 'phone'
          ? {
              phone: {
                dial: async () => 'CA123',
                hangup: async () => {
                  hangups++;
                },
              },
            }
          : {}),
      }),
    transcriberFactory: () => ({
      connect: async () => {},
      append: (pcm) => inputEvents.emit('append', pcm),
      flush: () => inputEvents.emit('flush'),
      close: () => {},
    }),
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const session of store.sessions.values()) session.cleanup();
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const request = (path, method = 'GET', body, extra = {}) =>
    fetch(`${base}/api/${path}`, {
      method,
      headers: {
        Cookie: cookie,
        ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  await t.test('dashboard is denied through public hosts or a forwarding tunnel', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(base, { headers: { Host: 'public.example.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.equal(
      (await fetch(base, { headers: { 'X-Forwarded-For': '203.0.113.1' } })).status,
      403,
    );
  });
  await t.test('API rejects missing session cookie and cross-site mutation', async () => {
    assert.equal((await fetch(`${base}/api/settings`)).status, 403);
    assert.equal(
      (await request('settings', 'PUT', {}, { Origin: 'https://attacker.example' })).status,
      403,
    );
    assert.equal((await request('settings', 'PUT', {}, { Origin: '' })).status, 403);
  });
  await t.test('settings response never contains provider secret values', async () => {
    const response = await request('settings', 'PUT', {
      openaiKey: 'unit-secret-openai',
      elevenKey: 'unit-secret-eleven',
      voiceId: 'voice123',
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('unit-secret'));
    assert.equal(JSON.parse(text).browserReady, true);
  });
  await t.test('real calls cannot start without Twilio settings or approval', async () => {
    const brief = {
      mode: 'phone',
      company: 'Clinic',
      goal: 'Cancel my appointment',
      to: '+13125550123',
      confirmed: true,
    };
    assert.equal((await request('sessions', 'POST', brief)).status, 400);
    assert.equal(
      (await request('sessions', 'POST', { ...brief, mode: 'demo', confirmed: false })).status,
      400,
    );
  });
  let demo;
  await t.test(
    'demo works without paid requests, rejects concurrent sessions, and protects transcript deletion',
    async () => {
      const brief = {
        mode: 'demo',
        company: 'Clinic',
        goal: 'Cancel my appointment',
        confirmed: true,
      };
      const response = await request('sessions', 'POST', brief);
      assert.equal(response.status, 201);
      demo = await response.json();
      assert.equal((await request('sessions', 'POST', brief)).status, 400);
      assert.equal((await request(`sessions/${demo.id}`, 'DELETE')).status, 409);
      assert.equal((await request(`sessions/${demo.id}/stop`, 'POST')).status, 204);
      assert.equal((await request(`sessions/${demo.id}`, 'DELETE')).status, 204);
    },
  );
  let phone;
  await t.test(
    'signed Twilio callbacks require correct call identity and do not expose media tokens',
    async () => {
      const sid = 'AC' + 'a'.repeat(32),
        token = 'unit-twilio-token',
        publicUrl = 'https://example.ngrok-free.app';
      await configStore.save({
        twilioSid: sid,
        twilioToken: token,
        fromNumber: '+13125550123',
        publicUrl,
      });
      const response = await request('sessions', 'POST', {
        mode: 'phone',
        company: 'Clinic',
        goal: 'Cancel my appointment',
        to: '+13125550124',
        confirmed: true,
      });
      assert.equal(response.status, 201);
      const text = await response.text();
      phone = JSON.parse(text);
      assert.ok(!text.includes(store.get(phone.id).mediaToken));
      assert.ok(!text.includes(token));
      const path = `/twilio/status/${phone.id}`;
      const send = (body) => {
        const signature = twilio.getExpectedTwilioSignature(token, `${publicUrl}${path}`, body);
        return fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Twilio-Signature': signature,
          },
          body: new URLSearchParams(body),
        });
      };
      assert.equal((await fetch(`${base}${path}`, { method: 'POST', body: '' })).status, 403);
      assert.equal((await send({ CallSid: 'CA-wrong', CallStatus: 'ringing' })).status, 403);
      assert.equal((await send({ CallSid: 'CA123', CallStatus: 'ringing' })).status, 204);
      assert.equal(store.get(phone.id).status, 'ringing');
      assert.equal(
        (await request(`sessions/${phone.id}/transcript`, 'POST', { text: 'Forged transcript' }))
          .status,
        400,
      );
    },
  );
  await t.test('media WebSocket requires both signed handshake and per-call token', async () => {
    const session = store.get(phone.id),
      path = `/media/${phone.id}/${session.mediaToken}`;
    const rejected = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const [error] = await once(rejected, 'error');
    assert.match(error.message, /403/);
    const signature = twilio.getExpectedTwilioSignature(
      session.config.twilioToken,
      `${session.config.publicUrl}${path}`,
      {},
    );
    const accepted = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { 'X-Twilio-Signature': signature },
    });
    await once(accepted, 'open');
    accepted.send(
      JSON.stringify({
        event: 'start',
        start: { callSid: 'CA123', accountSid: session.config.twilioSid, streamSid: 'MZ123' },
      }),
    );
    const incoming = once(inputEvents, 'append');
    accepted.send(
      JSON.stringify({ event: 'media', streamSid: 'MZ123', media: { payload: '/w==' } }),
    );
    const [pcm] = await incoming;
    assert.deepEqual(pcm, Buffer.alloc(6));
    accepted.close();
    await once(accepted, 'close');
  });
  await t.test('explicit End calls the provider hangup and cleans up', async () => {
    assert.equal((await request(`sessions/${phone.id}/stop`, 'POST')).status, 204);
    assert.equal(hangups, 1);
  });
  await t.test(
    'browser audio requires local origin and session cookie, accepts PCM, and flushes on microphone stop',
    async () => {
      const response = await request('sessions', 'POST', {
        mode: 'browser',
        company: 'Clinic',
        goal: 'Cancel my appointment',
        confirmed: true,
      });
      assert.equal(response.status, 201);
      const browser = await response.json(),
        path = `/browser/${browser.id}`;
      const rejected = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: { Cookie: cookie, Origin: 'https://attacker.example' },
      });
      const [error] = await once(rejected, 'error');
      assert.match(error.message, /403/);
      const accepted = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: { Cookie: cookie, Origin: origin },
      });
      const ready = once(accepted, 'message');
      await once(accepted, 'open');
      const [message] = await ready;
      assert.equal(JSON.parse(message.toString()).type, 'ready');
      const incoming = once(inputEvents, 'append'),
        bytes = Buffer.from([0, 0, 255, 127]);
      accepted.send(bytes);
      const [pcm] = await incoming;
      assert.deepEqual(pcm, bytes);
      const flushed = once(inputEvents, 'flush');
      accepted.send(JSON.stringify({ type: 'flush' }));
      await flushed;
      accepted.close();
      await once(accepted, 'close');
      await request(`sessions/${browser.id}/stop`, 'POST');
    },
  );
});
