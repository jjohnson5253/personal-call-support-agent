import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpenAIBrain, RealtimeTranscriber, agentInstructions } from '../src/providers/openai.js';
import { ElevenLabsVoice } from '../src/providers/elevenlabs.js';
import { TwilioPhone } from '../src/providers/twilio.js';

test('brain uses structured actions, bounded history, and disables Responses storage', async () => {
  let request;
  const client = {
    responses: {
      create: async (value) => {
        request = value;
        return {
          output_text: JSON.stringify({
            action: 'wait',
            text: '',
            digits: '',
            summary: '',
            outcome: 'unknown',
          }),
        };
      },
    },
  };
  const brain = new OpenAIBrain({ model: 'test-model' }, client);
  await brain.decide(
    { company: 'Clinic', goal: 'Cancel', details: '' },
    Array.from({ length: 150 }, () => ({ role: 'company', text: 'Hold' })),
  );
  assert.equal(request.store, false);
  assert.equal(request.input.length, 100);
  assert.equal(request.text.format.strict, true);
  assert.match(agentInstructions({ company: 'Clinic' }), /Never claim to be the user/);
});
test('ElevenLabs speech streams headerless telephony bytes and keeps keys in headers', async () => {
  const chunks = [];
  let captured;
  const voice = new ElevenLabsVoice(
    { elevenKey: 'test-secret', voiceId: 'voice123', speechModel: 'test-speech' },
    async (url, options) => {
      captured = { url, options };
      return new Response(Uint8Array.from([255, 128, 0]), { status: 200 });
    },
  );
  await voice.speak('Hello', 'ulaw_8000', (chunk) => chunks.push(chunk));
  assert.ok(!captured.url.includes('test-secret'));
  assert.equal(captured.options.headers['xi-api-key'], 'test-secret');
  assert.match(captured.url, /output_format=ulaw_8000/);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([255, 128, 0]));
});
test('ElevenLabs failures do not expose provider response bodies', async () => {
  const voice = new ElevenLabsVoice(
    { voiceId: 'voice' },
    async () => new Response('sensitive body', { status: 401 }),
  );
  await assert.rejects(
    voice.speak('text', 'pcm_24000', () => {}),
    (error) => /401/.test(error.message) && !/sensitive/.test(error.message),
  );
});
test('Twilio call creation sets server callbacks and an independent provider duration limit', async () => {
  let request;
  const phone = new TwilioPhone(
    { fromNumber: '+13125550123', publicUrl: 'https://example.com' },
    {
      calls: {
        create: async (input) => {
          request = input;
          return { sid: 'CA123' };
        },
      },
    },
  );
  const sid = await phone.dial({
    id: 'id',
    mediaToken: 'token',
    brief: { to: '+13125550124', maxMinutes: 45 },
  });
  assert.equal(sid, 'CA123');
  assert.equal(request.timeLimit, 2700);
  assert.equal(request.statusCallbackMethod, 'POST');
  assert.match(request.twiml, /<Connect>/);
  assert.equal(request.to, '+13125550124');
  assert.equal(request.record, undefined);
  await phone.dial({
    id: 'recorded-call',
    mediaToken: 'token',
    brief: { to: '+13125550124', maxMinutes: 45, record: true },
  });
  assert.equal(request.record, true);
  assert.equal(request.recordingChannels, 'dual');
  assert.equal(request.recordingTrack, 'both');
  assert.equal(
    request.recordingStatusCallback,
    'https://example.com/twilio/recording/recorded-call',
  );
  assert.deepEqual(request.recordingStatusCallbackEvent, ['completed', 'absent']);
});
test('transcriber waits for session.updated, bounds initial audio, commits local VAD, and closes intentionally', async () => {
  class Socket extends EventEmitter {
    static latest;
    constructor(url, options) {
      super();
      this.readyState = 1;
      this.sent = [];
      Socket.latest = this;
      this.url = url;
      this.options = options;
    }
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.emit('close');
    }
  }
  const transcripts = [],
    errors = [];
  const transcriber = new RealtimeTranscriber(
    { openaiKey: 'test-key', transcriptionModel: 'gpt-live-transcribe' },
    { onTranscript: (text) => transcripts.push(text), onError: (error) => errors.push(error) },
    Socket,
  );
  const connecting = transcriber.connect(),
    socket = Socket.latest;
  socket.emit('open');
  assert.equal(socket.sent[0].session.audio.input.turn_detection, null);
  for (let i = 0; i < 20; i++) transcriber.append(Buffer.alloc(24000));
  assert.ok(transcriber.pendingBytes <= 240000);
  socket.emit('message', JSON.stringify({ type: 'session.updated' }));
  await connecting;
  assert.equal(transcriber.ready, true);
  assert.equal(transcriber.pendingBytes, 0);
  const loud = Buffer.alloc(960);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(8000, i);
  for (let i = 0; i < 10; i++) transcriber.append(loud);
  for (let i = 0; i < 40; i++) transcriber.append(Buffer.alloc(960));
  assert.ok(socket.sent.some((event) => event.type === 'input_audio_buffer.commit'));
  socket.emit(
    'message',
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Hello',
    }),
  );
  assert.deepEqual(transcripts, ['Hello']);
  for (let i = 0; i < 6; i++) transcriber.append(loud);
  transcriber.flush();
  assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.commit');
  assert.equal(transcriber.detector.speaking, false);
  transcriber.flush();
  assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.clear');
  transcriber.close();
  assert.equal(errors.length, 0);
});
test('transcription completion events are delivered in audio commit order', async () => {
  class Socket extends EventEmitter {
    static latest;
    constructor() {
      super();
      this.readyState = 1;
      Socket.latest = this;
    }
    send() {}
    close() {
      this.emit('close');
    }
  }
  const transcripts = [];
  const transcriber = new RealtimeTranscriber(
    { openaiKey: 'test' },
    { onTranscript: (text) => transcripts.push(text), onError: () => {} },
    Socket,
  );
  const connecting = transcriber.connect(),
    socket = Socket.latest;
  const emit = (event) => socket.emit('message', JSON.stringify(event));
  socket.emit('open');
  emit({ type: 'session.updated' });
  await connecting;
  for (const item_id of ['first', 'second'])
    emit({ type: 'input_audio_buffer.committed', item_id });
  emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'second',
    transcript: 'Second turn',
  });
  assert.deepEqual(transcripts, []);
  emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'first',
    transcript: 'First turn',
  });
  assert.deepEqual(transcripts, ['First turn', 'Second turn']);
  transcriber.close();
});
