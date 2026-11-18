import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDriverAuditDataBackend, openDriverAuditDataBackend } from './driverAuditDataBackend.js';
import { createDriverAuditSupabaseAppBackend } from './driverAuditSupabaseAppBackend.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('fictional original preserved report bytes'), key = hash(bytes) + '.gz';
const basis = 'supabase-http-bytes-v1';
const photoIdentity = 'a'.repeat(64);
const originalCollector = JSON.stringify({ version: 1, fixture: 'original source fixture' });
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'driver-supabase-app-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { DRIVER_AUDIT_EXECUTION_HOST: 'sidi', MATTER_SUPABASE_SECRET: 'fictional-private-credential',
    MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: directory, SPACES_BUCKET: 'fixture-photos',
    SPACES_ENDPOINT: 'fra1.digitaloceanspaces.com', SPACES_REGION: 'fra1' };
  const calls = [], objects = new Map([[key, bytes]]), aliases = new Map();
  let offline = false, photoReads = 0, collectorFullReads = 0;
  const fetchImpl = async (input, options) => {
    if (offline) throw Error('Offline fixture');
    const url = new URL(input), name = url.pathname.split('/').at(-1);
    calls.push({ path: url.pathname, method: options.method,
      args: url.pathname.includes('/rest/v1/rpc/') ? JSON.parse(options.body) : undefined });
    if (url.pathname.includes('/rest/v1/rpc/')) {
      const args = JSON.parse(options.body);
      let value;
      if (name.endsWith('_egress_reserve')) value = { version: 1, basis, allowed: true, id: args.p_id,
        period: '2026-11', requestBytes: args.p_request_bytes, responseBytes: args.p_response_bytes };
      else if (name.endsWith('_egress_settle')) value = { version: 1, basis, settled: true,
        period: '2026-11', chargedRequestBytes: args.p_request_bytes, chargedResponseBytes: args.p_response_bytes };
      else if (name.endsWith('_egress_read')) value = { version: 1, basis,
        month: { period: '2026-11', usedBytes: 0, reservedBytes: 0, limitBytes: 8 * 1024 ** 3 },
        day: { period: '2026-11-17', usedBytes: 0, reservedBytes: 0, limitBytes: 512 * 1024 ** 2 },
        activeReservations: 0, uncertainReservations: 0 };
      else if (name.endsWith('_photo_alias_register')) {
        if (!aliases.has(args.p_key)) aliases.set(args.p_key, args.p_reference);
        value = { reference: aliases.get(args.p_key) };
      } else if (name.endsWith('_photo_alias_read')) value = { reference: aliases.get(args.p_key) ?? null };
      else if (name.endsWith('_progress_read')) value = { revision: 0, body_text: null };
      else if (name === 'matter_hosted_state_read') { collectorFullReads++; value = { revision: 17, body_text: originalCollector }; }
      else if (name === 'matter_hosted_state_read_if_changed') {
        const unchanged = args.p_revision === 17;
        if (!unchanged) collectorFullReads++;
        value = { revision: 17, body_text: unchanged ? null : originalCollector, unchanged };
      }
      else assert.fail('Unexpected RPC: ' + name);
      return Response.json(value);
    }
    if (url.pathname.includes('/storage/v1/bucket/')) return Response.json({ id: 'matter-report-archive', public: false });
    const objectKey = url.pathname.split('/').at(-1);
    if (options.method === 'POST') { objects.set(objectKey, Buffer.from(options.body)); return Response.json({ Key: objectKey }); }
    return objects.has(objectKey) ? new Response(objects.get(objectKey)) : Response.json({ statusCode: '404' }, { status: 400 });
  };
  const photoStore = { identitySha256: photoIdentity,
    async assertExistingPhotoRetention() { return { verified: true, rules: 0, existingPhotosExpire: false }; },
    async verifyExistingPhoto(value) { return { version: 1, provider: 'spaces', identitySha256: photoIdentity,
      kind: 'existing-photo-v1', ...value, etag: '"fixture-etag"', versionId: null }; },
    async readExistingPhoto() { photoReads++; return bytes; },
  };
  const open = () => createDriverAuditSupabaseAppBackend({ env, fetchImpl, photoStore, cacheFreeBytes: async () => 4 * 1024 ** 3 });
  return { env, calls, objects, aliases, open, offline: () => { offline = true; }, photoReads: () => photoReads,
    collectorFullReads: () => collectorFullReads };
}

test('unmarked Supabase remains the original backend and has no Sidi capabilities', async () => {
  const backend = await createDriverAuditDataBackend({ env: { MATTER_SUPABASE_SECRET: 'fictional-private' } });
  assert.equal(backend.kind, 'supabase');
  assert.equal(backend.executionHost, undefined);
  assert.equal(backend.pollProgress, undefined);
  await assert.rejects(createDriverAuditDataBackend({ env: { DRIVER_AUDIT_EXECUTION_HOST: 'other' } }), /execution host/);
});

