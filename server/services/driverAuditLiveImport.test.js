import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDriverAuditTechnicalKey, createDriverAuditReceiptSelection, collectDriverAuditReceiptRoots } from './driverAuditLiveImport.js';

test('technical history selection requires a pinned complete backup and preserves evidence namespaces', () => {
  const originalReceiptSha256 = 'a'.repeat(64);
  const input = { originalReceiptSha256, collectorRevisions: [10, 7],
    backup: { verified: true, originalsPreserved: true, originalReceiptSha256,
      receiptCount: 100, sourceDumpSha256: 'b'.repeat(64) } };
  assert.throws(() => createDriverAuditReceiptSelection({ ...input, backup: null }), /backup/);
  assert.throws(() => createDriverAuditReceiptSelection({ ...input,
    backup: { ...input.backup, originalReceiptSha256: 'c'.repeat(64) } }), /backup/);
  const selection = createDriverAuditReceiptSelection(input);
  for (const key of ['reader-budget', 'reader-budget-sync-restore-20261113', 'worker-budget',
    'photo-grading-budget', 'preview-acceptance-hosted-20261109:hosted-password-login-throttle',
    'preview-acceptance-hosted-20261109:preview-map-loads:20261106:2026-11']) {
    assert.equal(isDriverAuditTechnicalKey(key), true);
    assert.equal(selection.include({ key, revision: 2 }), false);
  }
  for (const key of ['photo-grade:original', 'photo-visual-audit:original', 'review-journal',
    'preview-gps-map-20261106:review-journal', 'preview-acceptance-hosted-20261109:household-arrangements',
    'maps-configuration', 'private-validation-latest', 'unknown-evidence']) {
    assert.equal(isDriverAuditTechnicalKey(key), false);
    assert.equal(selection.include({ key, revision: 2 }), true);
  }
  assert.equal(selection.include({ key: 'collector-state', revision: 10 }), true);
  assert.equal(selection.include({ key: 'collector-state', revision: 7 }), true);
  assert.equal(selection.include({ key: 'collector-state', revision: 9 }), false);
});

test('receipt roots bind current, previous, bootstrap and retained workspace metadata', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'driver-audit-root-census-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const attempt = path.join(root, 'work/attempts/00000000-0000-4000-8000-000000000001');
  await fs.mkdir(attempt, { recursive: true, mode: 0o700 });
  const write = (name, value) => fs.writeFile(name, JSON.stringify(value), { mode: 0o600 });
  await write(path.join(root, 'sync.json'), { version: 1, root,
    baselineRoot: path.join(root, 'baseline'), codeRoot: path.join(root, 'builder'),
    rendererBuild: { path: path.join(root, 'baseline/build.private.json') },
    journals: { path: path.join(root, 'validation-journals.private.json') } });
  await write(path.join(root, 'seed.json'), { collectorRevision: 2 });
  await write(path.join(root, 'work/current.private.json'), { collectorRevision: 9, previous: { collectorRevision: 8 } });
  const accepted = { collectorRevision: 5, manifestSha256: 'a'.repeat(64), sourceBasis: 'b'.repeat(64) };
  await write(path.join(attempt, 'accepted.private.json'), accepted);
  await write(path.join(attempt, 'direct-seed.private.json'), accepted);
  let stage = null;
  const head = { sourceRevision: 9, directImport: { collectorRevision: 9 },
    previous: { sourceRevision: 8, directImport: { collectorRevision: 8 } } };
  const db = { collection: () => ({ findOne: async query => query._id === 'head' ? { head } : stage }) };
  const input = { db, syncRoot: root, documents: [{ key: 'collector-state', revision: 10, body_text: '{}' }] };
  const first = await collectDriverAuditReceiptRoots(input);
  assert.deepEqual(first.collectorRevisions, [2, 5, 8, 9, 10]);
  await write(path.join(attempt, 'accepted.private.json'), { ...accepted, collectorRevision: 4 });
  await assert.rejects(collectDriverAuditReceiptRoots(input), /workspace.*differ/);
  await write(path.join(attempt, 'direct-seed.private.json'), { ...accepted, collectorRevision: 4 });
  assert.notEqual((await collectDriverAuditReceiptRoots(input)).sha256, first.sha256);
  stage = { pointer: { sourceRevision: 10 } };
  await assert.rejects(collectDriverAuditReceiptRoots(input), /staged report/);
  stage = { pointer: null };
  await assert.rejects(collectDriverAuditReceiptRoots(input), /staged report/);
});
