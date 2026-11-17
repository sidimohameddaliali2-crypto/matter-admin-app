import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from './driverAuditSource.js';
import { DRIVER_AUDIT_HISTORICAL_SOURCE_FILE, originalDriverAuditReceiptSha256,
  validateDriverAuditHistoricalSourceProof } from './driverAuditOriginalSourceLineage.js';

const hashPattern = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function* readDriverAuditImportRows(root, reference) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]+\.jsonl(?:\.gz)?$/.test(reference?.file || '')
      || !hashPattern.test(reference.sha256 || '')) throw Error('A pinned private import file is required');
  const filename = path.join(root, reference.file), info = await fs.lstat(filename);
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077
      || await fs.realpath(filename) !== filename) throw Error('The import input must be owner-private');
  const digest = createHash('sha256');
  for await (const part of createReadStream(filename)) digest.update(part);
  if (digest.digest('hex') !== reference.sha256) throw Error('The original import file hash differs');
  const input = reference.file.endsWith('.gz') ? createReadStream(filename).pipe(createGunzip()) : createReadStream(filename);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 66 * 1024 * 1024) throw Error('The original import record exceeds its limit');
    if (line) yield JSON.parse(line);
  }
}
const technicalNames = new Set([
  'reader-budget', 'reader-budget-reserve', 'reader-budget-approved-20261106',
  'reader-budget-release-20261112', 'reader-budget-sync-20261112',
  'reader-budget-recovery-20261112', 'reader-budget-overnight-20261113',
  'reader-budget-sync-restore-20261113', 'reader-budget-arrival-20261113',
  'worker-budget', 'worker-budget-overnight-20261113', 'photo-grading-budget',
  'hosted-password-login-throttle',
]);

// Unknown keys stay protected. Acceptance-named namespaces contain genuine
// review and household history, so a namespace is never a technical category.
export function isDriverAuditTechnicalKey(key) {
  if (typeof key !== 'string') return false;
  return technicalNames.has(key.split(':').at(-1))
    || /^(?:native-progress:delivery|native-progress:gps:[a-zA-Z0-9_-]{1,60})$/.test(key)
    || /(?:^|:)preview-map-loads:\d{8}:\d{4}-(?:0[1-9]|1[0-2])$/.test(key)
    || /(?:^|:)road-display-requests:\d{4}-(?:0[1-9]|1[0-2])$/.test(key);
}

export function createDriverAuditReceiptSelection({ backup, originalReceiptSha256, collectorRevisions, receiptBindings = [] }) {
  if (!hashPattern.test(originalReceiptSha256 || '') || backup?.verified !== true
      || backup.originalsPreserved !== true || backup.originalReceiptSha256 !== originalReceiptSha256
      || !hashPattern.test(backup.sourceDumpSha256 || '')
      || !Number.isSafeInteger(backup.receiptCount) || backup.receiptCount < 1) {
    throw Error('A pinned verified original bookkeeping backup is required');
  }
  if (!Array.isArray(receiptBindings) || receiptBindings.length > 8 || receiptBindings.some(row => row?.key !== 'collector-state'
      || !collectorRevisions.includes(row.revision) || !hashPattern.test(row.receiptSha256 || ''))
      || new Set(receiptBindings.map(row => row.revision)).size !== receiptBindings.length) {
    throw Error('Original historical source receipt bindings differ');
  }
  const bindings = new Map(receiptBindings.map(row => [row.revision, row.receiptSha256]));
  if (!Array.isArray(collectorRevisions) || !collectorRevisions.length || collectorRevisions.length > 4096
      || collectorRevisions.some(revision => !Number.isSafeInteger(revision) || revision < 1)) {
    throw Error('The required original collector revisions must be pinned');
  }
  const required = new Set(collectorRevisions);
  return { include(row) {
    if (typeof row?.key !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw Error('Invalid original receipt identity');
    }
    if (isDriverAuditTechnicalKey(row.key)) return false;
    if (row.key === 'collector-state' && bindings.has(row.revision)
        && originalDriverAuditReceiptSha256(row) !== bindings.get(row.revision)) {
      throw Error('The selected historical source receipt differs from its original proof');
    }
    return row.key !== 'collector-state' || required.has(row.revision);
  } };
}

