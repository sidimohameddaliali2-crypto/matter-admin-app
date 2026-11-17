import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDriverAuditTechnicalKey, createDriverAuditReceiptSelection, collectDriverAuditReceiptRoots } from './driverAuditLiveImport.js';
import { DRIVER_AUDIT_HISTORICAL_SOURCE_FILE, DRIVER_AUDIT_ORIGINAL_BASIS_MODULE_SHA256,
  originalDriverAuditReceiptSha256, originalDriverAuditSourceBasis } from './driverAuditOriginalSourceLineage.js';

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

const digest = text => createHash('sha256').update(text).digest('hex');
const sourceBasis = revision => digest('fictional source ' + revision);

async function censusFixture(t, { manifest = { 'fixture.private.json': digest('fictional file') } } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'driver-audit-root-census-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, value) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  };
  const manifestSha256 = digest(JSON.stringify(manifest));
  const seed = (revision, mode, bundleRoot) => {
    const generation = digest('fictional generation ' + revision), reportHash = digest('fictional report ' + revision);
    const descriptorSha256 = digest('fictional descriptor ' + revision);
    const binding = { version: 1, manifestSha256, generation, reportHash, descriptorSha256 };
    return { version: 1, mode, bundleRoot, collectorRevision: revision, manifestSha256,
      sourceBasis: sourceBasis(revision), visibleCutoffAt: null,
      pointer: { version: 1, generation, reportHash, descriptor: { version: 1, domain: 'previewPackage',
        path: 'descriptor.json', kind: 'immutable-evidence', size: 1, sha256: descriptorSha256,
        chunks: [{ offset: 0, size: 1, sha256: descriptorSha256 }] } },
      closureReceipt: { ...binding, status: 'verified', sourceBasis: sourceBasis(revision),
        checkedAt: '2026-01-01T00:00:00Z', checks: { archive: true, photos: true, reviewHistory: true } },
      restore: { ...binding, archive: 'matter-report-archive', verified: true } };
  };
  const retired = revision => ({ version: 1, status: 'retired', manifestSha256, sourceBasis: sourceBasis(revision),
    source: { revision, stateSha256: digest('original state'), browserSha256: digest('original browser'),
      reviewsSha256: digest('original reviews'), gpsStateSha256: [] },
    inventoryFile: 'retired-workspace-inventory.private.json.gz', inventorySha256: digest('inventory'),
    inventoryCompressedSha256: digest('compressed inventory'), verifiedAt: '2026-01-01T00:00:00.000Z' });
  await write('sync.json', { version: 1, root,
    baselineRoot: path.join(root, 'baseline'), codeRoot: path.join(root, 'builder'),
    rendererBuild: { path: path.join(root, 'baseline/build.private.json') },
    journals: { path: path.join(root, 'validation-journals.private.json') } });
  await write('seed.json', seed(2, 'bootstrap', path.join(root, 'objects')));
  await write('baseline/files.private.json', manifest);
  const reference = value => ({ basis: value.basis, privateRoot: value.privateRoot, manifestSha256: value.manifestSha256 });
  async function attempt(number, revision, previous = null, prepared = true) {
    const relative = 'work/attempts/00000000-0000-4000-8000-' + String(number).padStart(12, '0');
    const accepted = { version: 1, basis: sourceBasis(revision), sourceBasis: sourceBasis(revision),
      collectorRevision: revision, manifestSha256, privateRoot: path.join(root, relative, 'server-data'),
      baselineRoot: previous?.privateRoot || path.join(root, 'baseline'), previous: previous && reference(previous),
      verifiedAt: '2026-01-01T00:00:00.000Z' };
    const directSeed = seed(revision, 'sync', path.join(root, relative, 'audit-objects'));
    await write(relative + '/accepted.private.json', accepted);
    await write(relative + '/server-data/files.private.json', manifest);
    if (prepared) await write(relative + '/direct-seed.private.json', directSeed);
    return { relative, accepted, directSeed };
  }
  const serving = revision => ({ version: 1, sourceRevision: revision,
    directImport: { version: 1, collectorRevision: revision, sourceBasis: sourceBasis(revision), manifestSha256 } });
  const prior = await attempt(1, 4);
  const current = await attempt(2, 8, prior.accepted);
  const pending = await attempt(3, 10, current.accepted, false);
  await write('work/current.private.json', pending.accepted);
  const state = { head: { ...serving(8), previous: serving(4) }, stage: null, onHeadRead: null };
  let headReads = 0;
  const db = { collection(name) {
    assert.equal(name, 'driverAuditControl');
    return { async findOne(query) {
      if (query._id === 'head') { await state.onHeadRead?.(++headReads); return structuredClone({ head: state.head }); }
      assert.equal(query._id, 'direct-stage');
      return structuredClone(state.stage);
    } };
  } };
  const input = { db, syncRoot: root, documents: [{ key: 'collector-state', revision: 11, body_text: '{}' }] };
  const collect = () => collectDriverAuditReceiptRoots(input);
  return { root, write, manifest, manifestSha256, reference, seed, retired, attempt, prior, current, pending, state, input, collect };
}

