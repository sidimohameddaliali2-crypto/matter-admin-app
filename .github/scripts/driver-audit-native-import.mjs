import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

export const NATIVE_IMPORT_CAPACITY_BYTES = 16 * 1024 ** 3;
export const NATIVE_IMPORT_SOURCE_MANIFEST = 'e1650c0a521271976629fafc1ad6d6eb0abf39074b5eeaf909f2d93f929f9d9d';
export const NATIVE_BUILDER_FROM = '293c5001a5cc3aa61e422dc659db507d9be00e79c0848900f074279f6a02960f';
export const NATIVE_BUILDER_TO = 'aa624979d3d119bb3fd8eb4ca82ed1b976aaa6319ec3974596745c3a30a24b65';
export const NATIVE_IMPORT_FILES = Object.freeze({
  documents: 'documents.private.jsonl.gz', receipts: 'receipts.private.jsonl.gz',
  historical: 'historical.private.jsonl.gz', objects: 'objects.private.jsonl.gz',
  bookkeepingBackup: 'bookkeeping-backup.private.json', reviewContexts: 'review-contexts.private.jsonl.gz',
  reviewDependencies: 'review-dependencies.private.jsonl.gz',
});
const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireImport = (condition, message) => { if (!condition) throw Object.assign(Error(message), { importGuard: true }); };

async function saveProfile(file, bytes, read) {
  try {
    const existing = await read(file, 1024 * 1024);
    requireImport(hash(existing) === hash(bytes), 'The immutable import profile differs');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temporary); }
}

