import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';
import { sealTransferSecrets, openTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';
import { readDriverAuditSourceConfig, verifyDriverAuditSourceRelease, driverAuditReportingFunctionCatalogSha256 } from '../../server/services/driverAuditSource.js';
import { stageDriverAuditSourceProof } from '../../server/scripts/driverAuditSourceStage.js';
import { manageDriverAuditSource } from '../../server/scripts/driverAuditSourceDeploy.js';
import { decodeDriverAuditSupabaseControlHost, loadDriverAuditSupabaseReleaseHost,
  driverAuditSupabaseReleaseControlHostSha256, driverAuditSupabaseReleaseProofNames,
  decodeDriverAuditSupabaseSourceReleasePack, runDriverAuditSupabaseReleaseControl,
  sealDriverAuditSupabaseReleaseInputs } from './driver-audit-supabase-release-control.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value));
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const recipientPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
function packFixture() {
  const values = new Map(driverAuditSupabaseReleaseProofNames.map(name => [name, { version: 1, verified: true }]));
  values.set('credential-evidence.private.json', { version: 1, verified: true, environmentSha256: 'a'.repeat(64) });
  const rows = new Map();
  const save = name => { const bytes = json(values.get(name)); rows.set(name, { path: name, sha256: sha(bytes), dataBase64: bytes.toString('base64') });
    return { path: name, sha256: sha(bytes) }; };
  values.set('credentials.private.json', { version: 1, verified: true, environmentSha256: 'a'.repeat(64),
    evidence: save('credential-evidence.private.json'), evidenceSha256: rows.get('credential-evidence.private.json').sha256 });
  const refs = {};
  for (const [key, name] of [['capabilityAudit', 'capability-audit.private.json'], ['drainAudit', 'drain-audit.private.json'],
    ['quietAudit', 'quiet-audit.private.json'], ['checkpoint', 'checkpoint.private.json']]) refs[key] = save(name);
  values.set('source-fence.private.json', { version: 1, verified: true, mode: 'reporting-hosting-admission-v1', writersStopped: false, ...refs });
  const release = { version: 1, verified: true, configSha256: 'b'.repeat(64), runtimeManifestSha256: 'c'.repeat(64), environmentSha256: 'a'.repeat(64) };
  for (const [key, name] of [['backup', 'backup.private.json'], ['parity', 'parity.private.json'],
    ['credentials', 'credentials.private.json'], ['sourceFence', 'source-fence.private.json']]) release[key] = save(name);
  values.set('release.private.json', release); save('release.private.json');
  const envelope = () => ({ version: 1, files: [...rows.values()] });
  const compressed = () => gzipSync(json(envelope()));
  return { values, rows, envelope, compressed, release };
}

test('the release continuation embeds and hashes the exact reviewed public control helpers without invoking any host action', async () => {
  const actual = await fs.readFile(new URL('./driver-audit-supabase-control.mjs', import.meta.url));
  assert.equal(sha(actual), driverAuditSupabaseReleaseControlHostSha256);
  assert.deepEqual(decodeDriverAuditSupabaseControlHost(), actual);
  const helpers = await loadDriverAuditSupabaseReleaseHost(); assert.equal(helpers.version, 1); assert(Object.isFrozen(helpers));
  assert.equal(typeof helpers.admittedContext, 'function'); assert.equal(typeof helpers.copiedArchiveReceiptPrefix, 'function');
  assert.equal(helpers.runDriverAuditSupabaseControl, undefined);
  assert.throws(() => decodeDriverAuditSupabaseControlHost(gzipSync(Buffer.from('export const unreviewed = true;'))));
});

test('a source proof pack preserves exact private bytes and only the ten fixed relative aliases', () => {
  const f = packFixture(), bytes = f.compressed();
  const decoded = decodeDriverAuditSupabaseSourceReleasePack(bytes, sha(bytes));
  assert.equal(decoded.sha256, sha(bytes)); assert.equal(decoded.legacyCompatible, true);
  assert.equal(decoded.files.size, 10); assert.equal(decoded.releaseSha256, f.rows.get('release.private.json').sha256);
  for (const [name, row] of f.rows) assert.deepEqual(decoded.files.get(name).data, Buffer.from(row.dataBase64, 'base64'));
});

test('missing, additional, duplicate, relabelled or corrupted proof aliases cannot be staged', () => {
  for (const change of [value => value.files.pop(), value => value.files.push({ ...value.files[0], path: 'environment.private.json' }),
    value => value.files.push(value.files[0]), value => value.files[0].path = '../release.private.json',
    value => value.files[0].sha256 = 'f'.repeat(64), value => value.files[0].dataBase64 += '\n',
    value => value.extra = 'unreviewed']) {
    const value = packFixture().envelope(); change(value); const bytes = gzipSync(json(value));
    assert.throws(() => decodeDriverAuditSupabaseSourceReleasePack(bytes, sha(bytes)));
  }
});

test('all proof references bind exact same-directory alias bytes before the actual SourceRelease validator is called', () => {
  for (const mutation of ['absolute', 'escape', 'foreign-hash', 'old-mode', 'credential-evidence']) {
    const f = packFixture();
    if (mutation === 'absolute') f.release.backup.path = '/private/backup.private.json';
    if (mutation === 'escape') f.release.parity.path = '../parity.private.json';
    if (mutation === 'foreign-hash') f.release.sourceFence.sha256 = 'f'.repeat(64);
    if (mutation === 'old-mode') f.values.get('source-fence.private.json').mode = 'reporting-database-capability-v2';
    if (mutation === 'credential-evidence') f.values.get('credentials.private.json').evidence.path = 'source-fence.private.json';
    for (const name of ['credentials.private.json', 'source-fence.private.json', 'release.private.json']) {
      const data = json(f.values.get(name)); f.rows.set(name, { path: name, sha256: sha(data), dataBase64: data.toString('base64') });
    }
    const bytes = f.compressed(); assert.throws(() => decodeDriverAuditSupabaseSourceReleasePack(bytes, sha(bytes)));
  }
});

test('arbitrary source control operations, commands, environments and paths fail before loading any host module', async () => {
  let loaded = false;
  for (const args of [{}, { operation: 'activate-native' }, { operation: 'start-source-sync', appRoot: '/arbitrary', command: 'anything' }])
    await assert.rejects(runDriverAuditSupabaseReleaseControl(args, { load() { loaded = true; throw Error('Unexpected load'); } }));
  assert.equal(loaded, false);
});

test('large private metadata is split into bounded authenticated pages with one exact envelope identity', () => {
  const metadata = { version: 1, artifacts: Array.from({ length: 19000 }, (_, index) => ({
    name: 'archive-' + sha('name-' + index), sha256: sha('bytes-' + index) })) };
  const bindings = { applicationCommit: 'a'.repeat(40), releaseCommit: 'b'.repeat(40), preparedReceiptSha256: 'c'.repeat(64) };
  const sealed = sealDriverAuditSupabaseReleaseInputs({ metadata, bindings, recipientKey: publicKey, sealTransferSecrets });
  assert(sealed.diagnosticPages > 1 && sealed.diagnosticPages <= 64);
  const pages = sealed.sealedPages.map(value => openTransferSecrets(privateKey, value));
  const parts = pages.map((page, index) => {
    assert.equal(page.pageIndex, index); assert.equal(page.pageCount, pages.length); assert.equal(page.metadataSha256, sealed.metadataSha256);
    assert.equal(page.preparedReceiptSha256, bindings.preparedReceiptSha256);
    const part = Buffer.from(page.pageGzipBase64, 'base64'); assert(part.length <= 32768);
    assert.equal(part.length, page.pageBytes); assert.equal(sha(part), page.pageSha256); return part;
  });
  const packed = Buffer.concat(parts); assert.equal(sha(packed), pages[0].metadataGzipSha256);
  assert.deepEqual(JSON.parse(gunzipSync(packed)), metadata);
  assert.equal(sha(gunzipSync(packed)), sealed.metadataSha256);
  assert(!JSON.stringify(sealed).includes(metadata.artifacts[0].name));
  assert.throws(() => sealDriverAuditSupabaseReleaseInputs({ metadata: { oversized: 'x'.repeat(8 * 1024 ** 2) },
    bindings, recipientKey: publicKey, sealTransferSecrets }));
});

async function actualSourceProofFixture(t) {
  // Reuse only the existing public fictional factories, without importing or
  // registering their tests. Their actual SourceRelease validator stays real.
  const source = await fs.readFile(new URL('../../server/services/driverAuditSource.test.js', import.meta.url), 'utf8');
  const definitions = ['fixture', 'configuredFixture', 'capabilityFenceFixture', 'hostingAdmissionFixture'].map(name => {
    const start = source.indexOf('async function ' + name + '(t) {'); assert(start >= 0);
    const end = source.indexOf('\ntest(', start); assert(end > start); return source.slice(start, end);
  }).join('\n');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const make = new AsyncFunction('fs', 'os', 'path', 'hash', 'readDriverAuditSourceConfig', 'verifyDriverAuditSourceRelease',
    'driverAuditReportingFunctionCatalogSha256', 't', definitions + '\nreturn await hostingAdmissionFixture(t);');
  const f = await make(fs, os, path, sha, readDriverAuditSourceConfig, verifyDriverAuditSourceRelease,
    driverAuditReportingFunctionCatalogSha256, t);
  await f.verify(); return f;
}

async function hostFixture(t, { largeManifest = false } = {}) {
  const actual = await actualSourceProofFixture(t), appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'supabase-release-host-')));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const h = await loadDriverAuditSupabaseReleaseHost(), server = path.join(appRoot, 'release/server'), oldServer = path.join(appRoot, 'server');
  const releaseRoot = path.dirname(server), syncRoot = path.join(server, '.private/driver-audits', 'd'.repeat(64));
  const sourceRoot = path.join(server, '.private/driver-audit-source'), controlRoot = path.join(syncRoot, 'controls');
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const data = Buffer.isBuffer(value) ? value : json(value); await fs.writeFile(file, data, { mode: 0o600 }); return h.read(file, { maximum: Math.max(data.length, 1) }); };
  for (const dir of [sourceRoot, controlRoot, path.join(server, 'node_modules'), path.join(server, '.private/driver-audit-heavy-work'),
    path.join(oldServer, '.private/driver-report-supabase-handoff'), path.join(oldServer, '.private/driver-audit-source'),
    path.join(oldServer, '.private/driver-audits')]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const states = new Map(), collectorBody = '{"fictional":"collector"}', reviewBody = '{"fictional":"review"}';
  const p = { base: 'a'.repeat(40), release: 'b'.repeat(40), source: actual.config.manifestSha256,
    sourceEnvironment: actual.config.environmentReference.sha256, builder: sha('builder'), fixture: sha('fixture'),
    collector: { revision: 7, bodySha256: sha(collectorBody), sourceBasis: sha('basis') }, candidate: '' };
  const keys = ['collector-state', 'review-journal', 'preview-gps-map-20261106:review-journal',
    'preview-acceptance-gps-final-20261111:review-journal', 'preview-acceptance-gps-hosted-20261109:review-journal',
    'preview-acceptance-hosted-20261109:review-journal', 'preview-acceptance-household-20261109:review-journal',
    'preview-acceptance-reconcile-20261109:review-journal'];
  for (const key of keys) states.set(key, { revision: key === 'collector-state' ? 7 : 1, body: key === 'collector-state' ? collectorBody : reviewBody });
  const originalManifest = { 'original.private.json': sha('original'), 'second.private.json': sha('second') };
  if (largeManifest) for (let i = 0; i < 18877; i++) {
    const hash = sha('fictional-large-manifest-' + i), runtime = i >= 18614;
    originalManifest[(runtime ? 'report-data-' : 'archive-') + hash + (runtime ? '.json.gz' : '.private.bin')] = runtime ? sha('runtime-value-' + i) : hash;
  }
  const manifestBytes = value => {
    const encoded = json(value); return largeManifest ? Buffer.concat([encoded, Buffer.alloc(2909890 - encoded.length, 32)]) : encoded;
  };
  const generatedManifestBytes = manifestBytes(Object.fromEntries(Object.entries(originalManifest).reverse())), generation = sha('generated'), reportHash = sha('report');
  const fileRef = { version: 1, domain: 'previewRuntime', path: 'original.private.json', kind: 'immutable-evidence',
    size: 8, sha256: sha('original'), chunks: [{ offset: 0, size: 8, sha256: sha('original') }] };
  const descriptorFiles = { 'original.private.json': fileRef };
  if (largeManifest) for (const [name, hash] of Object.entries(originalManifest).filter(([name]) => !name.startsWith('archive-')).slice(1))
    descriptorFiles[name] = { version: 1, domain: 'previewRuntime', path: name, kind: 'immutable-evidence', size: 8,
      sha256: hash, chunks: [{ offset: 0, size: 8, sha256: hash }] };
  const descriptorRaw = json({ version: 1, files: descriptorFiles, sourceManifestSha256: sha(generatedManifestBytes), generation, reportHash });
  const generatedDescriptorBytes = largeManifest ? Buffer.concat([descriptorRaw, Buffer.alloc(119 * 1024 - descriptorRaw.length, 32)]) : descriptorRaw;
  const descriptor = { version: 1, domain: 'previewPackage', path: 'descriptor.json', kind: 'immutable-evidence',
    size: generatedDescriptorBytes.length, sha256: sha(generatedDescriptorBytes),
    chunks: [{ offset: 0, size: generatedDescriptorBytes.length, sha256: sha(generatedDescriptorBytes) }] };
  const previousBytes = largeManifest ? manifestBytes(originalManifest) : json({ 'previous.private.json': sha('original previous report') });
  p.current = { revision: 6, generation: sha('previous'), manifest: sha(previousBytes) };
  const previousRoot = path.join(syncRoot, 'retained/serving-current/server-data');
  const previousManifest = await write(path.join(previousRoot, 'files.private.json'), previousBytes);
  const previousHead = { version: 1, generation: p.current.generation, reportHash: sha('previous report'),
    servingPackage: { version: 1, dataStore: 'supabase', collectorRevision: p.current.revision,
      sourceBasis: sha('previous basis'), manifestSha256: p.current.manifest } };
  const previousSeed = await write(path.join(path.dirname(previousRoot), 'direct-seed.original.private.json'), {
    version: 1, mode: 'sync', collectorRevision: p.current.revision, sourceBasis: previousHead.servingPackage.sourceBasis,
    manifestSha256: p.current.manifest, pointer: { version: 1, generation: previousHead.generation, reportHash: previousHead.reportHash } });
  const head = { version: 1, generation, reportHash, descriptor, servingPackage: { version: 1, dataStore: 'supabase', collectorRevision: 7,
    sourceBasis: p.collector.sourceBasis, manifestSha256: sha(generatedManifestBytes) }, visibleCutoffAt: '2026-11-17T00:00:00.000Z',
    closureReceipt: { version: 1, fictional: 'original verified closure' }, restore: { version: 1, fictional: 'original verified restore' },
    previous: previousHead };
  const headBody = JSON.stringify(head); states.set('app-sidi-report-head', { revision: 2, body: headBody });
  const paid = '{"version":1,"fictional":"paid-original"}'; states.set('photo-grading-budget', { revision: 1, body: paid });
  const candidate = await write(path.join(syncRoot, 'retained/candidate/server-data/files.private.json'), manifestBytes(originalManifest)); p.candidate = candidate.sha256;
  const generatedRoot = path.join(syncRoot, 'work/attempts/11111111-2222-4333-a444-555555555555');
  const generatedManifestFile = await write(path.join(generatedRoot, 'server-data/files.private.json'), generatedManifestBytes);
  const generatedDescriptorFile = await write(path.join(generatedRoot, 'audit-objects', descriptor.sha256 + '.gz'), generatedDescriptorBytes);
  const generatedSeedFile = await write(path.join(generatedRoot, 'supabase-seed.private.json'), { version: 1, mode: 'sync',
    collectorRevision: 7, sourceBasis: p.collector.sourceBasis, manifestSha256: generatedManifestFile.sha256,
    bundleRoot: path.join(generatedRoot, 'audit-objects'), pointer: { version: 1, generation, reportHash, descriptor },
    visibleCutoffAt: head.visibleCutoffAt, closureReceipt: head.closureReceipt, restore: head.restore });
  const generatedPointerFile = await write(path.join(syncRoot, 'work/current.private.json'), { version: 1, collectorRevision: 7,
    sourceBasis: p.collector.sourceBasis, manifestSha256: generatedManifestFile.sha256, privateRoot: path.join(generatedRoot, 'server-data'),
    verifiedAt: '2026-11-17T00:00:00.000Z' });
  const sourceConfigFile = await h.read(actual.configFile), syncFile = await write(path.join(syncRoot, 'sync.json'), { version: 1, root: syncRoot });
  const envBefore = Buffer.from('DRIVER_AUDIT_ENABLED="0"\nDRIVER_AUDIT_IMPORT_ENABLED="0"\nDRIVER_AUDIT_REPLICA_GC_ENABLED="0"\n');
  const envAfter = Buffer.from(envBefore.toString().replace('ENABLED="0"', 'ENABLED="1"'));
  const envFile = path.join(server, '.env.local'); await write(envFile, envAfter);
  const preparedBody = { version: 1, fictional: true, ...(largeManifest ? { fictionalSizePadding: Array.from({ length: 400 }, (_, i) => sha('prepared-' + i)).join('') } : {}) };
  const prepared = await write(path.join(syncRoot, 'staging.private.json'), preparedBody);
  await write(path.join(controlRoot, 'app-environment.before.private.env'), envBefore); await write(path.join(controlRoot, 'app-environment.after.private.env'), envAfter);
  await write(path.join(controlRoot, 'app-environment-plan.private.json'), { version: 1, kind: 'supabase-report-enable-plan-v1', preparedReceiptSha256: prepared.sha256,
    beforeSha256: sha(envBefore), afterSha256: sha(envAfter), changedKey: 'DRIVER_AUDIT_ENABLED' });
  const oldConfig = { version: 1, root: path.join(oldServer, '.private/driver-audits', 'e'.repeat(64)) };
  const old = await write(path.join(oldConfig.root, 'sync.json'), oldConfig); await write(path.join(syncRoot, 'retained/original-sync.private.json'), old.data);
  const prefix = await write(path.join(syncRoot, 'retained/archive-verification-receipts.private.json'), { version: 1, fictionalPrefix: true });
  const qualification = await write(path.join(controlRoot, 'host-qualification-pending.private.json'), { version: 1, status: 'verified', fictionalFixture: true,
    ...(largeManifest ? { fictionalSizePadding: Array.from({ length: 1024 }, (_, i) => sha('qualification-' + i)).join('') } : {}) });
  await fs.rename(qualification.path, path.join(controlRoot, 'host-qualification-' + qualification.sha256 + '.private.json'));
  const npm = { realpath: '/usr/share/nodejs/npm/bin/npm-cli.js', uid: 0, mode: 0o100644, bytes: 20, sha256: sha('npm') };
  npm.identitySha256 = sha(JSON.stringify([npm.realpath, npm.sha256]));
  const rows = [{ name: 'matter-delivery-api', pm_id: 1, pid: 1001, pm2_env: { status: 'online', pm_cwd: appRoot,
    pm_exec_path: '/usr/bin/npm', args: ['start', '--prefix', 'server'], pm_uptime: 1 } },
  { name: 'matter-driver-audit-sync', pm_id: 2, pid: 0, pm2_env: { status: 'stopped', pm_cwd: server, pm_exec_path: path.join(server, 'scripts/driverAuditSync.js'),
    args: ['--config', syncFile.path], exec_interpreter: process.execPath, node_args: [] } },
  { name: 'matter-driver-reports-api', pm_id: 3, pid: 1003, pm2_env: { status: 'online', pm_cwd: server, pm_exec_path: path.join(server, 'scripts/driverAuditHttp.js'),
    args: [], exec_interpreter: process.execPath, node_args: [] } }];
  const context = { p, appRoot, server, releaseRoot, syncRoot, sourceRoot, controlRoot, preparedReceiptSha256: prepared.sha256,
    receiptFile: prepared.path, receipt: { sourceConfig: sourceConfigFile.path, syncConfig: syncFile.path, appEnvironmentSha256: sha(envBefore),
      packages: [{ role: 'serving-current', root: previousRoot, manifestSha256: p.current.manifest, privateDirectoryBoundary: syncRoot,
        collectorRevision: p.current.revision, sourceBasis: previousHead.servingPackage.sourceBasis,
        originalDirectSeedSha256: previousSeed.sha256, descriptorVerified: true }],
      dependencies: { path: path.join(server, 'node_modules'), inventory: await h.dependencyInventory(path.join(server, 'node_modules')) } },
    bootstrap: { expected: { syncConfigSha256: old.sha256 } }, node: { executable: process.execPath, version: process.version, sha256: sha('node') }, npm,
    env: { DRIVER_AUDIT_EXECUTION_HOST: 'sidi', DRIVER_AUDIT_DATA_STORE: 'supabase', DRIVER_AUDIT_ENABLED: '1' }, envFile,
    config: actual.config, fixedFiles: [prepared, sourceConfigFile, syncFile] };
  context.sourceEnvironment = await h.read(actual.config.environmentReference.path); p.bootstrap = sha('bootstrap'); p.bootstrapBytes = 1;
  const environmentBackup = { version: 1, kind: 'driver-report-source-environment-off-host-backup-v1', verified: true,
    releaseSha: p.release, bootstrapSha256: p.bootstrap, sourceManifestSha256: p.source,
    environmentSha256: context.sourceEnvironment.sha256, originalEnvironmentValuesMatched: 9,
    backup: { kind: 'owner-private-recovery-volume', readbackReceiptSha256: sha('readback'), environmentSha256: context.sourceEnvironment.sha256,
      environmentBytes: context.sourceEnvironment.bytes, bootstrapSha256: p.bootstrap, bootstrapBytes: p.bootstrapBytes }, verifiedAt: new Date().toISOString() };
  const environmentBackupBytes = gzipSync(json(environmentBackup)); p.backupProof = sha(environmentBackupBytes);
  const businessParity = { allDeclaredFilesEqual: true, retainedManifestSha256: p.candidate, generatedManifestSha256: head.servingPackage.manifestSha256 };
  const sourceIdentity = { revision: 7, bodySha256: p.collector.bodySha256, sourceBasis: p.collector.sourceBasis };
  const intent = await write(path.join(controlRoot, 'report-once-intents', sha(headBody) + '.private.json'), { version: 1,
    kind: 'supabase-one-report-publication-intent-v1', preparedReceiptSha256: prepared.sha256, releaseSha: p.release,
    sourceManifestSha256: p.source, builderSha256: p.builder, qualificationReceiptSha256: qualification.sha256,
    source: sourceIdentity, expectedServingRevision: 1, publicationBody: headBody, publicationBodySha256: sha(headBody), businessParity });
  const protectedHeads = [{ key: 'review-journal', revision: 1, bodySha256: sha(reviewBody) }];
  const completionIdentity = sha(JSON.stringify([sha(headBody), protectedHeads]));
  await write(path.join(controlRoot, 'report-once-complete-' + completionIdentity + '.private.json'), { version: 1,
    kind: 'supabase-one-report-completion-v1', preparedReceiptSha256: prepared.sha256, qualificationReceiptSha256: qualification.sha256,
    sourceStarted: false, collectorRevision: 7, source: sourceIdentity, servingHeadRevision: 2, servingHeadBodySha256: sha(headBody), publicationIntentSha256: intent.sha256,
    protectedHeads, businessParity, generation: head.generation, previousGeneration: head.previous.generation });
  const values = new Map(); values.set('backup.private.json', { ...actual.backup,
    uncertainAttemptsBaseline: { ...actual.backup.uncertainAttemptsBaseline, sha256: sha(paid) } });
  const parity = { ...actual.parity, collectorBodySha256: sha(collectorBody), reviewBodySha256: sha(reviewBody),
    hostQualification: { fixtureSha256: p.fixture, receiptSha256: qualification.sha256 },
    allNamedHeads: Object.fromEntries(keys.map(key => [key, { revision: states.get(key).revision, bodySha256: sha(states.get(key).body) }])),
    appHead: { revision: 2, bodySha256: sha(headBody) } };
  values.set('parity.private.json', parity); values.set('credential-evidence.private.json', actual.credentialEvidence);
  values.set('capability-audit.private.json', actual.proofs.capabilityAudit); values.set('drain-audit.private.json', actual.proofs.drainAudit);
  values.set('quiet-audit.private.json', actual.proofs.quietAudit);
  const rowsByName = new Map(), save = name => { const data = json(values.get(name)); rowsByName.set(name, { path: name, sha256: sha(data), dataBase64: data.toString('base64') }); return { path: name, sha256: sha(data) }; };
  const backupRef = save('backup.private.json'), parityRef = save('parity.private.json'), evidenceRef = save('credential-evidence.private.json');
  values.set('credentials.private.json', { version: 1, verified: true, environmentSha256: p.sourceEnvironment, evidence: evidenceRef, evidenceSha256: evidenceRef.sha256 });
  values.set('checkpoint.private.json', { ...actual.proofs.checkpoint, backupReceiptSha256: backupRef.sha256, parityReceiptSha256: parityRef.sha256,
    collectorBodySha256: sha(collectorBody), reviewBodySha256: sha(reviewBody), sourceReadback: { ...actual.proofs.checkpoint.sourceReadback,
      collectorBodySha256: sha(collectorBody), reviewBodySha256: sha(reviewBody) } });
  const fence = { ...actual.fence };
  for (const [key, name] of [['capabilityAudit', 'capability-audit.private.json'], ['drainAudit', 'drain-audit.private.json'],
    ['quietAudit', 'quiet-audit.private.json'], ['checkpoint', 'checkpoint.private.json']]) fence[key] = { ...save(name), id: values.get(name).id };
  values.set('source-fence.private.json', fence); values.set('release.private.json', { ...actual.release, backup: backupRef, parity: parityRef,
    credentials: save('credentials.private.json'), sourceFence: save('source-fence.private.json') }); save('release.private.json');
  const pack = () => gzipSync(json({ version: 1, files: [...rowsByName.values()] }));
  const calls = [], counts = { privateChecks: 0, gets: 0, qualifications: 0, sourceChecks: 0 };
  const backend = { kind: 'supabase', executionHost: 'sidi', executionAdmission: 'fixed-host-v1', transferAccounting: 'supabase-http-bytes-v1',
    archive: { managedReadCache: true, async putVerifiedObject() { throw Error('No object upload expected'); },
      async assertPrivate() { counts.privateChecks++; return { public: false }; }, async readObject(key) {
      if (key === p.backupProof + '.gz') return [environmentBackupBytes]; counts.gets++; assert.equal(key, sha(pack()) + '.gz'); return [pack()]; } },
    async rpc(name, args) { assert.equal(name, 'matter_hosted_state_read'); const value = states.get(args.p_key); assert(value); return { revision: value.revision, body_text: value.body }; },
    async readTransferUsage() { return { version: 1, basis: 'supabase-http-bytes-v1', fictional: true }; }, async close() {} };
  context.load = async name => {
    if (name === 'services/driverAuditSource.js') return { readDriverAuditSourceConfig: async () => actual.config, verifyDriverAuditSourceRelease };
    if (name === 'services/driverAuditTransferCodec.js') return { sealTransferSecrets };
    if (name === 'services/driverAuditDataBackend.js') return { async openDriverAuditDataBackend({ env }) { assert.equal(env.DRIVER_AUDIT_DATA_STORE, 'supabase'); assert.equal(env.MONGODB_URI, undefined); return backend; } };
    if (name === 'services/driverAuditSupabaseAppBackend.js') return { async createDriverAuditSupabaseAppBackend({ env }) { assert.equal(env.DRIVER_AUDIT_DATA_STORE, 'supabase'); return backend; } };
    if (name === 'services/driverAuditSupabaseReplica.js') return import('../../server/services/driverAuditSupabaseReplica.js');
    if (name === 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return { acquireWorkerLock };
    if (name === 'scripts/driverAuditSourceStage.js') return { stageDriverAuditSourceProof };
    if (name === 'vendor/driver-audits/integration/cloud/cloud-state.mjs') return import('../../server/vendor/driver-audits/integration/cloud/cloud-state.mjs');
    throw Error('Unexpected module ' + name);
  };
  const adapters = { platform: 'linux', node: context.node, admitContext: async () => context, systemFile: async () => npm,
    inspectProcess: async () => {}, now: () => new Date(actual.release.verifiedAt), wait: async () => {},
    async qualification(c, hash) { counts.qualifications++; assert.equal(c, context); assert.equal(hash, qualification.sha256); },
    async verifyPrefix() { const saved = await h.read(prefix.path); assert.equal(saved.sha256, prefix.sha256);
      context.archiveReceiptPrefix = { path: saved.path, sha256: saved.sha256, bytes: saved.bytes, receipts: 0,
        freshRemoteObjectBytesVerified: false, remoteAvailabilityAsserted: false }; },
    async exec(file, args, options) {
      calls.push({ file, args, options });
      if (file === 'git') { if (args.includes('show')) return { stdout: Buffer.from('export const fictional = true;') };
        if (args.includes('rev-parse')) return { stdout: (args.at(-1) === '--show-toplevel' ? args[1] : args[1] === appRoot ? p.base : p.release) + '\n' };
        return { stdout: '' }; }
      if (file === 'pm2') {
        if (args[0] === 'jlist') return { stdout: JSON.stringify(rows) };
        if (['restart', 'stop'].includes(args[0])) { const row = rows.find(row => String(row.pm_id) === args[1]); assert(row);
          row.pid = args[0] === 'restart' ? 2000 + row.pm_id : 0; row.pm2_env.status = args[0] === 'restart' ? 'online' : 'stopped'; }
        else assert.equal(args[0], 'save'); return { stdout: '' };
      }
      assert.equal(file, context.node.executable); assert.deepEqual(args.slice(0, 1), [path.join(server, 'scripts/driverAuditSourceDeploy.js')]);
      const action = args[1].replace('audit-source-', ''); assert(['start', 'resume'].includes(action));
      const reference = { path: options.env.DRIVER_AUDIT_SOURCE_RELEASE_FILE, sha256: options.env.DRIVER_AUDIT_SOURCE_RELEASE_SHA256 };
      const activationFile = path.join(actual.config.root, 'deployment-source.private.json');
      const output = await manageDriverAuditSource({ operation: action, config: actual.config, now: adapters.now(), adapter: {
        async worker() { const row = rows.find(r => r.name === 'matter-driver-audit-source'); return row && { config: actual.configFile,
          status: row.pm2_env.status, startedAt: row.pm2_env.pm_uptime }; },
        async check() { counts.sourceChecks++; }, async verifyRelease() { await verifyDriverAuditSourceRelease(actual.config, reference, adapters.now());
          for (const file of [path.join(sourceRoot, 'source-deployment.lock'), path.join(sourceRoot, 'source-worker.lock'),
            path.join(path.dirname(syncRoot), 'sync-worker.lock'), path.join(server, '.private/driver-audit-heavy-work/work.lock')]) {
            const lease = await acquireWorkerLock(file); await lease.release(); }
          await assert.rejects(acquireWorkerLock(path.join(oldServer, '.private/driver-report-supabase-handoff/operator.lock')), /Collector already active/);
          return { reference }; },
        async readActivation() { return fs.readFile(activationFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); },
        async writeActivation(value) { await write(activationFile, value); },
        async start() { let row = rows.find(r => r.name === 'matter-driver-audit-source'); if (!row) { row = { name: 'matter-driver-audit-source', pm_id: 4,
          pm2_env: { pm_cwd: server, pm_exec_path: path.join(server, 'scripts/driverAuditSource.js'), args: ['--config', actual.configFile], exec_interpreter: process.execPath, node_args: [] } }; rows.push(row); }
          row.pid = 2004; row.pm2_env.status = 'online'; row.pm2_env.pm_uptime = Date.now();
          await write(path.join(actual.config.root, 'source-status.private.json'), { version: 1, status: 'ready', configSha256: actual.config.configSha256, checkedAt: new Date().toISOString() }); },
        async wait() {}, async save() {}, async stop() { const row = rows.find(r => r.name === 'matter-driver-audit-source'); if (row) { row.pid = 0; row.pm2_env.status = 'stopped'; } },
      } }); return { stdout: JSON.stringify(output) };
    },
    listenerFor: async () => true,
    async fetch() { return new Response(JSON.stringify({ service: 'driver-reports', dataStore: 'supabase', executionHost: 'sidi', ready: true,
      generation: head.generation, reportHash: head.reportHash, collectorRevision: 7, release: p.release })); },
  };
  const common = { appRoot, expectedSha: p.base, preparedReceiptSha256: prepared.sha256, qualificationReceiptSha256: qualification.sha256, recipientPublicKey };
  const run = (operation, extra = {}) => runDriverAuditSupabaseReleaseControl({ ...common, operation,
    ...(['export-release-inputs', 'export-previous-manifest'].includes(operation)
      ? { reportCompletionIdentitySha256: completionIdentity } : { releasePackSha256: sha(pack()) }), ...extra }, adapters)
    .catch(error => {
      if (error.supabaseControlStopped) {
        const sealed = openTransferSecrets(privateKey, error.supabaseControlStopped.capsule);
        const detail = JSON.parse(gunzipSync(Buffer.from(sealed.metadataGzipBase64, 'base64')));
        Object.defineProperty(error, 'cause', { value: Error(detail.message) });
      }
      throw error;
    });
  return { actual, context, adapters, run, pack, rowsByName, values, states, rows, calls, counts, common, completionIdentity, write, backend,
    generatedRoot, generatedManifestFile, generatedDescriptorFile, generatedSeedFile, generatedPointerFile, previousManifest, previousHead, previousSeed };
}

test('the separate retained previous manifest export binds exact prepared5463 and original publication.previous without changing the nine-artifact export', async t => {
  const f = await hostFixture(t), result = await f.run('export-previous-manifest');
  assert.equal(result.operation, 'export-previous-manifest'); assert.equal(result.status, 'supabase-previous-manifest-exported');
  assert.equal(result.sourceStarted, false); assert.equal(result.syncSteadyStarted, false);
  const pages = result.sealedPages.map(page => openTransferSecrets(privateKey, page));
  const raw = gunzipSync(Buffer.concat(pages.map(page => Buffer.from(page.pageGzipBase64, 'base64'))));
  assert.equal(sha(raw), result.metadataSha256); const value = JSON.parse(raw);
  assert.equal(value.kind, 'supabase-retained-previous-manifest-export-v1'); assert.equal(value.artifacts.length, 1);
  const [artifact] = value.artifacts;
  assert.equal(artifact.name, 'retainedPreviousManifest'); assert.equal(artifact.path, f.previousManifest.path);
  assert.equal(artifact.dataEncoding, 'gzip-base64'); const packed = Buffer.from(artifact.dataBase64, 'base64');
  assert.equal(packed.toString('base64'), artifact.dataBase64); assert.equal(packed.length, artifact.dataGzipBytes);
  assert.equal(sha(packed), artifact.dataGzipSha256); const bytes = gunzipSync(packed);
  assert.deepEqual(bytes, f.previousManifest.data); assert.equal(artifact.sha256, f.context.p.current.manifest); assert.equal(bytes.length, artifact.bytes);
  assert.equal(value.retainedPrevious.collectorRevision, f.context.p.current.revision);
  assert.equal(value.retainedPrevious.generation, f.previousHead.generation); assert.equal(value.retainedPrevious.sourceBasis, f.previousHead.servingPackage.sourceBasis);
  assert.equal(value.retainedPrevious.preparedPackageRole, 'serving-current'); assert.equal(value.retainedPrevious.freshServingHeadRead, false);
  assert.equal(value.exportIsGenerationExecution, false); assert.equal(value.originalGenerationProvenanceRequired, true);
  assert.equal(value.networkRequests, 0); assert.equal(value.databaseWrites, false);
  assert.equal(f.counts.gets, 0); assert.equal(f.counts.privateChecks, 0); assert.equal(f.calls.filter(call => call.file === 'pm2' && call.args[0] !== 'jlist').length, 0);
  assert.deepEqual(await fs.readFile(f.previousManifest.path), bytes);
  await fs.chmod(path.dirname(f.previousManifest.path), 0o775);
  assert.equal((await f.run('export-previous-manifest')).status, 'supabase-previous-manifest-exported');
  const normal = await f.run('export-release-inputs');
  const standard = JSON.parse(gunzipSync(Buffer.concat(normal.sealedPages.map(page => Buffer.from(openTransferSecrets(privateKey, page).pageGzipBase64, 'base64')))));
  assert.equal(standard.artifacts.length, 9); assert(!standard.artifacts.some(file => file.name === 'retainedPreviousManifest'));
});

test('a representative18879-entry retained previous manifest round-trips its exact2909890 bytes within the unchanged paged limits', async t => {
  const f = await hostFixture(t, { largeManifest: true }), result = await f.run('export-previous-manifest');
  assert(result.diagnosticPages > 1 && result.diagnosticPages <= 64);
  const pages = result.sealedPages.map(page => openTransferSecrets(privateKey, page));
  const packed = Buffer.concat(pages.map(page => Buffer.from(page.pageGzipBase64, 'base64')));
  assert(packed.length <= 2 * 1024 ** 2); const raw = gunzipSync(packed, { maxOutputLength: 8 * 1024 ** 2 });
  assert.equal(sha(raw), result.metadataSha256); const artifact = JSON.parse(raw).artifacts[0];
  const bytes = gunzipSync(Buffer.from(artifact.dataBase64, 'base64'), { maxOutputLength: 4 * 1024 ** 2 });
  assert.equal(bytes.length, 2909890); assert.equal(Object.keys(JSON.parse(bytes)).length, 18879);
  assert.equal(sha(bytes), artifact.sha256); assert.deepEqual(bytes, f.previousManifest.data); assert.equal(f.counts.gets, 0);
});

test('previous-manifest export rejects foreign prepared roles, original previous identity, qualification, raw bytes and physical drift', async t => {
  for (const kind of ['missing', 'raw-hash', 'prepared-root', 'prepared-manifest', 'prepared-basis', 'duplicate-role', 'missing-seed', 'seed-hash',
    'seed-basis', 'previous-revision', 'previous-generation', 'previous-manifest', 'previous-basis', 'previous-report-hash',
    'wrong-qualification', 'exposed-leaf', 'symlink', 'parent-drift', 'late-file-drift']) {
    const f = await hostFixture(t), p = f.context.p; const extra = {};
    if (kind === 'missing') await fs.unlink(f.previousManifest.path);
    if (kind === 'raw-hash') await fs.appendFile(f.previousManifest.path, ' ');
    if (kind === 'prepared-root') f.context.receipt.packages[0].root += '-other';
    if (kind === 'prepared-manifest') f.context.receipt.packages[0].manifestSha256 = 'f'.repeat(64);
    if (kind === 'prepared-basis') f.context.receipt.packages[0].sourceBasis = sha('different prepared basis');
    if (kind === 'missing-seed') await fs.unlink(f.previousSeed.path);
    if (kind === 'seed-hash') f.context.receipt.packages[0].originalDirectSeedSha256 = 'f'.repeat(64);
    if (kind === 'seed-basis') {
      const seed = JSON.parse(f.previousSeed.data); seed.sourceBasis = sha('different original seed basis');
      f.context.receipt.packages[0].originalDirectSeedSha256 = (await f.write(f.previousSeed.path, seed)).sha256;
    }
    if (kind === 'duplicate-role') f.context.receipt.packages.push({ ...f.context.receipt.packages[0] });
    if (kind.startsWith('previous-')) {
      const context = f.context, identity = f.completionIdentity;
      const completionFile = path.join(context.controlRoot, 'report-once-complete-' + identity + '.private.json');
      const completion = JSON.parse(await fs.readFile(completionFile));
      const intentFile = path.join(context.controlRoot, 'report-once-intents', completion.servingHeadBodySha256 + '.private.json');
      const intent = JSON.parse(await fs.readFile(intentFile)), publication = JSON.parse(intent.publicationBody);
      if (kind === 'previous-revision') publication.previous.servingPackage.collectorRevision++;
      if (kind === 'previous-generation') { publication.previous.generation = sha('foreign previous'); completion.previousGeneration = publication.previous.generation; }
      if (kind === 'previous-manifest') publication.previous.servingPackage.manifestSha256 = sha('foreign previous');
      if (kind === 'previous-basis') publication.previous.servingPackage.sourceBasis = sha('valid but foreign original basis');
      if (kind === 'previous-report-hash') publication.previous.reportHash = sha('valid but foreign original report');
      intent.publicationBody = JSON.stringify(publication); intent.publicationBodySha256 = sha(intent.publicationBody);
      const next = path.join(context.controlRoot, 'report-once-intents', intent.publicationBodySha256 + '.private.json');
      completion.servingHeadBodySha256 = intent.publicationBodySha256; completion.publicationIntentSha256 = (await f.write(next, intent)).sha256;
      const newIdentity = sha(JSON.stringify([completion.servingHeadBodySha256, completion.protectedHeads]));
      await f.write(path.join(context.controlRoot, 'report-once-complete-' + newIdentity + '.private.json'), completion);
      extra.reportCompletionIdentitySha256 = newIdentity;
    }
    if (kind === 'exposed-leaf') await fs.chmod(f.previousManifest.path, 0o644);
    if (kind === 'symlink') { await fs.rename(f.previousManifest.path, f.previousManifest.path + '.original'); await fs.symlink(f.previousManifest.path + '.original', f.previousManifest.path); }
    let reached = false;
    if (kind === 'parent-drift' || kind === 'late-file-drift') {
      const open = fs.open;
      fs.open = async (file, ...args) => {
        const handle = await open(file, ...args);
        if (!reached && file === f.previousManifest.path) { reached = true;
          if (kind === 'parent-drift') await fs.chmod(path.dirname(file), 0o775); else await fs.appendFile(file, ' ');
        }
        return handle;
      };
      try { await assert.rejects(f.run('export-previous-manifest'), /Supabase source release stopped/); }
      finally { fs.open = open; }
      assert(reached);
    } else await assert.rejects(f.run('export-previous-manifest', kind === 'wrong-qualification' ? { qualificationReceiptSha256: 'f'.repeat(64) } : extra), /Supabase source release stopped/, kind);
    assert.equal(f.counts.gets, 0); assert.equal(f.counts.privateChecks, 0); assert.equal(p.current.revision, 6);
  }
});

test('source-release readbacks preserve the originally captured base Event file and reject later file or parent changes', async t => {
  for (const change of [null, 'file', 'parent']) {
    const f = await hostFixture(t), git = args => promisify(execFile)('git', ['-C', f.context.appRoot, ...args]);
    for (const name of ['loadEnv.js', 'package.json', 'package-lock.json', 'services/driverAuditTransferCodec.js'])
      await f.write(path.join(f.context.appRoot, 'server', name), Buffer.from('// fictional tracked fixture\n'));
    await f.write(path.join(f.context.appRoot, '.gitignore'), Buffer.from('server/.private/\n'));
    await git(['init', '-q']); await git(['add', '.gitignore', 'server']);
    await git(['-c', 'user.name=Fictional Release Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fictional preserved base']);
    f.context.p.base = (await git(['rev-parse', 'HEAD'])).stdout.trim(); f.common.expectedSha = f.context.p.base;
    const event = path.join(f.context.appRoot, 'server/routes/Event.js'), body = Buffer.from('throw Error("Never execute preserved business data");\n');
    await f.write(event, body); await fs.chmod(event, 0o664);
    const original = f.adapters.exec;
    f.adapters.exec = (file, args, options) => file === 'git' && args[1] === f.context.appRoot
      ? promisify(execFile)(file, args, options) : original(file, args, options);
    const h = await loadDriverAuditSupabaseReleaseHost();
    f.context.preservedBaseFiles = await h.checkout(f.context.appRoot, f.common.expectedSha, f.adapters.exec,
      ['loadEnv.js'], { preserveBaseEvent: true });
    const before = await fs.lstat(event, { bigint: true }); let reached = false;
    if (change) {
      const qualification = f.adapters.qualification;
      f.adapters.qualification = async (...args) => { await qualification(...args); reached = true;
        if (change === 'file') await fs.appendFile(event, 'independent change'); else await fs.chmod(path.dirname(event), 0o775);
      };
      await assert.rejects(f.run('export-release-inputs'), /Supabase source release stopped/); assert(reached);
      assert.equal(await fs.readFile(event, 'utf8'), body.toString() + (change === 'file' ? 'independent change' : ''));
    } else {
      assert.equal((await f.run('export-release-inputs')).status, 'supabase-release-inputs-exported');
      const after = await fs.lstat(event, { bigint: true });
      for (const key of ['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
      assert.deepEqual(await fs.readFile(event), body);
    }
    assert.equal(f.counts.gets, 0);
  }
});

test('the fixed read-only export preserves actual artifact bytes and original generation provenance while omitting environment values', async t => {
  const f = await hostFixture(t), result = await f.run('export-release-inputs');
  assert.equal(result.status, 'supabase-release-inputs-exported'); assert.equal(f.counts.gets, 0);
  const pages = result.sealedPages.map(value => openTransferSecrets(privateKey, value));
  const raw = gunzipSync(Buffer.concat(pages.map(page => Buffer.from(page.pageGzipBase64, 'base64'))));
  assert.equal(sha(raw), result.metadataSha256); const value = JSON.parse(raw);
  assert.equal(value.exportIsGenerationExecution, false); assert.equal(value.originalGenerationProvenanceRequired, true);
  assert.equal(value.networkRequests, 0); assert.equal(value.databaseWrites, false); assert.equal(value.artifacts.length, 9);
  assert.deepEqual(value.artifacts.map(file => file.name), ['prepared', 'sourceConfig', 'syncConfig', 'qualification',
    'publicationIntent', 'completion', 'retainedCandidateManifest', 'generatedCurrentDescriptor', 'generatedCurrentManifest']);
  for (const file of value.artifacts) {
    const encoded = Buffer.from(file.dataBase64, 'base64'); assert.equal(encoded.toString('base64'), file.dataBase64);
    const compressed = ['retainedCandidateManifest', 'generatedCurrentManifest'].includes(file.name);
    assert.equal(file.dataEncoding, compressed ? 'gzip-base64' : undefined);
    if (compressed) { assert.equal(encoded.length, file.dataGzipBytes); assert.equal(sha(encoded), file.dataGzipSha256); }
    else assert.deepEqual(Object.keys(file).sort(), ['name', 'path', 'sha256', 'bytes', 'dataBase64'].sort());
    const bytes = compressed ? gunzipSync(encoded, { maxOutputLength: 4 * 1024 ** 2 }) : encoded;
    assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256); assert.deepEqual(bytes, await fs.readFile(file.path));
  }
  assert(!value.artifacts.some(file => file.path.endsWith('.env.local') || file.path.endsWith('environment.private.json')));
  const descriptor = value.artifacts.find(file => file.name === 'generatedCurrentDescriptor'), manifest = value.artifacts.find(file => file.name === 'generatedCurrentManifest');
  assert.equal(descriptor.sha256, f.generatedDescriptorFile.sha256); assert.equal(manifest.sha256, f.generatedManifestFile.sha256);
  assert.notEqual(manifest.sha256, f.context.p.candidate); assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(manifest.dataBase64, 'base64'))),
    JSON.parse(gunzipSync(Buffer.from(value.artifacts[6].dataBase64, 'base64'))));
  assert.equal(value.generatedCurrent.servingHeadBodySha256, sha(f.states.get('app-sidi-report-head').body));
  assert.equal(value.generatedCurrent.servingHeadRevision, 2);
  assert.equal(value.generatedCurrent.workPointer.sha256, f.generatedPointerFile.sha256);
  assert.equal(value.generatedCurrent.directSeed.sha256, f.generatedSeedFile.sha256);
  assert(!f.calls.some(call => call.file === 'pm2' && call.args[0] !== 'jlist'));
});

