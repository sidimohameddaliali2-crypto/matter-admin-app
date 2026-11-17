import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const check = (value, message) => { if (!value) throw Error(message); };
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = rows => rows.sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
const options = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true, wtimeoutMS: 10000 }, readPreference: 'primary' };
const capacityBytes = 16 * 1024 ** 3;
const emptyNames = ['Documents', 'Receipts', 'Historical', 'ReviewContexts', 'ReviewFiles', 'TechnicalRecords',
  'TechnicalChunks', 'Reservations', 'Consumption', 'ArchiveLedger', 'RoadCache'].map(name => 'driverAuditNative' + name);
const metadataNames = new Set(['driverAuditNativeFiles', 'driverAuditNativeChunks', 'driverAuditNativeControl',
  'driverAuditNativeLeases', 'driverAuditNativeArchiveControl']);

export function parseNativeCleanupInventory(bytes, backup) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 16 * 1024 ** 2, 'Bounded cleanup inventory required');
  const rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  check(rows.length > 0 && rows.length <= 100000 && new Set(rows.map(row => row.key)).size === rows.length
    && rows.every(row => Object.keys(row).sort().join(',') === 'bytes,key'
      && /^[a-f0-9]{64}\.(?:gz|json)$/.test(row.key || '') && integer(row.bytes) && row.bytes > 0 && row.bytes <= 16 * 1024 ** 2),
  'Only exact original archive object inventory rows may be cleanup candidates');
  check(backup?.version === 1 && backup.kind === 'verified-original-cleanup-backup'
    && backup.verified === true && backup.originalsPreserved === true && backup.encryptedBackupPreserved === true
    && backup.allCandidateOriginalBytesHashVerified === true && backup.ciphertextAndSessionsPreserved === true
    && backup.inventorySha256 === hash(bytes) && backup.objects === rows.length
    && backup.bytes === rows.reduce((sum, row) => sum + row.bytes, 0)
    && hex(backup.locatorsSha256) && hex(backup.originalPreservationProofSha256), 'Exact verified original backup proof required');
  return rows;
}

function fileMetadata(row) {
  check(row && Object.keys(row).sort().join(',') === '_id,reference' && /^[a-f0-9]{64}\.(?:gz|json)$/.test(row._id || ''),
    'Unexpected native file metadata; retain it for review');
  const r = row.reference;
  check(r && Object.keys(r).sort().join(',') === 'chunks,sha256,size,version'
    && r.version === 1 && r.sha256 === row._id.slice(0, 64) && integer(r.size) && r.size > 0 && r.size <= 16 * 1024 ** 2
    && Array.isArray(r.chunks) && r.chunks.length > 0 && r.chunks.length <= 4
    && r.chunks.every(part => part && Object.keys(part).sort().join(',') === 'sha256,size'
      && hex(part.sha256) && integer(part.size) && part.size > 0 && part.size <= 4 * 1024 ** 2)
    && r.chunks.reduce((sum, part) => sum + part.size, 0) === r.size, 'Invalid native file reference');
  return { _id: row._id, reference: { version: 1, sha256: r.sha256, size: r.size,
    chunks: r.chunks.map(part => ({ sha256: part.sha256, size: part.size })) } };
}
function chunkMetadata(row) {
  check(row && Object.keys(row).sort().join(',') === '_id,size' && hex(row._id)
    && integer(row.size) && row.size > 0 && row.size <= 4 * 1024 ** 2, 'Unexpected native chunk metadata');
  return { _id: row._id, size: row.size };
}

