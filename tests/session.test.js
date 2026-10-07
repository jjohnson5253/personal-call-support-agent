import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CallSession, SessionStore } from '../src/session.js';
import { DemoBrain } from '../src/providers/demo.js';

const brief = {
  mode: 'demo',
  company: 'Clinic',
  goal: 'Cancel my appointment',
  details: '',
  maxMinutes: 1,
};
const speak = {
  action: 'speak',
  text: 'Please cancel the appointment.',
  digits: '',
  summary: '',
  outcome: 'unknown',
};
function trackedSession(t, dependencies = {}, override = {}) {
  const session = new CallSession(
    { ...brief, ...override },
    {},
    { brain: new DemoBrain(), ...dependencies },
  );
  t.after(() => session.cleanup());
  return session;
}
async function turn(session, text) {
  session.hear(text);
  clearTimeout(session.debounce);
  await session.process();
}

test('first spoken turn discloses AI; demo navigates IVR, waits, asks privately, and confirms only explicit success', async (t) => {
  const session = trackedSession(t);
  await session.start();
  await turn(session, 'For appointments, press 1.');
  assert.equal(session.history.at(-1).text, 'Pressed 1');
  await turn(session, 'Please hold.');
  assert.equal(session.history.filter((item) => item.role === 'agent').length, 0);
  await turn(session, 'Hello, how can I help?');
  assert.match(session.history.at(-1).text, /I’m an AI assistant/);
  await turn(session, 'What is your date of birth?');
  assert.equal(session.status, 'needs_user');
  assert.ok(session.question);
  assert.equal(session.history.at(-1).role, 'company');
  session.guide('The caller will verify directly.');
  await delay(10);
  assert.equal(session.question, '');
  await turn(session, 'Your appointment has been canceled. Confirmation DEMO-123.');
  assert.equal(session.ended, true);
  assert.equal(session.outcome, 'completed');
  assert.match(session.summary, /DEMO-123/);
});
test('manual hang-up never fabricates a successful outcome', async (t) => {
  const session = trackedSession(t);
  await session.start();
  await session.stop();
  assert.equal(session.outcome, 'unknown');
  assert.match(session.summary, /No completed outcome/);
});
test('pause cancels a pending decision and resume retries with current context', async (t) => {
  let resolve,
    count = 0;
  const brain = {
    decide: () => {
      count++;
      return count === 1
        ? new Promise((r) => {
            resolve = r;
          })
        : Promise.resolve(speak);
    },
  };
  const session = trackedSession(t, { brain });
  session.hear('Hello');
  clearTimeout(session.debounce);
  const work = session.process();
  session.pause(true);
  resolve(speak);
  await work;
  assert.equal(
    session.history.some((item) => item.role === 'agent'),
    false,
  );
  session.pause(false);
  await delay(10);
  assert.equal(session.history.filter((item) => item.role === 'agent').length, 1);
});
test('new company turn invalidates a stale model decision', async (t) => {
  let resolve,
    count = 0;
  const brain = {
    decide: () =>
      ++count === 1
        ? new Promise((r) => {
            resolve = r;
          })
        : Promise.resolve({ ...speak, text: 'Answer to the latest question.' }),
  };
  const session = trackedSession(t, { brain });
  session.hear('First question');
  clearTimeout(session.debounce);
  const work = session.process();
  session.hear('Second question');
  clearTimeout(session.debounce);
  resolve(speak);
  await work;
  await delay(10);
  assert.equal(session.history.filter((item) => item.role === 'agent').length, 1);
  assert.match(session.history.at(-1).text, /latest question/);
});
test('barge-in cancels model work until the remote speech turn completes', async (t) => {
  let resolve;
  const session = trackedSession(t, {
    brain: {
      decide: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
  });
  session.hear('First question');
  clearTimeout(session.debounce);
  const work = session.process();
  session.speechStarted();
  resolve(speak);
  await work;
  assert.equal(session.remoteSpeaking, true);
  assert.equal(
    session.history.some((item) => item.role === 'agent'),
    false,
  );
  session.speechEnded();
});
test('provider errors pause instead of silently ending an active call', async (t) => {
  const session = trackedSession(t, {
    brain: {
      decide: async () => {
        throw new Error('sensitive provider body');
      },
    },
  });
  await turn(session, 'Hello');
  assert.equal(session.status, 'paused');
  assert.equal(session.ended, false);
  assert.ok(!JSON.stringify(session.events).includes('sensitive provider body'));
});
test('only one active session is allowed; memory and audio event retention are bounded', (t) => {
  const store = new SessionStore(),
    session = trackedSession(t);
  store.add(session);
  assert.throws(() => store.add(trackedSession(t)), /End the current/);
  for (let i = 0; i < 1000; i++) session.publish('audio', { payload: 'privateaudio' });
  assert.equal(session.events.length, 0);
  for (let i = 0; i < 600; i++) session.turn('company', `${i}`);
  assert.equal(session.events.length, 500);
  assert.equal(session.history.length, 200);
});
test('Twilio hang-up failure keeps the session retryable', async (t) => {
  let failed = true;
  const phone = {
    dial: async () => 'CA123',
    hangup: async () => {
      if (failed) throw new Error('failure');
    },
  };
  const session = trackedSession(t, { phone }, { mode: 'phone' });
  await session.start();
  await assert.rejects(session.stop(), /Hang-up/);
  assert.equal(session.ended, false);
  assert.equal(session.paused, true);
  failed = false;
  await session.stop();
  assert.equal(session.ended, true);
});
test('End during dialing waits for the call SID and then hangs up', async (t) => {
  let resolve, hungupSid;
  const phone = {
    dial: () =>
      new Promise((r) => {
        resolve = r;
      }),
    hangup: async (session) => {
      hungupSid = session.callSid;
    },
  };
  const session = trackedSession(t, { phone }, { mode: 'phone' });
  const starting = session.start(),
    stopping = session.stop();
  resolve('CA-created');
  await Promise.all([starting, stopping]);
  assert.equal(hungupSid, 'CA-created');
  assert.equal(session.ended, true);
});
test('Twilio completion callback closes audio but keeps outcome unknown without confirmation', async (t) => {
  const session = trackedSession(t);
  await session.start();
  session.providerStatus('completed');
  assert.equal(session.ended, true);
  assert.equal(session.outcome, 'unknown');
  assert.match(session.summary, /does not confirm/);
});
test('a terminal callback racing a rejected hang-up does not reopen the ended session', async (t) => {
  const phone = {
    dial: async () => 'CA123',
    hangup: async (session) => {
      session.providerStatus('completed');
      throw new Error('Already completed');
    },
  };
  const session = trackedSession(t, { phone }, { mode: 'phone' });
  await session.start();
  await session.stop();
  assert.equal(session.status, 'completed');
  assert.equal(session.ended, true);
});
