import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { OpenAIBrain } from './providers/openai.js';
import { ElevenLabsVoice } from './providers/elevenlabs.js';
import { TwilioPhone } from './providers/twilio.js';
import { DemoBrain } from './providers/demo.js';
import { decisionSchema, digitsSchema } from './validation.js';
import { muLawToPcm24 } from './audio.js';

export const terminalStatuses = new Set([
  'ended',
  'completed',
  'failed',
  'busy',
  'no-answer',
  'canceled',
]);
const disclosure =
  'I’m an AI assistant calling on behalf of the person who authorized this request. ';

export class CallSession extends EventEmitter {
  constructor(brief, config, dependencies = {}) {
    super();
    this.id = randomUUID();
    this.mediaToken = randomBytes(32).toString('hex');
    this.brief = brief;
    this.config = { ...config };
    this.createdAt = new Date().toISOString();
    this.status = 'ready';
    this.history = [];
    this.events = [];
    this.sequence = 0;
    this.historyRevision = 0;
    this.remoteSpeaking = false;
    this.paused = false;
    this.question = '';
    this.summary = '';
    this.outcome = 'unknown';
    this.thinking = false;
    this.dirty = false;
    this.disclosed = false;
    this.stopping = false;
    this.brain =
      dependencies.brain ?? (brief.mode === 'demo' ? new DemoBrain() : new OpenAIBrain(config));
    this.voice =
      'voice' in dependencies
        ? dependencies.voice
        : brief.mode === 'demo'
          ? null
          : new ElevenLabsVoice(config);
    this.phone = dependencies.phone ?? (brief.mode === 'phone' ? new TwilioPhone(config) : null);
  }