async function stageBuilder({ folder, received, bundleSha256, syncRoot, read, privateDirectory, load, pins }) {
  const changed = 'integration/cloud/automatic-release-source.mjs', filename = 'builder-bundle.private.json.gz';
  requireImport(digest(pins.from) && digest(pins.to) && pins.from !== pins.to, 'The reviewed builder identities differ');
  const matching = Array.isArray(received.inputFiles) ? received.inputFiles.filter(row => row?.name === filename) : [];
  requireImport(matching.length === 1 && matching[0].sha256 === bundleSha256 && integer(matching[0].bytes)
    && matching[0].bytes > 0 && matching[0].bytes <= 36 * 1024, 'The received reviewed builder bundle is required');
  const compressed = await read(path.join(folder, filename), 36 * 1024);
  requireImport(compressed.length === matching[0].bytes && hash(compressed) === bundleSha256, 'The received builder bundle differs');
  const bundle = JSON.parse(gunzipSync(compressed, { maxOutputLength: 128 * 1024 }));
  requireImport(object(bundle) && bundle.version === 1 && Object.keys(bundle).sort().join(',') === 'delta,manifest,version'
    && typeof bundle.manifest === 'string' && object(bundle.delta) && Object.keys(bundle.delta).join(',') === changed,
  'Only the reviewed one-file builder delta is accepted');
  const decode = value => {
    requireImport(typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'The builder encoding differs');
    const bytes = Buffer.from(value, 'base64');
    requireImport(bytes.toString('base64') === value, 'The builder encoding differs'); return bytes;
  };
  const manifestBytes = decode(bundle.manifest), manifest = JSON.parse(manifestBytes), replacement = decode(bundle.delta[changed]);
  requireImport(hash(manifestBytes) === pins.to && manifest.version === 1 && object(manifest.files)
    && Object.keys(manifest.files).length === 73, 'The exact replacement 73-file builder manifest is required');
  const source = path.join(syncRoot, 'builder'), target = path.join(syncRoot, 'builder-staged-' + pins.to);
  const config = JSON.parse(await read(path.join(syncRoot, 'sync.json'), 1024 * 1024));
  requireImport(config.codeRoot === source && config.builderSha256 === pins.from, 'The active source builder differs');
  const { verifyAuditBuilder } = await load('vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs');
  await verifyAuditBuilder(source, pins.from);
  const originalBytes = await read(path.join(source, 'runtime-manifest.json'), 128 * 1024), original = JSON.parse(originalBytes);
  requireImport(hash(originalBytes) === pins.from && original.version === 1 && object(original.files)
    && Object.keys(original.files).length === 73 && JSON.stringify(Object.keys(original.files).sort())
      === JSON.stringify(Object.keys(manifest.files).sort()), 'The exact original builder inventory differs');
  const candidate = [];
  for (const [name, expected] of Object.entries(manifest.files)) {
    requireImport(name.length < 512 && name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
      && digest(expected) && (name === changed ? expected !== original.files[name] : expected === original.files[name]),
    'The builder delta changed an unreviewed file');
    const saved = await read(path.join(source, name), 8 * 1024 * 1024);
    requireImport(hash(saved) === original.files[name], 'The original builder file differs');
    const bytes = name === changed ? replacement : saved;
    requireImport(bytes.length <= 8 * 1024 * 1024 && hash(bytes) === expected, 'The replacement builder file differs');
    candidate.push([name, bytes]);
  }
  const verify = async directory => {
    await verifyAuditBuilder(directory, pins.to);
    async function directories(root) {
      await privateDirectory(root);
      for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await directories(path.join(root, entry.name));
    }
    await directories(directory);
    for (const [name, expected] of Object.entries(manifest.files)) {
      requireImport(hash(await read(path.join(directory, name), 8 * 1024 * 1024)) === expected, 'The staged builder file differs');
    }
    requireImport(hash(await read(path.join(directory, 'runtime-manifest.json'), 128 * 1024)) === pins.to,
      'The staged builder manifest differs');
  };
  const result = { builderSha256: pins.to, sourceBuilderSha256: pins.from, bundleSha256, files: 73, activationPending: true,
    authorityChanged: false };
  if (await fs.lstat(target).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) {
    await verify(target); return { ...result, status: 'builder-already-staged' };
  }
  await fs.mkdir(target, { mode: 0o700 });
  for (const [name, bytes] of [...candidate, ['runtime-manifest.json', manifestBytes]]) {
    await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(target, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  await verify(target);
  return { ...result, status: 'builder-staged' };
}

async function stageSource({ folder, received, bundleSha256, syncRoot, server, db, client, read, privateDirectory, load, execute, pins }) {
  const names = ['source-bundle.private.json.gz', 'environment.private.json'];
  requireImport(Array.isArray(received.inputFiles) && received.inputFiles.length === names.length
    && names.every(name => received.inputFiles.filter(row => row?.name === name).length === 1),
  'The exact two private source inputs are required');
  const input = async (name, maximum) => {
    const matches = received.inputFiles?.filter(row => row?.name === name);
    requireImport(Array.isArray(matches) && matches.length === 1 && digest(matches[0].sha256)
      && integer(matches[0].bytes) && matches[0].bytes > 0 && matches[0].bytes <= maximum, 'The received private source inputs differ');
    const bytes = await read(path.join(folder, name), maximum);
    requireImport(bytes.length === matches[0].bytes && hash(bytes) === matches[0].sha256, 'The received private source input hash differs');
    return bytes;
  };
  const compressed = await input('source-bundle.private.json.gz', 1024 * 1024);
  const environmentBytes = await input('environment.private.json', 64 * 1024);
  requireImport(hash(compressed) === bundleSha256 && digest(pins.manifest) && pins.files === 134, 'The reviewed complete source bundle differs');
  const bundle = JSON.parse(gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }));
  requireImport(object(bundle) && Object.keys(bundle).sort().join(',') === 'files,manifestSha256,nodeExecutable,nodeVersion,version'
    && bundle.version === 1 && bundle.manifestSha256 === pins.manifest && Array.isArray(bundle.files) && bundle.files.length === pins.files + 1
    && bundle.files.every(row => object(row) && Object.keys(row).sort().join(',') === 'dataBase64,path'
      && typeof row.path === 'string' && typeof row.dataBase64 === 'string'), 'The source archive must contain only the complete pinned code envelope');
  const environment = JSON.parse(environmentBytes), cacheDirectory = path.join(syncRoot, 'work/archive-cache');
  const forbidden = ['MONGODB_URI', 'DRIVER_AUDIT_NATIVE_CAPACITY_BYTES', 'NODE_OPTIONS', 'NODE_PATH', 'PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'];
  requireImport(object(environment) && environment.DRIVER_AUDIT_DATA_STORE === 'mongo'
    && environment.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY === cacheDirectory
    && Object.entries(environment).every(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === 'string'
      && value.length <= 16384 && !value.includes('\0') && !forbidden.includes(key) && !key.includes('OIDC')),
  'The private source environment must use the app native connection and managed cache');
  const manifestEntry = bundle.files.find(row => row.path === 'manifest.private.json');
  const manifestBytes = manifestEntry && Buffer.from(manifestEntry.dataBase64, 'base64');
  requireImport(manifestBytes && hash(manifestBytes) === pins.manifest, 'The complete source manifest pin differs');
  const manifest = JSON.parse(manifestBytes);
  const switches = ['MATTER_DELIVERY_ENABLED', 'MATTER_PHOTO_READ_ENABLED', 'MATTER_PHOTO_GRADE_ENABLED', 'MATTER_GPS_ENABLED', 'MATTER_GPS_PUBLICATION_ENABLED'];
  requireImport(Array.isArray(manifest.files) && manifest.files.length === pins.files && Array.isArray(manifest.entrypoints)
    && manifest.entrypoints.length === 13 && manifest.entrypoints.every(row => Array.isArray(row.requiredEnvironment)
      && row.requiredEnvironment.every(key => typeof environment[key] === 'string' && environment[key].length > 0))
    && typeof environment.CRON_SECRET === 'string' && environment.CRON_SECRET.length >= 32
    && switches.every(key => environment[key] === undefined || ['0', '1'].includes(environment[key]))
    && (environment.MATTER_PHOTO_GRADE_ENABLED !== '1' || typeof environment.AI_GATEWAY_API_KEY === 'string' && environment.AI_GATEWAY_API_KEY.length > 0),
  'The private source environment does not satisfy the pinned handlers');
  await privateDirectory(cacheDirectory);
  requireImport(typeof bundle.nodeExecutable === 'string' && path.isAbsolute(bundle.nodeExecutable)
    && path.resolve(bundle.nodeExecutable) === bundle.nodeExecutable
    && await fs.realpath(bundle.nodeExecutable) === await fs.realpath(process.execPath)
    && bundle.nodeVersion === process.version, 'The source bundle must identify the current host Node');
  const node = await execute(bundle.nodeExecutable, ['--version'], { env: {}, timeout: 5000, maxBuffer: 4096 });
  requireImport(node.stdout.trim() === bundle.nodeVersion, 'The freshly checked source Node version differs');
  const sourceRoot = path.join(server, '.private/driver-audit-source');
  await fs.mkdir(sourceRoot, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await privateDirectory(sourceRoot);
  const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
  const lock = await acquireWorkerLock(path.join(sourceRoot, 'source-deployment.lock'));
  try {
    const { stageDriverAuditSource } = await load('scripts/driverAuditSourceStage.js');
    const result = await stageDriverAuditSource({ sourceRoot, compressed, expectedBundleSha256: bundleSha256,
      expectedManifestSha256: pins.manifest, environmentBytes, nodeExecutable: bundle.nodeExecutable });
    requireImport(['staged', 'already-staged'].includes(result.status) && result.manifestSha256 === pins.manifest
      && result.configFile === path.join(sourceRoot, pins.manifest, 'source.json'), 'The actual source stage receipt differs');
    const { readDriverAuditSourceConfig } = await load('services/driverAuditSource.js');
    const config = await readDriverAuditSourceConfig(result.configFile);
    requireImport(config.dataStore === 'mongo' && config.archiveCacheDirectory === cacheDirectory
      && config.manifestSha256 === pins.manifest && config.runtime.files.length === pins.files,
    'The staged complete native source configuration differs');
    const receipt = JSON.parse(await read(path.join(sourceRoot, pins.manifest, 'stage.private.json'), 1024 * 1024));
    requireImport(receipt.bundleSha256 === bundleSha256 && receipt.environmentSha256 === hash(environmentBytes),
      'The staged source code and private environment pins differ');
    const { createDriverAuditMongoArchive } = await load('services/driverAuditMongoArchive.js');
    const archive = createDriverAuditMongoArchive({ db, client, capacityBytes: NATIVE_IMPORT_CAPACITY_BYTES });
    const key = bundleSha256 + '.gz', saved = await archive.putVerifiedObject(key, compressed);
    requireImport(saved.verified === true && saved.key === key && saved.sha256 === bundleSha256 && saved.bytes === compressed.length,
      'The complete native code archive receipt differs');
    requireImport(Buffer.concat(await archive.readObject(key, { maxBytes: compressed.length })).equals(compressed),
      'The complete native code archive readback differs');
    return { status: result.status === 'staged' ? 'source-staged' : 'source-already-staged',
      manifestSha256: pins.manifest, bundleSha256, archiveCodeKey: key, files: pins.files, bundleBytes: compressed.length,
      nodeVersion: bundle.nodeVersion, configSha256: config.configSha256, environmentArchived: false,
      authorityChanged: false, activationPending: true };
  } finally { await lock.release(); }
}

async function diagnoseRoots({ db, syncRoot, read, privateDirectory, load, recipientPublicKey, diagnosticPage }) {
  const signatures = new Map(), controls = [], inventories = [], records = new Map(), references = [], candidates = new Set();
  const orphans = [], orphanProbes = [], orphanIndexes = new Map(), unresolvedPaths = new Set(), directorySignatures = new Map();
  const attemptPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  let metadataBytes = 0;
  async function bytes(relative, maximum, optional = true) {
    const file = path.join(syncRoot, relative);
    try {
      const value = await read(file, maximum);
      signatures.set(relative, { sha256: hash(value), maximum, bytes: value.length });
      return value;
    } catch (error) {
      if (optional && error.code === 'ENOENT') { signatures.set(relative, { sha256: null, maximum }); return null; }
      throw error;
    }
  }
  async function control(relative, kind, optional = true, maximum = 1024 * 1024) {
    const raw = await bytes(relative, maximum, optional);
    if (!raw) return null;
    metadataBytes += raw.length;
    requireImport(metadataBytes <= 8 * 1024 * 1024, 'Diagnostic control metadata exceeds its bound');
    const value = JSON.parse(raw);
    requireImport(object(value), 'Diagnostic control metadata must be an object');
    controls.push({ relative, kind, sha256: hash(raw), value });
    return value;
  }
  async function inventory(relative) {
    const raw = await bytes(relative, 16 * 1024 * 1024);
    const value = raw && JSON.parse(raw);
    const result = { relative, present: !!raw, bytes: raw?.length ?? 0, sha256: raw ? hash(raw) : null,
      entries: value && object(value) ? Object.keys(value).length : null,
      entriesValid: !!value && object(value) && Object.keys(value).length > 0
        && Object.entries(value).every(([name, expected]) => name.length <= 512
          && name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) && digest(expected)) };
    inventories.push(result); return result;
  }
  async function directory(relative) {
    const root = path.join(syncRoot, relative);
    const info = await fs.lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!info) return { present: false, ownerPrivate: false, entries: [], counts: { file: 0, directory: 0, symlink: 0, other: 0 } };
    await privateDirectory(root);
    const entries = await fs.readdir(root, { withFileTypes: true });
    requireImport(entries.length <= 32768, 'Diagnostic orphan directory exceeds its bound');
    const counts = { file: 0, directory: 0, symlink: 0, other: 0 };
    const listed = entries.map(entry => {
      const type = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other';
      counts[type]++; return { name: entry.name, type };
    }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return { present: true, ownerPrivate: true, entries: listed, counts };
  }
  async function orphanProbe(root, reference, index) {
    unresolvedPaths.add(root);
    if (!orphanIndexes.has(root)) {
      if (orphans.length === 8) return;
      const relative = path.relative(syncRoot, root), prefix = path.dirname(relative);
      const attempt = await directory(prefix), serverData = await directory(relative), savedCurrent = await directory(prefix + '/saved-current');
      const source = await directory(prefix + '/source');
      for (const [name, value] of [[prefix, attempt], [relative, serverData], [prefix + '/saved-current', savedCurrent], [prefix + '/source', source]]) {
        directorySignatures.set(name, JSON.stringify(value));
      }
      const savedInventory = await inventory(relative + '/files.private.json');
      const metadataFiles = [], sourceSnapshots = [];
      for (const [location, name, kind, maximum = 1024 * 1024] of [
        ['attempt', 'accepted.private.json', 'orphan-accepted'],
        ['attempt', 'direct-seed.private.json', 'orphan-direct-seed'],
        ['attempt', 'retired-workspace.private.json', 'orphan-retired'],
        ['attempt', 'build-recipe.private.json', 'orphan-build-recipe'],
        ['attempt', 'automatic-build.private.json', 'orphan-build-summary'],
        ['server-data', 'publication.private.json', 'orphan-publication', 2 * 1024 * 1024],
        ['server-data', 'build.private.json', 'orphan-renderer-build'],
        ['server-data', 'build-recipe.private.json', 'orphan-server-recipe'],
        ['saved-current', 'collector-state.private.json', 'orphan-saved-collector', 2 * 1024 * 1024],
        ['source', 'collector-state.private.json', 'orphan-source-collector', 2 * 1024 * 1024],
      ]) {
        const file = (location === 'attempt' ? prefix : location === 'server-data' ? relative : prefix + '/' + location) + '/' + name;
        const value = await control(file, kind, true, maximum);
        const saved = signatures.get(file);
        metadataFiles.push({ location, name, type: saved.sha256 ? 'file' : 'missing',
          present: saved.sha256 !== null, bytes: saved.bytes ?? 0, sha256: saved.sha256 });
        if (name === 'collector-state.private.json' && value) sourceSnapshots.push({ location,
          revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : null,
          bodySha256: typeof value.body === 'string' ? hash(value.body) : null, fileSha256: saved.sha256 });
      }
      for (const location of ['saved-current', 'source']) for (const name of ['current-reviews.private.json', 'current-browser.private.json']) {
        const raw = await bytes(prefix + '/' + location + '/' + name, 64 * 1024 * 1024);
        metadataFiles.push({ location, name, type: raw ? 'file' : 'missing',
          present: !!raw, bytes: raw?.length ?? 0, sha256: raw ? hash(raw) : null });
      }
      const summary = value => ({ present: value.present, ownerPrivate: value.ownerPrivate, counts: value.counts });
      const probe = { probe: orphanProbes.length, referenceIndices: [], identityRecovered: false,
        attempt: summary(attempt), serverData: summary(serverData), savedCurrent: summary(savedCurrent), source: summary(source),
        inventory: { present: savedInventory.present, bytes: savedInventory.bytes, sha256: savedInventory.sha256,
          entries: savedInventory.entries, entriesValid: savedInventory.entriesValid, matchesReference: true },
        metadataFiles, sourceSnapshots };
      orphanIndexes.set(root, probe.probe); orphanProbes.push(probe);
      orphans.push({ relative, attempt, serverData, savedCurrent, source, inventory: savedInventory, metadataFiles, sourceSnapshots });
    }
    const probe = orphanProbes[orphanIndexes.get(root)];
    probe.referenceIndices.push(index);
    probe.inventory.matchesReference &&= probe.inventory.present && probe.inventory.sha256 === reference.manifestSha256;
  }
  const config = await control('sync.json', 'sync-config', false), baseline = path.join(syncRoot, 'baseline');
  requireImport(config.root === syncRoot && config.baselineRoot === baseline, 'Diagnostic managed baseline differs');
  const workspace = value => {
    if (value === baseline) return value;
    if (typeof value !== 'string') return null;
    const relative = path.relative(syncRoot, value), parts = relative.split(path.sep);
    return parts.length === 4 && parts[0] === 'work' && parts[1] === 'attempts' && attemptPattern.test(parts[2])
      && parts[3] === 'server-data' && value === path.join(syncRoot, ...parts) ? value : null;
  };
  const identity = (value, revision = value?.collectorRevision) => ({
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : null,
    sourceBasis: digest(value?.sourceBasis) ? value.sourceBasis : null,
    manifestSha256: digest(value?.manifestSha256) ? value.manifestSha256 : null,
  });
  const retain = value => { if (value.revision) candidates.add(value.revision); return value; };
  const seed = await control('seed.json', 'bootstrap-seed', false);
  const baselineInventory = await inventory('baseline/files.private.json');
  const baselineRecipe = await control('baseline/build-recipe.private.json', 'bootstrap-recipe');
  records.set(baseline, { kind: 'bootstrap', identity: retain(identity(seed)), accepted: null, recipe: baselineRecipe?.recipe ?? config.legacyBuildRecipe });
  const pointer = await control('work/current.private.json', 'current-pointer');
  const attemptsRoot = path.join(syncRoot, 'work/attempts');
  const names = async () => {
    let entries;
    try { await privateDirectory(attemptsRoot); entries = await fs.readdir(attemptsRoot, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    requireImport(entries.length <= 16384, 'Diagnostic workspace count exceeds its bound');
    const result = [];
    for (const entry of entries) if (attemptPattern.test(entry.name)) {
      requireImport(entry.isDirectory(), 'Diagnostic workspace must be a real directory');
      await privateDirectory(path.join(attemptsRoot, entry.name)); result.push(entry.name);
    }
    return result.sort();
  };
  const directories = await names();
  for (const name of directories) {
    const prefix = 'work/attempts/' + name + '/', root = path.join(syncRoot, prefix, 'server-data');
    const accepted = await control(prefix + 'accepted.private.json', 'accepted');
    const direct = await control(prefix + 'direct-seed.private.json', 'direct-seed');
    const retired = await control(prefix + 'retired-workspace.private.json', 'retired');
    const recipe = await control(prefix + 'build-recipe.private.json', 'build-recipe');
    if (!accepted && !direct && !retired) continue;
    const identities = [accepted && identity(accepted), direct && identity(direct), retired && identity(retired, retired.source?.revision)].filter(Boolean);
    identities.forEach(retain);
    const value = identities[0];
    await inventory(prefix + 'server-data/files.private.json');
    records.set(root, { kind: accepted ? 'accepted' : direct ? 'seed-only' : 'retired-only', identity: value,
      accepted, recipe: recipe?.recipe ?? retired?.recipe, identityAgreement: identities.every(item => JSON.stringify(item) === JSON.stringify(value)) });
    if (accepted?.previous) references.push({ kind: 'accepted-previous', ownerRevision: value.revision, reference: accepted.previous });
  }
  if (pointer) {
    retain(identity(pointer));
    if (pointer.previous) references.push({ kind: 'current-previous', ownerRevision: pointer.collectorRevision, reference: pointer.previous });
  }
  const head = await db.collection('driverAuditControl').findOne({ _id: 'head' }), headHash = hash(JSON.stringify(head));
  for (const [kind, value] of [['mongo-current', head?.head], ['mongo-previous', head?.head?.previous]]) if (value) {
    const item = identity(value.directImport, value.sourceRevision); retain(item);
    controls.push({ kind, sha256: hash(JSON.stringify(value)), value });
  }
  const cleanReference = value => ({ basis: digest(value?.basis) ? value.basis : null,
    manifestSha256: digest(value?.manifestSha256) ? value.manifestSha256 : null,
    collectorRevision: Number.isSafeInteger(value?.collectorRevision) ? value.collectorRevision : null,
    sourceBasis: digest(value?.sourceBasis) ? value.sourceBasis : null });
  const mismatches = [], allMatches = [];
  for (const [index, item] of references.entries()) {
    const targetPath = workspace(item.reference.privateRoot), target = targetPath && records.get(targetPath), value = target?.identity;
    if (targetPath && !target && targetPath !== baseline) await orphanProbe(targetPath, item.reference, index);
    const matches = { resolved: !!target, manifest: !!target && item.reference.manifestSha256 === value.manifestSha256,
      basis: !!target && item.reference.basis === (target.accepted?.basis || value.sourceBasis),
      revision: !!target && (item.reference.collectorRevision === undefined || item.reference.collectorRevision === value.revision),
      sourceBasis: !!target && (item.reference.sourceBasis === undefined || item.reference.sourceBasis === value.sourceBasis) };
    const recipe = target?.recipe, recipeFields = ['builderSha256', 'rendererSha256', 'journalsSha256', 'baselineManifestSha256'];
    const recipeId = recipeFields.every(key => digest(recipe?.[key])) ? hash(JSON.stringify(Object.fromEntries(recipeFields.map(key => [key, recipe[key]])))) : null;
    const recipeDerivedBasis = recipeId && value?.sourceBasis ? hash(JSON.stringify({ source: value.sourceBasis, recipeId })) : null;
    const result = { index, referenceKind: item.kind, ownerRevision: Number.isSafeInteger(item.ownerRevision) ? item.ownerRevision : null,
      targetKind: target?.kind || 'unresolved', reference: cleanReference(item.reference), target: target ? {
        ...value, acceptedBasis: digest(target.accepted?.basis) ? target.accepted.basis : null, recipeId, recipeDerivedBasis,
      } : null, matches, basisMatchesRecipeDerivation: !!recipeDerivedBasis && item.reference.basis === recipeDerivedBasis };
    allMatches.push(result); if (!Object.values(matches).every(Boolean)) mismatches.push(result);
  }
  requireImport(JSON.stringify(directories) === JSON.stringify(await names()), 'Diagnostic workspace inventory changed');
  requireImport(hash(JSON.stringify(await db.collection('driverAuditControl').findOne({ _id: 'head' }))) === headHash, 'Diagnostic serving roots changed');
  for (const [relative, expected] of directorySignatures) {
    requireImport(JSON.stringify(await directory(relative)) === expected, 'Diagnostic orphan directory changed');
  }
  for (const [relative, expected] of signatures) {
    let actual = null;
    try { actual = hash(await read(path.join(syncRoot, relative), expected.maximum)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    requireImport(actual === expected.sha256, 'Diagnostic control metadata changed');
  }
  const metadata = { version: 1, syncRoot, controls, inventories, matches: allMatches, orphans }, raw = Buffer.from(JSON.stringify(metadata));
  requireImport(raw.length <= 8 * 1024 * 1024, 'Diagnostic metadata exceeds its bound');
  const candidateRevisions = [...candidates].sort((a, b) => a - b);
  const output = { status: 'roots-diagnosed', censusVerified: false, authorityChanged: false, activationPending: true,
    controls: controls.length, workspaces: directories.length, referenceCount: references.length, mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 8), candidateCount: candidateRevisions.length, candidateRevisions: candidateRevisions.slice(0, 256),
    orphanProbeCount: orphanProbes.length, orphanUnprobedCount: unresolvedPaths.size - orphanProbes.length, orphanProbes,
    candidateRevisionsSha256: hash(JSON.stringify(candidateRevisions)), rootMetadataSha256: hash(raw),
    bootstrap: { ...identity(seed), inventorySha256: baselineInventory.sha256,
      inventoryBytes: baselineInventory.bytes, inventoryMatches: seed.manifestSha256 === baselineInventory.sha256 } };
  if (recipientPublicKey) {
    const compressed = gzipSync(raw), chunkBytes = 32 * 1024, pages = Math.ceil(compressed.length / chunkBytes);
    output.diagnosticPages = pages;
    requireImport(diagnosticPage < pages, 'Diagnostic metadata page is outside its bound');
    const { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
    output.capsule = sealTransferSecrets(recipientPublicKey, { version: 1, page: diagnosticPage, pages,
      metadataSha256: hash(raw), gzipSha256: hash(compressed), metadataBytes: raw.length, gzipBytes: compressed.length,
      gzipChunkBase64: compressed.subarray(diagnosticPage * chunkBytes, (diagnosticPage + 1) * chunkBytes).toString('base64') });
    output.recipientSha256 = hash(recipientPublicKey);
  }
  return output;
}

// The optional adapters are for isolated fixture tests. Dispatch supplies only
// reviewed public identities; all private paths/modules come from the host.
export async function runDriverAuditNativeImport({ operation, sessionId, templateSha256, profileSha256,
  expectedSha, appRoot, recipientPublicKey, diagnosticPage = 0 }, adapters = {}) {
  let phase = 'checkout', lock, connection;
  const execute = adapters.exec || exec, env = adapters.env || process.env;
  try {
    requireImport(['create-profile', 'plan-import', 'stage-import', 'verify-import', 'stage-builder', 'stage-source', 'diagnose-roots'].includes(operation)
      && typeof sessionId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId)
      && (operation === 'diagnose-roots' ? templateSha256 === undefined || digest(templateSha256) : digest(templateSha256)),
    'A reviewed import operation and public input identities are required');
    requireImport(integer(diagnosticPage) && diagnosticPage <= 256 && (recipientPublicKey === undefined
      || typeof recipientPublicKey === 'string' && recipientPublicKey.length <= 8192 && !recipientPublicKey.includes('PRIVATE KEY')
        && /-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(recipientPublicKey)), 'A bounded public diagnostic recipient is required');
    requireImport(profileSha256 === undefined || digest(profileSha256), 'The import profile pin is invalid');
    requireImport(!['stage-import', 'verify-import'].includes(operation) || digest(profileSha256), 'The exact import profile pin is required');
    requireImport(typeof appRoot === 'string' && path.isAbsolute(appRoot) && path.resolve(appRoot) === appRoot
      && await fs.realpath(appRoot) === appRoot, 'The exact application root is required');
    const checkout = async () => {
      const actual = (await execute('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 })).stdout.trim();
      requireImport((adapters.platform || process.platform) === 'linux' && /^[a-f0-9]{40}$/.test(expectedSha || '')
        && actual === expectedSha, 'The exact Linux application checkout is required');
    };
    await checkout();
    const server = path.join(appRoot, 'server');
    const load = adapters.load || (name => import(pathToFileURL(path.join(server, name)).href));
    await load('loadEnv.js');
    const { readPrivateDriverAuditSource: read, requirePrivateDriverAuditSourceDirectory: privateDirectory,
      verifyDriverAuditSource } = await load('services/driverAuditSource.js');
    phase = 'private-session';
    const transferRoot = path.join(server, '.private/driver-audit-native-transfer'), folder = path.join(transferRoot, sessionId);
    await privateDirectory(transferRoot); await privateDirectory(folder);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(transferRoot, 'operator.lock'));
    await checkout();
    const state = JSON.parse(await read(path.join(folder, 'session.private.json'), 128 * 1024));
    const received = JSON.parse(await read(path.join(folder, 'received.private.json'), 1024 * 1024));
    requireImport(state.version === 1 && state.sessionId === sessionId && state.capacityBytes === NATIVE_IMPORT_CAPACITY_BYTES
      && digest(state.inventorySha256) && state.plan?.inventorySha256 === state.inventorySha256
      && integer(state.createdAt) && state.createdAt <= Date.now(), 'The verified private transfer session differs');
    requireImport(received.version === 1 && received.status === 'transfer-received' && received.verified === true
      && received.authorityChanged === false && received.sessionId === sessionId && received.targetDatabase === state.targetDatabase
      && received.inventorySha256 === state.inventorySha256 && received.objects === state.plan.objectCount
      && received.bytes === state.plan.objectBytes && integer(received.objects) && received.objects > 0 && received.objects <= 100000
      && integer(received.bytes) && received.bytes > 0 && received.bytes <= 2 * 1024 ** 3
      && Number.isFinite(Date.parse(received.completedAt)) && Date.parse(received.completedAt) >= state.createdAt
      && Date.parse(received.completedAt) <= Date.now(), 'The verified native transfer receipt differs');
    phase = 'database';
    requireImport(typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0, 'The existing app database connection is required');
    const { default: mongoose } = await load('node_modules/mongoose/index.js');
    connection = mongoose.createConnection(env.MONGODB_URI, {
      autoCreate: false, autoIndex: false, maxPoolSize: 1, serverSelectionTimeoutMS: 10000,
    });
    await connection.asPromise();
    const db = connection.db;
    requireImport(db.databaseName === state.targetDatabase, 'The received inputs target another database');
    let syncRoot;
    const stopped = async () => {
      const entries = JSON.parse((await execute('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout);
      requireImport(Array.isArray(entries), 'The managed process inventory is invalid');
      const sync = entries.filter(row => row.name === 'matter-driver-audit-sync');
      requireImport(entries.filter(row => row.name === 'matter-delivery-api').length === 1 && sync.length === 1
        && sync[0].pm2_env?.status === 'stopped'
        && entries.filter(row => row.name === 'matter-driver-audit-source').every(row => row.pm2_env?.status === 'stopped'),
      'Native import requires stopped report workers');
      const worker = sync[0].pm2_env, args = worker.args;
      requireImport(worker.pm_cwd === server && worker.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js')
        && Array.isArray(args) && args.length === 2 && args[0] === '--config', 'The managed sync invocation differs');
      const candidate = typeof args[1] === 'string' ? path.dirname(args[1]) : '';
      requireImport(path.dirname(candidate) === path.join(server, '.private/driver-audits') && digest(path.basename(candidate))
        && args[1] === path.join(candidate, 'sync.json') && (!syncRoot || syncRoot === candidate), 'The managed sync root differs');
      syncRoot = candidate;
      await privateDirectory(syncRoot);
      const config = JSON.parse(await read(args[1], 1024 * 1024));
      requireImport(config.version === 1 && config.root === syncRoot && config.codeRoot === path.join(syncRoot, 'builder')
        && config.baselineRoot === path.join(syncRoot, 'baseline')
        && config.rendererBuild?.path === path.join(syncRoot, 'baseline/build.private.json')
        && config.journals?.path === path.join(syncRoot, 'validation-journals.private.json'), 'The managed sync configuration differs');
      const [authority, stage, capacity] = await Promise.all([
        db.collection('driverAuditNativeControl').findOne({ _id: 'authority' }),
        db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }),
        db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' }),
      ]);
      requireImport(!authority || authority.status === 'staging', 'Native import requires inactive authority');
      requireImport(!stage, 'An unresolved direct publication blocks native import');
      requireImport(!capacity || capacity.limitBytes === NATIVE_IMPORT_CAPACITY_BYTES
        && integer(capacity.usedBytes) && capacity.usedBytes <= capacity.limitBytes, 'The explicit native storage allowance differs');
      return authority;
    };
    phase = 'writers'; await stopped();
    if (operation === 'diagnose-roots') {
      phase = 'root-diagnostics';
      const result = await diagnoseRoots({ db, syncRoot, read, privateDirectory, load, recipientPublicKey, diagnosticPage });
      await stopped(); await checkout();
      return { version: 1, sessionId, applicationCommit: expectedSha, ...result };
    }
    if (operation === 'stage-source') {
      phase = 'source-staging';
      const result = await stageSource({ folder, received, bundleSha256: templateSha256, syncRoot, server,
        db, client: connection.getClient(), read, privateDirectory, load, execute,
        pins: adapters.sourcePins || { manifest: NATIVE_IMPORT_SOURCE_MANIFEST, files: 134 } });
      await stopped(); await checkout();
      return { version: 1, sessionId, applicationCommit: expectedSha, ...result };
    }
    if (operation === 'stage-builder') {
      phase = 'builder-staging';
      const result = await stageBuilder({ folder, received, bundleSha256: templateSha256, syncRoot, read, privateDirectory, load,
        pins: adapters.builderPins || { from: NATIVE_BUILDER_FROM, to: NATIVE_BUILDER_TO } });
      await stopped(); await checkout();
      return { version: 1, sessionId, applicationCommit: expectedSha, ...result };
    }
    phase = 'input-files';
    const templateFile = 'profile-template.private.json', names = [templateFile, ...Object.values(NATIVE_IMPORT_FILES)];
    requireImport(Array.isArray(received.inputFiles) && received.inputFiles.length === names.length,
      'The complete fixed-name private import inputs are required');
    const inputs = new Map();
    for (const row of received.inputFiles) {
      requireImport(object(row) && names.includes(row.name) && !inputs.has(row.name) && digest(row.sha256)
        && integer(row.bytes) && row.bytes > 0 && row.bytes <= 64 * 1024 * 1024, 'The private import input inventory differs');
      const bytes = await read(path.join(folder, row.name), row.bytes);
      requireImport(bytes.length === row.bytes && hash(bytes) === row.sha256, 'The received private import input hash or size differs');
      inputs.set(row.name, row);
    }
    requireImport([...inputs.values()].reduce((sum, row) => sum + row.bytes, 0) <= received.bytes,
      'The received private import byte coverage differs');
    const templateBytes = await read(path.join(folder, templateFile), 128 * 1024);
    requireImport(templateSha256 === inputs.get(templateFile)?.sha256 && hash(templateBytes) === templateSha256,
      'The private import template hash differs');
    const template = JSON.parse(templateBytes), fields = Object.keys(NATIVE_IMPORT_FILES);
    requireImport(object(template) && Object.keys(template).every(name => [...fields, 'version', 'capacityBytes', 'receiptInput', 'previousImportSha256'].includes(name))
      && template.version === 2 && template.capacityBytes === NATIVE_IMPORT_CAPACITY_BYTES
      && ['full', 'selected'].includes(template.receiptInput)
      && (template.previousImportSha256 === undefined || digest(template.previousImportSha256)), 'The host-neutral private import template differs');
    const refs = {};
    for (const [name, file] of Object.entries(NATIVE_IMPORT_FILES)) {
      const ref = template[name];
      requireImport(object(ref) && Object.keys(ref).sort().join(',') === 'file,sha256' && ref.file === file
        && digest(ref.sha256) && ref.sha256 === inputs.get(file)?.sha256, 'A fixed-name private import reference differs');
      refs[name] = { file, sha256: ref.sha256 };
    }
    phase = 'source-runtime';
    const sourceRoot = path.join(server, '.private/driver-audit-source', NATIVE_IMPORT_SOURCE_MANIFEST);
    await privateDirectory(sourceRoot);
    const source = JSON.parse(await read(path.join(sourceRoot, 'source.json'), 1024 * 1024));
    requireImport(source.version === 1 && source.root === sourceRoot && source.manifestSha256 === NATIVE_IMPORT_SOURCE_MANIFEST
      && source.runtimeRoot === path.join(sourceRoot, 'runtime'), 'The staged pinned source runtime differs');
    await verifyDriverAuditSource({ runtimeRoot: source.runtimeRoot, expectedSha256: NATIVE_IMPORT_SOURCE_MANIFEST });
    const { readDriverAuditImportRows, collectDriverAuditReceiptRoots } = await load('services/driverAuditLiveImport.js');
    const census = async () => {
      const documents = await Array.fromAsync(readDriverAuditImportRows(folder, refs.documents));
      const value = await collectDriverAuditReceiptRoots({ db, documents, syncRoot });
      requireImport(digest(value.sha256), 'The actual retained collector census is unavailable'); return value.sha256;
    };
    phase = 'collector-census'; const collectorRootsSha256 = await census();
    const profile = { version: 2, targetDatabase: db.databaseName, capacityBytes: NATIVE_IMPORT_CAPACITY_BYTES,
      ...(template.previousImportSha256 ? { previousImportSha256: template.previousImportSha256 } : {}),
      syncRoot, collectorRootsSha256, receiptInput: template.receiptInput, ...refs,
      runtimeRoot: source.runtimeRoot, runtimeSha256: NATIVE_IMPORT_SOURCE_MANIFEST };
    const profileBytes = Buffer.from(JSON.stringify(profile, null, 2) + '\n'), actualProfileSha = hash(profileBytes);
    phase = 'profile';
    requireImport(profileSha256 === undefined || actualProfileSha === profileSha256, 'The exact import profile or collector roots differ');
    const profileFile = path.join(folder, 'profile.private.json');
    const safety = async () => {
      await checkout(); const authority = await stopped();
      requireImport(!authority ? !profile.previousImportSha256 : authority.importSha256 === actualProfileSha
        || authority.importSha256 === profile.previousImportSha256, 'The staged previous import identity differs');
      requireImport(await census() === collectorRootsSha256, 'The actual retained collector roots changed');
    };
    await safety();
    if (operation === 'create-profile') await saveProfile(profileFile, profileBytes, read);
    requireImport(hash(await read(profileFile, 1024 * 1024)) === actualProfileSha, 'The pinned import profile or collector roots differ');
    const output = { version: 1, sessionId, applicationCommit: expectedSha, templateSha256, profileSha256: actualProfileSha,
      collectorRootsSha256, capacityBytes: NATIVE_IMPORT_CAPACITY_BYTES, activationPending: true };
    if (operation === 'create-profile') return { ...output, status: 'profile-created' };
    phase = operation;
    const cliOperation = { 'plan-import': 'plan', 'stage-import': 'stage', 'verify-import': 'verify' }[operation];
    const result = await execute(process.execPath, [path.join(server, 'scripts/driverAuditMongoMigrate.js'), cliOperation,
      profileFile, actualProfileSha], { cwd: server, env, timeout: 55 * 60 * 1000, maxBuffer: 256 * 1024 });
    const receipt = JSON.parse(result.stdout);
    requireImport(receipt.status === { plan: 'planned', stage: 'staged', verify: 'staged-data-verified' }[cliOperation]
      && receipt.importSha256 === actualProfileSha
      && (receipt.collectorRootsSha256 === undefined || receipt.collectorRootsSha256 === collectorRootsSha256)
      && (cliOperation === 'plan' || receipt.activationPending === true), 'The native migration CLI receipt differs');
    await safety();
    const counts = {};
    for (const name of ['objects', 'missingObjects', 'missingBytes', 'availableAllowanceBytes', 'archiveObjects']) {
      if (integer(receipt[name])) counts[name] = receipt[name];
    }
    for (const [name, count] of Object.entries({ documents: receipt.documents?.documents ?? receipt.documents,
      receipts: receipt.receipts?.receipts ?? receipt.receipts, historical: receipt.historical?.records ?? receipt.historical })) {
      if (integer(count)) counts[name] = count;
    }
    return { ...output, status: receipt.status, counts,
      ...(cliOperation === 'verify' ? { archiveClosurePending: true, resultsEqual: receipt.resultsEqual === true,
        reportIdentityEqual: receipt.reportIdentityEqual === true, assessmentHistoryEqual: receipt.assessmentHistoryEqual === true } : {}) };
  } catch (error) {
    throw Object.assign(Error(error.importGuard ? error.message : 'Native import stopped at ' + phase), { phase });
  } finally {
    let cleanupFailed = false;
    try { await connection?.close(); } catch { cleanupFailed = true; }
    try { await lock?.release(); } catch { cleanupFailed = true; }
    if (cleanupFailed) throw Object.assign(Error('Native import cleanup stopped'), { phase: 'cleanup' });
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runDriverAuditNativeImport({ operation: process.env.NATIVE_HANDOFF_OPERATION,
      sessionId: process.env.NATIVE_TRANSFER_SESSION_ID, templateSha256: process.env.NATIVE_IMPORT_TEMPLATE_SHA256,
      profileSha256: process.env.NATIVE_IMPORT_PROFILE_SHA256 || undefined,
      expectedSha: process.env.EXPECTED_DEPLOYED_SHA, appRoot: await fs.realpath(process.cwd()) })));
  } catch (error) {
    console.error('Native import stopped at ' + (error.phase || 'checkout') + '. Check the reviewed inputs and stopped report workers.');
    process.exitCode = 1;
  }
}
