import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { encryptTransfer, decryptTransfer, transferPlan, parseTransferInventory,
  sealTransferSecrets, openTransferSecrets } from './driverAuditTransferCodec.js';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const values = [Buffer.from('fictional original GPS evidence bytes'), Buffer.from('fictional original photo image bytes'),
    Buffer.from('{"fictionalReviewHistory":["first","second"]}')];
  const rows = values.map((value, index) => ({ key: hash(value) + (index === 2 ? '.json' : '.gz'), bytes: value.length,
    ...(index === 2 ? { kind: 'input', name: 'review-history.private.json' } : {}) }));
  const inventory = Buffer.from(rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  const plan = transferPlan(inventory), key = randomBytes(32), baseNonce = randomBytes(8);
  const context = { sessionId: '11111111-2222-4333-8444-555555555555', targetDatabase: 'fictional_reports', inventorySha256: plan.inventorySha256 };
  const chunks = [];
  for await (const chunk of encryptTransfer({ inventory, key, baseNonce, context, readObject: async row => values[rows.findIndex(value => value.key === row.key)] })) chunks.push(chunk);
  return { values, rows, inventory, plan, key, baseNonce, context, encoded: Buffer.concat(chunks) };
}

test('authenticated fragmented transfer preserves every object and private input exactly', async () => {
  const f = await fixture(), received = [];
  const chunks = Array.from({ length: Math.ceil(f.encoded.length / 7) }, (_, i) => f.encoded.subarray(i * 7, i * 7 + 7));
  const proof = await decryptTransfer({ ...f, stream: Readable.from(chunks), receive: async (row, bytes) => received.push({ row, bytes: Buffer.from(bytes) }) });
  assert.equal(proof.verified, true);
  assert.equal(proof.objects, f.rows.length);
  assert.equal(f.encoded.length, f.plan.cipherBytes);
  assert.deepEqual(received.map(value => value.row), f.rows);
  assert.deepEqual(received.map(value => value.bytes), f.values);
  for (const value of f.values) assert.equal(f.encoded.includes(value), false);
});

test('tampered, truncated and wrong-context frames release no evidence', async t => {
  for (const mode of ['tamper', 'truncate', 'wrong-context', 'wrong-plan', 'abort']) await t.test(mode, async () => {
    const f = await fixture(); let received = 0;
    let encoded = Buffer.from(f.encoded), context = f.context, plan = f.plan;
    if (mode === 'tamper') encoded[encoded.length - 1] ^= 1;
    if (mode === 'truncate') encoded = encoded.subarray(0, -1);
    if (mode === 'wrong-context') context = { ...context, targetDatabase: 'another_database' };
    if (mode === 'wrong-plan') plan = { ...plan, objectCount: plan.objectCount + 1 };
    await assert.rejects(decryptTransfer({ ...f, context, plan, stream: Readable.from([encoded]),
      signal: mode === 'abort' ? AbortSignal.abort() : undefined, receive: async () => { received++; } }));
    assert.equal(received, 0);
  });
});

test('source hash mismatch refuses encryption and unsafe inventories refuse planning', async () => {
  const f = await fixture();
  await assert.rejects(async () => {
    for await (const _ of encryptTransfer({ ...f, readObject: async () => Buffer.from('wrong evidence') })) { /* consume */ }
  }, /Original transfer bytes differ/);
  for (const rows of [[f.rows[0], f.rows[0]], [{ ...f.rows[0], bytes: 16 * 1024 * 1024 + 1 }],
    [{ ...f.rows[2], name: '../../outside.private.json' }], [{ ...f.rows[0], key: '../outside.gz' }],
    [{ ...f.rows[2], name: 'session.private.json' }], [{ ...f.rows[2], name: 'received.private.json' }],
    [{ ...f.rows[0], kind: 'input', name: f.rows[2].name }, f.rows[2]]]) {
    assert.throws(() => parseTransferInventory(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n'))));
  }
});

test('transfer capability capsule is readable only by the local recipient and rejects alteration', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const original = { uploadUrl: 'https://example.invalid/fictional-capability', key: randomBytes(32).toString('base64') };
  const sealed = sealTransferSecrets(pair.publicKey, original);
  assert.deepEqual(openTransferSecrets(pair.privateKey, sealed), original);
  assert.equal(JSON.stringify(sealed).includes(original.uploadUrl), false);
  const cipherChanged = Buffer.from(sealed.data, 'base64'); cipherChanged[0] ^= 1;
  assert.throws(() => openTransferSecrets(pair.privateKey, { ...sealed, data: cipherChanged.toString('base64') }));
  const altered = { ...sealed, tag: randomBytes(16).toString('base64') };
  assert.throws(() => openTransferSecrets(pair.privateKey, altered));
  for (const changed of [
    { tag: Buffer.from(sealed.tag, 'base64').subarray(0, 4).toString('base64') },
    { iv: Buffer.from(sealed.iv, 'base64').subarray(0, 8).toString('base64') },
    { key: 'A'.repeat(4096) }, { data: sealed.data + '\n' },
  ]) assert.throws(() => openTransferSecrets(pair.privateKey, { ...sealed, ...changed }));
});