test('two real-size 18879-entry manifests retain exact bytes through the actual bounded nine-artifact sealer and receiver', async t => {
  const f = await hostFixture(t, { largeManifest: true }), result = await f.run('export-release-inputs');
  assert(result.diagnosticPages <= 64); assert.equal(result.diagnosticPages, result.sealedPages.length);
  const pages = result.sealedPages.map(capsule => openTransferSecrets(privateKey, capsule));
  const packed = Buffer.concat(pages.map((page, index) => {
    assert.equal(page.pageIndex, index); assert.equal(page.pageCount, result.diagnosticPages); assert(page.pageBytes <= 32768);
    const bytes = Buffer.from(page.pageGzipBase64, 'base64'); assert.equal(sha(bytes), page.pageSha256); return bytes;
  }));
  assert(packed.length <= 2 * 1024 ** 2); assert.equal(sha(packed), pages[0].metadataGzipSha256);
  const raw = gunzipSync(packed, { maxOutputLength: 8 * 1024 ** 2 }); assert.equal(sha(raw), result.metadataSha256);
  const metadata = JSON.parse(raw); assert.equal(metadata.artifacts.length, 9);
  for (const name of ['retainedCandidateManifest', 'generatedCurrentManifest']) {
    const file = metadata.artifacts.find(file => file.name === name), gzip = Buffer.from(file.dataBase64, 'base64');
    assert.equal(file.dataEncoding, 'gzip-base64'); assert.equal(gzip.toString('base64'), file.dataBase64);
    assert.equal(gzip.length, file.dataGzipBytes); assert.equal(sha(gzip), file.dataGzipSha256);
    const bytes = gunzipSync(gzip, { maxOutputLength: 4 * 1024 ** 2 }); assert.equal(bytes.length, 2909890);
    assert.equal(Object.keys(JSON.parse(bytes)).length, 18879); assert.equal(sha(bytes), file.sha256);
    assert.deepEqual(bytes, await fs.readFile(file.path));
  }
  assert.equal(f.counts.gets, 0); assert.equal(f.counts.privateChecks, 0);
});

