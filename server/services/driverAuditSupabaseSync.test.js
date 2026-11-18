import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { archiveBytes, archiveCatalog } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { prepareRemotePreviewPackage } from '../vendor/driver-audits/integration/cloud/remote-preview-package.mjs';
import { acquireWorkerLock } from '../vendor/driver-audits/integration/hosted/worker-lock.mjs';
import { createDriverAuditSupabaseSync, runDriverAuditSupabaseSync } from './driverAuditSupabaseSync.js';
import { readDriverAuditFileSyncStatus } from './driverAuditSyncStatus.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const at = '2026-11-12T00:00:00.000Z';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const basis = publication => sha(JSON.stringify(canonical({ head: { reportHash: publication.head.reportHash,
  manifest: publication.head.manifest, gps: publication.head.gps }, gps: {}, photos: {}, photoBindingRepair: null })));
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}

// A fictional builder implements the existing four-module boundary. The real
// public package preparation, dependency closure, CAS and OS locks run below.
const builderModules = {
  'integration/cloud/automatic-release.mjs': `
import fs from 'node:fs/promises';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const automaticReleaseBasis=p=>createHash('sha256').update(JSON.stringify(canonical({head:{reportHash:p.head.reportHash,manifest:p.head.manifest,gps:p.head.gps},gps:{},photos:{},photoBindingRepair:null}))).digest('hex');
export function createAutomaticRelease({root,baselineRoot,loadSource,build,validate,pinnedDirectSync}){
 if(pinnedDirectSync!==true)throw Error('Pinned fixture required');const pointerFile=path.join(root,'current.private.json');
 return{pointerFile,async tick(){const source=await loadSource(),output=path.join(root,'attempts',randomUUID());await fs.mkdir(output,{recursive:true,mode:0o700});
 const result=await build({source,output,baselineRoot});const validation=await validate(result);if(!validation.ok)throw Error('Fixture validation failed');
 const candidate={version:1,collectorRevision:source.savedState.revision,sourceBasis:automaticReleaseBasis(source.publication),privateRoot:result.privateRoot,manifestSha256:validation.manifestSha256};
 await fs.writeFile(pointerFile,JSON.stringify(candidate),{mode:0o600});return candidate;}};}
`,
  'integration/cloud/automatic-release-source.mjs': `
export const supportsManagedArchiveCache=true;
export function createAutomaticReleaseSource({stateStore,skipCacheWrite,archiveTransport}){
 if(!skipCacheWrite||archiveTransport.managedReadCache!==true)throw Error('Managed fixture cache required');
 return async()=>{const savedState=await stateStore.read('collector-state');return{savedState,publication:JSON.parse(savedState.body),transport:archiveTransport};};}
`,
  'integration/cloud/automatic-release-build.mjs': `
import fs from 'node:fs/promises';import path from 'node:path';export const compactDirectBuildVersion=1;
export async function buildAutomaticRelease({source,output,checkSpace}){await checkSpace();
 const privateRoot=path.join(output,'private');await fs.cp(source.publication.fixturePackageRoot,privateRoot,{recursive:true});
 await fs.appendFile(path.join(path.dirname(path.dirname(output)),'fixture-builds.private.txt'),'built\\n',{mode:0o600});return{privateRoot};}
`,
  'scripts/run-automatic-report.mjs': `
import fs from 'node:fs/promises';import path from 'node:path';import{createHash}from'node:crypto';
export async function validateAutomaticCandidate(candidate){const bytes=await fs.readFile(path.join(candidate.privateRoot,'files.private.json'));
 return{ok:true,manifestSha256:createHash('sha256').update(bytes).digest('hex')};}
`,
};

