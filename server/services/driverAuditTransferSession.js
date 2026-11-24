import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { decryptTransfer, sealTransferSecrets, TRANSFER_MAX_BYTES } from './driverAuditTransferCodec.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const sessionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const maximumAge = 24 * 60 * 60 * 1000;

export function validateDriverAuditTransferPlan(request) {
  const plan = request?.plan;
  if (request?.version !== 1 || !/^[A-Za-z0-9_-]{1,100}$/.test(request.targetDatabase || '')
      || !positive(request.capacityBytes) || request.capacityBytes > 60_000_000_000
      || typeof request.recipientPublicKey !== 'string' || request.recipientPublicKey.length > 8192
      || plan?.version !== 1 || !/^[a-f0-9]{64}$/.test(plan.inventorySha256 || '')
      || !positive(plan.inventoryBytes) || plan.inventoryBytes > 16 * 1024 * 1024
      || !positive(plan.objectCount) || plan.objectCount > 100000
      || !positive(plan.objectBytes) || plan.objectBytes > TRANSFER_MAX_BYTES
      || !positive(plan.cipherBytes) || plan.cipherBytes < plan.objectBytes + plan.inventoryBytes + 40
      || plan.cipherBytes > TRANSFER_MAX_BYTES + 32 * 1024 * 1024) {
    throw Error('Invalid bounded native transfer plan');
  }
  return { version: 1, targetDatabase: request.targetDatabase, capacityBytes: request.capacityBytes,
    recipientPublicKey: request.recipientPublicKey,
    plan: Object.fromEntries(['version', 'inventorySha256', 'inventoryBytes', 'objectCount', 'objectBytes', 'cipherBytes']
      .map(name => [name, plan[name]])) };
}

async function directory(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid() || await fs.realpath(root) !== root) {
    throw Error('Owner-private native transfer directory required');
  }
}

async function durableFile(file, bytes) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, file);
  } finally { await fs.unlink(temporary); }
  const parent = await fs.open(path.dirname(file), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

async function jsonFile(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid() || info.size > 128 * 1024) {
    throw Error('Owner-private native transfer state required');
  }
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// The Spaces adapter can access only this session's newly generated encrypted
// object. The archive adapter owns immutable native objects, never app deliveries.
export function createDriverAuditTransferSessions({ root, targetDatabase, capacityBytes, spaces, archive,
  canStage, clock = Date.now }) {
  if (!path.isAbsolute(root || '') || path.resolve(root) !== root || !archive?.putVerifiedObject
      || !spaces?.prepare || !spaces?.head || !spaces?.read || !spaces?.remove || typeof canStage !== 'function') {
    throw Error('Native transfer adapters are unavailable');
  }
  const sessionRoot = async id => {
    if (!sessionPattern.test(id || '')) throw Error('Invalid native transfer session');
    await directory(root);
    const folder = path.join(root, id);
    await directory(folder);
    return folder;
  };
  return {
    async prepare(input) {
      const request = validateDriverAuditTransferPlan(input);
      if (request.targetDatabase !== targetDatabase || request.capacityBytes !== capacityBytes) {
        throw Error('Native transfer target differs');
      }
      await canStage();
      const sessionId = randomUUID(), folder = await sessionRoot(sessionId);
      const context = { sessionId, targetDatabase, inventorySha256: request.plan.inventorySha256 };
      const state = { version: 1, ...context, capacityBytes, plan: request.plan, createdAt: clock(),
        key: randomBytes(32).toString('base64'), baseNonce: randomBytes(8).toString('base64') };
      // Check the recipient before creating a remote upload capability.
      sealTransferSecrets(request.recipientPublicKey, { sessionId });
      await durableFile(path.join(folder, 'session.private.json'), Buffer.from(JSON.stringify(state)));
      const upload = await spaces.prepare(sessionId, request.plan.cipherBytes);
      const capsule = sealTransferSecrets(request.recipientPublicKey, { version: 1, ...upload,
        context, plan: request.plan, key: state.key, baseNonce: state.baseNonce });
      return { status: 'transfer-prepared', sessionId, inventorySha256: request.plan.inventorySha256,
        objectCount: request.plan.objectCount, objectBytes: request.plan.objectBytes, capsule };
    },
    async receive(sessionId, { signal } = {}) {
      const folder = await sessionRoot(sessionId);
      const state = await jsonFile(path.join(folder, 'session.private.json'));
      if (state.sessionId !== sessionId || state.targetDatabase !== targetDatabase || state.capacityBytes !== capacityBytes
          || !Number.isSafeInteger(state.createdAt) || clock() < state.createdAt || clock() - state.createdAt > maximumAge) {
        throw Error('Native transfer session differs or expired');
      }
      await canStage();
      const proofFile = path.join(folder, 'received.private.json');
      const prior = await jsonFile(proofFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (prior) {
        if (prior.version !== 1 || prior.status !== 'transfer-received' || prior.verified !== true
            || prior.inventorySha256 !== state.inventorySha256 || prior.sessionId !== sessionId
            || prior.targetDatabase !== targetDatabase || prior.objects !== state.plan.objectCount
            || prior.bytes !== state.plan.objectBytes || prior.authorityChanged !== false) throw Error('Native transfer completion differs');
        await spaces.remove(sessionId);
        return { ...prior, status: 'transfer-already-received' };
      }
      const remote = await spaces.head(sessionId);
      if (remote.bytes !== state.plan.cipherBytes) throw Error('Encrypted native transfer size differs');
      const stream = await spaces.read(sessionId, signal, remote);
      const inputFiles = [];
      let proof;
      try {
        proof = await decryptTransfer({ stream, key: Buffer.from(state.key, 'base64'), baseNonce: Buffer.from(state.baseNonce, 'base64'),
          context: { sessionId, targetDatabase, inventorySha256: state.inventorySha256 }, plan: state.plan, signal: stream.signal || signal,
          async receive(row, bytes) {
            if (row.kind !== 'input') { await archive.putVerifiedObject(row.key, bytes); return; }
            const file = path.join(folder, row.name);
            try { await durableFile(file, bytes); }
            catch (error) {
              if (error.code !== 'EEXIST') throw error;
              const info = await fs.lstat(file);
              if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid() || info.size !== bytes.length
                  || hash(await fs.readFile(file)) !== row.key.slice(0, 64)) throw Error('Existing native transfer input differs');
            }
            inputFiles.push({ name: row.name, sha256: row.key.slice(0, 64), bytes: bytes.length });
          } });
      } finally { await stream.destroy?.(); }
      await canStage();
      const receipt = { version: 1, status: 'transfer-received', ...proof, sessionId, targetDatabase,
        inputFiles, completedAt: new Date(clock()).toISOString(), authorityChanged: false };
      await durableFile(proofFile, Buffer.from(JSON.stringify(receipt)));
      // The only deleted remote object is this session's transient ciphertext.
      // Plain source evidence and original backups are never cleanup targets.
      await spaces.remove(sessionId);
      return receipt;
    },
  };
}
