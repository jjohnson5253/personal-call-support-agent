import twilio from 'twilio';
import { digitsSchema } from '../validation.js';

export function streamTwiml(config, id, token, digits = '') {
  if (digits) digitsSchema.parse({ digits });
  const response = new twilio.twiml.VoiceResponse();
  if (digits) response.play({ digits });
  response
    .connect()
    .stream({ url: `${config.publicUrl.replace(/^https:/, 'wss:')}/media/${id}/${token}` });
  response.hangup();
  return response.toString();
}

export class TwilioPhone {
  constructor(
    config,
    client = twilio(config.twilioSid, config.twilioToken, { timeout: 15000, autoRetry: false }),
  ) {
    this.config = config;
    this.client = client;
  }
  async dial(session) {
    const call = await this.client.calls.create({
      to: session.brief.to,
      from: this.config.fromNumber,
      twiml: streamTwiml(this.config, session.id, session.mediaToken),
      statusCallback: `${this.config.publicUrl}/twilio/status/${session.id}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      timeout: 45,
      timeLimit: session.brief.maxMinutes * 60,
      ...(session.brief.record
        ? {
            record: true,
            recordingChannels: 'dual',
            recordingTrack: 'both',
            recordingStatusCallback: `${this.config.publicUrl}/twilio/recording/${session.id}`,
            recordingStatusCallbackMethod: 'POST',
            recordingStatusCallbackEvent: ['completed', 'absent'],
          }
        : {}),
    });
    return call.sid;
  }
  async digits(session, digits) {
    return this.client
      .calls(session.callSid)
      .update({ twiml: streamTwiml(this.config, session.id, session.mediaToken, digits) });
  }
  async hangup(session) {
    if (session.callSid) await this.client.calls(session.callSid).update({ status: 'completed' });
  }
}