  get ended() {
    return terminalStatuses.has(this.status);
  }
  snapshot() {
    return {
      id: this.id,
      brief: this.brief,
      createdAt: this.createdAt,
      status: this.status,
      history: this.history,
      paused: this.paused,
      question: this.question,
      summary: this.summary,
      outcome: this.outcome,
      sequence: this.sequence,
    };
  }
  publish(type, data = {}) {
    const event = { sequence: ++this.sequence, type, at: new Date().toISOString(), ...data };
    // Keep a bounded transcript/event history; audio is never retained here.
    if (!['audio', 'clear'].includes(type)) {
      this.events.push(event);
      if (this.events.length > 500) this.events.shift();
    }
    this.emit('event', event);
    return event;
  }
  setStatus(status) {
    this.status = status;
    this.publish('status', { status, paused: this.paused });
  }
  turn(role, text) {
    const turn = { role, text, at: new Date().toISOString() };
    this.historyRevision++;
    this.history.push(turn);
    if (this.history.length > 200) this.history.shift();
    this.publish('transcript', { turn });
  }
  async start() {
    this.timer = setTimeout(() => {
      this.summary =
        'The configured call time limit was reached. Review the transcript; completion was not confirmed.';
      this.stop('ended').catch(() => {});
    }, this.brief.maxMinutes * 60000);
    this.timer.unref?.();
    if (!this.phone) {
      this.setStatus('listening');
      return;
    }
    this.setStatus('dialing');
    try {
      this.dialPromise = this.phone.dial(this).then((sid) => {
        this.callSid = sid;
        return sid;
      });
      await this.dialPromise;
    } catch {
      this.summary =
        'Twilio could not start the call. Check credentials, caller number, verified destinations, and geographic permissions.';
      this.publish('error', { message: this.summary });
      this.cleanup();
      this.setStatus('failed');
      throw new Error(this.summary);
    }
  }
  attachTransport(transport) {
    this.transport?.close?.();
    this.transport = transport;
    this.remoteSpeaking = false;
    if (!this.ended) this.setStatus('listening');
  }
  hear(text) {
    if (this.ended || this.stopping) return;
    this.turn('company', text);
    this.dirty = true;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.process(), 300);
  }
  interruptSpeech() {
    this.speechAbort?.abort();
    this.transport?.clear?.();
    this.publish('clear');
  }
  speechStarted() {
    this.remoteSpeaking = true;
    this.brainAbort?.abort();
    this.dirty = true;
    this.interruptSpeech();
  }
  speechEnded() {
    this.remoteSpeaking = false;
  }
  async process() {
    if (
      this.thinking ||
      this.remoteSpeaking ||
      this.reconnecting ||
      this.paused ||
      this.question ||
      this.ended ||
      this.stopping ||
      !this.dirty
    )
      return;
    this.thinking = true;
    this.dirty = false;
    this.brainAbort = new AbortController();
    this.setStatus('thinking');
    const version = this.historyRevision;
    try {
      const decision = decisionSchema.parse(
        await this.brain.decide(this.brief, this.history, this.brainAbort.signal),
      );
      if (this.paused || this.ended || this.stopping || this.brainAbort.signal.aborted) return;
      // If more company speech arrived while thinking, decide again with the new context.
      if (this.historyRevision !== version) {
        this.dirty = true;
        return;
      }
      await this.act(decision);
    } catch (error) {
      if (!this.brainAbort.signal.aborted && !this.stopping && !this.ended) this.fail(error);
    } finally {
      this.thinking = false;
      if (!this.ended && this.dirty && !this.paused && !this.question)
        queueMicrotask(() => this.process());
    }
  }
  async act(decision) {
    switch (decision.action) {
      case 'speak':
        await this.say(decision.text);
        break;
      case 'dtmf':
        await this.digits(decision.digits);
        break;
      case 'wait':
        this.publish('note', { text: 'Waiting for the company. The agent will listen quietly.' });
        this.setStatus('listening');
        break;
      case 'ask_user':
        this.question = decision.text;
        this.setStatus('needs_user');
        this.publish('question', { text: this.question });
        if (this.voice && this.transport)
          await this.say('Let me check that with the person I’m assisting. One moment, please.');
        break;
      case 'finish':
        this.summary = decision.summary;
        this.outcome = decision.outcome;
        this.publish('summary', { text: this.summary, outcome: this.outcome });
        await this.stop('ended');
        break;
    }
  }
  async say(text) {
    if (!this.disclosed) {
      text = disclosure + text;
      this.disclosed = true;
    }
    this.turn('agent', text);
    this.setStatus('speaking');
    if (!this.voice) {
      this.publish('demo_speech', { text });
      this.setStatus('listening');
      return;
    }
    if (!this.transport) throw new Error('Audio connection is not ready.');
    const transport = this.transport;
    this.speechAbort = new AbortController();
    const signal = this.speechAbort.signal;
    try {
      await this.voice.speak(
        text,
        this.brief.mode === 'phone' ? 'ulaw_8000' : 'pcm_24000',
        async (chunk) => {
          if (!signal.aborted && !this.ended && !this.paused) {
            await transport.audio(chunk);
            if (this.brief.mode === 'phone')
              this.publish('audio', { payload: muLawToPcm24(chunk).toString('base64') });
          }
        },
        signal,
      );
      if (!signal.aborted) await transport.drain?.(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (!this.ended && !this.stopping)
        this.setStatus(this.question ? 'needs_user' : this.paused ? 'paused' : 'listening');
    }
  }
  async digits(digits) {
    digitsSchema.parse({ digits });
    if (this.ended || this.stopping) throw new Error('The call has ended.');
    this.interruptSpeech();
    if (this.phone) {
      if (!this.callSid) throw new Error('The call is not connected yet.');
      this.setStatus('reconnecting');
      this.reconnecting = true;
      try {
        await this.phone.digits(this, digits);
      } catch {
        this.reconnecting = false;
        throw new Error('Twilio could not send keypad input.');
      }
    } else this.setStatus('listening');
    this.turn('action', `Pressed ${digits}`);
    this.publish('digits', { digits });
  }
  guide(text) {
    if (this.ended || this.stopping) throw new Error('The call has ended.');
    this.turn('user', text);
    this.question = '';
    this.dirty = true;
    if (!this.paused) this.process();
  }
  pause(paused) {
    if (this.ended || this.stopping) throw new Error('The call has ended.');
    this.paused = paused;
    if (paused) {
      this.brainAbort?.abort();
      this.interruptSpeech();
      this.dirty = true;
    }
    this.setStatus(paused ? 'paused' : this.question ? 'needs_user' : 'listening');
    if (!paused) this.process();
  }
  fail(error) {
    this.paused = true;
    this.remoteSpeaking = false;
    this.interruptSpeech();
    this.setStatus('paused');
    // Do not expose provider response bodies (which may contain private conversation data).
    const known =
      /^(ElevenLabs|Twilio|OpenAI|Cannot connect|Audio connection|Invalid transcription)/.test(
        error.message,
      );
    this.publish('error', {
      message: known
        ? error.message
        : 'The agent could not continue. Check API access, model settings, and credits. You can end the call or resume to retry.',
    });
  }
  cleanup() {
    clearTimeout(this.timer);
    clearTimeout(this.debounce);
    this.brainAbort?.abort();
    this.speechAbort?.abort();
    this.transcriber?.close();
    this.transport?.close?.();
  }
  async stop(status = 'ended') {
    if (this.ended) return;
    this.stopping = true;
    this.paused = true;
    this.brainAbort?.abort();
    this.interruptSpeech();
    this.transcriber?.close();
    if (this.phone) {
      // A user can click End while Twilio is still creating the call.
      if (this.dialPromise && !this.callSid) {
        try {
          await this.dialPromise;
        } catch {
          /* Creation failed, so no call to stop. */
        }
      }
      try {
        await this.phone.hangup(this);
      } catch {
        if (this.ended) return;
        this.stopping = false;
        this.setStatus('paused');
        this.publish('error', {
          message:
            'Twilio could not confirm hang-up. Retry End call or end it in the Twilio Console. The provider time limit still applies.',
        });
        throw new Error('Hang-up was not confirmed by Twilio.');
      }
    }
    this.cleanup();
    if (!this.summary)
      this.summary =
        'Call ended. No completed outcome was confirmed by the agent; review the transcript.';
    this.publish('summary', { text: this.summary, outcome: this.outcome });
    this.setStatus(status);
  }
  providerStatus(status) {
    if (this.ended) return;
    if (terminalStatuses.has(status)) {
      this.cleanup();
      if (!this.summary)
        this.summary = `Twilio reported ${status}. Review the transcript; this status alone does not confirm your request was completed.`;
      this.publish('summary', { text: this.summary, outcome: this.outcome });
      this.setStatus(status);
    } else if (status === 'ringing' || status === 'queued') this.setStatus(status);
  }
}

export class SessionStore {
  constructor() {
    this.sessions = new Map();
  }
  add(session) {
    if ([...this.sessions.values()].some((item) => !item.ended))
      throw new Error('End the current session before starting another.');
    this.sessions.set(session.id, session);
    if (this.sessions.size > 20) this.sessions.delete(this.sessions.keys().next().value);
    return session;
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) {
      const error = new Error('Session not found.');
      error.status = 404;
      throw error;
    }
    return session;
  }
}
