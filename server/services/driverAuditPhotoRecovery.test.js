import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as implementation from './driverAuditPhotoRecovery.js';
import { createSupabaseArchiveTransport } from '../vendor/driver-audits/integration/hosted/supabase-archive.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('fictional exact original image bytes'), reference = { sha256: sha(bytes), size: bytes.length };
const key = reference.sha256 + '.gz';
function fixture({ initial, lostAck = false, getStatus, publicBucket = false, competingBytes } = {}) {
  const objects = new Map(initial === undefined ? [] : [[key, Buffer.from(initial)]]), requests = [];
  let lose = lostAck;
  const archive = createSupabaseArchiveTransport({ secret: 'fictional-private-key', drainAcknowledgements: true,
    async fetchImpl(input, options) {
      const url = new URL(input); assert.equal(url.origin, 'https://trhhjfgfmxofxhnzocks.supabase.co');
      requests.push({ path: url.pathname, method: options.method });
      if (url.pathname === '/storage/v1/bucket/matter-report-archive') return Response.json({ id: 'matter-report-archive', public: publicBucket });
      assert.equal(url.pathname.split('/').at(-1), key);
      if (options.method === 'POST') {
        assert.equal(options.headers['x-upsert'], 'false');
        if (competingBytes) objects.set(key, Buffer.from(competingBytes));
        if (objects.has(key)) return Response.json({ error: 'Duplicate' }, { status: 409 });
        objects.set(key, Buffer.from(options.body));
        if (lose) { lose = false; throw Error('Acknowledgement lost after immutable insert'); }
        return Response.json({ Key: key });
      }
      assert.equal(options.method, 'GET');
      if (getStatus) return Response.json({ statusCode: String(getStatus) }, { status: getStatus });
      return objects.has(key) ? new Response(objects.get(key)) : Response.json({ statusCode: '404' }, { status: 400 });
    } });
  assert.equal(typeof implementation.createDriverAuditSupabasePhotoRecovery, 'function');
  return { recovery: implementation.createDriverAuditSupabasePhotoRecovery({ archive }), objects, requests };
}

test('private directory recovery preserves original raw bytes and never replaces an existing corrupt original', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photo-local-recovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recovery = implementation.createDriverAuditPhotoRecovery(root);
  await recovery.preserve(reference, bytes);
  const original = await fs.stat(path.join(root, reference.sha256));
  await recovery.preserve(reference, bytes);
  assert.deepEqual(await recovery.read(reference), bytes);
  assert.equal((await fs.stat(path.join(root, reference.sha256))).ino, original.ino);
  await fs.writeFile(path.join(root, reference.sha256), 'independent changed bytes');
  await assert.rejects(recovery.preserve(reference, bytes));
  assert.equal(await fs.readFile(path.join(root, reference.sha256), 'utf8'), 'independent changed bytes');
});

test('an existing raw Supabase object is fully verified and reused without a second object or PUT', async () => {
  const f = fixture({ initial: bytes });
  assert.equal((await f.recovery.assertReady()).strategy, 'supabase-private-photo-recovery');
  await f.recovery.preserve(reference, bytes);
  assert.deepEqual(await f.recovery.read(reference), bytes);
  assert.equal(f.objects.size, 1);
  assert.equal(f.requests.filter(row => row.method === 'POST').length, 0);
  assert(f.requests.filter(row => row.path.includes('/object/')).every(row => row.path.endsWith('/' + key)));
});

test('only proved absence adds the exact raw hash key and actual transport readback verifies its bytes', async () => {
  const f = fixture();
  await f.recovery.preserve(reference, bytes);
  assert.deepEqual(f.objects.get(key), bytes, 'The existing raw-photo key never receives a new encoding');
  assert.equal(f.requests.filter(row => row.method === 'POST').length, 1);
  assert.equal(f.requests.filter(row => row.method === 'GET' && row.path.includes('/object/')).length, 2,
    'One absence check and the original verified transport readback are sufficient');
  await f.recovery.preserve(reference, bytes);
  assert.equal(f.requests.filter(row => row.method === 'POST').length, 1);
});

test('an immutable write with no acknowledgement is reused on exact retry without repeating the upload', async () => {
  const f = fixture({ lostAck: true });
  await assert.rejects(f.recovery.preserve(reference, bytes));
  assert.deepEqual(f.objects.get(key), bytes);
  await f.recovery.preserve(reference, bytes);
  assert.equal(f.requests.filter(row => row.method === 'POST').length, 1);
  assert.deepEqual(await f.recovery.read(reference), bytes);
});

test('unavailable, forbidden, oversized and corrupt stored bytes never count as absence or allow a PUT', async () => {
  for (const options of [{ getStatus: 403 }, { getStatus: 429 }, { getStatus: 500 },
    { initial: Buffer.alloc(bytes.length + 1) }, { initial: Buffer.from('x'.repeat(bytes.length)) }, { initial: bytes.subarray(1) }]) {
    const f = fixture(options), before = f.objects.get(key);
    await assert.rejects(f.recovery.preserve(reference, bytes));
    assert.equal(f.requests.some(row => row.method === 'POST'), false);
    assert.deepEqual(f.objects.get(key), before);
  }
});

test('concurrent identical content is reusable while a conflicting winner remains untouched and blocks preservation', async () => {
  const same = fixture({ competingBytes: bytes });
  await same.recovery.preserve(reference, bytes);
  assert.deepEqual(await same.recovery.read(reference), bytes);
  const foreign = Buffer.from('x'.repeat(bytes.length)), different = fixture({ competingBytes: foreign });
  await assert.rejects(different.recovery.preserve(reference, bytes));
  assert.deepEqual(different.objects.get(key), foreign);
});

test('public buckets and invalid photo hash/size bindings stop before any immutable object write', async () => {
  const f = fixture({ publicBucket: true });
  await assert.rejects(f.recovery.preserve(reference, bytes));
  assert.equal(f.requests.some(row => row.path.includes('/object/')), false);
  const valid = fixture();
  for (const value of [{ ...reference, size: 0 }, { ...reference, size: 16 * 1024 ** 2 + 1 },
    { ...reference, sha256: 'not-a-hash' }, { ...reference, size: bytes.length - 1 }]) {
    await assert.rejects(valid.recovery.preserve(value, bytes));
  }
  assert.deepEqual(valid.requests, []);
});
