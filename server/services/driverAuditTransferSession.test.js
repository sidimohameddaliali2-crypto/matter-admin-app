import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createDriverAuditTransferSessions, validateDriverAuditTransferPlan } from './driverAuditTransferSession.js';
import { transferPlan, encryptTransfer, openTransferSecrets } from './driverAuditTransferCodec.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'audit-transfer-fixture-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = [Buffer.from('{"fictionalReviewHistory":["original","saved"]}'),
    Buffer.from('fictional original GPS'), Buffer.from('fictional photo')];
  const rows = original.map((value, i) => ({ key: hash(value) + (i ? '.gz' : '.json'), bytes: value.length,
    ...(i ? {} : { kind: 'input', name: 'history.private.json' }) }));
  const inventory = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const request = { version: 1, targetDatabase: 'fictional_reports', capacityBytes: 1000000, plan: transferPlan(inventory),
    recipientPublicKey: recipient.publicKey.export({ type: 'spki', format: 'pem' }) };
  const saved = new Map(), removed = [], objects = new Map();
  let failObject = false, failCleanup = false, admitted = true, calls = 0;
  const spaces = {
    async prepare(id, bytes) { return { uploadUrl: 'https://example.invalid/' + id, headers: {}, cipherBytes: bytes }; },
    async head(id) { return { bytes: saved.get(id)?.length }; },
    async read(id) { return Readable.from([saved.get(id)]); },
    async remove(id) { if (failCleanup) { failCleanup = false; throw Error('fixture cleanup interruption'); } removed.push(id); saved.delete(id); },
  };
  const manager = createDriverAuditTransferSessions({ root, targetDatabase: request.targetDatabase, capacityBytes: request.capacityBytes,
    spaces, archive: { async putVerifiedObject(key, value) {
      calls++; if (failObject) { failObject = false; throw Error('fixture interrupted native write'); }
      if (objects.has(key)) assert.deepEqual(objects.get(key), value);
      objects.set(key, Buffer.from(value));
    } }, canStage: async () => { if (!admitted) throw Error('fixture active authority'); } });
  async function prepare() {
    const result = await manager.prepare(request);
    const secrets = openTransferSecrets(recipient.privateKey, result.capsule);
    const chunks = [];
    for await (const chunk of encryptTransfer({ ...secrets, inventory, key: Buffer.from(secrets.key, 'base64'),
      baseNonce: Buffer.from(secrets.baseNonce, 'base64'), readObject: async row => original[rows.findIndex(item => item.key === row.key)] })) chunks.push(chunk);
    saved.set(result.sessionId, Buffer.concat(chunks));
    return { ...result, secrets };
  }
  return { root, request, manager, original, rows, saved, removed, objects, prepare,
    failObject: () => { failObject = true; }, failCleanup: () => { failCleanup = true; },
    refuseAdmission: () => { admitted = false; }, calls: () => calls };
}

test('encrypted transfer stages exact immutable evidence and private history without changing authority', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  assert.equal(JSON.stringify(prepared.capsule).includes(prepared.secrets.key), false);
  const result = await f.manager.receive(prepared.sessionId);
  assert.equal(result.verified, true); assert.equal(result.authorityChanged, false);
  assert.deepEqual([...f.objects.values()], f.original.slice(1));
  const input = path.join(f.root, prepared.sessionId, 'history.private.json');
  assert.deepEqual(await fs.readFile(input), f.original[0]);
  assert.equal((await fs.stat(input)).mode & 0o077, 0);
  assert.deepEqual(f.removed, [prepared.sessionId]);
  const usedCalls = f.calls();
  assert.equal((await f.manager.receive(prepared.sessionId)).status, 'transfer-already-received');
  assert.equal(f.calls(), usedCalls);
});

test('interrupted evidence writes reuse exact private inputs and resume without authority changes', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  f.failObject();
  await assert.rejects(f.manager.receive(prepared.sessionId), /interrupted native write/);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(await fs.readFile(path.join(f.root, prepared.sessionId, 'history.private.json')), f.original[0]);
  const result = await f.manager.receive(prepared.sessionId);
  assert.equal(result.verified, true); assert.equal(f.objects.size, 2);
});

test('completed transfer retries cleanup without importing any evidence again', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  f.failCleanup();
  await assert.rejects(f.manager.receive(prepared.sessionId), /cleanup interruption/);
  const calls = f.calls();
  assert.equal((await f.manager.receive(prepared.sessionId)).verified, true);
  assert.equal(f.calls(), calls);
});

test('transfer refuses altered ciphertext, active authority, target drift and unsafe plan sizes', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  const altered = f.saved.get(prepared.sessionId); altered[altered.length - 1] ^= 1;
  await assert.rejects(f.manager.receive(prepared.sessionId));
  assert.equal(f.objects.size, 0);
  f.refuseAdmission();
  await assert.rejects(f.manager.receive(prepared.sessionId), /active authority/);
  await assert.rejects(f.manager.prepare({ ...f.request, targetDatabase: 'another_database' }), /target differs/);
  for (const value of [-1, NaN, 0, 100001]) {
    assert.throws(() => validateDriverAuditTransferPlan({ ...f.request, plan: { ...f.request.plan, objectCount: value } }));
  }
  await assert.rejects(f.manager.receive('../../outside'));
});

test('a completion receipt copied from another session cannot bypass target-bound staging checks', async t => {
  const f = await fixture(t), first = await f.prepare(), second = await f.prepare();
  await f.manager.receive(first.sessionId);
  await fs.copyFile(path.join(f.root, first.sessionId, 'received.private.json'),
    path.join(f.root, second.sessionId, 'received.private.json'));
  await assert.rejects(f.manager.receive(second.sessionId), /completion differs/);
  assert.ok(f.saved.has(second.sessionId));
});
