import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RecordingStore } from '../src/recordings.js';

const config = { twilioSid: 'AC' + 'a'.repeat(32), twilioToken: 'unit-secret' };
const callSid = 'CA' + 'b'.repeat(32),
  recordingSid = 'RE' + 'c'.repeat(32);
const audio = Buffer.from('ID3\x00\x00\x00test-audio');
function event(patch = {}) {
  return {
    AccountSid: config.twilioSid,
    CallSid: callSid,
    RecordingSid: recordingSid,
    RecordingStatus: 'completed',
    RecordingDuration: '45',
    ...patch,
  };
}
async function fixture(t, fetcher = async () => new Response(audio)) {
  const directory = await mkdtemp(join(tmpdir(), 'call-recordings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new RecordingStore(directory, fetcher).load();
  const session = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    brief: { company: 'Clinic' },
    config,
  };
  await store.prepare(session);
  await store.setCall(session.id, callSid);
  return { store, session, directory };
}
test('completed recording downloads to a real protected file and persists across restart', async (t) => {
  let captured;
  const { store, session, directory } = await fixture(t, async (url, options) => {
    captured = { url, options };
    return new Response(audio);
  });
  await store.accept(session.id, event({ RecordingUrl: 'https://attacker.invalid/steal' }), config);
  const path = await store.audioPath(session.id);
  assert.deepEqual(await readFile(path), audio);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(
    captured.url,
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Recordings/${recordingSid}.mp3`,
  );
  assert.equal(captured.options.redirect, 'error');
  assert.match(captured.options.headers.Authorization, /^Basic /);
  assert.ok(
    !(await readFile(join(directory, `${session.id}.json`), 'utf8')).includes(config.twilioToken),
  );
  const restarted = await new RecordingStore(directory).load();
  assert.equal(restarted.list()[0].status, 'ready');
  assert.equal(await restarted.audioPath(session.id), path);
});
test('duplicate callbacks share one download and never overwrite a completed file', async (t) => {
  let requests = 0;
  const { store, session } = await fixture(t, async () => {
    requests++;
    return new Response(audio);
  });
  await Promise.all([
    store.accept(session.id, event(), config),
    store.accept(session.id, event(), config),
  ]);
  await store.accept(session.id, event(), config);
  assert.equal(requests, 1);
});
test('wrong call/account/recording identity and malformed IDs cannot request remote files', async (t) => {
  let requests = 0;
  const { store, session } = await fixture(t, async () => {
    requests++;
    return new Response(audio);
  });
  for (const patch of [
    { AccountSid: 'AC' + 'd'.repeat(32) },
    { CallSid: 'CA' + 'd'.repeat(32) },
    { RecordingSid: '../secret' },
  ])
    await assert.rejects(store.accept(session.id, event(patch), config));
  assert.throws(() => store.get('../../secret'));
  assert.equal(requests, 0);
  await store.accept(session.id, event(), config);
  await assert.rejects(
    store.accept(session.id, event({ RecordingSid: 'RE' + 'd'.repeat(32) }), config),
  );
});
test('failed and non-audio downloads leave no playable or partial file and can retry', async (t) => {
  let valid = false;
  const { store, session, directory } = await fixture(
    t,
    async () => new Response(valid ? audio : '<html>not audio</html>'),
  );
  await assert.rejects(store.accept(session.id, event(), config), /download failed/);
  assert.equal(store.get(session.id).status, 'failed');
  assert.ok(!(await readdir(directory)).some((name) => /\.(part|mp3)$/.test(name)));
  await assert.rejects(store.audioPath(session.id));
  valid = true;
  await store.retry(session.id, config);
  assert.equal(store.get(session.id).status, 'ready');
});
test('truncated streaming downloads clean up, and interrupted jobs expose retry after restart', async (t) => {
  const { store, session, directory } = await fixture(
    t,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(audio);
            controller.error(new Error('interrupted'));
          },
        }),
      ),
  );
  await assert.rejects(store.accept(session.id, event(), config));
  assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.part')));
  await store.save({ ...store.get(session.id), status: 'downloading' });
  const restarted = await new RecordingStore(directory).load();
  assert.equal(restarted.get(session.id).status, 'failed');
});
test('recovery can fetch the exact call recording when its completion callback was missed', async (t) => {
  const requested = [];
  const { store, session } = await fixture(t, async (url) => {
    requested.push(url);
    if (url.includes('Recordings.json'))
      return Response.json({
        recordings: [
          {
            sid: recordingSid,
            call_sid: callSid,
            account_sid: config.twilioSid,
            status: 'completed',
            duration: '45',
          },
        ],
      });
    return new Response(audio);
  });
  await store.retry(session.id, config);
  assert.equal(store.get(session.id).status, 'ready');
  assert.match(requested[0], new RegExp(`/Calls/${callSid}/Recordings.json`));
});
test('audio serving rejects symlinks and size mismatches; delete touches only owned files', async (t) => {
  const { store, session, directory } = await fixture(t);
  await store.accept(session.id, event(), config);
  const path = await store.audioPath(session.id);
  const unrelated = join(directory, 'keep.txt');
  await writeFile(unrelated, 'keep');
  await rm(path);
  await symlink(unrelated, path);
  await assert.rejects(store.audioPath(session.id));
  await store.remove(session.id);
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  assert.equal(store.list().length, 0);
});
test('pending recordings cannot be deleted and absent recordings never appear ready', async (t) => {
  const { store, session } = await fixture(t);
  await assert.rejects(store.remove(session.id), /pending/);
  await store.accept(session.id, event({ RecordingStatus: 'absent' }), config);
  assert.equal(store.get(session.id).status, 'failed');
  await store.remove(session.id);
});