async function packageFiles(directory, revision) {
  const blobs = new Map(), files = {};
  const local = { async putVerifiedObject(key, body) {
    blobs.set(key, Buffer.from(body));
    return { key, sha256: sha(body), verified: true };
  } };
  const browser = Buffer.from(JSON.stringify({ fictionalRevision: revision })), generation = sha(browser), reportHash = sha('report-' + revision);
  const snapshot = { sha256: generation, url: 'report-data/snapshot-' + generation + '.json' };
  const queue = { items: [] }, inventories = [{ queue, proposals: {} }, { queue, proposals: {} }];
  const inventoryDigest = sha(JSON.stringify(inventories)), queueDigest = sha(JSON.stringify(queue));
  const retained = [];
  for (const [name, body] of Object.entries({
    ['review-snapshots/' + reportHash + '.json.gz']: gzipSync(JSON.stringify({ snapshotHash: reportHash, rows: [], issues: [] })),
    ['photo-generations/' + reportHash + '.json']: Buffer.from(JSON.stringify({ digest: inventoryDigest })),
    ['photo-inventories/' + inventoryDigest + '.json']: Buffer.from(JSON.stringify(inventories.map(({ queue: ignored, ...rest }) => ({ queueDigest, ...rest })))),
    ['photo-inventories/queues/' + queueDigest + '.json']: Buffer.from(JSON.stringify(queue)),
  })) retained.push(await archiveBytes(local, body, { domain: 'state', path: name }));
  const catalog = await archiveCatalog(local, retained);
  const publication = { version: 1, head: { reportHash, manifest: snapshot, source: { observedAt: at } }, catalog,
    fixturePackageRoot: directory };
  const values = {
    'publication.private.json': Buffer.from(JSON.stringify(publication)), 'identities.private.json': Buffer.from('{}'),
    'maps.private.json': Buffer.from('{}'), 'gps-index.private.json.gz': gzipSync('{"streamFiles":{}}'),
    'preview-read-view.private.json.gz': gzipSync(JSON.stringify({ reportHash, generation, catalogHash: catalog.sha256,
      browser: snapshot, allowedResources: [snapshot.url], photos: [], gpsRows: [] })),
    'renderer.private.html': Buffer.from('<html>Fictional</html>'), 'build.private.json': Buffer.from('{}'),
    'browser-data.private.json.gz': gzipSync(browser),
  };
  for (const [name, body] of Object.entries(values)) { await write(path.join(directory, name), body); files[name] = sha(body); }
  for (const [key, body] of blobs) {
    const name = 'archive-' + key.slice(0, 64) + '.private.bin';
    await write(path.join(directory, name), body); files[name] = sha(body);
  }
  const manifestBytes = Buffer.from(JSON.stringify(files)), manifestSha256 = sha(manifestBytes);
  await write(path.join(directory, 'files.private.json'), manifestBytes);
  const bundleRoot = path.join(path.dirname(directory), 'objects');
  const prepared = await prepareRemotePreviewPackage({ privateRoot: directory, validation: { ok: true, manifestSha256 },
    includeRetained: false, maxBytes: 128 * 1024 ** 2, runBatch: async (_, operation) => operation(),
    transport: { async putVerifiedObject(key, body) { await write(path.join(bundleRoot, key), body); return { key, sha256: sha(body), verified: true }; } } });
  const binding = { manifestSha256, generation, reportHash, descriptorSha256: prepared.descriptor.sha256 };
  return { publication, blobs, seed: { version: 1, mode: 'bootstrap', bundleRoot, collectorRevision: revision,
    sourceBasis: basis(publication), manifestSha256, pointer: { version: 1, generation, reportHash, descriptor: prepared.descriptor },
    visibleCutoffAt: at, closureReceipt: { version: 1, status: 'verified', sourceBasis: basis(publication), ...binding,
      checkedAt: at, checks: { archive: true, photos: true, reviewHistory: true } },
    restore: { version: 1, archive: 'matter-report-archive', verified: true, ...binding } } };
}

