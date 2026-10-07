import { BrowserAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const terminal = new Set(['ended', 'completed', 'failed', 'busy', 'no-answer', 'canceled']);
const labels = {
  ready: 'Ready',
  dialing: 'Dialing',
  ringing: 'Ringing',
  queued: 'Queued',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  paused: 'Agent paused',
  needs_user: 'Needs your input',
  reconnecting: 'Sending keypad input',
  ended: 'Session ended',
  completed: 'Call ended',
  failed: 'Call failed',
  busy: 'Line busy',
  'no-answer': 'No answer',
  canceled: 'Canceled',
};
let session,
  settings,
  events,
  pendingBrief,
  microphoneActive = false;
const audio = new BrowserAudio((message) => {
  if (message.includes('disconnected') || message.includes('failed')) {
    microphoneActive = false;
    $('microphone').textContent = 'Reconnect audio';
    notice(message);
  }
});

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let data;
    try {
      data = await response.json();
    } catch {
      /* Non-JSON provider response. */
    }
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? null : response.json();
}
function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  if (message && $('settings-dialog').open) $('settings-result').textContent = message;
  if (message && $('review-dialog').open) $('review-result').textContent = message;
}
async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    notice(error.message);
  }
}
function isActive() {
  return session && !terminal.has(session.status);
}

const descriptions = {
  demo: 'A scripted agent you can try right now. Play the company using the sample responses.',
  browser:
    'Test real AI with typed company replies or your microphone. Speech plays through your speakers. This doesn’t dial a phone number.',
  phone:
    'Your agent dials from your Twilio number. Keep your computer and public tunnel running. Provider charges apply.',
};
$('mode').addEventListener('change', () => {
  $('mode-description').textContent = descriptions[$('mode').value];
  $('to').required = $('mode').value === 'phone';
});
const examples = {
  appointment: {
    company: 'My physical therapy clinic',
    goal: 'Cancel my physical therapy appointment on Friday at 2 pm. Ask for confirmation. If there is a cancellation fee, ask me before accepting it.',
  },
  flight: {
    company: 'My airline',
    goal: 'Ask whether my flight allows a carry-on bag and what the size limits are. Do not buy anything or change my reservation.',
  },
  benefits: {
    company: 'My benefits provider',
    goal: 'Ask what documents I need to submit for reimbursement and the submission deadline. Do not change my coverage or make commitments.',
  },
};
document.querySelectorAll('[data-example]').forEach((button) =>
  button.addEventListener('click', () => {
    const example = examples[button.dataset.example];
    $('company').value = example.company;
    $('goal').value = example.goal;
    $('goal').focus();
  }),
);

function renderSettings() {
  for (const key of ['openaiKey', 'elevenKey', 'twilioToken']) {
    $(key).value = '';
    $(`${key}-state`).textContent = settings[`${key}Configured`] ? 'Saved ✓' : '';
    $(key).placeholder = settings[`${key}Configured`]
      ? 'Leave blank to keep saved key'
      : 'Paste your credential';
  }
  for (const key of [
    'voiceId',
    'twilioSid',
    'fromNumber',
    'publicUrl',
    'model',
    'transcriptionModel',
    'speechModel',
  ])
    $(key).value = settings[key] || '';
  for (const element of $('settings-form').elements)
    if (element.name) element.disabled = settings.environmentFields.includes(element.name);
}
$('open-settings').addEventListener('click', () => {
  renderSettings();
  $('settings-result').textContent = '';
  $('settings-dialog').showModal();
});
document
  .querySelectorAll('[data-close]')
  .forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  attempt(async () => {
    const button = event.submitter;
    button.disabled = true;
    try {
      settings = await api('settings', {
        method: 'PUT',
        body: Object.fromEntries(
          [...new FormData(event.target)].map(([key, value]) => [key, value.trim()]),
        ),
      });
      renderSettings();
      $('settings-result').textContent = settings.phoneReady
        ? 'Settings saved. Ready for a real call.'
        : settings.browserReady
          ? 'Settings saved. Browser rehearsal is ready.'
          : 'Settings saved. Add both API keys and choose a voice to use real AI.';
      notice('');
    } finally {
      button.disabled = false;
    }
  });
});
$('clear-settings').addEventListener('click', () =>
  attempt(async () => {
    settings = await api('settings', { method: 'DELETE' });
    renderSettings();
    $('settings-result').textContent =
      'Saved settings cleared. Environment credentials remain active if configured.';
  }),
);
$('load-voices').addEventListener('click', () =>
  attempt(async () => {
    $('load-voices').disabled = true;
    try {
      const voices = await api('voices'),
        picker = $('voice-picker');
      picker.replaceChildren(
        new Option('Choose a voice…', ''),
        ...voices.map(
          (voice) =>
            new Option(`${voice.name}${voice.category === 'cloned' ? ' · cloned' : ''}`, voice.id),
        ),
      );
      picker.hidden = false;
    } finally {
      $('load-voices').disabled = false;
    }
  }),
);
$('voice-picker').addEventListener('change', () => {
  if (!$('voiceId').disabled) $('voiceId').value = $('voice-picker').value;
});