test('census preserves serving roots and an accepted unpublished candidate without rewriting pointers', async t => {
  const f = await censusFixture(t);
  const before = await fs.readFile(path.join(f.root, 'work/current.private.json'));
  const result = await f.collect();
  assert.deepEqual(result.collectorRevisions, [2, 4, 8, 10, 11]);
  assert.ok(result.roots.some(row => row.kind === 'sync-previous' && row.revision === 8));
  assert.ok(result.roots.some(row => row.kind === f.pending.relative + '/accepted' && row.revision === 10));
  assert.deepEqual(await fs.readFile(path.join(f.root, 'work/current.private.json')), before);
  assert.equal((await f.collect()).sha256, result.sha256);
});

test('published current with an abbreviated previous resolves the original accepted receipt', async t => {
  const f = await censusFixture(t);
  await f.write('work/current.private.json', f.current.accepted);
  const result = await f.collect();
  assert.deepEqual(result.collectorRevisions, [2, 4, 8, 10, 11]);
  assert.ok(result.roots.some(row => row.kind === 'sync-previous' && row.revision === 4));
});

test('census accepts a pinned package inventory above one MiB using the existing sixteen MiB contract', async t => {
  const manifest = Object.fromEntries(Array.from({ length: 14000 }, (_, n) => ['fixture-' + n + '.private.json', digest('file ' + n)]));
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) > 1024 * 1024);
  const f = await censusFixture(t, { manifest });
  assert.deepEqual((await f.collect()).collectorRevisions, [2, 4, 8, 10, 11]);
});

test('census retains nested package entries accepted by the builder inventory contract', async t => {
  const f = await censusFixture(t, { manifest: { 'report-data/detail-fixture.json': digest('fictional detail') } });
  assert.deepEqual((await f.collect()).collectorRevisions, [2, 4, 8, 10, 11]);
});

test('census refuses traversal, empty or absolute package entry paths', async t => {
  for (const name of ['../outside.json', '/absolute.json', 'report-data//detail.json', 'report-data/./detail.json']) {
    await t.test(name, async sub => {
      const f = await censusFixture(sub, { manifest: { [name]: digest('fictional') } });
      await assert.rejects(f.collect(), /manifest.*differs/);
    });
  }
});

test('abbreviated previous can resolve exact seed-only and retired identities', async t => {
  const f = await censusFixture(t);
  await fs.unlink(path.join(f.root, f.current.relative, 'accepted.private.json'));
  let result = await f.collect();
  assert.ok(result.roots.some(row => row.kind === 'sync-previous' && row.revision === 8));
  await fs.unlink(path.join(f.root, f.current.relative, 'direct-seed.private.json'));
  await fs.unlink(path.join(f.root, f.current.relative, 'server-data/files.private.json'));
  await f.write(f.current.relative + '/retired-workspace.private.json', f.retired(8));
  result = await f.collect();
  assert.deepEqual(result.collectorRevisions, [2, 4, 8, 10, 11]);
});

test('bootstrap lineage resolves from its exact baseline and original seed', async t => {
  const f = await censusFixture(t);
  const previous = { basis: sourceBasis(2), privateRoot: path.join(f.root, 'baseline'), manifestSha256: f.manifestSha256 };
  await f.write(f.pending.relative + '/accepted.private.json', { ...f.pending.accepted, previous, baselineRoot: previous.privateRoot });
  await f.write('work/current.private.json', { ...f.pending.accepted, previous, baselineRoot: previous.privateRoot });
  assert.deepEqual((await f.collect()).collectorRevisions, [2, 4, 8, 10, 11]);
});

test('all retained accepted, prepared and retired roots participate in the pinned census', async t => {
  const f = await censusFixture(t);
  const first = await f.collect();
  const retained = await f.attempt(4, 6, null, false);
  assert.deepEqual((await f.collect()).collectorRevisions, [2, 4, 6, 8, 10, 11]);
  await fs.unlink(path.join(f.root, retained.relative, 'accepted.private.json'));
  await fs.unlink(path.join(f.root, retained.relative, 'server-data/files.private.json'));
  await f.write(retained.relative + '/retired-workspace.private.json', f.retired(6));
  const result = await f.collect();
  assert.deepEqual(result.collectorRevisions, [2, 4, 6, 8, 10, 11]);
  assert.notEqual(result.sha256, first.sha256);
});