test('Sidi execution preserves truthful storage kind and requires a private shared cache', async t => {
  const f = await fixture(t), backend = await f.open();
  assert.equal(backend.kind, 'supabase');
  assert.equal(backend.executionHost, 'sidi');
  assert.equal(backend.executionAdmission, 'fixed-host-v1');
  assert.equal(backend.transferAccounting, basis);
  assert.equal(backend.archive.managedReadCache, true);
  await fs.chmod(f.env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY, 0o755);
  await assert.rejects(f.open(), /owner-private/);
  assert.equal(f.calls.length, 0);
});

test('explicit Sidi reporting ignores parked inherited Mongo settings without opening a connection', async t => {
  const f = await fixture(t);
  const backend = await openDriverAuditDataBackend({ env: { ...f.env, SPACES_KEY: 'fictional-key',
    SPACES_SECRET: 'fictional-secret', DRIVER_AUDIT_DATA_STORE: 'mongo',
    MONGODB_URI: 'mongodb://127.0.0.1:1/never-connect', DRIVER_AUDIT_NATIVE_CAPACITY_BYTES: '17179869184' } });
  assert.equal(backend.kind, 'supabase');
  assert.equal(backend.executionHost, 'sidi');
  assert.equal(backend.db, undefined);
  await backend.close();
});

test('one verified download fills the shared cache and reload works without remote access', async t => {
  const f = await fixture(t), backend = await f.open();
  assert.deepEqual(Buffer.concat(await backend.archive.readObject(key, { maxBytes: bytes.length })), bytes);
  const count = f.calls.length;
  assert.ok(count > 0);
  assert.equal(f.calls.filter(call => call.path.includes('/storage/')).length, 1);
  const reservations = f.calls.filter(call => call.path.endsWith('_egress_reserve'));
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every(call => call.args.p_response_bytes <= 128 * 1024),
    'A short archive request and photo reference must reserve only their response bounds');
  assert.deepEqual(Buffer.concat(await backend.archive.readObject(key)), bytes);
  assert.equal(f.calls.length, count, 'A disk cache hit must not reserve or fetch remote bytes');
  f.offline();
  const reloaded = await f.open();
  assert.deepEqual(Buffer.concat(await reloaded.archive.readObject(key)), bytes);
  assert.equal(f.calls.length, count);
});

test('a new photo admits only a reference and persists across backend reload', async t => {
  const f = await fixture(t), backend = await f.open();
  f.objects.clear();
  backend.archive.offerSourcePhotoCandidate({ sha256: hash(bytes), size: bytes.length,
    url: 'https://fixture-photos.fra1.cdn.digitaloceanspaces.com/photos/fixture.jpg' });
  assert.equal((await backend.archive.putVerifiedObject(key, bytes)).reusedExistingPhoto, true);
  assert.equal(f.objects.size, 0);
  assert.equal(f.aliases.size, 1);
  const reloaded = await f.open();
  assert.deepEqual(Buffer.concat(await reloaded.archive.readObject(key)), bytes);
  assert.ok(f.photoReads() >= 2);
  assert.equal(f.calls.some(call => call.path.includes('/storage/')), false);
});

test('poll progress uses additive bounded metadata RPCs and leaves the original state RPC available', async t => {
  const f = await fixture(t), backend = await f.open();
  assert.deepEqual(await backend.pollProgress.read({ key: 'native-progress:delivery' }), { revision: 0, body: null });
  assert(f.calls.some(call => call.path.endsWith('/matter_hosted_app_progress_read')));
  assert.equal(f.calls.some(call => call.path.endsWith('/matter_hosted_state_cas')), false);
  const original = await backend.rpc('matter_hosted_state_read', { p_key: 'collector-state' });
  assert.equal(original.revision, 17);
  const usage = await backend.readTransferUsage();
  assert.equal(usage.basis, basis);
});

test('collector state checks Supabase on each read but reuses exact bytes across limited readers and backend restart', async t => {
  const f = await fixture(t), backend = await f.open();
  const expected = { revision: 17, body_text: originalCollector };
  assert.deepEqual(await backend.rpc('matter_hosted_state_read', { p_key: 'collector-state' }), expected);
  assert.deepEqual(await backend.rpcForResponseLimit(4096)('matter_hosted_state_read', { p_key: 'collector-state' }), expected);
  const restarted = await f.open();
  assert.deepEqual(await restarted.rpc('matter_hosted_state_read', { p_key: 'collector-state' }), expected);
  assert.equal(f.collectorFullReads(), 1);
  assert.deepEqual(f.calls.filter(call => call.path.endsWith('/matter_hosted_state_read_if_changed'))
    .map(call => call.args.p_revision), [0, 17, 17]);
  await restarted.rpc('matter_hosted_state_read', { p_key: 'photo-grading-budget' });
  assert.equal(f.collectorFullReads(), 2, 'Paid state must use its original uncached RPC');
  f.offline();
  await assert.rejects(restarted.rpc('matter_hosted_state_read', { p_key: 'collector-state' }), /unavailable|admission|connection/i);
});