// Only bounded control metadata is read here. Current evidence and archived
// reports are preserved independently; their rows are never a selection filter.
export async function collectDriverAuditReceiptRoots({ db, documents, syncRoot }) {
  const source = documents.find(row => row.key === 'collector-state');
  if (!Number.isSafeInteger(source?.revision) || source.revision < 1 || typeof source.body_text !== 'string') {
    throw Error('Original collector head is required');
  }
  const revisions = new Set([source.revision]);
  const roots = [{ kind: 'source-current', revision: source.revision, sha256: hash(source.body_text) }];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const requireRoot = (condition, message = 'Retained workspace collector roots differ') => {
    if (!condition) throw Error(message);
  };
  function add(kind, value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > source.revision) throw Error('Collector root needs a fresh source snapshot');
    revisions.add(value);
    roots.push({ kind, revision: value });
  }
  const sourceIdentities = new Map();
  const receiptBindings = [];
  function identity(value, revision = value?.collectorRevision) {
    requireRoot(object(value) && hashPattern.test(value.manifestSha256 || '')
      && hashPattern.test(value.sourceBasis || ''), 'Invalid retained collector identity');
    return { revision, manifestSha256: value.manifestSha256, sourceBasis: value.sourceBasis };
  }
  function retain(kind, value) {
    add(kind, value.revision);
    const prior = sourceIdentities.get(value.revision);
    requireRoot(!prior || prior === value.sourceBasis, 'Collector source identities differ');
    sourceIdentities.set(value.revision, value.sourceBasis);
  }
  const current = await db.collection('driverAuditControl').findOne({ _id: 'head' });
  const currentHash = hash(JSON.stringify(current));
  const stage = await db.collection('driverAuditControl').findOne({ _id: 'direct-stage' });
  const requireNoStage = value => requireRoot(!value,
    'An unresolved staged report must be drained before selecting receipt roots');
  requireNoStage(stage);
  for (const [kind, head] of [['mongo-current', current?.head], ['mongo-previous', current?.head?.previous]]) {
    if (!head) continue;
    requireRoot(head.version === 1 && head.directImport?.version === 1
      && head.sourceRevision === head.directImport.collectorRevision, 'Serving collector roots differ');
    retain(kind, identity(head.directImport, head.sourceRevision));
    roots.push({ kind: kind + '-pointer', sha256: hash(JSON.stringify(head)) });
  }
  async function checkServing() {
    const after = await db.collection('driverAuditControl').findOne({ _id: 'head' });
    requireNoStage(await db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }));
    requireRoot(hash(JSON.stringify(after)) === currentHash, 'Serving roots changed during the census');
  }
  if (current?.head && !syncRoot) throw Error('The managed sync root is required for retained collector receipts');
  if (syncRoot) {
    await requirePrivateDriverAuditSourceDirectory(syncRoot);
    const signatures = new Map();
    async function bytes(relative, optional) {
      // Package inventories use the same bounded contract as qualification;
      // small control receipts keep their separate one MiB limit.
      const maxBytes = path.basename(relative) === 'files.private.json' || relative === DRIVER_AUDIT_HISTORICAL_SOURCE_FILE
        ? 16 * 1024 * 1024 : 1024 * 1024;
      try { return await readPrivateDriverAuditSource(path.join(syncRoot, relative), maxBytes); }
      catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    }
    async function metadata(relative, optional = false) {
      const body = await bytes(relative, optional), sha256 = body && hash(body);
      signatures.set(relative, sha256);
      if (!body) return null;
      roots.push({ kind: relative, sha256 });
      const value = JSON.parse(body);
      requireRoot(object(value), 'Invalid collector root metadata');
      return value;
    }
    const config = await metadata('sync.json');
    if (config.version !== 1 || config.root !== syncRoot || config.baselineRoot !== path.join(syncRoot, 'baseline')
        || config.codeRoot !== path.join(syncRoot, 'builder')
        || config.rendererBuild?.path !== path.join(syncRoot, 'baseline/build.private.json')
        || config.journals?.path !== path.join(syncRoot, 'validation-journals.private.json')) {
      throw Error('Managed sync configuration differs from the collector root census');
    }
    const attemptPattern = /^work\/attempts\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    function workspace(value, baseline = false) {
      if (baseline && value === config.baselineRoot) return 'baseline';
      requireRoot(typeof value === 'string' && path.isAbsolute(value), 'Invalid managed collector workspace path');
      const relative = path.relative(syncRoot, value);
      requireRoot(value === path.join(syncRoot, relative) && path.basename(value) === 'server-data'
        && attemptPattern.test(path.dirname(relative)), 'Invalid managed collector workspace path');
      return relative;
    }
    async function manifest(relative, expected, allowMissing = false) {
      const value = await metadata(relative, true);
      requireRoot(value ? signatures.get(relative) === expected && Object.keys(value).length > 0
        && Object.entries(value).every(([name, digest]) => name.length <= 512
          && name.split('/').every(component => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(component))
          && hashPattern.test(digest)) : allowMissing, 'Retained workspace manifest is missing or differs');
    }
    async function seedMetadata(relative, mode, bundleRoot) {
      const value = await metadata(relative, true);
      if (!value) return null;
      // Use the same complete seed schema as direct import; this reads no
      // evidence bytes and never stages or activates a package.
      const { readDriverAuditSeedConfig } = await import('./driverAuditDirectImport.js');
      const checked = await readDriverAuditSeedConfig(path.join(syncRoot, relative));
      requireRoot(isDeepStrictEqual(value, checked) && value.mode === mode && value.bundleRoot === bundleRoot);
      return value;
    }
    const seed = await seedMetadata('seed.json', 'bootstrap', path.join(syncRoot, 'objects'));
    requireRoot(seed, 'Original bootstrap collector identity is unavailable');
    const bootstrap = identity(seed);
    retain('bootstrap', bootstrap);
    await manifest('baseline/files.private.json', bootstrap.manifestSha256);
    const pointer = await metadata('work/current.private.json', true);
    const historicalProof = await metadata(DRIVER_AUDIT_HISTORICAL_SOURCE_FILE, true);
    const historical = historicalProof ? await validateDriverAuditHistoricalSourceProof({ proof: historicalProof, config }) : null;
    const historicalEntries = historical?.entries || [];
    const historicalByOwner = new Map(historicalEntries.map(entry => [entry.owner.relative, entry]));
    const usedHistorical = new Set(), absentHistorical = new Set();
    if (historicalProof) {
      const basisModule = path.relative(syncRoot, historical.basisModuleFile), body = await bytes(basisModule);
      requireRoot(hash(body) === historicalProof.sourceBasisModuleSha256, 'Original source basis module changed');
      signatures.set(basisModule, hash(body));
      roots.push({ kind: 'historical-source-basis-module', sha256: hash(body) });
      if (historical.canonicalBuilderAbsent) absentHistorical.add('builder');
    }
    const attempts = path.join(syncRoot, 'work/attempts');
    async function directories() {
      const info = await fs.lstat(attempts).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) return [];
      await requirePrivateDriverAuditSourceDirectory(attempts);
      const entries = await fs.readdir(attempts, { withFileTypes: true });
      requireRoot(entries.length <= 16384, 'Retained collector root census exceeds its bound');
      const names = [];
      for (const entry of entries) {
        if (!attemptPattern.test('work/attempts/' + entry.name)) continue;
        requireRoot(entry.isDirectory(), 'Retained collector workspace must be a real directory');
        await requirePrivateDriverAuditSourceDirectory(path.join(attempts, entry.name));
        names.push(entry.name);
      }
      return names.sort();
    }
    const names = await directories(), retained = new Map();
    for (const name of names) {
      const prefix = 'work/attempts/' + name + '/';
      const accepted = await metadata(prefix + 'accepted.private.json', true);
      const candidate = await seedMetadata(prefix + 'direct-seed.private.json', 'sync', path.join(syncRoot, prefix, 'audit-objects'));
      const retired = await metadata(prefix + 'retired-workspace.private.json', true);
      const identities = [];
      if (accepted) {
        requireRoot(accepted.version === 1 && hashPattern.test(accepted.basis || '')
          && Number.isFinite(Date.parse(accepted.verifiedAt)) && workspace(accepted.privateRoot) === prefix + 'server-data',
        'Invalid accepted collector workspace');
        workspace(accepted.baselineRoot, true);
        requireRoot(accepted.previous === null ? accepted.baselineRoot === config.baselineRoot
          : object(accepted.previous) && accepted.previous.privateRoot === accepted.baselineRoot);
        identities.push(identity(accepted));
        retain(prefix + 'accepted', identities.at(-1));
      }
      if (candidate) { identities.push(identity(candidate)); retain(prefix + 'seed', identities.at(-1)); }
      if (retired) {
        requireRoot(retired.version === 1 && ['prepared', 'retired'].includes(retired.status) && object(retired.source)
          && ['stateSha256', 'browserSha256', 'reviewsSha256'].every(key => hashPattern.test(retired.source[key] || ''))
          && Array.isArray(retired.source.gpsStateSha256) && retired.source.gpsStateSha256.every(value => hashPattern.test(value))
          && retired.inventoryFile === 'retired-workspace-inventory.private.json.gz'
          && hashPattern.test(retired.inventorySha256 || '') && hashPattern.test(retired.inventoryCompressedSha256 || '')
          && Number.isFinite(Date.parse(retired.verifiedAt)),
          'Invalid retired collector workspace');
        identities.push(identity(retired, retired.source.revision));
        retain(prefix + 'retired', identities.at(-1));
      }
      if (!identities.length) continue;
      requireRoot(identities.every(value => isDeepStrictEqual(value, identities[0])));
      await manifest(prefix + 'server-data/files.private.json', identities[0].manifestSha256, Boolean(retired));
      retained.set(path.join(syncRoot, prefix, 'server-data'), { accepted, identity: identities[0], relative: prefix + 'accepted.private.json' });
    }
    function resolve(reference) {
      requireRoot(object(reference) && hashPattern.test(reference.basis || '')
        && hashPattern.test(reference.manifestSha256 || ''), 'Invalid previous collector reference');
      workspace(reference.privateRoot, true);
      const record = reference.privateRoot === config.baselineRoot ? { identity: bootstrap } : retained.get(reference.privateRoot);
      requireRoot(record, 'Original collector workspace identity is unresolved');
      const value = record.identity;
      requireRoot(reference.manifestSha256 === value.manifestSha256
        && reference.basis === (record.accepted?.basis || value.sourceBasis)
        && (reference.collectorRevision === undefined || reference.collectorRevision === value.revision)
        && (reference.sourceBasis === undefined || reference.sourceBasis === value.sourceBasis));
      return value;
    }
    async function assertAbsent(relative) {
      const info = await fs.lstat(path.join(syncRoot, relative)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      requireRoot(!info, 'The historical missing workspace reappeared');
    }
    async function historicalSource(record) {
      const entry = historicalByOwner.get(record.relative), reference = record.accepted.previous;
      requireRoot(entry && signatures.get(record.relative) === entry.owner.sha256
        && record.identity.revision === entry.owner.collectorRevision && isDeepStrictEqual(reference, entry.reference),
      'Original collector workspace identity is unresolved');
      const relative = workspace(reference.privateRoot), parent = path.dirname(relative);
      requireRoot(reference.privateRoot !== pointer?.privateRoot && reference.privateRoot !== pointer?.previous?.privateRoot
        && ![current?.head, current?.head?.previous].filter(Boolean).some(head => head.sourceRevision === entry.receipt.revision
          || head.directImport?.sourceBasis === reference.basis || head.directImport?.manifestSha256 === reference.manifestSha256),
      'A historical source proof cannot replace an operational report workspace');
      await assertAbsent(parent); await assertAbsent(relative);
      absentHistorical.add(parent); absentHistorical.add(relative); usedHistorical.add(record.relative);
      const value = { revision: entry.receipt.revision, sourceBasis: reference.basis };
      retain('historical-original-source-receipt', value);
      receiptBindings.push({ key: 'collector-state', revision: value.revision, receiptSha256: entry.receiptSha256 });
      roots.push({ kind: entry.gap.kind, owner: record.relative, ownerSha256: entry.owner.sha256,
        sourceRevision: value.revision, sourceBodySha256: entry.receipt.body_sha256, originalReceiptSha256: entry.receiptSha256,
        sourceBasis: reference.basis, expectedRenderedManifestSha256: reference.manifestSha256,
        workspacePresent: false, renderedManifestAvailable: false });
      return value;
    }
    for (const record of retained.values()) {
      if (!record.accepted?.previous) continue;
      const reference = record.accepted.previous;
      const previous = reference.privateRoot === config.baselineRoot || retained.has(reference.privateRoot)
        ? resolve(reference) : await historicalSource(record);
      requireRoot(previous.revision < record.identity.revision, 'Retained collector lineage identities differ');
    }
    requireRoot(usedHistorical.size === historicalEntries.length, 'An unused historical source proof is not trusted');
    if (pointer) {
      workspace(pointer.privateRoot);
      const record = retained.get(pointer.privateRoot);
      requireRoot(record?.accepted && isDeepStrictEqual(pointer, record.accepted), 'Current and accepted collector roots differ');
      retain('sync-current', record.identity);
      if (pointer.previous) retain('sync-previous', resolve(pointer.previous));
    }
    // A local accepted candidate can precede bundle preparation/publication.
    // Protect it alongside both Mongo serving roots, without rewriting either.
    await checkServing();
    for (const relative of absentHistorical) await assertAbsent(relative);
    requireRoot(isDeepStrictEqual(names, await directories()), 'Workspace roots changed during the census');
    for (const [relative, expected] of signatures) {
      const body = await bytes(relative, true);
      requireRoot((body && hash(body)) === expected, 'Workspace metadata changed during the census');
    }
  } else await checkServing();
  requireRoot(revisions.size <= 4096, 'Required collector roots exceed their bound');
  const census = { collectorRevisions: [...revisions].sort((a, b) => a - b), roots,
    ...(receiptBindings.length ? { receiptBindings: receiptBindings.sort((a, b) => a.revision - b.revision) } : {}) };
  return { ...census, sha256: hash(JSON.stringify(census)) };
}