test('a source snapshot older than any retained candidate is rejected', async t => {
  const f = await censusFixture(t);
  f.input.documents[0].revision = 9;
  await assert.rejects(f.collect(), /fresh source snapshot/);
});

test('census rejects conflicting pointer, previous, seed, retirement and source identities', async t => {
  const cases = [
    async f => f.write('work/current.private.json', { ...f.pending.accepted, basis: digest('conflict') }),
    async f => f.write('work/current.private.json', { ...f.pending.accepted,
      previous: { ...f.pending.accepted.previous, manifestSha256: digest('conflict') } }),
    async f => f.write(f.current.relative + '/direct-seed.private.json', { ...f.current.directSeed, collectorRevision: 7 }),
    async f => f.write(f.current.relative + '/retired-workspace.private.json', f.retired(7)),
    async f => { f.state.head.directImport.sourceBasis = digest('conflict'); },
  ];
  for (const [index, change] of cases.entries()) await t.test('conflict ' + index, async sub => {
    const f = await censusFixture(sub); await change(f);
    await assert.rejects(f.collect(), /differ|conflict/);
  });
});

test('unresolved references and unverified accepted manifests stop the census', async t => {
  for (const [name, change] of [
    ['missing previous identity', async f => {
      await fs.unlink(path.join(f.root, f.current.relative, 'accepted.private.json'));
      await fs.unlink(path.join(f.root, f.current.relative, 'direct-seed.private.json'));
    }],
    ['missing accepted receipt', f => fs.unlink(path.join(f.root, f.pending.relative, 'accepted.private.json'))],
    ['missing manifest', f => fs.unlink(path.join(f.root, f.pending.relative, 'server-data/files.private.json'))],
    ['different manifest', f => f.write(f.pending.relative + '/server-data/files.private.json', { changed: digest('different') })],
    ['missing bootstrap', f => fs.unlink(path.join(f.root, 'seed.json'))],
  ]) await t.test(name, async sub => {
    const f = await censusFixture(sub); await change(f);
    await assert.rejects(f.collect());
  });
});

test('unknown schemas and unsafe managed paths are rejected', async t => {
  for (const [name, change] of [
    ['unknown accepted version', f => f.write(f.pending.relative + '/accepted.private.json', { ...f.pending.accepted, version: 2 })],
    ['invalid hash', f => f.write(f.pending.relative + '/accepted.private.json', { ...f.pending.accepted, sourceBasis: 'unknown' })],
    ['unknown unpointed accepted schema', async f => {
      const extra = await f.attempt(4, 7, null, false);
      await f.write(extra.relative + '/accepted.private.json', { ...extra.accepted, version: 2 });
    }],
    ['escaped baseline', async f => {
      const value = { ...f.pending.accepted, baselineRoot: path.join(f.root, 'outside') };
      await f.write(f.pending.relative + '/accepted.private.json', value);
      await f.write('work/current.private.json', value);
    }],
    ['escaped private root', f => f.write('work/current.private.json', { ...f.pending.accepted, privateRoot: path.join(f.root, 'outside/server-data') })],
    ['symlinked attempt', async f => {
      const dir = path.join(f.root, 'work/attempts/00000000-0000-4000-8000-000000000099');
      await fs.symlink(path.join(f.root, f.current.relative), dir);
    }],
  ]) await t.test(name, async sub => {
    const f = await censusFixture(sub); await change(f);
    await assert.rejects(f.collect());
  });
});

test('a retirement marker without original source and inventory provenance is not trusted', async t => {
  const f = await censusFixture(t), retired = f.retired(8);
  delete retired.source.stateSha256;
  await f.write(f.current.relative + '/retired-workspace.private.json', retired);
  await assert.rejects(f.collect(), /Invalid retired/);
});

test('unresolved direct stages are rejected before and during the census', async t => {
  for (const during of [false, true]) await t.test(during ? 'appears during read' : 'already staged', async sub => {
    const f = await censusFixture(sub);
    if (during) f.state.onHeadRead = count => { if (count === 2) f.state.stage = { pointer: null }; };
    else f.state.stage = { pointer: null };
    await assert.rejects(f.collect(), /staged report/);
  });
});