async function emptyGuard(db, names, session) {
  check(!await db.collection('driverAuditNativeControl').findOne({ _id: 'authority' }, { session }),
    'Cleanup requires completely absent native authority, including staging');
  check(!await db.collection('driverAuditNativeControl').findOne({ _id: { $ne: 'capacity' } }, { session }),
    'Unknown native controls block cleanup');
  for (const name of names) check(await db.collection(name).countDocuments({}, { session }) === 0,
    'A native record, receipt, history, review, technical record or unknown reference blocks cleanup');
  check(!await db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }, { session }), 'A direct publication is pending');
  for (const row of await db.collection('driverAuditNativeLeases').find({}, { session }).toArray()) {
    check(['collector', 'qualification'].includes(row._id) && row.expires_at instanceof Date && row.expires_at <= new Date(),
      'A native writer lease is active or unknown');
  }
  for (const row of await db.collection('driverAuditNativeArchiveControl').find({}, { session }).toArray()) {
    check(row._id === 'total' && row.used_bytes === 0 && row.reserved_bytes === 0, 'A native archive reservation or ledger is in use');
  }
}
async function guardNames(db) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name);
  check(names.length <= 1000, 'Collection census exceeds its bound');
  return [...new Set([...emptyNames, ...names.filter(name => name.startsWith('driverAuditNative') && !metadataNames.has(name))])];
}
async function metadata(db) {
  const files = sorted((await db.collection('driverAuditNativeFiles').find({}).toArray()).map(fileMetadata));
  const chunks = sorted((await db.collection('driverAuditNativeChunks').find({}, { projection: { bytes: 0 } }).toArray()).map(chunkMetadata));
  check(files.length <= 100000 && chunks.length <= 200000, 'Native staging census exceeds its bound');
  const chunkIndex = new Map(chunks.map(row => [row._id, row.size]));
  check(files.every(row => row.reference.chunks.every(part => chunkIndex.get(part.sha256) === part.size)),
    'Native file metadata has a missing or differing chunk reference');
  const capacity = await db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' });
  check(capacity?.limitBytes === capacityBytes && integer(capacity.usedBytes) && capacity.usedBytes <= capacityBytes
    && (capacity.technicalBytes === undefined || capacity.technicalBytes === 0), 'The unused native capacity ledger differs');
  return { files, chunks, capacity };
}
export function nativeCleanupSelection(before, inventory) {
  const keys = new Map(inventory.map(row => [row.key, row.bytes]));
  const selected = before.files.filter(row => keys.has(row._id));
  check(selected.length > 0 && selected.every(row => row.reference.size === keys.get(row._id)), 'No exact received batch staging is available');
  const selectedIds = new Set(selected.map(row => row._id));
  const referenced = new Set(before.files.filter(row => !selectedIds.has(row._id))
    .flatMap(row => row.reference.chunks.map(part => part.sha256)));
  const candidateChunks = new Set(selected.flatMap(row => row.reference.chunks.map(part => part.sha256)));
  const removeChunks = before.chunks.filter(row => candidateChunks.has(row._id) && !referenced.has(row._id));
  const charged = before.chunks.reduce((sum, row) => sum + row.size + 1024, 0);
  check(charged === before.capacity.usedBytes, 'Native capacity is not the exact unused chunk allocation');
  const reclaimBytes = removeChunks.reduce((sum, row) => sum + row.size + 1024, 0);
  return { selected, selectedFiles: selected.map(row => row._id), removeChunks, reclaimBytes, expectedUsedBytes: charged - reclaimBytes };
}

export async function planNativeStagingCleanup({ db, inventoryBytes, backup, binding, safety = async () => {} }) {
  const inventory = parseNativeCleanupInventory(inventoryBytes, backup);
  check(uuid(binding?.candidateSessionId) && hex(binding.templateSha256) && hex(binding.backupSha256), 'Exact cleanup session and input pins required');
  await safety(); const names = await guardNames(db); await emptyGuard(db, names);
  const before = await metadata(db), selection = nativeCleanupSelection(before, inventory);
  const { selected, removeChunks, reclaimBytes } = selection;
  check(reclaimBytes > 0 && reclaimBytes <= 2 * 1024 ** 3, 'Cleanup must release a bounded amount of unused staging');
  await safety(); await emptyGuard(db, await guardNames(db));
  const after = await metadata(db); check(same(before, after), 'Native staging changed while preparing cleanup');
  return { version: 1, kind: 'unused-native-batch-staging-cleanup-plan', ...binding, targetDatabase: db.databaseName,
    inventorySha256: hash(inventoryBytes), before, selectedFiles: selected.map(row => row._id), removeChunks,
    emptyCollectionNames: names, reclaimBytes, expectedUsedBytes: selection.expectedUsedBytes,
    targetBytesRead: false, targetByteParityAsserted: false, backupOriginalBytesFreshlyVerified: true, originalBackupPreserved: true,
    servingHeadSha256: hash(JSON.stringify(await db.collection('driverAuditControl').findOne({ _id: 'head' }))),
    planOnly: true, authorityChanged: false };
}