test('generated export requires the exact completed pointer, direct seed, descriptor and generated manifest', async t => {
  for (const kind of ['missing-descriptor', 'missing-manifest', 'missing-direct-seed', 'foreign-pointer', 'foreign-seed',
    'changed-descriptor', 'changed-manifest', 'public-boundary', 'exposed-manifest', 'missing-head-revision', 'foreign-head-revision']) {
    const f = await hostFixture(t);
    if (kind === 'missing-descriptor') await fs.unlink(f.generatedDescriptorFile.path);
    if (kind === 'missing-manifest') await fs.unlink(f.generatedManifestFile.path);
    if (kind === 'missing-direct-seed') await fs.unlink(f.generatedSeedFile.path);
    if (kind === 'foreign-pointer') {
      const pointer = JSON.parse(f.generatedPointerFile.data); pointer.collectorRevision++; await f.write(f.generatedPointerFile.path, pointer);
    }
    if (kind === 'foreign-seed') {
      const seed = JSON.parse(f.generatedSeedFile.data); seed.pointer.descriptor.sha256 = 'f'.repeat(64); await f.write(f.generatedSeedFile.path, seed);
    }
    if (kind === 'changed-descriptor') await fs.appendFile(f.generatedDescriptorFile.path, ' ');
    if (kind === 'changed-manifest') await fs.appendFile(f.generatedManifestFile.path, ' ');
    if (kind === 'public-boundary') await fs.chmod(f.context.syncRoot, 0o755);
    if (kind === 'exposed-manifest') await fs.chmod(f.generatedManifestFile.path, 0o644);
    if (kind.endsWith('head-revision')) {
      const file = path.join(f.context.controlRoot, 'report-once-complete-' + f.completionIdentity + '.private.json'), value = JSON.parse(await fs.readFile(file));
      if (kind === 'missing-head-revision') delete value.servingHeadRevision; else value.servingHeadRevision++;
      await f.write(file, value);
    }
    await assert.rejects(f.run('export-release-inputs'), /Supabase source release stopped/);
    assert.equal(f.counts.gets, 0); assert.equal(f.counts.privateChecks, 0); assert.equal(f.counts.sourceChecks, 0);
    assert(!f.calls.some(call => call.file === 'pm2' && call.args[0] !== 'jlist'));
  }
});