async function fixture(t, { signal, clock, executionHost = 'sidi', collectSource, armedAt } = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'driver-audit-supabase-sync-')));
  let worker;
  t.after(async () => { try { await worker?.close(); } finally { await fs.rm(temporary, { recursive: true, force: true }); } });
  const root = path.join(temporary, 'sync', randomUUID()), baselineRoot = path.join(root, 'baseline'), codeRoot = path.join(root, 'builder');
  const initial = await packageFiles(baselineRoot, 42), next = await packageFiles(path.join(temporary, 'next'), 43);
  const manifest = { version: 1, files: {} };
  for (const [name, source] of Object.entries(builderModules)) { await write(path.join(codeRoot, name), source); manifest.files[name] = sha(source); }
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); await write(path.join(codeRoot, 'runtime-manifest.json'), manifestBytes);
  await write(path.join(root, 'validation-journals.private.json'), '{}');
  await write(path.join(root, 'seed.json'), initial.seed);
  const config = { version: 1, root, baselineRoot, codeRoot, builderSha256: sha(manifestBytes),
    rendererBuild: { path: path.join(baselineRoot, 'build.private.json'), sha256: sha('{}') },
    journals: { path: path.join(root, 'validation-journals.private.json'), sha256: sha('{}') } };
  const file = path.join(root, 'sync.json'); await write(file, config);
  const states = new Map([['collector-state', { revision: 43, body: JSON.stringify(next.publication) }]]), calls = [], uploads = [], objects = new Map();
  const receipts = new Map([initial, next].map((entry, i) => [42 + i, { revision: 42 + i, body_text: JSON.stringify(entry.publication),
    body_sha256: sha(JSON.stringify(entry.publication)), event_text: '{}', event_id: 'collector-' + (42 + i), request_sha256: sha('request-' + i) }]));
  const reservations = new Map(); let lostAck = false, corrupt = false, afterCas;
  const archive = { managedReadCache: true,
    async assertPrivate() { return { bucket: 'matter-report-archive', public: false }; },
    async readObject(key, { maxBytes }) {
      const body = objects.get(key);
      if (!body) throw Object.assign(Error('Original object missing'), { code: 'storage_not_found' });
      if (body.length > maxBytes) throw Error('Fixture bound exceeded');
      return [Buffer.from(body)];
    },
    async putVerifiedObject(key, body) {
      uploads.push(key); objects.set(key, corrupt ? Buffer.from('corrupt') : Buffer.from(body));
      return { key, bytes: body.length, sha256: sha(body), verified: true };
    },
  };
  async function rpc(name, args) {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'matter_hosted_state_read') { const row = states.get(args.p_key) ?? { revision: 0, body: null }; return { revision: row.revision, body_text: row.body }; }
    if (name === 'matter_hosted_state_read_if_changed') {
      const row = states.get(args.p_key) ?? { revision: 0, body: null };
      return { revision: row.revision, body_text: row.revision === args.p_revision ? null : row.body, unchanged: row.revision === args.p_revision };
    }
    if (name === 'matter_hosted_state_receipts') return [...receipts.values()].filter(row => row.revision > args.p_after)
      .sort((left, right) => left.revision - right.revision).slice(0, 1);
    if (name === 'matter_hosted_state_cas') {
      assert.equal(args.p_key, 'app-sidi-report-head');
      const row = states.get(args.p_key) ?? { revision: 0, body: null };
      if (row.revision !== args.p_expected) throw Object.assign(Error('Concurrent fixture'), { status: 409 });
      const result = { revision: row.revision + 1, body: args.p_body_text }; states.set(args.p_key, result);
      if (afterCas) { const callback = afterCas; afterCas = null; callback(); }
      if (lostAck) { lostAck = false; throw Error('Lost acknowledgement'); }
      return { revision: result.revision, body_text: result.body, body_sha256: sha(result.body), event_text: args.p_event_text, replayed: false };
    }
    if (name === 'matter_hosted_archive_capacity') return { used_bytes: 0, requested_bytes: args.p_requested_bytes, limit_bytes: 60000000000, allowed: true };
    if (name === 'matter_hosted_archive_reserve') { const row = { id: args.p_id, reserved_bytes: args.p_reserved_bytes, consumed_bytes: 0, released: false }; reservations.set(args.p_id, row); return { ...row }; }
    if (name === 'matter_hosted_archive_consume') { const row = reservations.get(args.p_id); row.consumed_bytes += args.p_bytes; return { ...row }; }
    if (name === 'matter_hosted_archive_release') { const row = reservations.get(args.p_id); row.released = true; return { ...row }; }
    throw Error('Unexpected fixture RPC: ' + name);
  }
  const backend = { kind: 'supabase', executionHost, executionAdmission: 'fixed-host-v1', transferAccounting: 'supabase-http-bytes-v1',
    rpc, rpcForResponseLimit: () => rpc, archive, archiveCacheDirectory: path.join(root, 'work', 'archive-cache'),
    readTransferUsage: async () => ({}), archiveReadBudget: { reserve: async () => ({ allowed: true }), settle: async () => ({ settled: true }) } };
  const f = { root, file, config, backend, states, objects, calls, uploads, initial, next, receipts,
    loseNextAck() { lostAck = true; }, corruptUploads() { corrupt = true; }, onNextCas(callback) { afterCas = callback; } };
  f.reopen = async (signalOverride = signal) => {
    await worker?.close();
    f.worker = worker = await createDriverAuditSupabaseSync({ config, file, backend, collectSource, armedAt, signal: signalOverride, clock });
  };
  await f.reopen();
  return f;
}

async function saveFixtureCollector(f, revision) {
  const next = await packageFiles(path.join(f.root, 'late-fixture-' + revision), revision);
  const body = JSON.stringify(next.publication);
  f.states.set('collector-state', { revision, body });
  f.receipts.set(revision, { ...f.receipts.get(43), revision, body_text: body,
    body_sha256: sha(body), event_id: 'collector-' + revision });
}

