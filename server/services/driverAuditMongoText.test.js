import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createDriverAuditMongoTextReader, packDriverAuditMongoTexts } from './driverAuditMongoText.js';

function fixture() {
  const values = new Map();
  const objects = {
    async putBytes(bytes) {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      values.set(sha256, bytes);
      return { version: 1, sha256, size: bytes.length, chunks: [] };
    },
    async readBytes(reference) { return values.get(reference.sha256); },
  };
  return { objects, values };
}

test('bounded receipt packs reuse repeated checkpoints while preserving exact Unicode text', async () => {
  const f = fixture();
  const payload = randomBytes(128 * 1024).toString('hex');
  const texts = Array.from({ length: 16 }, (_, revision) => JSON.stringify({ payload, revision, text: 'Dubai دبي 😀' }));
  const refs = await packDriverAuditMongoTexts({ ...f, texts });
  const read = createDriverAuditMongoTextReader(f.objects);
  for (let i = 0; i < texts.length; i++) assert.equal(await read(refs[i]), texts[i]);
  assert.ok([...f.values.values()].reduce((sum, bytes) => sum + bytes.length, 0) < Buffer.byteLength(texts.join('')) / 8);
});

test('packed history rejects changed offsets, oversized decoded packs and tampered original text hashes', async () => {
  const f = fixture();
  const [reference] = await packDriverAuditMongoTexts({ ...f, texts: ['original evidence'] });
  const read = createDriverAuditMongoTextReader(f.objects);
  await assert.rejects(read({ ...reference, offset: 1 }), /reference/);
  await assert.rejects(read({ ...reference, plainBytes: 65 * 1024 * 1024 }), /reference/);
  await assert.rejects(read({ ...reference, sha256: 'a'.repeat(64) }), /integrity/);
  await assert.rejects(read({ ...reference, plainBytes: 1, offset: 0, size: 1 }), /larger|length|size|buffer/i);
});