function remainingState(plan, state) {
  const fileSet = new Set(plan.selectedFiles), chunks = new Set(plan.removeChunks.map(row => row._id));
  for (const [name, candidates] of [['files', fileSet], ['chunks', chunks]]) {
    const original = new Map(plan.before[name].map(row => [row._id, row]));
    const current = new Map(state[name].map(row => [row._id, row]));
    check(state[name].every(row => same(original.get(row._id), row)), 'Cleanup encountered new or changed native staging');
    check(plan.before[name].every(row => current.has(row._id) || candidates.has(row._id)), 'Non-candidate native staging disappeared');
  }
  check([plan.before.capacity.usedBytes, plan.expectedUsedBytes].includes(state.capacity.usedBytes), 'Cleanup capacity changed unexpectedly');
  check(state.capacity.usedBytes >= state.chunks.reduce((sum, row) => sum + row.size + 1024, 0),
    'Cleanup capacity must never undercount remaining native chunks');
}

export async function applyNativeStagingCleanup({ db, client, plan, inventoryBytes, backup, safety = async () => {}, saveIntent }) {
  check(plan?.version === 1 && plan.kind === 'unused-native-batch-staging-cleanup-plan' && plan.targetDatabase === db.databaseName
    && plan.planOnly === true && plan.targetBytesRead === false && plan.targetByteParityAsserted === false
    && plan.backupOriginalBytesFreshlyVerified === true && typeof saveIntent === 'function', 'An exact reviewed cleanup plan is required');
  const inventory = parseNativeCleanupInventory(inventoryBytes, backup);
  check(hash(inventoryBytes) === plan.inventorySha256, 'Reviewed cleanup inventory differs');
  const selection = nativeCleanupSelection(plan.before, inventory);
  check(same(selection.selectedFiles, plan.selectedFiles) && same(selection.removeChunks, plan.removeChunks)
    && selection.reclaimBytes === plan.reclaimBytes && selection.expectedUsedBytes === plan.expectedUsedBytes,
  'The cleanup plan contains a file, chunk or refund outside its exact inventory');
  let names = await guardNames(db);
  const guard = async session => { await emptyGuard(db, names, session);
    check(hash(JSON.stringify(await db.collection('driverAuditControl').findOne({ _id: 'head' }, { session }))) === plan.servingHeadSha256,
      'The serving report pointer changed'); };
  await safety(); await guard(); remainingState(plan, await metadata(db));
  await saveIntent({ version: 1, planSha256: hash(json(plan)), deletionsOnlyBeforeQuotaRefund: true, originalsPreserved: true });
  const run = async operation => {
    await safety(); names = await guardNames(db); const session = client.startSession();
    try { await session.withTransaction(async () => { await guard(session); await operation(session); }, options); }
    finally { await session.endSession(); }
  };
  // All file pointers go first. Every chunk deletion then independently proves
  // that NO remaining native file refers to it. No writes increase data usage.
  for (let offset = 0; offset < plan.selectedFiles.length; offset += 500) {
    const ids = plan.selectedFiles.slice(offset, offset + 500);
    const planned = new Map(plan.before.files.filter(row => ids.includes(row._id)).map(row => [row._id, row]));
    await run(async session => {
      const rows = await db.collection('driverAuditNativeFiles').find({ _id: { $in: ids } }, { session }).toArray();
      check(rows.every(row => same(fileMetadata(row), planned.get(row._id))), 'Candidate native file changed before deletion');
      await db.collection('driverAuditNativeFiles').deleteMany({ _id: { $in: ids } }, { session });
    });
  }
  remainingState(plan, await metadata(db));
  for (let offset = 0; offset < plan.removeChunks.length;) {
    const ids = []; let bytes = 0;
    do { const row = plan.removeChunks[offset++]; ids.push(row._id); bytes += row.size; }
    while (offset < plan.removeChunks.length && ids.length < 128
      && bytes + plan.removeChunks[offset].size <= 16 * 1024 ** 2);
    await run(async session => {
      check(await db.collection('driverAuditNativeFiles').countDocuments({ 'reference.chunks.sha256': { $in: ids } }, { session }) === 0,
        'A remaining native file still uses a cleanup chunk');
      await db.collection('driverAuditNativeChunks').deleteMany({ _id: { $in: ids } }, { session });
    });
  }
  await safety(); names = await guardNames(db); await guard(); const final = await metadata(db); remainingState(plan, final);
  const removedFiles = new Set(plan.selectedFiles), removedChunks = new Set(plan.removeChunks.map(row => row._id));
  check(!final.files.some(row => removedFiles.has(row._id)) && !final.chunks.some(row => removedChunks.has(row._id))
    && final.chunks.reduce((sum, row) => sum + row.size + 1024, 0) === plan.expectedUsedBytes, 'Cleanup deletion readback differs');
  // Atlas may reject updates while over quota. Deletion commits deliberately
  // precede this non-growing refund. A failed refund leaves conservative usage
  // and the exact immutable plan/intent; retry reconciles this same plan only.
  if (final.capacity.usedBytes !== plan.expectedUsedBytes) await run(async session => {
    const result = await db.collection('driverAuditNativeControl').updateOne({ _id: 'capacity', limitBytes: capacityBytes,
      usedBytes: plan.before.capacity.usedBytes }, { $set: { usedBytes: plan.expectedUsedBytes } }, { session });
    check(result.matchedCount === 1, 'Exact native capacity refund raced');
  });
  await safety(); names = await guardNames(db); await guard(); const verified = await metadata(db); remainingState(plan, verified);
  check(verified.capacity.usedBytes === plan.expectedUsedBytes, 'Native capacity refund needs retry');
  return { version: 1, status: 'unused-native-staging-cleaned', verified: true, targetDatabase: db.databaseName,
    inventorySha256: plan.inventorySha256, removedFiles: plan.selectedFiles.length, removedChunks: plan.removeChunks.length,
    releasedNativeCapacityBytes: plan.reclaimBytes, nativeUsedBytes: plan.expectedUsedBytes,
    targetBytesRead: false, targetByteParityAsserted: false, originalBackupPreserved: true,
    sessionsAndCiphertextPreserved: true, servingCollectionsChanged: false, authorityChanged: false };
}