test('generated export permits owned normal-mode data directories only behind its unchanged private root', async t => {
  const f = await hostFixture(t); await fs.chmod(f.generatedRoot, 0o775); await fs.chmod(path.dirname(f.generatedManifestFile.path), 0o775);
  const result = await f.run('export-release-inputs'); assert.equal(result.status, 'supabase-release-inputs-exported');
  assert.equal((await fs.stat(f.generatedRoot)).mode & 0o777, 0o775);
  const moved = f.generatedRoot + '.retained'; await fs.rename(f.generatedRoot, moved); await fs.symlink(moved, f.generatedRoot);
  await assert.rejects(f.run('export-release-inputs'), /Supabase source release stopped/);
});

test('a generated file edit during export cannot produce a success or change original generation evidence', async t => {
  const f = await hostFixture(t), open = fs.open, intent = await fs.readFile(path.join(f.context.controlRoot, 'report-once-intents', sha(f.states.get('app-sidi-report-head').body) + '.private.json'));
  let reached = false;
  fs.open = async (file, ...args) => {
    if (file === f.generatedDescriptorFile.path && !reached) { reached = true; await fs.appendFile(f.generatedManifestFile.path, ' '); }
    return open(file, ...args);
  };
  try { await assert.rejects(f.run('export-release-inputs'), /Supabase source release stopped/); } finally { fs.open = open; }
  assert(reached); assert.deepEqual(await fs.readFile(path.join(f.context.controlRoot, 'report-once-intents', sha(f.states.get('app-sidi-report-head').body) + '.private.json')), intent);
  assert.equal(f.counts.gets, 0); assert.equal(f.counts.sourceChecks, 0);
});