$('brief-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (isActive()) return notice('End the current session before starting another.');
  const mode = $('mode').value;
  if (mode !== 'demo' && !settings.browserReady) {
    notice('Connect OpenAI and ElevenLabs and choose a voice in Settings.');
    renderSettings();
    $('settings-dialog').showModal();
    return;
  }
  if (mode === 'phone' && !settings.phoneReady) {
    notice('Add your Twilio credentials, phone number, and tunnel URL in Settings.');
    renderSettings();
    $('settings-dialog').showModal();
    return;
  }
  pendingBrief = {
    mode,
    company: $('company').value.trim(),
    goal: $('goal').value.trim(),
    details: $('details').value.trim(),
    to: $('to').value.replace(/[\s()-]/g, ''),
    maxMinutes: Number($('maxMinutes').value),
    confirmed: true,
  };
  if (mode !== 'phone') pendingBrief.to = '';
  if (mode === 'phone' && !/^\+[1-9]\d{7,14}$/.test(pendingBrief.to))
    return notice('Use international phone format, such as +13125550123.');
  $('review-company').textContent = pendingBrief.company;
  $('review-goal').textContent = pendingBrief.goal;
  $('review-details').textContent = pendingBrief.details || 'No extra details provided.';
  $('review-connection').textContent =
    mode === 'phone'
      ? `${settings.fromNumber} → ${pendingBrief.to}`
      : mode === 'browser'
        ? 'Browser rehearsal — real AI, no phone call'
        : 'Demo — scripted AI, no phone call';
  $('review-limit').textContent = `${pendingBrief.maxMinutes} minutes`;
  $('confirmed').checked = false;
  $('start-call').disabled = true;
  $('review-result').textContent = '';
  $('start-call').textContent = mode === 'phone' ? 'Place call →' : 'Start rehearsal →';
  $('review-dialog').showModal();
  notice('');
});
$('confirmed').addEventListener('change', () => {
  $('start-call').disabled = !$('confirmed').checked;
});
$('start-call').addEventListener('click', () =>
  attempt(async () => {
    if (!$('confirmed').checked || !pendingBrief) return;
    $('start-call').disabled = true;
    try {
      // Resume audio in the user gesture before waiting for the network.
      if (pendingBrief.mode === 'browser') await audio.init();
      const next = await api('sessions', { method: 'POST', body: pendingBrief });
      attachSession(next);
      $('review-dialog').close();
      if (next.brief.mode === 'browser') await audio.connect(next.id);
    } finally {
      $('start-call').disabled = !$('confirmed').checked;
    }
  }),
);

