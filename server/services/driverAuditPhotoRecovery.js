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

// The existing raw transport is already metered and performs immutable
// no-upsert writes followed by full-byte readback. Use the original photo key,
// including its historical .gz suffix; those image bytes are not re-encoded.
export function createDriverAuditSupabasePhotoRecovery({ archive } = {}) {
  if (!['assertPrivate', 'readObject', 'putVerifiedObject'].every(name => typeof archive?.[name] === 'function')) {
    throw Error('The original private Supabase archive transport is required');
  }
  function keyFor(reference) {
    if (typeof reference?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256) || !Number.isSafeInteger(reference.size)
      || reference.size < 1 || reference.size > maximumBytes) throw Error('Invalid photo recovery binding');
    return reference.sha256 + '.gz';
  }
  async function assertReady() {
    const proof = await archive.assertPrivate();
    if (proof?.bucket !== 'matter-report-archive' || proof.public !== false) throw Error('The photo recovery archive must remain private');
    return { verified: true, strategy: 'supabase-private-photo-recovery' };
  }
  async function readVerified(reference) {
    const key = keyFor(reference), chunks = [];
    let length = 0;
    for await (const chunk of await archive.readObject(key, { maxBytes: reference.size })) {
      if (!(chunk instanceof Uint8Array) || (length += chunk.byteLength) > reference.size) {
        throw Error('Preserved photo exceeds its bound');
      }
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks, length);
    if (length !== reference.size || digest(body) !== reference.sha256) throw Error('Preserved photo bytes differ');
    return body;
  }
  async function read(reference) {
    keyFor(reference);
    await assertReady();
    try { return await readVerified(reference); }
    catch (error) {
      // The existing alias reader may try its prior archive fallback only on
      // positively missing bytes, never on permission, quota or integrity errors.
      if (error.code === 'storage_not_found') throw Object.assign(Error('Preserved photo is unavailable'), { code: 'ENOENT', cause: error });
      throw error;
    }
  }
  async function preserve(reference, bytes) {
    const key = keyFor(reference);
    if (!Buffer.isBuffer(bytes) || bytes.length !== reference.size || digest(bytes) !== reference.sha256) {
      throw Error('Photo recovery bytes differ');
    }
    await assertReady();
    try { await readVerified(reference); return; }
    catch (error) { if (error.code !== 'storage_not_found') throw error; }
    const receipt = await archive.putVerifiedObject(key, bytes);
    if (receipt?.verified !== true || receipt.key !== key || receipt.bytes !== reference.size
      || receipt.sha256 !== reference.sha256) throw Error('The immutable photo recovery readback differs');
  }
  return Object.freeze({ assertReady, preserve, read });
}