test('proof staging uses the actual application stager and SourceRelease verifier without starting any process or refreshing clocks', async t => {
  const f = await hostFixture(t), result = await f.run('stage-source-release');
  assert.equal(result.status, 'supabase-source-release-staged'); assert.equal(f.counts.privateChecks, 2); assert.equal(f.counts.gets, 1);
  assert(!f.calls.some(call => call.file === 'pm2' && call.args[0] !== 'jlist'));
  const root = path.join(f.actual.config.root, 'proofs', sha(f.pack()));
  assert.deepEqual(await fs.readFile(path.join(root, 'source-release-pack.private.json.gz')), f.pack());
  const plan = JSON.parse(await fs.readFile(path.join(f.context.controlRoot, 'source-release-' + sha(f.pack()) + '.private.json')));
  assert.equal(plan.verifiedAt, f.actual.release.verifiedAt); assert.equal(plan.validUntil, f.actual.release.validUntil);
  await f.run('stage-source-release'); assert.equal(f.rows.length, 3);
});

test('a genuinely larger metadata pack uses only the separately bounded immutable aliases and never broadens the application stager', async t => {
  const f = await hostFixture(t), original = f.context.load;
  f.values.get('capability-audit.private.json').fictionalPadding = Array.from({ length: 2500 }, (_, i) => sha('metadata-only-' + i)); rebindPack(f);
  assert(f.pack().length > 36 * 1024 && f.pack().length < 512 * 1024);
  f.context.load = async name => { assert.notEqual(name, 'scripts/driverAuditSourceStage.js'); return original(name); };
  const result = await f.run('stage-source-release'); assert.equal(result.status, 'supabase-source-release-staged');
  const root = path.join(f.actual.config.root, 'proofs', sha(f.pack()));
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  for (const name of driverAuditSupabaseReleaseProofNames) {
    assert.equal((await fs.stat(path.join(root, name))).mode & 0o777, 0o600);
    assert.equal(sha(await fs.readFile(path.join(root, name))), f.rowsByName.get(name).sha256);
  }
  const receipt = JSON.parse(await fs.readFile(path.join(f.context.controlRoot, 'source-release-' + sha(f.pack()) + '.private.json')));
  assert.equal(receipt.legacyProofStagerUsed, false); assert.equal(f.rows.length, 3);
});

