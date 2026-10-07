export class ElevenLabsVoice {
  constructor(config, fetcher = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }
  async voices() {
    const response = await this.fetcher('https://api.elevenlabs.io/v2/voices?page_size=100', {
      headers: { 'xi-api-key': this.config.elevenKey },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        `ElevenLabs voice listing failed (${response.status}). Check your API key permissions.`,
      );
    const data = await response.json();
    return data.voices.map((v) => ({ id: v.voice_id, name: v.name, category: v.category }));
  }
  async speak(text, format, onChunk, signal) {
    const timeout = AbortSignal.timeout(30000);
    const response = await this.fetcher(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.config.voiceId)}/stream?output_format=${format}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': this.config.elevenKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: this.config.speechModel }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
    if (!response.ok)
      throw new Error(
        `ElevenLabs speech failed (${response.status}). Check voice access, API permissions, and credit balance.`,
      );
    let bytes = 0;
    for await (const chunk of response.body) {
      if (signal?.aborted) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 2_880_000) throw new Error('Speech response exceeded the audio limit.');
      await onChunk(buffer);
    }
  }
}