test('serving or workspace drift during the census requires a new snapshot', async t => {
  for (const [name, change] of [
    ['serving head', async f => { f.state.head.directImport.manifestSha256 = digest('changed head'); }],
    ['accepted receipt', f => f.write(f.pending.relative + '/accepted.private.json', { ...f.pending.accepted, verifiedAt: '2026-01-02T00:00:00Z' })],
    ['new attempt', f => f.attempt(5, 7)],
  ]) await t.test(name, async sub => {
    const f = await censusFixture(sub);
    f.state.onHeadRead = async count => { if (count === 2) await change(f); };
    await assert.rejects(f.collect(), /changed during|drift/);
  });
});

async function historicalSourceFixture(t) {
  const f = await censusFixture(t), root = f.root;
  const module = await fs.readFile(new URL('./fixtures/driverAuditOriginalAutomaticRelease.mjs', import.meta.url));
  assert.equal(digest(module), DRIVER_AUDIT_ORIGINAL_BASIS_MODULE_SHA256);
  const runner = Buffer.from('export const fictional = true;\n');
  for (const [name, body] of [['integration/cloud/automatic-release.mjs', module], ['scripts/run-automatic-report.mjs', runner]]) {
    await fs.mkdir(path.dirname(path.join(root, 'builder', name)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, 'builder', name), body, { mode: 0o600 });
  }
  const manifest = { version: 1, files: { 'integration/cloud/automatic-release.mjs': digest(module),
    'scripts/run-automatic-report.mjs': digest(runner) } };
  await f.write('builder/runtime-manifest.json', manifest);
  const config = JSON.parse(await fs.readFile(path.join(root, 'sync.json')));
  await f.write('sync.json', { ...config, builderSha256: digest(JSON.stringify(manifest)) });
  const publication = { head: { reportHash: digest('fictional original result'), manifest: { sha256: digest('fictional original browser') } },
    gpsState: { fixture: { stateManifest: { sha256: digest('fictional original GPS') } } }, cloudPhotoResults: {} };
  const receipt = { key: 'collector-state', revision: 3, event_id: 'original-fixture-event', request_sha256: digest('original request'),
    body_sha256: digest(JSON.stringify(publication)), body_text: JSON.stringify(publication), event_text: '{"fixture":true}',
    created_at: '2026-01-01T00:00:00.123456+04:00' };
  const owner = await f.attempt(4, 7, null, false), reference = { basis: originalDriverAuditSourceBasis(publication),
    privateRoot: path.join(root, 'work/attempts/00000000-0000-4000-8000-000000000099/server-data'),
    manifestSha256: digest('unavailable original rendered manifest') };
  const accepted = { ...owner.accepted, baselineRoot: reference.privateRoot, previous: reference };
  await f.write(owner.relative + '/accepted.private.json', accepted);
  const proof = { version: 1, kind: 'historical-source-receipt-retention-v1',
    sourceBasisModuleSha256: DRIVER_AUDIT_ORIGINAL_BASIS_MODULE_SHA256,
    origin: { sourceDumpSha256: digest('original dump'), sourceSnapshotSha256: digest('original snapshot'),
      restoreVerificationSha256: digest('independent restored comparison'), originalReceiptSha256: digest('complete original receipt backup') },
    entries: [{ owner: { relative: owner.relative + '/accepted.private.json', sha256: digest(JSON.stringify(accepted)), collectorRevision: 7 },
      reference, receipt, receiptSha256: originalDriverAuditReceiptSha256(receipt),
      gap: { kind: 'preexisting-missing-temporary-report-workspace', workspacePresent: false, renderedManifestAvailable: false } }] };
  await f.write(DRIVER_AUDIT_HISTORICAL_SOURCE_FILE, proof);
  return { ...f, owner, accepted, reference, receipt, proof };
}

