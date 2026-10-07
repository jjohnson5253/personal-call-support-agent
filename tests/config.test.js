import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/config.js';

test('settings persist server-side, preserve blank secrets, and return redacted readiness', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'call-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new ConfigStore(directory, {}).load();
  await store.save({
    openaiKey: 'test-openai',
    elevenKey: 'test-eleven',
    twilioToken: 'test-twilio',
    voiceId: 'voice123',
  });
  await store.save({ openaiKey: '', elevenKey: '' });
  const publicSettings = store.public();
  assert.equal(publicSettings.browserReady, true);
  assert.equal(publicSettings.phoneReady, false);
  assert.equal(publicSettings.openaiKeyConfigured, true);
  for (const key of ['openaiKey', 'elevenKey', 'twilioToken'])
    assert.equal(key in publicSettings, false);
  const loaded = await new ConfigStore(directory, {}).load();
  assert.equal(loaded.get().openaiKey, 'test-openai');
  assert.equal((await stat(join(directory, 'settings.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  await loaded.clear();
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')), {});
});
test('environment overrides saved values and is not erased by clear', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'call-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new ConfigStore(directory, { OPENAI_API_KEY: 'environment-key' }).load();
  await store.save({ openaiKey: 'saved-key' });
  assert.equal(store.get().openaiKey, 'environment-key');
  assert.ok(store.public().environmentFields.includes('openaiKey'));
  await store.clear();
  assert.equal(store.get().openaiKey, 'environment-key');
});
test('concurrent settings updates serialize and preserve both patches', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'call-concurrent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new ConfigStore(directory, {}).load();
  await Promise.all([
    store.save({ openaiKey: 'test-openai' }),
    store.save({ elevenKey: 'test-eleven' }),
  ]);
  assert.equal(store.get().openaiKey, 'test-openai');
  assert.equal(store.get().elevenKey, 'test-eleven');
});
