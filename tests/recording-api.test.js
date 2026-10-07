import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import twilio from 'twilio';
import { createApp } from '../src/app.js';
import { ConfigStore } from '../src/config.js';
import { RecordingStore } from '../src/recordings.js';
import { CallSession } from '../src/session.js';
import { DemoBrain } from '../src/providers/demo.js';

test('signed completion callback saves audio locally and its playback API is localhost-only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'call-recording-api-'));
  const configStore = await new ConfigStore(join(directory, 'config'), {}).load();
  const config = {
    openaiKey: 'test-key',
    elevenKey: 'test-key',
    voiceId: 'voice123',
    twilioSid: 'AC' + 'a'.repeat(32),
    twilioToken: 'test-token',
    fromNumber: '+13125550123',
    publicUrl: 'https://example.com',
  };
  await configStore.save(config);
  const bytes = Buffer.from('ID3test-local-audio'),
    callSid = 'CA' + 'b'.repeat(32),
    recordingSid = 'RE' + 'c'.repeat(32);
  const recordingStore = await new RecordingStore(
    join(directory, 'audio'),
    async () => new Response(bytes),
  ).load();
  const port = randomInt(20000, 50000),
    base = `http://127.0.0.1:${port}`;
  const { server, store, sockets, drainRecordings } = createApp({
    configStore,
    recordingStore,
    port,
    sessionFactory: (brief, current) =>
      new CallSession(brief, current, {
        brain: new DemoBrain(),
        voice: null,
        phone: { dial: async () => callSid, hangup: async () => {} },
      }),
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await drainRecordings();
    for (const session of store.sessions.values()) session.cleanup();
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const page = await fetch(base),
    cookie = page.headers.get('set-cookie').split(';')[0];
  const api = (path, method = 'GET', body) =>
    fetch(`${base}/api/${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: `http://localhost:${port}`,
        'Content-Type': 'application/json',
      },
      body: body && JSON.stringify(body),
    });
  const sessionResponse = await api('sessions', 'POST', {
    mode: 'phone',
    company: 'Clinic',
    goal: 'Cancel appointment',
    to: '+13125550124',
    confirmed: true,
    record: true,
  });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();
  const path = `/twilio/recording/${session.id}`,
    body = {
      AccountSid: config.twilioSid,
      CallSid: callSid,
      RecordingSid: recordingSid,
      RecordingStatus: 'completed',
      RecordingDuration: '12',
      RecordingUrl: 'https://attacker.example/credentials',
    };
  const callback = (values, signed = true) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(signed
          ? {
              'X-Twilio-Signature': twilio.getExpectedTwilioSignature(
                config.twilioToken,
                `${config.publicUrl}${path}`,
                values,
              ),
            }
          : {}),
      },
      body: new URLSearchParams(values),
    });
  assert.equal((await callback(body, false)).status, 403);
  assert.equal((await callback({ ...body, CallSid: 'CA' + 'd'.repeat(32) })).status, 403);
  assert.equal((await callback(body)).status, 204);
  await drainRecordings();
  const list = await (await api('recordings')).json();
  assert.equal(list.directory, recordingStore.directory);
  assert.equal(list.recordings[0].status, 'ready');
  assert.deepEqual(await readFile(await recordingStore.audioPath(session.id)), bytes);
  assert.equal((await fetch(`${base}/api/recordings/${session.id}/audio`)).status, 403);
  assert.equal(
    (
      await fetch(`${base}/api/recordings/${session.id}/audio`, {
        headers: { Cookie: cookie, 'X-Forwarded-For': '203.0.113.1' },
      })
    ).status,
    403,
  );
  const playback = await api(`recordings/${session.id}/audio`);
  assert.match(playback.headers.get('content-type'), /audio\/mpeg/);
  assert.deepEqual(Buffer.from(await playback.arrayBuffer()), bytes);
  assert.equal(
    (await api(`recordings/${session.id}/audio?download=1`)).headers
      .get('content-disposition')
      .startsWith('attachment;'),
    true,
  );
  await api(`sessions/${session.id}/stop`, 'POST');
  await api(`sessions/${session.id}`, 'DELETE');
  assert.equal(recordingStore.list().length, 1); // Transcript deletion never removes audio.
  assert.equal((await api(`recordings/${session.id}`, 'DELETE')).status, 204);
  assert.equal(recordingStore.list().length, 0);
});
