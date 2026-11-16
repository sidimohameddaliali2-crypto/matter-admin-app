import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from './driverAuditSource.js';

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
    || /(?:^|:)preview-map-loads:\d{8}:\d{4}-(?:0[1-9]|1[0-2])$/.test(key)
    || /(?:^|:)road-display-requests:\d{4}-(?:0[1-9]|1[0-2])$/.test(key);
}

export function createDriverAuditReceiptSelection({ backup, originalReceiptSha256, collectorRevisions }) {
  if (!hashPattern.test(originalReceiptSha256 || '') || backup?.verified !== true
      || backup.originalsPreserved !== true || backup.originalReceiptSha256 !== originalReceiptSha256
      || !hashPattern.test(backup.sourceDumpSha256 || '')
      || !Number.isSafeInteger(backup.receiptCount) || backup.receiptCount < 1) {
    throw Error('A pinned verified original bookkeeping backup is required');
  }
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
    return row.key !== 'collector-state' || required.has(row.revision);
  } };
}

// Only bounded control metadata is read here. Current evidence and archived
// reports are preserved independently; their rows are never a selection filter.
export async function collectDriverAuditReceiptRoots({ db, documents, syncRoot }) {
  const source = documents.find(row => row.key === 'collector-state');
  if (!Number.isSafeInteger(source?.revision) || source.revision < 1) throw Error('Original collector head is required');
  const revisions = new Set([source.revision]);
  const roots = [{ kind: 'source-current', revision: source.revision, sha256: hash(source.body_text) }];
  function add(kind, value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > source.revision) throw Error('Collector root needs a fresh source snapshot');
    revisions.add(value);
    roots.push({ kind, revision: value });
  }
  const current = await db.collection('driverAuditControl').findOne({ _id: 'head' });
  const stage = await db.collection('driverAuditControl').findOne({ _id: 'direct-stage' });
  if (stage) {
    throw Error('An unresolved staged report must be drained before selecting receipt roots');
  }
  for (const [kind, head] of [['mongo-current', current?.head], ['mongo-previous', current?.head?.previous]]) {
    if (!head) continue;
    if (head.sourceRevision !== head.directImport?.collectorRevision) throw Error('Serving collector roots differ');
    add(kind, head.sourceRevision);
    roots.push({ kind: kind + '-pointer', sha256: hash(JSON.stringify(head)) });
  }
  if (current?.head && !syncRoot) throw Error('The managed sync root is required for retained collector receipts');
  if (syncRoot) {
    await requirePrivateDriverAuditSourceDirectory(syncRoot);
    async function metadata(relative, optional = false) {
      let bytes;
      try { bytes = await readPrivateDriverAuditSource(path.join(syncRoot, relative), 1024 * 1024); }
      catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
      roots.push({ kind: relative, sha256: hash(bytes) });
      return JSON.parse(bytes);
    }
    const config = await metadata('sync.json');
    if (config.version !== 1 || config.root !== syncRoot || config.baselineRoot !== path.join(syncRoot, 'baseline')
        || config.codeRoot !== path.join(syncRoot, 'builder')
        || config.rendererBuild?.path !== path.join(syncRoot, 'baseline/build.private.json')
        || config.journals?.path !== path.join(syncRoot, 'validation-journals.private.json')) {
      throw Error('Managed sync configuration differs from the collector root census');
    }
    const seed = await metadata('seed.json');
    add('bootstrap', seed.collectorRevision);
    const pointer = await metadata('work/current.private.json', true);
    if (pointer) {
      if (current?.head && (pointer.collectorRevision !== current.head.sourceRevision
          || pointer.manifestSha256 !== current.head.directImport?.manifestSha256
          || pointer.previous?.collectorRevision !== current.head.previous?.sourceRevision)) {
        throw Error('Serving and retained workspace collector roots differ');
      }
      add('sync-current', pointer.collectorRevision);
      if (pointer.previous) add('sync-previous', pointer.previous.collectorRevision);
    }
    const attempts = path.join(syncRoot, 'work/attempts');
    const info = await fs.lstat(attempts).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o022
        || await fs.realpath(attempts) !== attempts)) throw Error('Retained collector directory is unsafe');
    const entries = await fs.readdir(attempts, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (entries.length > 16384) throw Error('Retained collector root census exceeds its bound');
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.name)) continue;
      if (!entry.isDirectory()) throw Error('Retained collector workspace must be a real directory');
      const prefix = 'work/attempts/' + entry.name + '/';
      const accepted = await metadata(prefix + 'accepted.private.json', true);
      const candidate = await metadata(prefix + 'direct-seed.private.json', true);
      if (accepted && (!candidate || accepted.collectorRevision !== candidate.collectorRevision
          || accepted.sourceBasis !== candidate.sourceBasis || accepted.manifestSha256 !== candidate.manifestSha256)) {
        throw Error('Retained workspace collector roots differ');
      }
      if (candidate) add(prefix + 'seed', candidate.collectorRevision);
      const retired = await metadata(prefix + 'retired-workspace.private.json', true);
      if (retired) {
        add(prefix + 'retired', retired.source?.revision);
        if (candidate && retired.source.revision !== candidate.collectorRevision) throw Error('Retired workspace roots differ');
      }
    }
  }
  const census = { collectorRevisions: [...revisions].sort((a, b) => a - b), roots };
  return { ...census, sha256: hash(JSON.stringify(census)) };
}
