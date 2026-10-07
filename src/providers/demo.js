const action = (name, text = '', extra = {}) => ({
  action: name,
  text,
  digits: '',
  summary: '',
  outcome: 'unknown',
  ...extra,
});

/** Deterministic rehearsal. Never uses provider APIs or makes a phone call. */
export class DemoBrain {
  async decide(brief, history) {
    const latest = history.at(-1).text;
    if (/press\s+(\d)/i.test(latest))
      return action('dtmf', '', { digits: latest.match(/press\s+(\d)/i)[1] });
    if (/hold|please wait|music/i.test(latest)) return action('wait');
    if (/confirmed|has been cancel|is cancel|successfully cancel/i.test(latest)) {
      return action('finish', '', {
        summary: `The representative explicitly confirmed the request for ${brief.company}: ${latest}`,
        outcome: 'completed',
      });
    }
    if (/birth|account number|verification|fee|charge/i.test(latest))
      return action(
        'ask_user',
        `The company asked: “${latest}” What would you like me to tell them?`,
      );
    if (history.at(-1).role === 'user')
      return action(
        'speak',
        'Thank you. I have that information from the person I’m assisting. Please proceed with the requested cancellation.',
      );
    return action('speak', `Hello, I’m calling to help with this request: ${brief.goal}`);
  }
}