test('missing historical working copy retains its exact original source receipt while recording the rendered gap', async t => {
  const f = await historicalSourceFixture(t), before = await fs.readFile(path.join(f.root, f.owner.relative, 'accepted.private.json'));
  const result = await f.collect();
  assert.deepEqual(result.collectorRevisions, [2, 3, 4, 7, 8, 10, 11]);
  assert.deepEqual(result.receiptBindings, [{ key: 'collector-state', revision: 3, receiptSha256: f.proof.entries[0].receiptSha256 }]);
  assert.ok(result.roots.some(row => row.kind === 'preexisting-missing-temporary-report-workspace'
    && row.sourceRevision === 3 && row.workspacePresent === false && row.renderedManifestAvailable === false));
  assert.equal(result.roots.some(row => row.kind === 'historical-original-rendered-workspace'), false);
  assert.deepEqual(await fs.readFile(path.join(f.root, f.owner.relative, 'accepted.private.json')), before);
  await assert.rejects(fs.lstat(path.dirname(f.reference.privateRoot)), { code: 'ENOENT' });
  const originalReceiptSha256 = digest('complete original receipt backup');
  const selection = createDriverAuditReceiptSelection({ collectorRevisions: result.collectorRevisions, receiptBindings: result.receiptBindings,
    originalReceiptSha256, backup: { verified: true, originalsPreserved: true, originalReceiptSha256, receiptCount: 100,
      sourceDumpSha256: digest('dump') } });
  assert.equal(selection.include(f.receipt), true);
  assert.throws(() => selection.include({ ...f.receipt, created_at: '2026-01-01T00:00:00.123Z' }), /differs/);
});

test('historical source proof rejects tampering, active roots, fabricated recovery and unused entries', async t => {
  const changes = [
    ['changed owner', async f => { f.proof.entries[0].owner.sha256 = digest('changed'); }],
    ['changed reference', async f => { f.proof.entries[0].reference.manifestSha256 = digest('changed'); }],
    ['changed original event', async f => { f.proof.entries[0].receipt.event_text = '{"changed":true}'; }],
    ['changed original clock', async f => { f.proof.entries[0].receipt.created_at = '2026-01-01T00:00:00Z'; }],
    ['missing backup origin', async f => { delete f.proof.origin.restoreVerificationSha256; }],
    ['fabricated rendered recovery', async f => { f.proof.entries[0].gap.renderedManifestAvailable = true; }],
    ['changed basis implementation', async f => {
      await fs.writeFile(path.join(f.root, 'builder/integration/cloud/automatic-release.mjs'), 'export const changed=true;');
    }],
    ['workspace parent present', async f => { await fs.mkdir(path.dirname(f.reference.privateRoot), { mode: 0o700 }); }],
    ['workspace parent symlink', async f => { await fs.symlink(path.join(f.root, f.owner.relative), path.dirname(f.reference.privateRoot)); }],
    ['duplicate original proof', async f => { f.proof.entries.push(f.proof.entries[0]); }],
    ['unused proof', async f => { await fs.rm(path.join(f.root, f.owner.relative), { recursive: true }); }],
    ['operational source identity', async f => { f.state.head.sourceRevision = 3; f.state.head.directImport.collectorRevision = 3;
      f.state.head.directImport.sourceBasis = f.reference.basis; }],
    ['operational rendered manifest', async f => { f.state.head.directImport.manifestSha256 = f.reference.manifestSha256; }],
    ['current pointer previous', async f => {
      const value = { ...f.pending.accepted, baselineRoot: f.reference.privateRoot, previous: f.reference };
      await f.write(f.pending.relative + '/accepted.private.json', value); await f.write('work/current.private.json', value);
    }],
  ];
  for (const [name, change] of changes) await t.test(name, async sub => {
    const f = await historicalSourceFixture(sub); await change(f); await f.write(DRIVER_AUDIT_HISTORICAL_SOURCE_FILE, f.proof);
    await assert.rejects(f.collect());
  });
});

test('historical source proof and workspace absence are rechecked after the census', async t => {
  for (const kind of ['proof', 'workspace']) await t.test(kind, async sub => {
    const f = await historicalSourceFixture(sub);
    f.state.onHeadRead = async count => {
      if (count !== 2) return;
      if (kind === 'proof') await f.write(DRIVER_AUDIT_HISTORICAL_SOURCE_FILE, { ...f.proof, version: 2 });
      else await fs.mkdir(path.dirname(f.reference.privateRoot), { mode: 0o700 });
    };
    await assert.rejects(f.collect(), /changed|reappeared/);
  });
});

test('historical source identity survives only the exact retained builder during an interrupted managed swap', async t => {
  const f = await historicalSourceFixture(t), before = await f.collect();
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'sync.json'))), retained = path.join(f.root, 'builder-retained-' + config.builderSha256);
  await fs.rename(path.join(f.root, 'builder'), retained);
  assert.equal((await f.collect()).sha256, before.sha256);
  await fs.mkdir(path.join(f.root, 'builder'), { mode: 0o700 });
  await assert.rejects(f.collect());
  await fs.rmdir(path.join(f.root, 'builder'));
  await fs.writeFile(path.join(retained, 'integration/cloud/automatic-release.mjs'), 'corrupt');
  await assert.rejects(f.collect());
});
