import { createCipheriv, createDecipheriv, createHash, createPublicKey, createPrivateKey, publicEncrypt, privateDecrypt, randomBytes } from 'node:crypto';
import { KeyObject } from 'node:crypto';

export const TRANSFER_FRAME_BYTES = 64 * 1024 * 1024;
export const TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const magic = Buffer.from('MATTER-NATIVE-TRANSFER-1\n');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

export function parseTransferInventory(raw) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 16 * 1024 * 1024) throw Error('Transfer inventory exceeds its bound');
  const rows = raw.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!rows.length || rows.length > 100000) throw Error('Transfer object count exceeds its bound');
  const keys = new Set(), inputNames = new Set();
  let totalBytes = 0;
  for (const row of rows) {
    if (!row || !/^[a-f0-9]{64}\.(?:gz|json)$/.test(row.key || '') || keys.has(row.key) || !positive(row.bytes)) {
      throw Error('Invalid or repeated transfer object');
    }
    keys.add(row.key);
    const input = row.kind === 'input';
    if (row.kind !== undefined && !['object', 'input'].includes(row.kind)) throw Error('Unknown transfer record type');
    if (row.bytes > (input ? TRANSFER_FRAME_BYTES : 16 * 1024 * 1024)) throw Error('Transfer object exceeds its bound');
    if (input && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.private\.(?:json|jsonl)(?:\.gz)?$/.test(row.name || '')
        || ['session.private.json', 'received.private.json'].includes(row.name) || inputNames.has(row.name))) {
      throw Error('Unsafe transfer input name');
    }
    if (input) inputNames.add(row.name);
    totalBytes += row.bytes;
    if (totalBytes > TRANSFER_MAX_BYTES) throw Error('Transfer session exceeds its bound');
  }
  return { rows, totalBytes, sha256: digest(raw) };
}

export function transferFrameGroups(rows) {
  const groups = [];
  let group = [], bytes = 0;
  for (const row of rows) {
    if (bytes + row.bytes > TRANSFER_FRAME_BYTES) { groups.push(group); group = []; bytes = 0; }
    group.push(row); bytes += row.bytes;
  }
  if (group.length) groups.push(group);
  return groups;
}

export function transferPlan(raw) {
  const inventory = parseTransferInventory(raw);
  const groups = transferFrameGroups(inventory.rows);
  return { version: 1, inventorySha256: inventory.sha256, inventoryBytes: raw.length,
    objectCount: inventory.rows.length, objectBytes: inventory.totalBytes,
    cipherBytes: magic.length + raw.length + inventory.totalBytes + (groups.length + 1) * 20 };
}

function nonce(base, index) {
  if (!Buffer.isBuffer(base) || base.length !== 8 || !Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw Error('Invalid transfer nonce');
  }
  const value = Buffer.alloc(12); base.copy(value); value.writeUInt32BE(index, 8); return value;
}

function aad(context, index) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(context?.sessionId || '')
      || !/^[A-Za-z0-9_-]{1,100}$/.test(context.targetDatabase || '') || !validHash(context.inventorySha256)) {
    throw Error('Invalid transfer context');
  }
  return Buffer.from(JSON.stringify(['matter-native-v1', context.sessionId, context.targetDatabase, context.inventorySha256, index]));
}

function encryptFrame(bytes, key, baseNonce, context, index) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce(baseNonce, index));
  cipher.setAAD(aad(context, index));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const size = Buffer.alloc(4); size.writeUInt32BE(encrypted.length);
  return Buffer.concat([size, encrypted, cipher.getAuthTag()]);
}

export async function* encryptTransfer({ inventory, readObject, key, baseNonce, context }) {
  const parsed = parseTransferInventory(inventory);
  if (parsed.sha256 !== context.inventorySha256 || typeof readObject !== 'function') throw Error('Transfer inventory identity differs');
  yield magic;
  yield encryptFrame(inventory, key, baseNonce, context, 0);
  let index = 1;
  for (const group of transferFrameGroups(parsed.rows)) {
    const pieces = [];
    for (const row of group) {
      const bytes = await readObject(row);
      if (!Buffer.isBuffer(bytes) || bytes.length !== row.bytes || digest(bytes) !== row.key.split('.')[0]) {
        throw Error('Original transfer bytes differ');
      }
      pieces.push(bytes);
    }
    yield encryptFrame(Buffer.concat(pieces), key, baseNonce, context, index++);
  }
}