test('seed verifies original saved receipts and bytes without live acquisition or business writers', async t => {
  const f = await fixture(t), sourceBefore = structuredClone(f.states.get('collector-state'));
  const local = await fs.readdir(f.initial.seed.bundleRoot), retained = local[0];
  f.objects.set(retained, await fs.readFile(path.join(f.initial.seed.bundleRoot, retained)));
  const result = await f.worker.seed();
  assert.equal(result.status, 'published');
  assert.equal(result.head.servingPackage.collectorRevision, 42);
  assert.equal(f.uploads.includes(retained), false);
  assert.deepEqual(f.states.get('collector-state'), sourceBefore);
  const originalReads = f.calls.filter(call => call.args.p_key === 'collector-state');
  assert.ok(originalReads.length > 0);
  assert.equal(originalReads.every(call => call.name === 'matter_hosted_state_receipts'), true);
  assert.equal(f.calls.filter(call => call.name === 'matter_hosted_state_cas').length, 1);
  assert.equal(result.head.closureReceipt.checkedAt, at);
  const uploaded = f.uploads.length;
  assert.equal((await f.worker.seed()).status, 'unchanged');
  assert.equal(f.uploads.length, uploaded);
});

test('a seed package cannot be relabeled as another original collector receipt', async t => {
  const f = await fixture(t), receipt = f.receipts.get(42);
  receipt.body_text = JSON.stringify(f.next.publication); receipt.body_sha256 = sha(receipt.body_text);
  await assert.rejects(f.worker.seed(), /original|receipt|basis/i);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.states.has('app-sidi-report-head'), false);
});

test('the original source clock is required even when its evidence basis is unchanged', async t => {
  const f = await fixture(t), receipt = f.receipts.get(42), altered = JSON.parse(receipt.body_text);
  altered.head.source.observedAt = '2026-11-13T00:00:00.000Z';
  assert.equal(basis(altered), f.initial.seed.sourceBasis);
  receipt.body_text = JSON.stringify(altered); receipt.body_sha256 = sha(receipt.body_text);
  await assert.rejects(f.worker.seed(), /source.*cutoff|source.*clock/i);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.states.has('app-sidi-report-head'), false);
});

test('bootstrap previous also requires the matching original collector receipt before uploads', async t => {
  const f = await fixture(t), old = await packageFiles(path.join(f.root, 'older', 'package'), 41);
  const previous = { ...old.seed.pointer,
    servingPackage: { version: 1, dataStore: 'supabase', collectorRevision: 41,
      sourceBasis: old.seed.sourceBasis, manifestSha256: old.seed.manifestSha256 },
    visibleCutoffAt: old.seed.visibleCutoffAt, closureReceipt: old.seed.closureReceipt, restore: old.seed.restore };
  const seed = structuredClone(f.initial.seed); seed.pointer.previous = previous;
  await write(path.join(f.root, 'seed.json'), seed);
  for (const key of await fs.readdir(old.seed.bundleRoot)) await fs.copyFile(path.join(old.seed.bundleRoot, key), path.join(seed.bundleRoot, key));
  f.receipts.set(41, { ...f.receipts.get(42), revision: 41, event_id: 'collector-41' });
  await assert.rejects(f.worker.seed(), /original|receipt|basis/i);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.states.has('app-sidi-report-head'), false);
});

test('missing local seed bytes fail before archive writes or pointer selection', async t => {
  const f = await fixture(t), files = await fs.readdir(f.initial.seed.bundleRoot);
  await fs.unlink(path.join(f.initial.seed.bundleRoot, files[0]));
  await assert.rejects(f.worker.seed(), /missing|ENOENT/i);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.states.has('app-sidi-report-head'), false);
});

test('check requires the genuine seed and reports the actual app pointer without writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.worker.check(), /seed/i);
  await f.worker.seed();
  const count = f.calls.filter(call => call.name.endsWith('_cas')).length;
  const checked = await f.worker.check();
  assert.equal(checked.status, 'checked');
  assert.equal(checked.activeGeneration, f.initial.seed.pointer.generation);
  assert.equal(checked.dataStore, 'supabase');
  assert.equal(f.calls.filter(call => call.name.endsWith('_cas')).length, count);
});

