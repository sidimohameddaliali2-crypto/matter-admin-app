import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);
test('backup-side export transfers only protected receipts and required recovery roots, safely retrying', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'driver-select-receipts-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, 'selected');
  await fs.mkdir(outputDirectory, { mode: 0o700 });
  const pinned = async (file, value, jsonl = false) => {
    const bytes = Buffer.from(jsonl ? value.map(row => JSON.stringify(row) + '\n').join('') : JSON.stringify(value));
    await fs.writeFile(path.join(root, file), bytes, { mode: 0o600 });
    return { file, sha256: sha(bytes) };
  };
  const original = [{ key: 'reader-budget', revision: 1 }, { key: 'collector-state', revision: 1 },
    { key: 'collector-state', revision: 2 }, { key: 'review-journal', revision: 5 },
    { key: 'photo-grade:original', revision: 1 }, { key: 'future-evidence', revision: 1 }];
  const sourceReceipts = await pinned('original.private.jsonl', original, true);
  const bookkeepingBackup = await pinned('backup.private.json', { verified: true, originalsPreserved: true,
    originalReceiptSha256: sourceReceipts.sha256, receiptCount: original.length, sourceDumpSha256: sha('dump') });
  const collectorRoots = await pinned('roots.private.json', { collectorRootsSha256: sha('roots'), collectorRevisions: [2] });
  const profile = await pinned('profile.private.json', { version: 1, sourceReceipts, bookkeepingBackup, collectorRoots, outputDirectory });
  const command = () => run(process.execPath, [new URL('../scripts/driverAuditSelectReceipts.js', import.meta.url).pathname,
    path.join(root, profile.file), profile.sha256]);
  assert.equal(JSON.parse((await command()).stdout).live, 4);
  const resultFile = path.join(outputDirectory, 'live-receipts.private.jsonl.gz');
  const result = await fs.readFile(resultFile);
  const actual = gunzipSync(result).toString().trim().split('\n').map(JSON.parse);
  assert.deepEqual(actual, original.slice(2));
  const proof = JSON.parse(await fs.readFile(path.join(outputDirectory, 'live-receipts-proof.private.json')));
  assert.equal(proof.liveReceiptSha256, sha(result));
  assert.equal(proof.backupOnlyCount, 2);
  assert.equal(JSON.parse((await command()).stdout).live, 4);
  assert.deepEqual(await fs.readFile(resultFile), result);
  await fs.writeFile(resultFile, 'conflicting existing data', { mode: 0o600 });
  await assert.rejects(command());
  assert.equal(await fs.readFile(resultFile, 'utf8'), 'conflicting existing data');
});