test('an interrupted fixed-alias stage resumes exact private bytes; a conflicting partial proof stays untouched', async t => {
  for (const conflict of [false, true]) {
    const f = await hostFixture(t), original = fs.open; let interrupted = false;
    f.values.get('capability-audit.private.json').fictionalPadding = Array.from({ length: 2500 }, (_, i) => sha('partial-stage-' + i)); rebindPack(f);
    assert(f.pack().length > 36 * 1024);
    fs.open = async (file, flags, ...rest) => {
      if (!interrupted && typeof file === 'string' && file.endsWith('/source-fence.private.json') && typeof flags === 'number' && (flags & constants.O_EXCL)) {
        interrupted = true; throw Error('Fictional interrupted stage');
      }
      return original(file, flags, ...rest);
    };
    try { await assert.rejects(f.run('stage-source-release')); } finally { fs.open = original; }
    assert(interrupted); const root = path.join(f.actual.config.root, 'proofs', sha(f.pack())), file = path.join(root, 'backup.private.json');
    if (conflict) {
      await fs.writeFile(file, '{"independent":true}'); await assert.rejects(f.run('stage-source-release'));
      assert.equal(await fs.readFile(file, 'utf8'), '{"independent":true}');
    } else assert.equal((await f.run('stage-source-release')).status, 'supabase-source-release-staged');
    assert.equal(f.rows.length, 3);
  }
});