test('a new genuine source uses the pinned builder and complete original closure before Supabase activation', async t => {
  const f = await fixture(t);
  await f.worker.seed();
  await f.worker.tick();
  const actual = JSON.parse(f.states.get('app-sidi-report-head').body);
  assert.equal(actual.servingPackage.collectorRevision, 43);
  assert.equal(actual.servingPackage.sourceBasis, basis(f.next.publication));
  assert.equal(actual.closureReceipt.collectorRevision, 43);
  assert.equal(actual.previous.generation, f.initial.seed.pointer.generation);
  assert.equal(f.calls.filter(call => call.name === 'matter_hosted_state_cas').length, 2);
  assert.ok(f.calls.some(call => call.name === 'matter_hosted_state_receipts' && call.args.p_after === 42));
  assert.equal(await fs.readFile(path.join(f.root, 'work', 'fixture-builds.private.txt'), 'utf8'), 'built\n');
  const status = JSON.parse(await fs.readFile(path.join(f.root, 'sync-status.private.json')));
  assert.equal(status.status, 'ready'); assert.equal(status.pending, false);
  assert.equal(status.activeGeneration, actual.generation);
  assert.equal(status.visibleCutoffAt, at);
});

test('an identical saved source performs no build, archive upload or publication receipt', async t => {
  const f = await fixture(t); await f.worker.seed(); await f.worker.tick();
  const uploads = f.uploads.length, cas = f.calls.filter(call => call.name.endsWith('_cas')).length;
  await f.worker.tick();
  assert.equal(f.uploads.length, uploads);
  assert.equal(f.calls.filter(call => call.name.endsWith('_cas')).length, cas);
  assert.equal(await fs.readFile(path.join(f.root, 'work', 'fixture-builds.private.txt'), 'utf8'), 'built\n');
});

test('10:30 Dubai builds once and an unchanged noon check survives restart without a second publication', async t => {
  const main = Date.parse('2026-11-18T06:30:00Z'), noon = Date.parse('2026-11-18T08:00:00Z');
  let now = main - 1;
  const f = await fixture(t, { clock: () => now });
  await f.worker.seed();
  const initialCalls = f.calls.length;
  assert.equal(await f.worker.scheduledTick(), main);
  assert.equal(f.calls.length, initialCalls);

  now = main;
  await f.worker.scheduledTick();
  const head = f.states.get('app-sidi-report-head'), calls = f.calls.length, uploads = f.uploads.length;
  const file = path.join(f.root, 'sync-status.private.json');
  const generation = JSON.parse(head.body).generation;
  assert.equal(JSON.parse(head.body).servingPackage.collectorRevision, 43);

  now = noon - 1;
  await f.reopen();
  assert.equal(await f.worker.scheduledTick(), noon);
  assert.equal(f.calls.length, calls);
  const status = await readDriverAuditFileSyncStatus(file, generation, () => now);
  assert.equal(status.status, 'ready');
  assert.equal(status.checkedAt, new Date(main).toISOString());
  assert.equal(status.latestCaptureAt, at);

  // A later collector receipt alone does not change the evidence basis.
  f.states.set('collector-state', { ...f.states.get('collector-state'), revision: 44 });
  now = noon;
  await f.worker.scheduledTick();
  assert.deepEqual(f.states.get('app-sidi-report-head'), head);
  assert.equal(f.uploads.length, uploads);
  assert.equal(await fs.readFile(path.join(f.root, 'work', 'fixture-builds.private.txt'), 'utf8'), 'built\n');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).lastScheduledAt, new Date(noon).toISOString());

  now = Date.parse('2026-11-18T20:00:00Z'); // Dubai midnight
  const afterNoonCalls = f.calls.length;
  await f.reopen();
  await f.worker.scheduledTick();
  assert.equal(f.calls.length, afterNoonCalls);
});

test('the off-host worker collects before building and retains unchanged noon evidence across restart', async t => {
  const morning = Date.parse('2026-11-18T06:30:00Z'), noon = Date.parse('2026-11-18T08:00:00Z');
  let now = morning - 1;
  const slots = [];
  const f = await fixture(t, { clock: () => now, executionHost: 'off-host', async collectSource({ dueAt, onAdmission }) {
    await onAdmission();
    slots.push(dueAt);
    if (dueAt === morning) f.states.set('collector-state', { revision: 43, body: JSON.stringify(f.next.publication) });
  } });
  f.states.set('collector-state', { revision: 42, body: JSON.stringify(f.initial.publication) });
  await f.worker.seed();
  const initial = f.calls.length;
  await f.worker.scheduledTick();
  assert.equal(f.calls.length, initial);
  now = morning;
  await f.worker.scheduledTick();
  const head = f.states.get('app-sidi-report-head'), uploads = f.uploads.length;
  assert.equal(JSON.parse(head.body).servingPackage.collectorRevision, 43);
  now = noon;
  await f.reopen();
  await f.worker.scheduledTick();
  await f.reopen();
  await f.worker.scheduledTick();
  assert.deepEqual(slots, [morning, noon]);
  assert.deepEqual(f.states.get('app-sidi-report-head'), head);
  assert.equal(f.uploads.length, uploads);
});

