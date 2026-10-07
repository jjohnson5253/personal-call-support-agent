import { timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function localRequest(req, port) {
  const host = req.headers.host;
  const localHost = [`localhost:${port}`, `127.0.0.1:${port}`].includes(host);
  const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const forwarded = Object.keys(req.headers).some(
    (key) => key.startsWith('x-forwarded-') || key === 'forwarded',
  );
  return localHost && localPeer && !forwarded;
}
export function localOrigin(req, port) {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin);
}
export function hasCookie(req, token) {
  const cookie = req.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('call_agent='));
  return safeEqual(cookie?.slice('call_agent='.length), token);
}
export function signedTwilio(req, config) {
  if (!config.twilioToken || !config.publicUrl) return false;
  return twilio.validateRequest(
    config.twilioToken,
    req.headers['x-twilio-signature'] || '',
    `${config.publicUrl}${req.url}`,
    req.body || {},
  );
}