test('oversized or unsafe private proof and export inputs fail closed without changing any process', async t => {
  const large = packFixture(); large.values.get('credential-evidence.private.json').oversized = 'x'.repeat(512 * 1024);
  const data = json(large.values.get('credential-evidence.private.json'));
  large.rows.set('credential-evidence.private.json', { path: 'credential-evidence.private.json', sha256: sha(data), dataBase64: data.toString('base64') });
  assert.throws(() => decodeDriverAuditSupabaseSourceReleasePack(large.compressed(), sha(large.compressed())));
  const f = await hostFixture(t), before = structuredClone(f.rows), manifest = path.join(f.context.syncRoot, 'retained/candidate/server-data/files.private.json');
  await fs.chmod(manifest, 0o664); await assert.rejects(f.run('export-release-inputs'));
  assert.deepEqual(f.rows, before); assert.equal((await fs.stat(manifest)).mode & 0o777, 0o664);
});

test('actual SourceDeploy admission receives released worker/heavy locks, confirms its receipt, and only then resumes the existing Sync', async t => {
  const f = await hostFixture(t), before = structuredClone(f.rows[0]), result = await f.run('start-source-sync');
  assert.equal(result.status, 'supabase-source-sync-started'); assert.equal(result.sourceStarted, true); assert.equal(result.syncSteadyStarted, true);
  assert(f.counts.sourceChecks > 0); assert.equal(f.rows.find(row => row.name === 'matter-driver-audit-source').pid, 2004);
  assert.equal(f.rows.find(row => row.name === 'matter-driver-audit-sync').pm2_env.status, 'online');
  assert.deepEqual(f.rows[0], before); assert(!f.calls.some(call => call.file === 'pm2' && call.args[0] === 'start'));
});

function rebindPack(f) {
  const save = name => { const data = json(f.values.get(name)); f.rowsByName.set(name, { path: name, sha256: sha(data), dataBase64: data.toString('base64') }); return { path: name, sha256: sha(data) }; };
  const backup = save('backup.private.json'), parity = save('parity.private.json'), evidence = save('credential-evidence.private.json');
  Object.assign(f.values.get('credentials.private.json'), { evidence, evidenceSha256: evidence.sha256 });
  const drain = save('drain-audit.private.json'); f.values.get('quiet-audit.private.json').drainAuditSha256 = drain.sha256;
  Object.assign(f.values.get('checkpoint.private.json'), { backupReceiptSha256: backup.sha256, parityReceiptSha256: parity.sha256 });
  for (const [key, name] of [['capabilityAudit', 'capability-audit.private.json'], ['drainAudit', 'drain-audit.private.json'],
    ['quietAudit', 'quiet-audit.private.json'], ['checkpoint', 'checkpoint.private.json']])
    f.values.get('source-fence.private.json')[key] = { ...save(name), id: f.values.get(name).id };
  Object.assign(f.values.get('release.private.json'), { backup, parity, credentials: save('credentials.private.json'), sourceFence: save('source-fence.private.json') });
  save('release.private.json');
}

test('current journal, collector and paid-ledger changes require a fresh tail checkpoint before the real source control can run', async t => {
  for (const key of ['collector-state', 'review-journal', 'preview-acceptance-reconcile-20261109:review-journal', 'photo-grading-budget']) {
    const f = await hostFixture(t), before = structuredClone(f.rows);
    const independent = { revision: f.states.get(key).revision + 1, body: '{"independent":"new-evidence"}' }; f.states.set(key, independent);
    await assert.rejects(f.run('start-source-sync'));
    assert.deepEqual(f.rows, before); assert.deepEqual(f.states.get(key), independent);
    assert(!f.calls.some(call => call.file === f.context.node.executable));
    await assert.rejects(fs.access(path.join(f.actual.config.root, 'deployment-source.private.json')), { code: 'ENOENT' });
  }
});

test('actual SourceRelease rejects changed environment evidence, missing helper provenance and expired admission before source start', async t => {
  for (const kind of ['credential-environment', 'helper', 'expired']) {
    const f = await hostFixture(t);
    if (kind === 'credential-environment') f.values.get('credential-evidence.private.json').environmentSha256 = 'f'.repeat(64);
    if (kind === 'helper') delete f.values.get('capability-audit.private.json').appHelperCatalogSha256;
    if (kind === 'expired') f.adapters.now = () => new Date(Date.parse(f.actual.release.validUntil) + 1);
    rebindPack(f); await assert.rejects(f.run('start-source-sync'));
    assert.equal(f.rows.length, 3); assert(!f.calls.some(call => call.file === f.context.node.executable));
  }
});

test('a public proof bucket or foreign data backend cannot admit a pack or trigger a source command', async t => {
  for (const kind of ['bucket', 'store']) {
    const f = await hostFixture(t);
    if (kind === 'bucket') f.backend.archive.assertPrivate = async () => ({ public: true }); else f.backend.kind = 'foreign';
    await assert.rejects(f.run('stage-source-release')); assert.equal(f.counts.gets, 0);
    assert(!f.calls.some(call => call.file === f.context.node.executable));
  }
});

test('the original off-host environment proof is still hash-checked before any release pack or writer is admitted', async t => {
  const f = await hostFixture(t), original = f.backend.archive.readObject;
  f.backend.archive.readObject = async (key, options) => key === f.context.p.backupProof + '.gz'
    ? [gzipSync(json({ version: 1, verified: true, environmentSha256: f.context.p.sourceEnvironment }))] : original(key, options);
  await assert.rejects(f.run('start-source-sync')); assert.equal(f.counts.gets, 0);
  assert.equal(f.rows.length, 3); assert(!f.calls.some(call => call.file === f.context.node.executable));
});

test('a source start with a lost acknowledgement and transient observation is durably stopped under real exclusion; retry uses its original activation clock', async t => {
  const f = await hostFixture(t), original = f.adapters.exec; let lost = false, transient = false;
  f.adapters.exec = async (file, args, options) => {
    if (file === 'pm2' && args[0] === 'jlist' && lost && !transient) {
      transient = true; await assert.rejects(acquireWorkerLock(path.join(f.context.appRoot, 'server/.private/driver-report-supabase-handoff/operator.lock')), /Collector already active/);
      throw Error('Fictional temporary PM2 observation failure');
    }
    const result = await original(file, args, options);
    if (file === f.context.node.executable && !lost) { lost = true; throw Error('Fictional lost source acknowledgement'); }
    return result;
  };
  await assert.rejects(f.run('start-source-sync')); assert(lost && transient);
  assert.equal(f.rows.find(row => row.name === 'matter-driver-audit-source').pid, 0);
  assert.equal(f.rows.find(row => row.name === 'matter-driver-audit-sync').pid, 0);
  assert(f.calls.some(call => call.file === 'pm2' && call.args[0] === 'save'));
  const activationFile = path.join(f.actual.config.root, 'deployment-source.private.json'), before = await fs.readFile(activationFile);
  const gets = f.counts.gets; f.adapters.now = () => new Date(Date.parse(f.actual.release.validUntil) + 10 * 24 * 60 * 60_000);
  const result = await f.run('start-source-sync'); assert.equal(result.status, 'supabase-source-sync-started');
  assert.equal(f.counts.gets, gets); assert.deepEqual(await fs.readFile(activationFile), before);
  assert(f.calls.some(call => call.file === f.context.node.executable && call.args[1] === 'audit-source-resume'));
});