test('a new enrollment skips elapsed slots and catches up the next day after restart', async t => {
  let now = Date.parse('2026-11-18T10:00:00Z');
  const morning = Date.parse('2026-11-19T06:30:00Z');
  const slots = [];
  const f = await fixture(t, { clock: () => now, executionHost: 'off-host', armedAt: new Date(now).toISOString(),
    async collectSource({ dueAt, onAdmission }) {
      await onAdmission();
      slots.push(dueAt);
    } });
  await f.worker.seed();
  const initialCalls = f.calls.length;
  await f.worker.scheduledTick();
  const status = path.join(f.config.root, 'sync-status.private.json');
  assert.equal(JSON.parse(await fs.readFile(status)).lastScheduledAt, null);
  assert.equal(f.calls.length, initialCalls);
  await f.reopen();
  now = morning + 2 * 60_000;
  await f.worker.scheduledTick();
  await f.reopen();
  await f.worker.scheduledTick();
  assert.deepEqual(slots, [morning]);
  assert.equal(JSON.parse(await fs.readFile(status)).lastScheduledAt, new Date(morning).toISOString());
});

test('restarting before off-host source admission keeps the same slot available', async t => {
  const morning = Date.parse('2026-11-18T06:30:00Z');
  const first = new AbortController();
  let waiting, admitted = 0;
  const startedWaiting = new Promise(resolve => { waiting = resolve; });
  const f = await fixture(t, { signal: first.signal, clock: () => morning, executionHost: 'off-host',
    async collectSource({ signal, onAdmission }) {
      if (signal === first.signal) {
        waiting();
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      await onAdmission();
      admitted++;
    } });
  await f.worker.seed();
  const stopping = f.worker.scheduledTick();
  await startedWaiting;
  first.abort(Error('Stopped before admission'));
  await assert.rejects(stopping, /Stopped before admission/);
  await f.reopen(new AbortController().signal);
  await f.worker.scheduledTick();
  assert.equal(admitted, 1);
  assert.equal(JSON.parse(f.states.get('app-sidi-report-head').body).servingPackage.collectorRevision, 43);
});

test('noon publishes changed evidence saved after the morning report once', async t => {
  let now = Date.parse('2026-11-18T06:30:00Z');
  const f = await fixture(t, { clock: () => now });
  await f.worker.seed();
  await f.worker.scheduledTick();
  const morning = JSON.parse(f.states.get('app-sidi-report-head').body);

  await saveFixtureCollector(f, 44);
  now = Date.parse('2026-11-18T07:59:00Z');
  await f.worker.scheduledTick();
  assert.equal(JSON.parse(f.states.get('app-sidi-report-head').body).generation, morning.generation);

  now += 60_000;
  await f.worker.scheduledTick();
  const head = f.states.get('app-sidi-report-head'), published = JSON.parse(head.body);
  assert.equal(published.servingPackage.collectorRevision, 44);
  assert.equal(published.previous.generation, morning.generation);
  const calls = f.calls.length;
  now += 60_000;
  await f.reopen();
  await f.worker.scheduledTick();
  assert.equal(f.calls.length, calls);
  assert.deepEqual(f.states.get('app-sidi-report-head'), head);
});

test('a stop after noon publication does not start another noon build after restart', async t => {
  let now = Date.parse('2026-11-18T06:30:00Z');
  const controller = new AbortController(), f = await fixture(t, { clock: () => now, signal: controller.signal });
  await f.worker.seed();
  await f.worker.scheduledTick();

  await saveFixtureCollector(f, 44);
  now = Date.parse('2026-11-18T08:00:00Z');
  f.onNextCas(() => controller.abort(Error('Worker stopped after publication')));
  await assert.rejects(f.worker.scheduledTick(), /stopped after publication/);
  const head = f.states.get('app-sidi-report-head');
  assert.equal(JSON.parse(head.body).servingPackage.collectorRevision, 44);

  await saveFixtureCollector(f, 45);
  now += 60_000;
  await f.reopen(null);
  const calls = f.calls.length;
  await f.worker.scheduledTick();
  assert.equal(f.calls.length, calls);
  assert.deepEqual(f.states.get('app-sidi-report-head'), head);
});

test('an idle restart reports an interrupted check as pending without touching the saved report', async t => {
  let now = Date.parse('2026-11-18T06:30:00Z');
  const f = await fixture(t, { clock: () => now });
  await f.worker.seed();
  await f.worker.scheduledTick();
  const file = path.join(f.root, 'sync-status.private.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  await write(file, { ...saved, status: 'checking', pending: true, admission: 'running' });

  now += 5 * 60_000;
  await f.reopen();
  const calls = f.calls.length;
  await f.worker.scheduledTick();
  assert.equal(f.calls.length, calls);
  const status = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(status.status, 'pending');
  assert.equal(status.admission, undefined);
  assert.equal(status.lastScheduledAt, saved.lastScheduledAt);
  assert.equal(status.checkedAt, saved.checkedAt);
  assert.equal(status.activeGeneration, saved.activeGeneration);
});

test('a failed 10:30 check retains the report and retries at noon without polling the source in between', async t => {
  let now = Date.parse('2026-11-18T06:30:00Z');
  const f = await fixture(t, { clock: () => now });
  await f.worker.seed();
  const head = f.states.get('app-sidi-report-head'), source = f.states.get('collector-state');
  f.states.delete('collector-state');
  await assert.rejects(f.worker.scheduledTick());
  assert.deepEqual(f.states.get('app-sidi-report-head'), head);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'sync-status.private.json'), 'utf8')).status, 'failed');
  f.states.set('collector-state', source);
  const calls = f.calls.length;
  now = Date.parse('2026-11-18T07:00:00Z');
  await f.worker.scheduledTick();
  assert.equal(f.calls.length, calls);
  now = Date.parse('2026-11-18T08:00:00Z');
  await f.worker.scheduledTick();
  assert.equal(JSON.parse(f.states.get('app-sidi-report-head').body).servingPackage.collectorRevision, 43);
});

