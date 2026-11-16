import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } from '../services/driverAuditSource.js';
import { createDriverAuditReceiptSelection, readDriverAuditImportRows } from '../services/driverAuditLiveImport.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Run beside the recovery backup. Only the small compressed selected output
// and its pinned proof need to be transferred to the app host.
async function main() {
  const [file, expected, ...extra] = process.argv.slice(2);
  const bytes = await readPrivateDriverAuditSource(file, 1024 * 1024);
  if (extra.length || hash(bytes) !== expected) throw Error('Selection profile differs');
  const profile = JSON.parse(bytes), root = path.dirname(file);
  const pinned = async reference => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]+\.private\.json$/.test(reference?.file || '')) throw Error('Pinned selection proof required');
    const body = await readPrivateDriverAuditSource(path.join(root, reference.file), 1024 * 1024);
    if (hash(body) !== reference.sha256) throw Error('Selection proof differs');
    return JSON.parse(body);
  };
  const backup = await pinned(profile.bookkeepingBackup), census = await pinned(profile.collectorRoots);
  if (profile.version !== 1 || !/^[a-f0-9]{64}$/.test(census.collectorRootsSha256 || '')) throw Error('Pinned collector census required');
  const selection = createDriverAuditReceiptSelection({ backup,
    originalReceiptSha256: profile.sourceReceipts.sha256, collectorRevisions: census.collectorRevisions });
  await requirePrivateDriverAuditSourceDirectory(profile.outputDirectory);
  const temporary = path.join(profile.outputDirectory, randomUUID() + '.jsonl.gz');
  const destination = path.join(profile.outputDirectory, 'live-receipts.private.jsonl.gz');
  const seen = new Set();
  let original = 0, live = 0;
  async function* selected() {
    for await (const row of readDriverAuditImportRows(root, profile.sourceReceipts)) {
      original++;
      if (!selection.include(row)) continue;
      if (row.key === 'collector-state') seen.add(row.revision);
      live++;
      yield JSON.stringify(row) + '\n';
    }
    if (original !== backup.receiptCount || census.collectorRevisions.some(revision => !seen.has(revision))) {
      throw Error('Backup count or required collector coverage differs');
    }
  }
  try {
    await pipeline(Readable.from(selected()), createGzip(), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const digest = createHash('sha256');
    for await (const part of createReadStream(temporary)) digest.update(part);
    const liveReceiptSha256 = digest.digest('hex');
    // Link is exclusive and atomic. Existing evidence is never overwritten.
    try { await fs.link(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = createHash('sha256');
      for await (const part of createReadStream(destination)) existing.update(part);
      if (existing.digest('hex') !== liveReceiptSha256) throw Error('Existing selected receipt output differs');
    }
    const proof = { ...backup, liveReceiptSha256, liveReceiptCount: live,
      collectorRootsSha256: census.collectorRootsSha256, collectorRevisions: census.collectorRevisions,
      backupOnlyCount: original - live };
    const proofFile = path.join(profile.outputDirectory, 'live-receipts-proof.private.json');
    const proofBytes = Buffer.from(JSON.stringify(proof, null, 2) + '\n');
    try { await fs.writeFile(proofFile, proofBytes, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !(await readPrivateDriverAuditSource(proofFile)).equals(proofBytes)) throw error;
    }
    console.log(JSON.stringify({ status: 'selected', original, live, backupOnly: original - live,
      file: 'live-receipts.private.jsonl.gz', sha256: liveReceiptSha256 }));
  } finally { await fs.rm(temporary, { force: true }); }
}

main().catch(() => {
  console.error('Receipt selection stopped. Check the pinned backup, complete collector census and private inputs.');
  process.exitCode = 1;
});
