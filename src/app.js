import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import { CallSession, SessionStore } from './session.js';
import { callSchema, textSchema, digitsSchema } from './validation.js';
import { localRequest, localOrigin, hasCookie, signedTwilio, safeEqual } from './security.js';
import { RealtimeTranscriber } from './providers/openai.js';
import { ElevenLabsVoice } from './providers/elevenlabs.js';
import { muLawToPcm24 } from './audio.js';
import { TwilioTransport, BrowserTransport } from './transport.js';

export function createApp({
  configStore,
  port = 3000,
  sessionFactory = (brief, config) => new CallSession(brief, config),
  transcriberFactory = (config, callbacks) => new RealtimeTranscriber(config, callbacks),
}) {
  const app = express(),
    server = createServer(app),
    store = new SessionStore();
  const cookieToken = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.post(
    '/twilio/status/:id',
    express.urlencoded({ extended: false, limit: '16kb' }),
    (req, res) => {
      let session;
      try {
        session = store.get(req.params.id);
      } catch {
        return res.sendStatus(404);
      }
      if (!signedTwilio(req, session.config)) return res.sendStatus(403);
      if (session.callSid && session.callSid !== req.body.CallSid) return res.sendStatus(403);
      session.providerStatus(req.body.CallStatus);
      res.sendStatus(204);
    },
  );
  // Dashboard is never served through the public tunnel, even if it rewrites Host.
  app.use((req, res, next) => {
    if (!localRequest(req, port))
      return res.status(403).json({ error: 'The dashboard is available only on localhost.' });
    if (req.path === '/' && req.method === 'GET') {
      res.cookie('call_agent', cookieToken, { httpOnly: true, sameSite: 'strict', path: '/' });
    }
    if (
      req.path.startsWith('/api/') &&
      (!hasCookie(req, cookieToken) ||
        (!['GET', 'HEAD'].includes(req.method) && !localOrigin(req, port)))
    ) {
      return res
        .status(403)
        .json({ error: 'Open the localhost dashboard to authorize this request.' });
    }
    next();
  });
  app.use(express.json({ limit: '24kb' }));
  app.get('/api/settings', (req, res) => res.json(configStore.public()));
  app.put('/api/settings', async (req, res) => res.json(await configStore.save(req.body)));
  app.delete('/api/settings', async (req, res) => {
    await configStore.clear();
    res.json(configStore.public());
  });
  app.get('/api/voices', async (req, res) => {
    const config = configStore.get();
    if (!config.elevenKey)
      return res.status(400).json({ error: 'Save your ElevenLabs key first.' });
    res.json(await new ElevenLabsVoice(config).voices());
  });
  app.get('/api/sessions', (req, res) =>
    res.json([...store.sessions.values()].map((session) => session.snapshot())),
  );
  app.post('/api/sessions', async (req, res) => {
    const brief = callSchema.parse(req.body),
      config = configStore.get(),
      readiness = configStore.public();
    if (brief.mode !== 'demo' && !readiness.browserReady)
      return res
        .status(400)
        .json({ error: 'Configure OpenAI, ElevenLabs, and a voice before starting.' });
    if (brief.mode === 'phone' && !readiness.phoneReady)
      return res.status(400).json({
        error: 'Configure Twilio, a caller number, and a public HTTPS tunnel before dialing.',
      });
    const session = store.add(sessionFactory(brief, config));
    await session.start();
    res.status(201).json(session.snapshot());
  });
  app.get('/api/sessions/:id', (req, res) => res.json(store.get(req.params.id).snapshot()));
  app.get('/api/sessions/:id/events', (req, res) => {
    const session = store.get(req.params.id);
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    // A fresh snapshot reconciles missed events on EventSource reconnection.
    res.write(`event: snapshot\ndata: ${JSON.stringify(session.snapshot())}\n\n`);
    const listener = (event) => {
      if (res.writableLength > 128000) return res.end();
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    session.on('event', listener);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      session.off('event', listener);
    });
  });
  app.post('/api/sessions/:id/transcript', (req, res) => {
    const session = store.get(req.params.id);
    if (session.brief.mode === 'phone')
      return res
        .status(400)
        .json({ error: 'Company transcript injection is available only in rehearsal.' });
    session.hear(textSchema.parse(req.body).text);
    res.sendStatus(204);
  });
  app.post('/api/sessions/:id/guide', (req, res) => {
    store.get(req.params.id).guide(textSchema.parse(req.body).text);
    res.sendStatus(204);
  });
  app.post('/api/sessions/:id/digits', async (req, res) => {
    await store.get(req.params.id).digits(digitsSchema.parse(req.body).digits);
    res.sendStatus(204);
  });
  app.post('/api/sessions/:id/pause', (req, res) => {
    store
      .get(req.params.id)
      .pause(z.object({ paused: z.boolean() }).strict().parse(req.body).paused);
    res.sendStatus(204);
  });
  app.post('/api/sessions/:id/stop', async (req, res) => {
    await store.get(req.params.id).stop();
    res.sendStatus(204);
  });
  app.delete('/api/sessions/:id', (req, res) => {
    const session = store.get(req.params.id);
    if (!session.ended)
      return res.status(409).json({ error: 'End the session before deleting its transcript.' });
    store.sessions.delete(session.id);
    res.sendStatus(204);
  });
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' '),
      });
    const safe =
      /^(Session not found|End the current|Hang-up|Twilio|ElevenLabs|The call|Cannot read|The agent)/.test(
        error.message,
      );
    res
      .status(error.status || 400)
      .json({ error: safe ? error.message : 'Request failed. Check your settings and try again.' });
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on('upgrade', (req, socket, head) => {
    let session, mode;
    try {
      const parts = new URL(req.url, 'http://localhost').pathname.split('/');
      session = store.get(parts[2]);
      if (session.ended || session.stopping) throw new Error('Ended');
      if (
        parts[1] === 'browser' &&
        parts.length === 3 &&
        session.brief.mode === 'browser' &&
        localRequest(req, port) &&
        localOrigin(req, port) &&
        hasCookie(req, cookieToken)
      )
        mode = 'browser';
      if (
        parts[1] === 'media' &&
        parts.length === 4 &&
        session.brief.mode === 'phone' &&
        safeEqual(parts[3], session.mediaToken) &&
        signedTwilio(req, session.config)
      )
        mode = 'phone';
      if (!mode) throw new Error('Unauthorized');
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) =>
      bindAudio(ws, session, mode, transcriberFactory),
    );
  });
  return { app, server, store, sockets };
}

