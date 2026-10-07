import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  chmod,
  lstat,
  unlink,
  open,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const uuid = z.string().uuid();
const sid = (prefix) => z.string().regex(new RegExp(`^${prefix}[a-fA-F0-9]{32}$`));
export const recordingCallbackSchema = z.object({
  AccountSid: sid('AC'),
  CallSid: sid('CA'),
  RecordingSid: sid('RE'),
  RecordingStatus: z.enum(['completed', 'absent', 'in-progress']),
  RecordingDuration: z.coerce.number().min(0).max(7200).default(0),
});
const metadataSchema = z.object({
  id: uuid,
  company: z.string().max(120),
  createdAt: z.string().datetime(),
  accountSid: sid('AC'),
  callSid: sid('CA').optional(),
  recordingSid: sid('RE').optional(),
  status: z.enum(['waiting', 'downloading', 'ready', 'failed']),
  bytes: z.number().int().nonnegative().default(0),
  duration: z.number().nonnegative().default(0),
  message: z.string().max(300).default(''),
});

/** Owns only UUID-named files created for this app. Never stores provider credentials. */
export class RecordingStore {
  constructor(directory, fetcher = fetch) {
    this.directory = resolve(directory);
    this.fetcher = fetcher;
    this.items = new Map();
    this.downloads = new Map();
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    for (const filename of await readdir(this.directory)) {
      if (!uuid.safeParse(filename.replace(/\.json$/, '')).success || !filename.endsWith('.json'))
        continue;
      const path = join(this.directory, filename);
      if (!(await lstat(path)).isFile()) continue;
      let item;
      try {
        item = metadataSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      } catch {
        continue;
      }
      if (filename !== `${item.id}.json`) continue;
      if (item.status === 'downloading') {
        item.status = 'failed';
        item.message = 'Download was interrupted. Retry to save the recording.';
      }
      this.items.set(item.id, item);
      if (item.status === 'ready') {
        try {
          await this.audioPath(item.id);
        } catch {
          item.status = 'failed';
          item.message = 'Local audio is missing or incomplete. Retry the download.';
        }
      }
    }
    return this;
  }
  get(id) {
    uuid.parse(id);
    const item = this.items.get(id);
    if (!item) {
      const error = new Error('Recording not found.');
      error.status = 404;
      throw error;
    }
    return item;
  }
  list() {
    return [...this.items.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => ({ ...item, filename: this.filename(item) }));
  }
  filename(item) {
    return `call-${item.createdAt.replace(/[:.]/g, '-')}-${item.id}.mp3`;
  }
  async save(item) {
    metadataSchema.parse(item);
    const path = join(this.directory, `${item.id}.json`),
      temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(item, null, 2), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    this.items.set(item.id, item);
  }
  async prepare(session) {
    const item = metadataSchema.parse({
      id: session.id,
      company: session.brief.company,
      createdAt: session.createdAt,
      accountSid: session.config.twilioSid,
      status: 'waiting',
    });
    await this.save(item);
  }
  async setCall(id, callSid) {
    const item = this.get(id);
    sid('CA').parse(callSid);
    if (item.callSid && item.callSid !== callSid)
      throw new Error('Recording call identity mismatch.');
    if (item.callSid === callSid) return;
    await this.save({ ...item, callSid });
  }
  async markFailed(id, message = 'No recording was produced for this call.') {
    const item = this.get(id);
    if (item.status === 'ready') return;
    await this.save({ ...item, status: 'failed', message });
  }
  validateCallback(id, input, config) {
    const event = recordingCallbackSchema.parse(input),
      item = this.get(id);
    if (
      event.AccountSid !== item.accountSid ||
      config.twilioSid !== item.accountSid ||
      (item.callSid && event.CallSid !== item.callSid) ||
      (item.recordingSid && event.RecordingSid !== item.recordingSid)
    ) {
      const error = new Error('Recording identity mismatch.');
      error.status = 403;
      throw error;
    }
    return event;
  }
  async accept(id, input, config) {
    const event = this.validateCallback(id, input, config),
      item = this.get(id);
    if (!item.callSid) await this.setCall(id, event.CallSid);
    if (event.RecordingStatus === 'absent') return this.markFailed(id);
    if (event.RecordingStatus !== 'completed') return;
    return this.download(id, event.RecordingSid, event.RecordingDuration, config);
  }
  download(id, recordingSid, duration, config) {
    if (this.downloads.has(id)) return this.downloads.get(id);
    const work = this.downloadFile(id, recordingSid, duration, config).finally(() =>
      this.downloads.delete(id),
    );
    this.downloads.set(id, work);
    return work;
  }
  async downloadFile(id, recordingSid, duration, config) {
    const item = this.get(id);
    sid('RE').parse(recordingSid);
    if (config.twilioSid !== item.accountSid || !config.twilioToken)
      throw new Error('Recording requires the original Twilio account credentials.');
    if (item.status === 'ready') return;
    const next = { ...item, recordingSid, duration, status: 'downloading', message: '' };
    await this.save(next);
    const target = join(this.directory, this.filename(next)),
      temporary = `${target}.part`;
    let file;
    try {
      // Ignore callback RecordingUrl entirely: never send credentials to a supplied URL.
      const url = `https://api.twilio.com/2010-04-01/Accounts/${item.accountSid}/Recordings/${recordingSid}.mp3`;
      const response = await this.fetcher(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64')}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok || !response.body) throw new Error('Recording media is unavailable.');
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      file = await open(temporary, 'wx', 0o600);
      let bytes = 0,
        header = Buffer.alloc(0);
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 128 * 1024 * 1024) throw new Error('Recording is too large.');
        if (header.length < 3) header = Buffer.concat([header, buffer]).subarray(0, 3);
        await file.writeFile(buffer);
      }
      if (
        bytes < 3 ||
        !(header.toString() === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0))
      )
        throw new Error('Invalid recording audio.');
      await file.sync();
      await file.close();
      file = null;
      await rename(temporary, target);
      await this.save({ ...next, status: 'ready', bytes });
    } catch {
      await file?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      await this.save({
        ...next,
        status: 'failed',
        message: 'Recording download failed. Check Twilio access, free disk space, and retry.',
      });
      throw new Error('Recording download failed.');
    }
  }
  async retry(id, config) {
    const item = this.get(id);
    if (item.status === 'ready') return;
    if (!item.recordingSid) {
      if (!item.callSid || config.twilioSid !== item.accountSid || !config.twilioToken)
        throw new Error('Recording recovery requires the original Twilio credentials and call ID.');
      const response = await this.fetcher(
        `https://api.twilio.com/2010-04-01/Accounts/${item.accountSid}/Calls/${item.callSid}/Recordings.json?PageSize=1`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64')}`,
          },
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error('Recording recovery failed. Check Twilio credentials.');
      const data = await response.json(),
        recording = data.recordings?.[0];
      if (!recording || recording.status !== 'completed')
        throw new Error('Recording is still processing or absent. Check the Twilio Console.');
      return this.accept(
        id,
        {
          AccountSid: recording.account_sid,
          CallSid: recording.call_sid,
          RecordingSid: recording.sid,
          RecordingStatus: recording.status,
          RecordingDuration: recording.duration,
        },
        config,
      );
    }
    return this.download(id, item.recordingSid, item.duration, config);
  }
  async audioPath(id) {
    const item = this.get(id);
    if (item.status !== 'ready') {
      const error = new Error('Recording is not ready.');
      error.status = 409;
      throw error;
    }
    const path = join(this.directory, this.filename(item)),
      info = await lstat(path);
    if (!info.isFile() || info.size !== item.bytes)
      throw new Error('Recording file is missing or incomplete.');
    return path;
  }
  async remove(id) {
    const item = this.get(id);
    if (item.status === 'waiting' || this.downloads.has(id)) {
      const error = new Error('Recording is still pending.');
      error.status = 409;
      throw error;
    }
    await unlink(join(this.directory, this.filename(item))).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await unlink(join(this.directory, `${id}.json`));
    this.items.delete(id);
  }
  async drain() {
    await Promise.allSettled([...this.downloads.values()]);
  }
}