async function immutable(file, bytes, read) {
  try { check((await read(file, 64 * 1024 ** 2)).equals(bytes), 'An immutable cleanup artifact differs'); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.' + randomUUID() + '.tmp', handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await fs.link(temporary, file); } finally { await fs.unlink(temporary); }
  const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

export async function runDriverAuditNativeCleanup({ operation, sessionId, templateSha256, profileSha256, expectedSha, appRoot }, adapters = {}) {
  let connection; const locks = [], execute = adapters.exec || exec, env = adapters.env || process.env;
  try {
    check(['plan-native-cleanup', 'apply-native-cleanup'].includes(operation) && uuid(sessionId) && hex(templateSha256)
      && (operation === 'plan-native-cleanup' ? profileSha256 === undefined : hex(profileSha256)), 'Pinned cleanup operation required');
    check(path.isAbsolute(appRoot || '') && await fs.realpath(appRoot) === appRoot && /^[a-f0-9]{40}$/.test(expectedSha || ''), 'Exact application checkout required');
    const checkout = async () => {
      check((adapters.platform || process.platform) === 'linux'
        && (await execute('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 })).stdout.trim() === expectedSha,
      'The exact Linux checkout changed');
      await execute('git', ['diff', '--quiet', 'HEAD', '--', 'server'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 });
      check(!(await execute('git', ['ls-files', '--others', '--exclude-standard', '--', 'server'],
        { cwd: appRoot, timeout: 5000, maxBuffer: 65536 })).stdout.trim(), 'Untracked server code blocks cleanup');
    };
    await checkout(); const server = path.join(appRoot, 'server');
    const load = adapters.load || (name => import(pathToFileURL(path.join(server, name)).href)); await load('loadEnv.js');
    const { readPrivateDriverAuditSource: read, requirePrivateDriverAuditSourceDirectory: directory } = await load('services/driverAuditSource.js');
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    const root = path.join(server, '.private/driver-audit-native-transfer'), folder = path.join(root, sessionId);
    await directory(root); await directory(folder); locks.push(await acquireWorkerLock(path.join(root, 'operator.lock')));
    const stateBytes = await read(path.join(folder, 'session.private.json'), 128 * 1024), state = JSON.parse(stateBytes);
    const receivedBytes = await read(path.join(folder, 'received.private.json'), 1024 * 1024), received = JSON.parse(receivedBytes);
    const templateBytes = await read(path.join(folder, 'cleanup-template.private.json'), 1024 * 1024);
    check(hash(templateBytes) === templateSha256, 'Cleanup template differs'); const template = JSON.parse(templateBytes);
    check(state.version === 1 && state.sessionId === sessionId && state.capacityBytes === capacityBytes && state.targetDatabase === 'test'
      && state.plan?.inventorySha256 === state.inventorySha256 && state.plan.objectCount === 3
      && integer(state.createdAt) && state.createdAt <= Date.now()
      && received.version === 1 && received.status === 'transfer-received' && received.verified === true && received.sessionId === sessionId
      && received.targetDatabase === state.targetDatabase && received.inventorySha256 === state.inventorySha256
      && received.objects === 3 && received.bytes === state.plan?.objectBytes && received.authorityChanged === false,
    'The complete cleanup control transfer is required');
    check(template.version === 1 && template.kind === 'unused-native-batch-staging-cleanup'
      && template.targetDatabase === state.targetDatabase && template.capacityBytes === capacityBytes
      && uuid(template.candidateSessionId) && template.candidateSessionId !== sessionId
      && hex(template.candidateInventorySha256) && hex(template.backupSha256), 'Exact cleanup candidate scope required');
    const inventoryBytes = await read(path.join(folder, 'cleanup-inventory.private.jsonl'), 16 * 1024 ** 2);
    const backupBytes = await read(path.join(folder, 'cleanup-backup.private.json'), 1024 * 1024);
    check(hash(inventoryBytes) === template.candidateInventorySha256 && hash(backupBytes) === template.backupSha256,
      'Cleanup original inventory or backup proof changed'); const backup = JSON.parse(backupBytes);
    parseNativeCleanupInventory(inventoryBytes, backup);
    check(received.inputFiles?.length === 3, 'Exactly three complete cleanup control inputs are required');
    const files = new Map(received.inputFiles.map(row => [row.name, row]));
    for (const [name, bytes] of [['cleanup-template.private.json', templateBytes], ['cleanup-inventory.private.jsonl', inventoryBytes], ['cleanup-backup.private.json', backupBytes]]) {
      check(files.size === 3 && files.get(name)?.sha256 === hash(bytes) && files.get(name)?.bytes === bytes.length, 'Received cleanup input binding differs');
    }
    const candidateFolder = path.join(root, template.candidateSessionId); await directory(candidateFolder);
    const candidateBytes = await read(path.join(candidateFolder, 'session.private.json'), 128 * 1024), candidate = JSON.parse(candidateBytes);
    check(candidate.version === 1 && candidate.sessionId === template.candidateSessionId && candidate.targetDatabase === state.targetDatabase
      && candidate.capacityBytes === capacityBytes && candidate.inventorySha256 === hash(inventoryBytes)
      && candidate.plan?.inventorySha256 === hash(inventoryBytes) && candidate.plan.objectCount === backup.objects
      && candidate.plan.objectBytes === backup.bytes, 'The failed original transfer session differs');
    const processes = async () => JSON.parse((await execute('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 ** 2 })).stdout);
    const initial = await processes(), sync = initial.filter(row => row.name === 'matter-driver-audit-sync');
    check(sync.length === 1 && sync[0].pm2_env?.status === 'stopped' && initial.filter(row => row.name === 'matter-driver-audit-source').length === 0,
      'Cleanup requires source absent and sync stopped');
    const args = sync[0].pm2_env.args, syncRoot = typeof args?.[1] === 'string' ? path.dirname(args[1]) : '';
    check(args?.length === 2 && args[0] === '--config' && args[1] === path.join(syncRoot, 'sync.json')
      && path.dirname(syncRoot) === path.join(server, '.private/driver-audits') && hex(path.basename(syncRoot))
      && sync[0].pm2_env.pm_cwd === server && sync[0].pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js'), 'Managed sync invocation differs');
    for (const parent of [path.dirname(syncRoot), path.join(server, '.private/driver-audit-source'), path.join(server, '.private/driver-audit-heavy-work')]) await directory(parent);
    for (const file of [path.join(path.dirname(syncRoot), 'sync-worker.lock'),
      path.join(server, '.private/driver-audit-source/source-deployment.lock'), path.join(server, '.private/driver-audit-source/source-worker.lock'),
      path.join(server, '.private/driver-audit-heavy-work/work.lock')]) locks.push(await acquireWorkerLock(file));
    const safety = async () => {
      await checkout(); const entries = await processes();
      check(entries.filter(row => row.name === 'matter-delivery-api').length === 1
        && entries.filter(row => row.name === 'matter-driver-audit-source').length === 0
        && entries.filter(row => row.name === 'matter-driver-audit-sync').length === 1
        && same(entries.find(row => row.name === 'matter-driver-audit-sync')?.pm2_env, sync[0].pm2_env), 'Reporting workers or sync registration changed');
      for (const [file, bytes] of [['session.private.json', stateBytes], ['received.private.json', receivedBytes], ['cleanup-template.private.json', templateBytes]]) {
        check((await read(path.join(folder, file), 1024 * 1024)).equals(bytes), 'Cleanup control evidence changed');
      }
      check((await read(path.join(candidateFolder, 'session.private.json'), 128 * 1024)).equals(candidateBytes), 'Original transfer evidence changed');
    };
    check(typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0, 'Existing app MongoDB connection required');
    const { default: mongoose } = await load('node_modules/mongoose/index.js');
    connection = mongoose.createConnection(env.MONGODB_URI, { autoCreate: false, autoIndex: false, maxPoolSize: 2, serverSelectionTimeoutMS: 10000 });
    await connection.asPromise(); const db = connection.db, client = connection.getClient();
    check(db.databaseName === state.targetDatabase, 'Cleanup database differs');
    const planFile = path.join(folder, 'native-cleanup-plan.private.json'); let planBytes;
    try { planBytes = await read(planFile, 64 * 1024 ** 2); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (operation === 'plan-native-cleanup' && !planBytes) {
      const plan = await planNativeStagingCleanup({ db, inventoryBytes, backup, safety,
        binding: { candidateSessionId: template.candidateSessionId, templateSha256, backupSha256: hash(backupBytes) } });
      planBytes = json(plan); await immutable(planFile, planBytes, read);
    }
    check(planBytes && (operation === 'plan-native-cleanup' || hash(planBytes) === profileSha256), 'An existing exact reviewed cleanup plan is required');
    const plan = JSON.parse(planBytes);
    check(plan.templateSha256 === templateSha256 && plan.backupSha256 === hash(backupBytes)
      && plan.inventorySha256 === hash(inventoryBytes) && plan.candidateSessionId === template.candidateSessionId, 'Cleanup plan provenance differs');
    check(plan.reclaimBytes >= 512 * 1024 ** 2 && plan.reclaimBytes <= 2 * 1024 ** 3,
      'This quota recovery operation requires a reviewed 512 MiB to 2 GiB release');
    if (operation === 'plan-native-cleanup') {
      await safety(); await emptyGuard(db, await guardNames(db));
      check(same(await metadata(db), plan.before)
        && hash(JSON.stringify(await db.collection('driverAuditControl').findOne({ _id: 'head' }))) === plan.servingHeadSha256,
      'The read-only cleanup plan no longer describes current staging');
      return { version: 1, status: 'unused-native-staging-cleanup-planned', planSha256: hash(planBytes),
      selectedFiles: plan.selectedFiles.length, removableChunks: plan.removeChunks.length, releaseBytes: plan.reclaimBytes,
      candidateSessionId: plan.candidateSessionId, candidateInventorySha256: plan.inventorySha256, backupAttestationSha256: plan.backupSha256,
      beforeNativeFiles: plan.before.files.length, beforeNativeChunks: plan.before.chunks.length,
      beforeNativeUsedBytes: plan.before.capacity.usedBytes, expectedNativeUsedBytes: plan.expectedUsedBytes,
      servingHeadSha256: plan.servingHeadSha256, nativeAuthorityAbsent: true, nativeReferenceCollectionsEmpty: true,
      targetBytesRead: false, targetByteParityAsserted: false, originalBackupPreserved: true, databaseWrites: false, authorityChanged: false };
    }
    const result = await applyNativeStagingCleanup({ db, client, plan, inventoryBytes, backup, safety,
      saveIntent: value => immutable(path.join(folder, 'native-cleanup-intent-' + profileSha256 + '.private.json'), json(value), read) });
    await immutable(path.join(folder, 'native-cleanup-result-' + profileSha256 + '.private.json'), json(result), read);
    return { ...result, applicationCommit: expectedSha, planSha256: profileSha256 };
  } finally { await connection?.close(); for (const lock of locks.reverse()) await lock.release(); }
}
