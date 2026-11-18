import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from './driverAuditSource.js';

const maximumBytes = 16 * 1024 ** 2;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function createDriverAuditPhotoRecovery(directory) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
    throw Error('An absolute recovery directory is required');
  }

  async function assertReady() {
    await requirePrivateDriverAuditSourceDirectory(directory);
    await fs.access(directory, fs.constants.R_OK | fs.constants.W_OK);
    return { verified: true, strategy: 'private-photo-recovery' };
  }

  function filename({ sha256, size }) {
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 1 || size > maximumBytes) {
      throw Error('Invalid photo recovery binding');
    }
    return path.join(directory, sha256);
  }

  async function read(reference) {
    await requirePrivateDriverAuditSourceDirectory(directory);
    const bytes = await readPrivateDriverAuditSource(filename(reference), reference.size);
    if (bytes.length !== reference.size || digest(bytes) !== reference.sha256) {
      throw Error('Preserved photo bytes differ');
    }
    return bytes;
  }

  async function preserve(reference, bytes) {
    const file = filename(reference);
    if (!Buffer.isBuffer(bytes) || bytes.length !== reference.size || digest(bytes) !== reference.sha256) {
      throw Error('Photo recovery bytes differ');
    }
    await assertReady();
    try { await read(reference); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }

    const temporary = path.join(directory, '.' + randomUUID() + '.tmp');
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.link(temporary, file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await read(reference);
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await fs.rm(temporary, { force: true }); }
  }

  return Object.freeze({ assertReady, preserve, read });
}