function exactReader(stream, limit) {
  const iterator = stream[Symbol.asyncIterator]();
  let current = Buffer.alloc(0), offset = 0, consumed = 0;
  return async (length, eof = false) => {
    const pieces = []; let received = 0;
    while (received < length) {
      if (offset === current.length) {
        const next = await iterator.next();
        if (next.done) { if (eof && received === 0) return null; throw Error('Truncated transfer'); }
        current = Buffer.from(next.value); offset = 0;
        consumed += current.length;
        if (consumed > limit || current.length > TRANSFER_FRAME_BYTES + 32) throw Error('Transfer stream exceeds its bound');
      }
      const take = Math.min(length - received, current.length - offset);
      pieces.push(current.subarray(offset, offset + take)); offset += take; received += take;
    }
    return pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, length);
  };
}

export async function decryptTransfer({ stream, key, baseNonce, context, plan, receive, signal }) {
  if (!positive(plan?.cipherBytes) || plan.cipherBytes > TRANSFER_MAX_BYTES + 32 * 1024 * 1024
      || typeof receive !== 'function' || plan.inventorySha256 !== context.inventorySha256) throw Error('Invalid transfer plan');
  const read = exactReader(stream, plan.cipherBytes);
  if (!(await read(magic.length)).equals(magic)) throw Error('Unknown transfer encoding');
  const frame = async index => {
    signal?.throwIfAborted();
    const size = (await read(4)).readUInt32BE();
    if (!positive(size) || size > TRANSFER_FRAME_BYTES) throw Error('Transfer frame exceeds its bound');
    const encrypted = await read(size), tag = await read(16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce(baseNonce, index));
    decipher.setAAD(aad(context, index)); decipher.setAuthTag(tag);
    // No record is released to storage before its whole frame authenticates.
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  };
  const raw = await frame(0), parsed = parseTransferInventory(raw);
  const calculated = transferPlan(raw);
  if (parsed.sha256 !== context.inventorySha256 || calculated.objectCount !== plan.objectCount
      || calculated.objectBytes !== plan.objectBytes || calculated.inventoryBytes !== plan.inventoryBytes
      || calculated.cipherBytes !== plan.cipherBytes) throw Error('Transfer inventory differs from the approved plan');
  for (const field of ['inventorySha256', 'inventoryBytes', 'objectCount', 'objectBytes', 'cipherBytes']) {
    if (calculated[field] !== plan[field]) throw Error('Transfer plan differs from authenticated inventory');
  }
  let index = 1, received = 0;
  for (const group of transferFrameGroups(parsed.rows)) {
    const bytes = await frame(index++);
    if (bytes.length !== group.reduce((sum, row) => sum + row.bytes, 0)) throw Error('Transfer frame size differs');
    let offset = 0;
    for (const row of group) {
      signal?.throwIfAborted();
      const value = bytes.subarray(offset, offset + row.bytes); offset += row.bytes;
      if (digest(value) !== row.key.split('.')[0]) throw Error('Transfer evidence hash differs');
      await receive(row, value); received++;
    }
  }
  if (await read(1, true) !== null) throw Error('Transfer has undeclared trailing bytes');
  return { verified: true, objects: received, bytes: parsed.totalBytes, inventorySha256: parsed.sha256 };
}

export function sealTransferSecrets(publicKey, value) {
  const recipient = publicKey instanceof KeyObject && publicKey.type === 'public' ? publicKey : createPublicKey(publicKey);
  if (recipient.asymmetricKeyType !== 'rsa' || recipient.asymmetricKeyDetails.modulusLength < 3072) throw Error('Strong RSA transfer recipient required');
  const plaintext = Buffer.from(JSON.stringify(value));
  if (plaintext.length > 64 * 1024) throw Error('Transfer capsule exceeds its bound');
  const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { version: 1, key: publicEncrypt({ key: recipient, oaepHash: 'sha256' }, key).toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

export function openTransferSecrets(privateKey, value) {
  if (value?.version !== 1) throw Error('Invalid transfer capsule');
  const decode = (field, maximum, length) => {
    const text = value[field];
    if (typeof text !== 'string' || !text.length || text.length > maximum || !/^[A-Za-z0-9+/]+=*$/.test(text)) throw Error('Invalid transfer capsule');
    const bytes = Buffer.from(text, 'base64');
    if (bytes.toString('base64') !== text || length !== undefined && bytes.length !== length) throw Error('Invalid transfer capsule');
    return bytes;
  };
  const recipient = privateKey instanceof KeyObject && privateKey.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (recipient.asymmetricKeyType !== 'rsa' || recipient.asymmetricKeyDetails.modulusLength < 3072) throw Error('Strong RSA transfer recipient required');
  const wrapped = decode('key', 2048, recipient.asymmetricKeyDetails.modulusLength / 8);
  const iv = decode('iv', 16, 12), tag = decode('tag', 24, 16), data = decode('data', 90 * 1024);
  if (data.length > 64 * 1024) throw Error('Invalid transfer capsule');
  const key = privateDecrypt({ key: recipient, oaepHash: 'sha256' }, wrapped);
  if (key.length !== 32) throw Error('Invalid transfer capsule');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}