test('lost Sync restart acknowledgement stops and saves only the two new writers while retaining their accepted source activation and all source data', async t => {
  const f = await hostFixture(t), original = f.adapters.exec, data = structuredClone([...f.states]); let failed = false;
  f.adapters.exec = async (file, args, options) => {
    const value = await original(file, args, options);
    if (file === 'pm2' && args[0] === 'restart' && !failed) { failed = true; throw Error('Fictional Sync acknowledgement lost'); }
    return value;
  };
  await assert.rejects(f.run('start-source-sync')); assert(failed);
  assert.equal(f.rows.find(row => row.name === 'matter-driver-audit-source').pid, 0);
  assert.equal(f.rows.find(row => row.name === 'matter-driver-audit-sync').pid, 0); assert.deepEqual([...f.states], data);
  assert.equal(f.rows[0].pid, 1001); assert.equal(f.rows.find(row => row.name === 'matter-driver-reports-api').pid, 1003);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.actual.config.root, 'deployment-source.private.json'))).status, 'active');
});

test('an accepted already-running recovery preserves newer collector, paid and review records without rebuilding, reopening the fence or restarting Sync', async t => {
  const f = await hostFixture(t); await f.run('start-source-sync');
  const activationFile = path.join(f.actual.config.root, 'deployment-source.private.json'), activation = await fs.readFile(activationFile);
  const gets = f.counts.gets, restarts = f.calls.filter(call => call.file === 'pm2' && call.args[0] === 'restart').length;
  f.states.set('collector-state', { revision: 8, body: '{"new":"captured evidence"}' });
  f.states.set('review-journal', { revision: 2, body: '{"new":"human review"}' });
  f.states.set('photo-grading-budget', { revision: 2, body: '{"new":"legitimate paid attempt"}' });
  const head = { ...JSON.parse(f.states.get('app-sidi-report-head').body), generation: sha('later-generation'), reportHash: sha('later-report'),
    servingPackage: { dataStore: 'supabase', collectorRevision: 8 } };
  f.states.set('app-sidi-report-head', { revision: 3, body: JSON.stringify(head) });
  f.adapters.fetch = async () => new Response(JSON.stringify({ service: 'driver-reports', dataStore: 'supabase', executionHost: 'sidi', ready: true,
    generation: head.generation, reportHash: head.reportHash, collectorRevision: 8, release: f.context.p.release }));
  const current = structuredClone([...f.states]); f.adapters.now = () => new Date(Date.parse(f.actual.release.validUntil) + 24 * 60 * 60_000);
  const result = await f.run('start-source-sync'); assert.equal(result.status, 'supabase-source-sync-started');
  assert.deepEqual([...f.states], current); assert.deepEqual(await fs.readFile(activationFile), activation); assert.equal(f.counts.gets, gets);
  assert.equal(f.calls.filter(call => call.file === 'pm2' && call.args[0] === 'restart').length, restarts);
});

test('late cancellation during final lock release cannot return source-started or leak reacquired drain locks', async t => {
  const f = await hostFixture(t), cancel = new AbortController(), original = f.context.load; let reached = false;
  f.adapters.signal = cancel.signal;
  f.context.load = async name => {
    const loaded = await original(name);
    if (name !== 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return loaded;
    return { async acquireWorkerLock(file) {
      const lease = await loaded.acquireWorkerLock(file); return { async release() {
        await lease.release(); if (file.endsWith('/driver-report-supabase-handoff/operator.lock')) { reached = true; cancel.abort(); }
      } };
    } };
  };
  const before = Object.fromEntries(['SIGTERM', 'SIGINT', 'SIGHUP'].map(name => [name, process.listeners(name)]));
  await assert.rejects(f.run('start-source-sync'), error => error.phase === 'interrupted'); assert(reached);
  assert.equal(f.rows.find(row => row.name === 'matter-driver-audit-source').pid, 0); assert.equal(f.rows[1].pid, 0);
  for (const file of [path.join(f.context.sourceRoot, 'source-worker.lock'), path.join(path.dirname(f.context.syncRoot), 'sync-worker.lock'),
    path.join(f.context.server, '.private/driver-audit-heavy-work/work.lock')]) { const lease = await acquireWorkerLock(file); await lease.release(); }
  for (const name of Object.keys(before)) assert.deepEqual(process.listeners(name), before[name]);
});

test('cancellation at each final cleanup microtask boundary cannot return success while the interruption guard is installed', async t => {
  for (const depth of [0, 1, 2, 3, 4, 5]) {
    const f = await hostFixture(t), cancel = new AbortController(), original = f.context.load;
    const before = process.listeners('SIGTERM').length; let guardAtAbort = false, reached = false;
    cancel.signal.addEventListener('abort', () => { guardAtAbort = process.listeners('SIGTERM').length > before; });
    f.adapters.signal = cancel.signal;
    f.context.load = async name => {
      const module = await original(name); if (name !== 'vendor/driver-audits/integration/hosted/worker-lock.mjs') return module;
      return { async acquireWorkerLock(file) {
        const lease = await module.acquireWorkerLock(file); return { async release() {
          await lease.release();
          if (file.endsWith('/driver-report-supabase-handoff/operator.lock')) {
            reached = true; let action = () => cancel.abort();
            for (let count = 0; count < depth; count++) { const next = action; action = () => queueMicrotask(next); }
            action();
          }
        } };
      } };
    };
    let success = false;
    try { await f.run('start-source-sync'); success = true; } catch { /* Expected if cancellation arrived before completion. */ }
    assert(reached); assert(!(guardAtAbort && success), 'A guarded cancellation returned success at depth ' + depth);
    if (guardAtAbort) { assert.equal(f.rows[1].pid, 0); assert.equal(f.rows.find(row => row.name === 'matter-driver-audit-source').pid, 0); }
    for (const file of [path.join(f.context.sourceRoot, 'source-worker.lock'), path.join(path.dirname(f.context.syncRoot), 'sync-worker.lock'),
      path.join(f.context.server, '.private/driver-audit-heavy-work/work.lock')]) { const lease = await acquireWorkerLock(file); await lease.release(); }
    assert.equal(process.listeners('SIGTERM').length, before);
  }
});

test('a real TERM during an actual Node control child retains exclusion until child close and then drains the created source', async t => {
  const f = await hostFixture(t), original = f.adapters.exec, startedFile = path.join(f.context.controlRoot, 'real-child.started'),
    closedFile = path.join(f.context.controlRoot, 'real-child.closed');
  const executable = path.join(f.context.server, 'scripts/driverAuditSourceDeploy.js');
  await f.write(executable, Buffer.from('const fs=require("node:fs");fs.writeFileSync(' + JSON.stringify(startedFile) + ',"started",{mode:384});' +
    'setTimeout(()=>{fs.writeFileSync(' + JSON.stringify(closedFile) + ',"closed",{mode:384});console.log(JSON.stringify({status:"started"}));},250);'));
  let sent = false, stopAfterClose = false, childClosed = false;
  f.adapters.exec = async (file, args, options) => {
    if (file === f.context.node.executable) {
      try { return await promisify(execFile)(file, args, options); } finally { childClosed = true; }
    }
    if (file === 'pm2' && args[0] === 'jlist' && await fs.access(startedFile).then(() => true, () => false)
      && !f.rows.some(row => row.name === 'matter-driver-audit-source'))
      f.rows.push({ name: 'matter-driver-audit-source', pm_id: 4, pid: 2004, pm2_env: { status: 'online', pm_cwd: f.context.server,
        pm_exec_path: path.join(f.context.server, 'scripts/driverAuditSource.js'), args: ['--config', f.actual.configFile], exec_interpreter: process.execPath, node_args: [] } });
    if (file === 'pm2' && args[0] === 'stop') { assert(childClosed); await fs.access(closedFile); stopAfterClose = true; }
    return original(file, args, options);
  };
  const timer = setInterval(async () => {
    if (!sent && await fs.access(startedFile).then(() => true, () => false)) {
      sent = true; await assert.rejects(acquireWorkerLock(path.join(f.context.appRoot, 'server/.private/driver-report-supabase-handoff/operator.lock')), /Collector already active/);
      process.kill(process.pid, 'SIGTERM');
    }
  }, 10);
  try { await assert.rejects(f.run('start-source-sync')); }
  finally { clearInterval(timer); }
  assert(sent && childClosed && stopAfterClose); assert.equal(f.rows.find(row => row.name === 'matter-driver-audit-source').pid, 0);
});
