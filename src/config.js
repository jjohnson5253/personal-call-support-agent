import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { settingsSchema } from './validation.js';

const secretFields = ['openaiKey', 'elevenKey', 'twilioToken'];
const envNames = {
  openaiKey: 'OPENAI_API_KEY',
  elevenKey: 'ELEVENLABS_API_KEY',
  voiceId: 'ELEVENLABS_VOICE_ID',
  twilioSid: 'TWILIO_ACCOUNT_SID',
  twilioToken: 'TWILIO_AUTH_TOKEN',
  fromNumber: 'TWILIO_PHONE_NUMBER',
  publicUrl: 'PUBLIC_URL',
  model: 'OPENAI_MODEL',
  transcriptionModel: 'OPENAI_TRANSCRIPTION_MODEL',
  speechModel: 'ELEVENLABS_MODEL',
};

export class ConfigStore {
  constructor(directory, env = process.env) {
    this.directory = directory;
    this.env = env;
    this.saved = {};
    this.mutations = Promise.resolve();
  }

  async load() {
    try {
      this.saved = settingsSchema.parse(
        JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8')),
      );
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error('Cannot read local settings. Check .data/settings.json.');
    }
    return this;
  }

  get() {
    const config = {
      model: 'gpt-4.1-mini',
      transcriptionModel: 'gpt-live-transcribe',
      speechModel: 'eleven_flash_v2_5',
      ...this.saved,
    };
    for (const [field, name] of Object.entries(envNames))
      if (this.env[name]) config[field] = this.env[name];
    config.publicUrl = config.publicUrl?.replace(/\/$/, '') || '';
    return config;
  }

  public() {
    const config = this.get();
    const result = Object.fromEntries(
      Object.entries(config).filter(([key]) => !secretFields.includes(key)),
    );
    for (const key of secretFields) result[`${key}Configured`] = Boolean(config[key]);
    result.environmentFields = Object.entries(envNames)
      .filter(([, name]) => Boolean(this.env[name]))
      .map(([field]) => field);
    result.browserReady = Boolean(config.openaiKey && config.elevenKey && config.voiceId);
    result.phoneReady = Boolean(
      result.browserReady &&
      config.twilioSid &&
      config.twilioToken &&
      config.fromNumber &&
      config.publicUrl,
    );
    return result;
  }

  save(input) {
    return this.mutate(async () => {
      const patch = settingsSchema.parse(input);
      const next = { ...this.saved };
      // Blank secret inputs preserve existing credentials. Explicit deletion uses clear().
      for (const [key, value] of Object.entries(patch))
        if (!secretFields.includes(key) || value) next[key] = value;
      await this.persist(next);
      return this.public();
    });
  }

  clear() {
    return this.mutate(() => this.persist({}));
  }
  mutate(action) {
    const result = this.mutations.then(action);
    this.mutations = result.catch(() => {});
    return result;
  }

  async persist(value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, 'settings.tmp');
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, join(this.directory, 'settings.json'));
    this.saved = value;
  }
}