test('a failed full-byte readback preserves the old report and private failure status', async t => {
  const f = await fixture(t); await f.worker.seed();
  const original = f.states.get('app-sidi-report-head'); f.corruptUploads();
  await assert.rejects(f.worker.tick(), /integrity|hash/i);
  assert.deepEqual(f.states.get('app-sidi-report-head'), original);
  const status = JSON.parse(await fs.readFile(path.join(f.root, 'sync-status.private.json')));
  assert.equal(status.pending, true); assert.equal(status.status, 'failed'); assert.equal(status.visibleCutoffAt, at);
});

test('lost publication acknowledgement recovers without a repeated source receipt or report copy', async t => {
  const f = await fixture(t); await f.worker.seed(); f.loseNextAck();
  await f.worker.tick();
  const count = f.uploads.length; await f.worker.tick();
  assert.equal(f.uploads.length, count);
  assert.equal(f.calls.filter(call => call.name === 'matter_hosted_state_cas').length, 2);
});

test('a forged collector receipt basis fails before candidate archive preparation and preserves the current head', async t => {
  const f = await fixture(t); await f.worker.seed();
  const original = f.states.get('app-sidi-report-head'), uploaded = f.uploads.length;
  const row = f.receipts.get(43); row.body_text = JSON.stringify(f.initial.publication); row.body_sha256 = sha(row.body_text);
  await assert.rejects(f.worker.tick(), /source|receipt|basis/i);
  assert.deepEqual(f.states.get('app-sidi-report-head'), original);
  assert.equal(f.uploads.length, uploaded);
});

test('a candidate cannot change the original source clock while retaining the same basis', async t => {
  const f = await fixture(t); await f.worker.seed();
  const original = f.states.get('app-sidi-report-head'), uploaded = f.uploads.length;
  const receipt = f.receipts.get(43), altered = JSON.parse(receipt.body_text);
  altered.head.source.observedAt = '2026-11-13T00:00:00.000Z';
  assert.equal(basis(altered), basis(f.next.publication));
  receipt.body_text = JSON.stringify(altered); receipt.body_sha256 = sha(receipt.body_text);
  await assert.rejects(f.worker.tick(), /source.*cutoff|source.*clock/i);
  assert.deepEqual(f.states.get('app-sidi-report-head'), original);
  assert.equal(f.uploads.length, uploaded);
});

test('the shared heavy-work lock excludes source work until the seed has finished', async t => {
  const f = await fixture(t), { withDriverAuditHeavyWork } = await import('./driverAuditHeavyWork.js');
  let entered = false, release;
  const ready = new Promise(resolve => { release = resolve; });
  const held = withDriverAuditHeavyWork({ root: path.resolve(f.root, '../../driver-audit-heavy-work'), owner: 'source' }, async () => { entered = true; await ready; });
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  const pending = f.worker.seed();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.uploads.length, 0); release(); await held; await pending;
  assert.ok(f.uploads.length > 0);
});

