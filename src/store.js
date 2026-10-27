import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';

export class Store {
  constructor(directory) { this.dir = directory; this.chain = Promise.resolve(); }
  async init() {
    await mkdir(path.join(this.dir, 'videos'), { recursive: true, mode: 0o700 });
    const keyPath = path.join(this.dir, 'encryption.key');
    try { await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    this.key = await readFile(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid encryption.key');
    try {
      const envelope = JSON.parse(await readFile(path.join(this.dir, 'state.enc'), 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      this.state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString());
    } catch (e) { if (e.code !== 'ENOENT') throw e; this.state = { accounts: {}, videos: {}, jobs: {} }; }
    // A crash can leave a remote post accepted. Never automatically send it again.
    for (const job of Object.values(this.state.jobs)) for (const result of Object.values(job.results)) {
      if (['queued', 'uploading'].includes(result.state)) {
        result.state = 'interrupted'; result.message = 'Máy chủ đã dừng. Kiểm tra tài khoản đích trước khi tạo lượt đăng mới.';
      }
    }
    await this.save();
  }
  save() {
    const snapshot = JSON.stringify(this.state);
    this.chain = this.chain.catch(() => {}).then(async () => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
      const data = Buffer.concat([cipher.update(snapshot), cipher.final()]);
      const file = path.join(this.dir, 'state.enc');
      await writeFile(file + '.tmp', JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
      await rename(file + '.tmp', file);
    });
    return this.chain;
  }
  videoPath(id) { return path.join(this.dir, 'videos', id + '.mp4'); }
}