function bindAudio(socket, session, mode, transcriberFactory) {
  let transcriber, transport, streamSid;
  const start = async () => {
    session.transcriber?.close();
    transcriber = transcriberFactory(session.config, {
      onTranscript: (text) => session.hear(text),
      onSpeechStart: () => session.speechStarted(),
      onSpeechEnd: () => session.speechEnded(),
      onError: (error) => session.fail(error),
    });
    session.transcriber = transcriber;
    session.attachTransport(transport);
    session.reconnecting = false;
    try {
      await transcriber.connect();
      if (socket.readyState === WebSocket.OPEN && mode === 'browser')
        socket.send(JSON.stringify({ type: 'ready' }));
    } catch (error) {
      if (!session.ended) session.fail(error);
    }
  };
  socket.on('error', () => {
    if (!session.ended) session.fail(new Error('Audio connection failed.'));
  });
  socket.on('message', (data, binary) => {
    try {
      if (session.ended || session.stopping) return;
      if (mode === 'browser') {
        if (binary && data.length % 2 === 0 && data.length <= 24000) transcriber?.append(data);
        if (!binary) {
          const event = JSON.parse(data.toString());
          if (event.type === 'mark' && typeof event.name === 'string') transport?.mark(event.name);
          if (event.type === 'flush') transcriber?.flush();
        }
        return;
      }
      const event = JSON.parse(data.toString());
      if (event.event === 'start') {
        if (
          transport ||
          (session.callSid && event.start.callSid !== session.callSid) ||
          event.start.accountSid !== session.config.twilioSid
        )
          throw new Error('Invalid stream start.');
        streamSid = event.start.streamSid;
        transport = new TwilioTransport(socket, streamSid);
        start();
      }
      if (event.event === 'media' && event.streamSid === streamSid) {
        const pcm = muLawToPcm24(Buffer.from(event.media.payload, 'base64'));
        transcriber?.append(pcm);
        session.publish('audio', { payload: pcm.toString('base64') });
      }
      if (event.event === 'mark' && event.streamSid === streamSid) transport?.mark(event.mark.name);
    } catch {
      session.fail(new Error('Audio connection received an invalid message.'));
      socket.close(1008);
    }
  });
  socket.on('close', () => {
    transcriber?.close();
    if (
      session.transport === transport &&
      !session.ended &&
      !session.stopping &&
      !session.reconnecting
    ) {
      session.fail(
        new Error('Audio connection disconnected. End the call or reconnect browser audio.'),
      );
    }
  });
  if (mode === 'browser') {
    transport = new BrowserTransport(socket);
    start();
  }
}