test('the real sync worker OS lock rejects another owner and is released on close', async t => {
  const f = await fixture(t), file = path.join(path.dirname(f.root), 'sync-worker.lock');
  await assert.rejects(acquireWorkerLock(file), /already active/);
  await f.worker.close();
  const lock = await acquireWorkerLock(file); await lock.release();
});

test('private code/config identity drift fails before any backend or source operation', async t => {
  const f = await fixture(t); await f.worker.close();
  await fs.appendFile(path.join(f.config.codeRoot, 'integration/cloud/automatic-release.mjs'), '\n// unexpected change');
  const before = f.calls.length;
  await assert.rejects(createDriverAuditSupabaseSync({ config: f.config, file: f.file, backend: f.backend }), /builder|hash|changed/i);
  assert.equal(f.calls.length, before);
});

test('renderer and journal identity drift fail closed on every operation', async t => {
  for (const which of ['rendererBuild', 'journals']) {
    const f = await fixture(t), calls = f.calls.length;
    await fs.appendFile(f.config[which].path, ' ');
    await assert.rejects(f.worker.seed(), /input|changed|hash/i);
    assert.equal(f.calls.length, calls);
    assert.equal(f.uploads.length, 0);
  }
});

test('cancellation while waiting for the shared gate never starts an upload or publication', async t => {
  const controller = new AbortController(), f = await fixture(t, { signal: controller.signal });
  const { withDriverAuditHeavyWork } = await import('./driverAuditHeavyWork.js');
  let entered = false, release;
  const ready = new Promise(resolve => { release = resolve; });
  const held = withDriverAuditHeavyWork({ root: path.resolve(f.root, '../../driver-audit-heavy-work'), owner: 'source' },
    async () => { entered = true; await ready; });
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  const seed = f.worker.seed();
  await new Promise(resolve => setTimeout(resolve, 30)); controller.abort(Error('Cancelled fixture'));
  await assert.rejects(seed, /cancel/i);
  assert.equal(f.uploads.length, 0); assert.equal(f.states.has('app-sidi-report-head'), false);
  release(); await held;
});

test('cancellation after immutable upload keeps its bytes but never selects the report', async t => {
  const controller = new AbortController(), f = await fixture(t, { signal: controller.signal });
  const put = f.backend.archive.putVerifiedObject;
  f.backend.archive.putVerifiedObject = async (...args) => { const receipt = await put(...args); controller.abort(Error('Cancelled fixture')); return receipt; };
  await assert.rejects(f.worker.seed(), /cancel/i);
  assert.ok(f.objects.size > 0);
  assert.equal(f.states.has('app-sidi-report-head'), false);
});

test('cancellation after a committed publication is observed after safe lock release', async t => {
  const controller = new AbortController(), f = await fixture(t, { signal: controller.signal });
  f.onNextCas(() => controller.abort(Error('Cancelled after commit')));
  await assert.rejects(f.worker.seed(), /Cancelled after commit/);
  assert.equal(JSON.parse(f.states.get('app-sidi-report-head').body).generation, f.initial.seed.pointer.generation);
  const heavy = path.resolve(f.root, '../../driver-audit-heavy-work', 'work.lock');
  const next = await acquireWorkerLock(heavy); await next.release();
});

test('runner rejects Mongo and implicit host mode before opening a connection', async () => {
  await assert.rejects(runDriverAuditSupabaseSync({ config: {}, file: '/not-used', env: { DRIVER_AUDIT_EXECUTION_HOST: 'sidi', DRIVER_AUDIT_DATA_STORE: 'mongo' } }), /Supabase|Sidi/i);
  await assert.rejects(runDriverAuditSupabaseSync({ config: {}, file: '/not-used', env: {} }), /Supabase|Sidi/i);
  const env = { DRIVER_AUDIT_EXECUTION_HOST: 'sidi', DRIVER_AUDIT_DATA_STORE: 'supabase',
    DRIVER_AUDIT_IMPORT_ENABLED: '0', DRIVER_AUDIT_ENABLED: '0' };
  await assert.rejects(runDriverAuditSupabaseSync({ config: {}, file: '/not-used', env }), /Explicit managed Supabase/);
  await assert.rejects(runDriverAuditSupabaseSync({ config: {}, file: '/not-used', mode: '--seed-only', env }), /staged.*configuration/);
});