function renderTurn(turn) {
  const node = document.createElement('div');
  node.className = `turn ${turn.role}`;
  const label = document.createElement('div');
  label.className = 'turn-label';
  label.textContent =
    { company: 'Company', agent: 'Your agent', user: 'You · private', action: 'Keypad' }[
      turn.role
    ] || turn.role;
  const time = document.createElement('time');
  time.textContent = new Date(turn.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  label.append(time);
  const content = document.createElement('div');
  content.className = 'turn-content';
  content.textContent = turn.text;
  node.append(label, content);
  $('transcript').append(node);
  $('transcript').scrollTop = $('transcript').scrollHeight;
}
function renderSession() {
  $('empty-state').hidden = Boolean(session);
  $('active-session').hidden = !session;
  if (!session) {
    $('status').textContent = 'Ready when you are';
    $('status').classList.remove('active');
    $('review-call').disabled = false;
    return;
  }
  const active = isActive();
  $('status').textContent = labels[session.status] || session.status;
  $('status').classList.toggle('active', active);
  $('session-company').textContent = session.brief.company;
  $('session-mode').textContent = {
    demo: 'Demo · no calls',
    browser: 'Browser rehearsal',
    phone: session.brief.to,
  }[session.brief.mode];
  $('review-call').disabled = active;
  $('pause-call').disabled = !active;
  $('pause-call').textContent = session.paused ? 'Resume agent' : 'Pause agent';
  $('stop-call').disabled = !active;
  $('stop-call').textContent = session.brief.mode === 'phone' ? 'End call' : 'End session';
  for (const element of [
    ...$('guide-form').elements,
    ...$('digits-form').elements,
    ...$('transcript-form').elements,
  ])
    element.disabled = !active;
  document.querySelectorAll('[data-line]').forEach((button) => {
    button.disabled = !active;
  });
  $('forget').disabled = active;
  $('question-box').hidden = !session.question || !active;
  $('question-text').textContent = session.question;
  $('summary-box').hidden = !session.summary;
  $('summary-text').textContent = session.summary;
  $('outcome-label').textContent =
    session.outcome === 'completed' ? 'REQUEST CONFIRMED' : 'CALL SUMMARY';
  $('rehearsal').hidden = session.brief.mode === 'phone';
  $('demo-buttons').hidden = session.brief.mode !== 'demo';
  $('microphone').hidden = session.brief.mode !== 'browser';
  $('microphone').disabled = !active;
  $('listen-label').textContent = session.brief.mode === 'demo' ? 'Hear demo voice' : 'Listen live';
  $('listen').disabled = session.brief.mode === 'browser';
  if (!active) {
    audio.stop();
    microphoneActive = false;
    $('microphone').textContent = 'Use microphone';
    speechSynthesis.cancel();
  }
}
function attachSession(next) {
  events?.close();
  audio.stop();
  microphoneActive = false;
  $('microphone').textContent = 'Use microphone';
  session = next;
  $('transcript').replaceChildren();
  next.history.forEach(renderTurn);
  renderSession();
  events = new EventSource(`/api/sessions/${next.id}/events`);
  events.addEventListener('snapshot', (event) => {
    const snapshot = JSON.parse(event.data);
    session = snapshot;
    $('transcript').replaceChildren();
    snapshot.history.forEach(renderTurn);
    renderSession();
  });
  events.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'transcript') {
      session.history.push(data.turn);
      renderTurn(data.turn);
    }
    if (data.type === 'status') {
      session.status = data.status;
      session.paused = data.paused;
    }
    if (data.type === 'question') session.question = data.text;
    if (data.type === 'summary') {
      session.summary = data.text;
      session.outcome = data.outcome;
    }
    if (data.type === 'error') notice(data.message);
    if (data.type === 'clear') {
      audio.clear();
      speechSynthesis.cancel();
    }
    if (data.type === 'demo_speech' && $('listen').checked) {
      const speech = new SpeechSynthesisUtterance(data.text);
      speech.rate = 1.05;
      speechSynthesis.speak(speech);
    }
    if (data.type === 'audio' && $('listen').checked) {
      const binary = atob(data.payload);
      audio.play(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    }
    if (!['audio', 'clear', 'note'].includes(data.type)) renderSession();
  };
  events.onerror = () =>
    notice(
      'Connection interrupted. The dashboard will reconnect. For real calls, check Twilio if the local server stopped.',
    );
}
$('pause-call').addEventListener('click', () =>
  attempt(() =>
    api(`sessions/${session.id}/pause`, { method: 'POST', body: { paused: !session.paused } }),
  ),
);
$('stop-call').addEventListener('click', () =>
  attempt(async () => {
    $('stop-call').disabled = true;
    try {
      await api(`sessions/${session.id}/stop`, { method: 'POST' });
    } finally {
      renderSession();
    }
  }),
);
$('guide-form').addEventListener('submit', (event) => {
  event.preventDefault();
  attempt(async () => {
    await api(`sessions/${session.id}/guide`, {
      method: 'POST',
      body: { text: $('guidance').value },
    });
    session.question = '';
    $('guidance').value = '';
    renderSession();
  });
});
$('digits-form').addEventListener('submit', (event) => {
  event.preventDefault();
  attempt(async () => {
    await api(`sessions/${session.id}/digits`, {
      method: 'POST',
      body: { digits: $('digits').value },
    });
    $('digits').value = '';
  });
});
$('transcript-form').addEventListener('submit', (event) => {
  event.preventDefault();
  attempt(async () => {
    await api(`sessions/${session.id}/transcript`, {
      method: 'POST',
      body: { text: $('company-line').value },
    });
    $('company-line').value = '';
  });
});
document.querySelectorAll('[data-line]').forEach((button) =>
  button.addEventListener('click', () =>
    attempt(() =>
      api(`sessions/${session.id}/transcript`, {
        method: 'POST',
        body: { text: button.dataset.line },
      }),
    ),
  ),
);
$('listen').addEventListener('change', () =>
  attempt(async () => {
    if ($('listen').checked) await audio.init();
    else {
      audio.clear();
      speechSynthesis.cancel();
    }
  }),
);
$('microphone').addEventListener('click', () =>
  attempt(async () => {
    if (microphoneActive) {
      audio.stopMicrophone();
      microphoneActive = false;
      $('microphone').textContent = 'Use microphone';
      return;
    }
    if (!audio.socket || audio.socket.readyState !== WebSocket.OPEN) {
      await audio.connect(session.id);
      notice('Audio reconnecting. Click Use microphone once connected.');
      $('microphone').textContent = 'Use microphone';
      return;
    }
    await audio.startMicrophone();
    microphoneActive = true;
    $('microphone').textContent = 'Mute microphone';
    notice('Microphone on. Play the company’s role; use headphones to avoid feedback.');
  }),
);
$('download').addEventListener('click', () => {
  const text = `Personal Call Support Agent\nCompany: ${session.brief.company}\nTask: ${session.brief.goal}\nMode: ${session.brief.mode}\nStarted: ${session.createdAt}\n\n${session.history.map((turn) => `[${turn.at}] ${turn.role}: ${turn.text}`).join('\n\n')}\n\nOutcome: ${session.outcome}\nSummary: ${session.summary || 'No outcome confirmed.'}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `call-${session.id}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('forget').addEventListener('click', () =>
  attempt(async () => {
    await api(`sessions/${session.id}`, { method: 'DELETE' });
    events?.close();
    session = null;
    renderSession();
    notice('Transcript deleted from local memory.');
  }),
);

await attempt(async () => {
  settings = await api('settings');
  const sessions = await api('sessions');
  const recent = sessions.find((item) => !terminal.has(item.status)) || sessions.at(-1);
  if (recent) {
    attachSession(recent);
    if (recent.brief.mode === 'browser' && !terminal.has(recent.status))
      notice('Browser rehearsal restored. Click Reconnect audio to continue listening.');
  }
});
