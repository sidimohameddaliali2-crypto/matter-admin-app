import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { driverAuditReplicaRetentionStatus, driverAuditRetentionImplementation } from '../services/driverAuditRetention.js';

export { driverAuditRetentionImplementation };

const exec = promisify(execFile);
const serverRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const appRoot = path.dirname(serverRoot);
const origin = 'https://matterapp.online';
const apiName = 'matter-delivery-api';
const syncName = 'matter-driver-audit-sync';
const syncScript = path.join(serverRoot, 'scripts/driverAuditSync.js');
const begin = '# BEGIN MANAGED DRIVER AUDIT SETTINGS';
const end = '# END MANAGED DRIVER AUDIT SETTINGS';
const managed = /^# BEGIN MANAGED DRIVER AUDIT SETTINGS\r?\n[\s\S]*?^# END MANAGED DRIVER AUDIT SETTINGS(?:\r?\n|$)/gm;
const enabledKey = 'DRIVER_AUDIT_ENABLED';
const importKey = 'DRIVER_AUDIT_IMPORT_ENABLED';
const originKey = 'DRIVER_AUDIT_ORIGIN';
const capacityKey = 'DRIVER_AUDIT_CAPACITY_BYTES';
const secretKey = 'DRIVER_AUDIT_SUPABASE_SECRET';
const gcKey = 'DRIVER_AUDIT_REPLICA_GC_ENABLED';
const disabled = { [enabledKey]: '0', [importKey]: '0', [gcKey]: '0' };
const activeKeys = [enabledKey, importKey, originKey, capacityKey, secretKey, gcKey];
const sha256 = /^[a-f0-9]{64}$/;
const retentionOperation = 'audit-retention-enable';
const retainedGenerations = /^[a-f0-9]{64}:[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

class DeploymentError extends Error {}
function requireValue(condition, message) {
  if (!condition) throw new DeploymentError(message);
}

function bytes(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(/^[1-9]\d*$/.test(value ?? '') && Number.isSafeInteger(Number(value)) && Number(value) <= maximum, `Invalid ${label}.`);
  return Number(value);
}

function reportingSecret(value) {
  requireValue(/^[A-Za-z0-9_.-]{1,8192}$/.test(value ?? ''), 'Private driver audit reporting credential is required.');
  return value;
}

async function readFile(file, { optional = false, privateOnly = false } = {}) {
  const stat = await fs.lstat(file).catch(error => {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  requireValue(stat.isFile(), 'Driver audit settings and receipts must be regular files.');
  if (privateOnly) {
    requireValue(!(stat.mode & 0o077) && stat.uid === process.getuid(), 'Driver audit settings and receipts must be owner-only.');
  }
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    requireValue(opened.ino === stat.ino && opened.dev === stat.dev, 'Driver audit settings changed while reading.');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function atomicWrite(file, text, beforeRename = async () => {}, { createOnly = false } = {}) {
  const temporary = file + '.' + randomUUID();
  try {
    await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await beforeRename();
    if (createOnly) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function writeDriverAuditEnvironment(root, settings) {
  const { default: dotenv } = await import('dotenv');
  const active = settings[enabledKey] === '1';
  const keys = active ? activeKeys : Object.keys(disabled);
  requireValue(Object.keys(settings).length === keys.length && keys.every(key => Object.hasOwn(settings, key))
    && settings[importKey] === '0' && (settings[gcKey] === '0' || active && settings[gcKey] === '1')
    && (active || settings[enabledKey] === '0'), 'Invalid driver audit settings.');
  if (active) {
    requireValue(settings[originKey] === origin, 'Driver audit production origin does not match.');
    bytes(settings[capacityKey], 'driver audit capacity', 256 * 1024 * 1024);
    reportingSecret(settings[secretKey]);
  }
  const file = path.join(root, '.env.local');
  const previous = await readFile(file, { optional: true });
  const unowned = (previous ?? '').replace(managed, '');
  requireValue(!unowned.split(/\r?\n/).some(line => line === begin || line === end), 'Driver audit managed settings block is malformed.');
  const prefix = unowned && !unowned.endsWith('\n') ? unowned + '\n' : unowned;
  const next = prefix + [begin, ...keys.map(key => key + '=' + settings[key]), end, ''].join('\n');
  const before = dotenv.parse(previous ?? '');
  const after = dotenv.parse(next);
  requireValue(keys.every(key => after[key] === settings[key])
    && Object.entries(before).every(([key, value]) => activeKeys.includes(key) || after[key] === value),
  'Driver audit managed settings would affect existing application settings.');
  await atomicWrite(file, next, async () => {
    requireValue(await readFile(file, { optional: true }) === previous, 'Application settings changed during the audit release.');
  });
}

async function privateReleaseRoot(manifest) {
  const base = path.join(serverRoot, '.private');
  await fs.mkdir(base, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  requireValue((await fs.lstat(base)).isDirectory(), 'The app private directory must be a real directory.');
  let directory = base;
  for (const name of ['driver-audits', manifest]) {
    directory = path.join(directory, name);
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    requireValue(stat.isDirectory() && !(stat.mode & 0o077) && stat.uid === process.getuid(),
      'The driver audit staging directory must be owner-only.');
  }
  return directory;
}

async function jsonFile(file) {
  return JSON.parse(await readFile(file, { privateOnly: true }));
}

async function readDurableSettings() {
  const { default: dotenv } = await import('dotenv');
  return {
    ...dotenv.parse(await readFile(path.join(serverRoot, '.env'), { optional: true }) ?? ''),
    ...dotenv.parse(await readFile(path.join(serverRoot, '.env.local'), { privateOnly: true })),
  };
}

async function run(command, args, env, message) {
  try {
    return (await exec(command, args, { cwd: appRoot, env, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch {
    throw new DeploymentError(message);
  }
}

async function runScript(name, args, env, message) {
  return run(process.execPath, [path.join(serverRoot, 'scripts', name), ...args], env, message);
}

function pm2Environment(shell) {
  return Object.fromEntries(Object.entries(shell).filter(([key]) =>
    ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'PM2_HOME'].includes(key) || key.startsWith('LC_')));
}

async function pm2(args, env) {
  return run('pm2', args, env, 'Driver audit PM2 operation failed.');
}

async function processEntry(name, env) {
  const entries = JSON.parse(await pm2(['jlist'], env)).filter(entry => entry.name === name);
  requireValue(entries.length <= 1, 'Driver audit release requires exactly one instance of each managed process.');
  return entries[0];
}

function matchingWorker(worker, config) {
  return worker?.pm2_env?.pm_exec_path === syncScript
    && worker.pm2_env.pm_cwd === serverRoot
    && (!config || JSON.stringify(worker.pm2_env.args) === JSON.stringify(['--config', config]));
}

function registeredWorkerConfig(worker) {
  const args = worker.pm2_env?.args;
  const config = args?.[1];
  const root = path.join(serverRoot, '.private', 'driver-audits');
  const segments = typeof config === 'string' ? path.relative(root, config).split(path.sep) : [];
  requireValue(matchingWorker(worker, config) && args?.length === 2 && segments.length === 2
    && sha256.test(segments[0]) && segments[1] === 'sync.json' && config === path.join(root, ...segments),
  'The named audit sync process does not match the managed worker.');
  return config;
}

async function checkWorkerConfig(config, shell) {
  await jsonFile(config);
  await runScript('driverAuditSync.js', ['--config', config, '--check'], shell, 'The staged audit sync worker did not pass its configuration checks.');
}

async function waitForWorker(config, pmEnv, startedAt, requiresQualifiedRetention = false) {
  const heartbeat = path.join(path.dirname(config), 'sync-status.private.json');
  for (let attempt = 0; attempt < 20; attempt++) {
    const text = await readFile(heartbeat, { optional: true, privateOnly: true });
    const status = text ? JSON.parse(text) : null;
    if (status?.version === 1 && Date.parse(status.checkedAt) >= startedAt && !status.errorCode
      && (!requiresQualifiedRetention || status.replicaGcStatus === 'qualified')) {
      const worker = await processEntry(syncName, pmEnv);
      if (matchingWorker(worker, config) && worker.pm2_env.status === 'online') return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new DeploymentError('The reviewed audit worker did not report startup readiness.');
}

async function resources(directory) {
  requireValue(typeof fetch === 'function' && typeof AbortSignal.any === 'function' && typeof fs.statfs === 'function',
    'The deployed Node runtime lacks required audit APIs.');
  const stat = await fs.statfs(directory);
  const memoryInfo = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memoryInfo);
  return {
    node: process.version,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: available ? Number(available[1]) * 1024 : os.freemem(),
    freeDiskBytes: stat.bavail * stat.bsize,
  };
}

async function seed(root, env, apply = false) {
  const args = ['--config', path.join(root, 'seed.json')];
  if (apply) args.push('--apply');
  const output = await runScript('driverAuditSeed.js', args, env, apply ? 'Driver audit seed did not pass production readback.' : 'Driver audit seed preflight failed.');
  const result = JSON.parse(output.trim());
  requireValue((apply ? ['imported', 'unchanged'].includes(result.status) : result.status === 'ready' && result.databaseChecked === true)
    && result.mode === 'bootstrap' && sha256.test(result.generation) && sha256.test(result.reportHash) && sha256.test(result.manifestSha256),
  'Driver audit seed did not confirm the expected bootstrap package and production database.');
  return {
    generation: result.generation, reportHash: result.reportHash, manifestSha256: result.manifestSha256,
    capacityBytes: result.capacityBytes, transferBytes: result.transferBytes, objects: result.objects,
  };
}

function samePackage(left, right) {
  return Boolean(left && right) && ['generation', 'reportHash', 'manifestSha256', 'capacityBytes', 'transferBytes', 'objects']
    .every(key => left?.[key] === right?.[key]);
}

async function verifyExistingApp(env) {
  await runScript('customerServiceDeploy.js', ['--verify'], env, 'Existing app health or Customer Service access did not verify after restart.');
}

async function verifyPublicAudit() {
  const marker = 'a'.repeat(64);
  const routes = [
    '/api/reporting/view?screen=reports&view=1&tab=mirror',
    '/api/reporting/status',
    `/api/reporting/report-data/snapshot-${marker}.json?generation=${marker}`,
    `/api/reporting/report-assets/font-${marker}.woff2`,
  ];
  const results = await Promise.all(routes.map(async route => {
    const response = await fetch(origin + route, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return response.status;
  })).catch(() => { throw new DeploymentError('Public driver audit routes could not be checked.'); });
  requireValue(results.every(status => status === 401), 'Public driver audit routes did not enforce signed-out access.');
}

async function verifyDisabledAudit() {
  const response = await fetch(origin + '/api/reporting/status', {
    redirect: 'manual', signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new DeploymentError('Disabled driver audit status could not be checked.'); });
  const body = await response.text();
  requireValue(response.status === 503 && body.trim() === 'Driver audits are not enabled.', 'Driver audit disablement was not confirmed.');
}

async function readActiveHead({rejectStage=false}={}) {
  const { default: mongoose } = await import('mongoose');
  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10_000 });
    const control=mongoose.connection.db.collection('driverAuditControl');
    if(rejectStage&&await control.findOne({_id:'direct-stage'}))
      throw new DeploymentError('Recover the pending direct import before changing the builder.');
    return (await control.findOne({_id:'head'}))?.head;
  } catch (error) {
    if(error instanceof DeploymentError)throw error;
    throw new DeploymentError('The active driver audit could not be read from the app database.');
  } finally {
    await mongoose.disconnect();
  }
}

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const verifiedFiles = value => positiveInteger(value?.files) && sha256.test(value.manifestSha256);
const verifiedJourney = value => ['servedSnapshot', 'verifiedPhoto', 'verifiedGps', 'reviewHistoryMatches', 'signedOutDenied', 'logout']
  .every(key => value?.[key] === true);

export async function readDriverAuditRetentionProof({ archive, expectedSha256, seed, implementationSha256 }) {
  const message = 'The private audit restore and rollback proof did not match the qualified implementation and approved seed.';
  const maxBytes = 16 * 1024;
  let proof;
  try {
    requireValue(sha256.test(expectedSha256 ?? ''), message);
    await archive.assertPrivate();
    const body = await archive.readObject(expectedSha256 + '.json', { maxBytes });
    const chunks = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      requireValue(size <= maxBytes, message);
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks, size);
    requireValue(digest(raw) === expectedSha256, message);
    proof = JSON.parse(raw);
  } catch {
    throw new DeploymentError(message);
  }
  const { previous, oldest, collection, reviews, checks, traffic, archiveEvidence } = proof ?? {};
  requireValue(proof?.version === 1 && proof.scope === 'isolated-loopback-Mongo-only'
    && /^[a-f0-9]{40}$/.test(proof.appCommit) && proof.implementationSha256 === implementationSha256
    && sha256.test(proof.appRuntimeManifestSha256)
    && positiveInteger(archiveEvidence?.seedVerifiedCacheCopies) && sha256.test(archiveEvidence.seedVerifiedObjectIndexSha256)
    && previous && seed?.pointer?.descriptor && previous.generation === seed.pointer.generation && previous.reportHash === seed.pointer.reportHash
    && previous.descriptorSha256 === seed.pointer.descriptor.sha256 && previous.manifestSha256 === seed.manifestSha256
    && previous.sourceRevision === seed.collectorRevision && verifiedFiles(previous.archiveRestore)
    && verifiedFiles(oldest?.postCollectionArchiveRead) && positiveInteger(collection?.objectsRemoved)
    && positiveInteger(collection.bytesReclaimed) && positiveInteger(collection.usedBefore) && positiveInteger(collection.usedAfter)
    && collection.usedBefore - collection.usedAfter === collection.bytesReclaimed
    && positiveInteger(collection.activeKeys) && positiveInteger(collection.previousKeys) && positiveInteger(collection.stagedKeys)
    && collection.orphanProtected === true && reviews?.copied === true && reviews.unchanged === true
    && positiveInteger(reviews.count) && sha256.test(reviews.sha256) && reviews.journalWrites === 0
    && verifiedJourney(checks?.baseline) && verifiedJourney(checks.rollback) && verifiedJourney(checks.archiveFallback)
    && checks.currentPointerUnchanged === true && checks.completeEmptyReplicaRestore === true
    && traffic?.productionRequests === 0 && traffic.productionWrites === 0, message);
}

export function checkDriverAuditRetentionHead(head, generations, expected) {
  const [active, previous] = retainedGenerations.test(generations ?? '') ? generations.split(':') : [];
  const verified = (pointer, generation) => {
    const { directImport, restore } = pointer ?? {};
    return Boolean(generation) && pointer?.version === 1 && pointer.generation === generation
      && sha256.test(pointer.reportHash) && sha256.test(pointer.descriptor?.sha256)
      && positiveInteger(pointer.sourceRevision) && sha256.test(pointer.sourceBodySha256)
      && directImport?.version === 1 && directImport.collectorRevision === pointer.sourceRevision
      && sha256.test(directImport.manifestSha256) && sha256.test(directImport.sourceBasis)
      && restore?.version === 1 && restore.verified === true && restore.archive === 'matter-report-archive'
      && restore.generation === generation && restore.reportHash === pointer.reportHash
      && restore.descriptorSha256 === pointer.descriptor.sha256 && restore.manifestSha256 === directImport.manifestSha256;
  };
  requireValue(verified(head, active) && verified(head.previous, previous) && head.sourceRevision > head.previous.sourceRevision,
    'The active or previous MongoDB audit differs from the reviewed restorable releases.');
  const identity = digest(JSON.stringify([head, head.previous]));
  requireValue(!expected || identity === expected, 'The active or previous audit changed while stopping the sync worker.');
  return identity;
}

export async function restartDriverAuditRetention({
  checkHead, stop, restart, wait, save, writeSettings, writeReceipt, restore, clearTransition,
}) {
  try {
    await stop();
    await checkHead();
    await writeReceipt(true);
    await writeSettings(true);
    await restart();
    await wait(true);
    await save();
  } catch (error) {
    try {
      await restore();
      await clearTransition();
    } catch {
      throw new DeploymentError('Audit retention activation failed and restoring the prior audit worker could not be confirmed. Retry the same operation to recover it.');
    }
    throw error;
  }
  await clearTransition();
}

async function enableRetention({ commit, manifest, capacity, secret, root, pmEnv, activeSettings, gcRestoreReceiptSha256, generations }) {
  requireValue(retainedGenerations.test(generations ?? ''), 'Exact current and previous audit generations are required.');
  const config = path.join(root, 'sync.json');
  const syncReceipt = path.join(root, 'deployment-sync.json');
  const transitionFile = path.join(root, 'deployment-retention-transition.json');
  let transitionText = await readFile(transitionFile, { optional: true, privateOnly: true });
  const transition = transitionText === null ? null : JSON.parse(transitionText);
  const worker = await processEntry(syncName, pmEnv);
  requireValue(Number.isInteger(worker?.pm_id) && registeredWorkerConfig(worker) === config
    && (transition || worker.pm2_env.status === 'online'), 'The reviewed audit sync worker does not match its pinned configuration.');
  if (transitionText !== null) {
    requireValue(transition?.version === 2 && transition.workerId === worker.pm_id
      && transition.manifest === manifest && transition.generations === generations
      && transition.proofSha256 === gcRestoreReceiptSha256 && /^[a-f0-9]{40}$/.test(transition.commit)
      && sha256.test(transition.implementationSha256) && ['0', '1'].includes(transition.priorGcSetting)
      && typeof transition.priorText === 'string' && Number.isFinite(Date.parse(transition.requestedAt)),
    'Retry the interrupted audit retention operation with the same reviewed inputs and registered worker.');
  }
  const checkedWorker = async () => {
    const current = await processEntry(syncName, pmEnv);
    requireValue(current?.pm_id === worker.pm_id && registeredWorkerConfig(current) === config,
      'The registered audit sync worker changed during retention activation.');
    return current.pm2_env.status;
  };

  const currentText = await readFile(syncReceipt, { privateOnly: true });
  const priorText = transition?.priorText ?? currentText;
  const prior = JSON.parse(priorText);
  const enabled = await jsonFile(path.join(root, 'deployment-enabled.json'));
  const seed = await jsonFile(path.join(root, 'seed.json'));
  const checkedSettings = async () => {
    const durable = await readDurableSettings();
    requireValue(durable.MONGODB_URI === process.env.MONGODB_URI && ['0', '1'].includes(durable[gcKey])
      && Object.entries(activeSettings).every(([key, value]) => key === gcKey || durable[key] === value && process.env[key] === value),
    'The persisted audit worker settings changed.');
    return durable[gcKey];
  };
  const gcSetting = await checkedSettings();
  const priorGcSetting = transition?.priorGcSetting ?? gcSetting;
  requireValue(prior.manifest === manifest && prior.generation === seed?.pointer?.generation
    && sha256.test(prior.staffVerificationSha256) && Number.isFinite(Date.parse(prior.supervisedAt))
    && enabled.manifest === manifest && enabled.prepared?.generation === seed.pointer.generation
    && enabled.prepared.reportHash === seed.pointer.reportHash && enabled.prepared.manifestSha256 === seed.manifestSha256
    && enabled.prepared.capacityBytes === capacity, 'The pinned audit seed and supervised worker receipts do not match.');

  const requestedAt = transition?.requestedAt ?? new Date().toISOString();
  const implementationSha256 = transition?.implementationSha256 ?? await driverAuditRetentionImplementation();
  let startedAt;
  const nextReceipt = JSON.stringify({
    ...prior, replicaGcEnabled: true, gcRestoreReceiptSha256, gcImplementationSha256: implementationSha256,
    retention: { commit: transition?.commit ?? commit, generations, requestedAt },
  }) + '\n';
  const receiptState = async () => {
    const current = await readFile(syncReceipt, { privateOnly: true });
    requireValue(current === priorText || current === nextReceipt, 'The audit sync receipt changed during retention activation.');
    return current;
  };
  const workerOperations = {
    async stop() {
      if (await checkedWorker() !== 'stopped') await pm2(['stop', syncName], pmEnv);
      requireValue(await checkedWorker() === 'stopped', 'The reviewed audit sync worker could not be stopped.');
    },
    async restart() {
      const status = await checkedWorker();
      requireValue(status === 'online' || status === 'stopped', 'The reviewed audit sync worker could not be restarted.');
      startedAt = Date.now();
      await pm2(['restart', syncName], pmEnv);
    },
    async wait(requiresQualifiedRetention) {
      await waitForWorker(config, pmEnv, startedAt, requiresQualifiedRetention);
      requireValue(await checkedWorker() === 'online', 'The reviewed audit sync worker did not become online.');
    },
    async save() { await pm2(['save'], pmEnv); },
    async writeSettings(on) {
      await checkedSettings();
      await writeDriverAuditEnvironment(serverRoot, { ...activeSettings, [gcKey]: on ? '1' : '0' });
    },
    async writeReceipt(on) {
      await atomicWrite(syncReceipt, on ? nextReceipt : priorText, async () => {
        await receiptState();
      });
    },
    async clearTransition() {
      requireValue(await readFile(transitionFile, { privateOnly: true }) === transitionText, 'The audit retention transition changed.');
      await fs.unlink(transitionFile);
    },
    async restore() {
      const currentGcSetting = await checkedSettings();
      requireValue(currentGcSetting === priorGcSetting || currentGcSetting === '1', 'The audit retention setting changed outside this operation.');
      const settingsChanged = currentGcSetting !== priorGcSetting;
      const receiptChanged = await receiptState() !== priorText;
      if (settingsChanged || receiptChanged || await checkedWorker() !== 'online') {
        await workerOperations.stop();
        if (settingsChanged) await workerOperations.writeSettings(priorGcSetting === '1');
        if (receiptChanged) await workerOperations.writeReceipt(false);
        await workerOperations.restart();
        await workerOperations.wait();
      }
      await workerOperations.save();
    },
  };

  if (transition) {
    await workerOperations.restore();
    await workerOperations.clearTransition();
    const fingerprint = priorGcSetting === '1' ? await driverAuditRetentionImplementation().catch(() => null) : null;
    const replicaGcStatus = driverAuditReplicaRetentionStatus(priorGcSetting === '1', prior, fingerprint);
    return { status: 'recovered', replicaGcEnabled: replicaGcStatus === 'qualified', replicaGcStatus };
  }

  const identity = checkDriverAuditRetentionHead(await readActiveHead(), generations);
  const { createSupabaseArchiveTransport } = await import('../vendor/driver-audits/integration/hosted/supabase-archive.mjs');
  await readDriverAuditRetentionProof({
    archive: createSupabaseArchiveTransport({ secret }),
    expectedSha256: gcRestoreReceiptSha256,
    seed,
    implementationSha256,
  });
  const priorStatus = driverAuditReplicaRetentionStatus(gcSetting === '1', prior, implementationSha256);
  const sameProof = prior.gcRestoreReceiptSha256 === gcRestoreReceiptSha256;
  const heartbeat = await jsonFile(path.join(root, 'sync-status.private.json')).catch(() => null);
  if (priorStatus === 'qualified' && sameProof && heartbeat?.version === 1 && heartbeat.replicaGcStatus === 'qualified'
    && Date.parse(heartbeat.checkedAt) >= worker.pm2_env.pm_uptime) {
    requireValue(await checkedWorker() === 'online', 'The reviewed audit sync worker is not online.');
    await workerOperations.save();
    return { status: 'already-enabled', replicaGcEnabled: true };
  }
  requireValue(priorStatus !== 'qualified' || sameProof, 'The running audit worker already has a different current retention proof.');
  await checkWorkerConfig(config, pmEnv);
  checkDriverAuditRetentionHead(await readActiveHead(), generations, identity);
  requireValue(await checkedSettings() === priorGcSetting && await receiptState() === priorText, 'The audit retention settings changed before activation.');
  transitionText = JSON.stringify({
    version: 2, commit, manifest, workerId: worker.pm_id, generations, requestedAt,
    proofSha256: gcRestoreReceiptSha256, implementationSha256, priorGcSetting, priorText,
  }) + '\n';
  await atomicWrite(transitionFile, transitionText, undefined, { createOnly: true });
  await restartDriverAuditRetention({
    ...workerOperations,
    async checkHead() { checkDriverAuditRetentionHead(await readActiveHead(), generations, identity); },
  });
  return { status: 'enabled', replicaGcEnabled: true };
}

async function changeAuditBuilder({operation,shell,pmEnv}){
  const [{transitionDriverAuditBuilder},{acquireWorkerLock}]=await Promise.all([
    import('../services/driverAuditBuilderTransition.js'),
    import('../vendor/driver-audits/integration/hosted/worker-lock.mjs'),
  ]);
  const from=shell.DRIVER_AUDIT_BUILDER_FROM,to=shell.DRIVER_AUDIT_BUILDER_TO;
  const rollback=operation==='audit-builder-rollback';
  requireValue([from,to].every(hash=>sha256.test(hash??''))&&from!==to,
    'Provide two distinct reviewed builder hashes.');
  const worker=await processEntry(syncName,pmEnv);
  requireValue(worker&&['online','stopped'].includes(worker.pm2_env?.status),'The managed audit worker must exist.');
  const config=registeredWorkerConfig(worker);
  const root=path.dirname(config);
  const receipt=path.join(root,'builder-transition-'+from+'-'+to+'.private.json');
  const interrupted=await readFile(receipt,{privateOnly:true,optional:true})!==null;
  requireValue(!rollback||interrupted,'A builder rollback requires the original transition receipt.');

  const retained=await jsonFile(path.join(root,'deployment-sync.json'));
  const retentionStatus=driverAuditReplicaRetentionStatus(process.env[gcKey]==='1',retained,await driverAuditRetentionImplementation());
  requireValue(retentionStatus==='off'||retentionStatus==='qualified','Qualify current replica retention before changing the builder.');
  const qualified=retentionStatus==='qualified';
  if(worker.pm2_env.status==='online'){
    requireValue(process.platform==='linux'&&Number.isInteger(worker.pid)&&worker.pid>0&&
      await fs.realpath('/proc/'+worker.pid+'/exe')===await fs.realpath(process.execPath),
    'Run with the registered worker Linux Node executable.');
    const existing=await jsonFile(config);
    requireValue([from,to].includes(existing.builderSha256),'The active builder does not match either reviewed hash.');
    const candidate=existing.builderSha256===to?existing.codeRoot:path.join(root,'builder-staged-'+to);
    if(!rollback)await runScript('checkDriverAuditBuilder.js',[candidate,to,root],pmEnv,'The reviewed builder did not pass its host smoke check.');
    await readActiveHead({rejectStage:true});
    await pm2(['stop',syncName],pmEnv);
  }else{
    if(!interrupted){
      requireValue(process.platform==='linux'&&(await jsonFile(config)).builderSha256===from,
        'The stopped worker does not match the reviewed source builder.');
      await runScript('checkDriverAuditBuilder.js',[path.join(root,'builder-staged-'+to),to,root],pmEnv,
        'The reviewed builder did not pass its host smoke check.');
    }
  }

  const resume=async()=>{
    await checkWorkerConfig(config,shell);
    const startedAt=Date.now();
    await pm2(['restart',syncName],pmEnv);
    await waitForWorker(config,pmEnv,startedAt,qualified);
    requireValue((await processEntry(syncName,pmEnv))?.pm_id===worker.pm_id,'The audit worker registration changed.');
    await pm2(['save'],pmEnv);
  };
  let switched=false;
  try{
    const stopped=await processEntry(syncName,pmEnv);
    requireValue(stopped?.pm_id===worker.pm_id&&registeredWorkerConfig(stopped)===config&&stopped.pm2_env.status==='stopped',
      'The original audit worker did not stop.');
    const lock=await acquireWorkerLock(path.join(path.dirname(root),'sync-worker.lock'));
    try{
      await readActiveHead({rejectStage:true});
      switched=true;
      await transitionDriverAuditBuilder({root,from,to,rollback});
    }finally{await lock.release();}
    await resume();
  }catch(error){
    if(rollback)throw error;
    await pm2(['stop',syncName],pmEnv);
    const lock=await acquireWorkerLock(path.join(path.dirname(root),'sync-worker.lock'));
    try{
      if(switched&&await readFile(receipt,{privateOnly:true,optional:true})!==null){
        await readActiveHead({rejectStage:true});
        await transitionDriverAuditBuilder({root,from,to,rollback:true});
      }
    }finally{await lock.release();}
    await resume();
    throw error;
  }
  return {status:rollback?'builder-rolled-back':'builder-started',builderSha256:rollback?from:to,productionAcceptancePending:true};
}

async function release(operation, shell) {
  const commit = shell.DRIVER_AUDIT_DEPLOY_SHA;
  requireValue(/^[a-f0-9]{40}$/.test(commit ?? ''), 'An exact reviewed application commit is required.');
  const gcRestoreReceiptSha256 = shell.DRIVER_AUDIT_GC_RESTORE_RECEIPT_SHA256 || null;
  requireValue(!gcRestoreReceiptSha256 || operation === retentionOperation && sha256.test(gcRestoreReceiptSha256),
    'Replica retention requires the reviewed restore receipt SHA-256 on audit-retention-enable.');
  requireValue(operation !== retentionOperation || gcRestoreReceiptSha256, 'The reviewed private restore and rollback proof SHA-256 is required.');
  const head = await run('git', ['rev-parse', 'HEAD'], shell, 'The deployed application commit could not be checked.');
  requireValue(head.trim() === commit, 'The deployed application commit differs from the reviewed commit.');
  const pmEnv = pm2Environment(shell);
  if(['audit-builder-upgrade','audit-builder-rollback'].includes(operation))return changeAuditBuilder({operation,shell,pmEnv});
  if (operation === 'deploy-worker-pause' || operation === 'deploy-worker-resume') {
    const worker = await processEntry(syncName, pmEnv);
    if (operation === 'deploy-worker-pause') {
      if (!worker || worker.pm2_env.status !== 'online') return { status: 'inactive' };
      registeredWorkerConfig(worker);
      await pm2(['stop', syncName], pmEnv);
      return { status: 'paused' };
    }
    requireValue(worker?.pm2_env?.status === 'stopped', 'The previously supervised audit worker is not paused.');
    const config = registeredWorkerConfig(worker);
    await checkWorkerConfig(config, shell);
    const startedAt = Date.now();
    try {
      await pm2(['restart', syncName], pmEnv);
      await waitForWorker(config, pmEnv, startedAt);
      await pm2(['save'], pmEnv);
      return { status: 'resumed' };
    } catch {
      await pm2(['stop', syncName], pmEnv);
      await pm2(['save'], pmEnv);
      throw new DeploymentError('The previously supervised audit worker did not resume after deployment.');
    }
  }
  const api = await processEntry(apiName, pmEnv);
  requireValue(api && api.pm2_env.pm_cwd === appRoot && (operation === 'audit-rollback' || api.pm2_env.status === 'online'),
    'The existing delivery API process is not available in the expected checkout.');
  if (operation === 'audit-rollback') {
    const worker = await processEntry(syncName, pmEnv);
    if (worker) {
      registeredWorkerConfig(worker);
      await pm2(['delete', syncName], pmEnv);
      await pm2(['save'], pmEnv);
    }
    await writeDriverAuditEnvironment(serverRoot, disabled);
    await pm2(['restart', apiName], pmEnv);
    await verifyExistingApp(shell);
    await verifyDisabledAudit();
    await pm2(['save'], pmEnv);
    return { status: 'disabled' };
  }

  const manifest = shell.DRIVER_AUDIT_DEPLOY_MANIFEST;
  requireValue(sha256.test(manifest ?? ''), 'An exact private handoff manifest is required.');
  const capacity = bytes(shell.DRIVER_AUDIT_DEPLOY_CAPACITY_BYTES, 'driver audit capacity', 256 * 1024 * 1024);
  const secret = reportingSecret(shell.DRIVER_AUDIT_DEPLOY_SECRET);
  const activeSettings = {
    [enabledKey]: '1', [importKey]: '0', [originKey]: origin, [capacityKey]: String(capacity), [secretKey]: secret, [gcKey]: '0',
  };
  requireValue(process.env.MONGODB_URI && process.env.JWT_SECRET, 'Existing application database and staff authentication settings are required.');
  requireValue(process.env[importKey] !== '1', 'Disable the previous publication importer before the direct MongoDB release.');
  const root = await privateReleaseRoot(manifest);
  if (operation === retentionOperation) {
    return enableRetention({ commit, manifest, capacity, secret, root, pmEnv, activeSettings, gcRestoreReceiptSha256,
      generations: shell.DRIVER_AUDIT_RETAINED_GENERATIONS });
  }
  const preflightFile = path.join(root, 'deployment-preflight.json');
  const enabledFile = path.join(root, 'deployment-enabled.json');
  const stageArgs = ['--root', root, '--sha256', manifest];
  const child = { ...shell, DRIVER_AUDIT_ORIGIN: origin };

  if (operation === 'audit-preflight') {
    const hostBefore = await resources(root);
    await runScript('driverAuditStage.js', stageArgs, child, 'The private audit handoff could not be staged and verified.');
    const prepared = await seed(root, child);
    requireValue(prepared.capacityBytes === capacity, 'Seed preflight used a different capacity from the reviewed allowance.');
    const receipt = { commit, manifest, prepared, hostBefore, hostAfter: await resources(root), checkedAt: new Date().toISOString() };
    await atomicWrite(preflightFile, JSON.stringify(receipt) + '\n');
    return { status: 'ready', ...receipt, databaseChecked: true };
  }

  const preflight = await jsonFile(preflightFile);
  requireValue(preflight.commit === commit && preflight.manifest === manifest && preflight.prepared?.capacityBytes === capacity,
    'Run a matching audit preflight before this operation.');

  if (operation === 'audit-seed-enable') {
    requireValue(!(await processEntry(syncName, pmEnv)), 'Stop the managed audit sync worker before seeding.');
    const prepared = await seed(root, child);
    requireValue(samePackage(preflight.prepared, prepared), 'The staged audit differs from the verified preflight package.');
    const imported = await seed(root, child, true);
    requireValue(samePackage(prepared, imported), 'The MongoDB audit readback differs from the verified preflight package.');
    await writeDriverAuditEnvironment(serverRoot, activeSettings);
    try {
      await pm2(['restart', apiName], pmEnv);
      await verifyExistingApp(shell);
      await verifyPublicAudit();
      await pm2(['save'], pmEnv);
      const receipt = { commit, manifest, prepared: imported, enabledAt: new Date().toISOString() };
      await atomicWrite(enabledFile, JSON.stringify(receipt) + '\n');
      return { status: 'enabled', ...receipt, signedOutAccessDenied: true, staffAcceptancePending: true };
    } catch {
      try {
        await writeDriverAuditEnvironment(serverRoot, disabled);
        await pm2(['restart', apiName], pmEnv);
        await verifyExistingApp(shell);
        await verifyDisabledAudit();
        await pm2(['save'], pmEnv);
      } catch {
        throw new DeploymentError('Driver audit activation failed and automatic rollback could not be confirmed. Run audit-rollback.');
      }
      throw new DeploymentError('Driver audit activation failed. Audit settings were disabled and existing app health was reverified.');
    }
  }

  const evidence = shell.DRIVER_AUDIT_STAFF_VERIFICATION;
  const generation = shell.DRIVER_AUDIT_STAFF_GENERATION;
  requireValue(sha256.test(evidence ?? '') && sha256.test(generation ?? ''), 'Reviewed staff verification evidence and generation are required.');
  const minimumMemory = bytes(shell.DRIVER_AUDIT_SYNC_MIN_MEMORY, 'reviewed sync free memory');
  const minimumDisk = bytes(shell.DRIVER_AUDIT_SYNC_MIN_DISK, 'reviewed sync free disk');
  const enabled = await jsonFile(enabledFile);
  requireValue(enabled.commit === commit && enabled.manifest === manifest && samePackage(enabled.prepared, preflight.prepared)
    && enabled.prepared.generation === generation && process.env[enabledKey] === '1' && process.env[importKey] === '0'
    && process.env[originKey] === origin && process.env[capacityKey] === String(capacity) && process.env[secretKey] === secret,
  'Staff verification must match the enabled audit release and its persisted runtime settings.');
  const durable = await readDurableSettings();
  requireValue(durable.MONGODB_URI === process.env.MONGODB_URI && durable[secretKey] === secret,
    'The worker must be able to load existing private database settings from the app environment.');
  await run(process.execPath, ['--input-type=module', '-e', 'import { DatabaseSync } from "node:sqlite";'], shell,
    'The deployed Node runtime needs node:sqlite for driver audit sync.');
  const ensureRoom = async () => {
    const host = await resources(root);
    requireValue(host.freeMemoryBytes >= minimumMemory && host.freeDiskBytes >= minimumDisk, 'The host does not meet the reviewed audit sync memory and disk minimums.');
  };
  const checkHead = async () => {
    const active = await readActiveHead();
    requireValue(active?.generation === generation && active.reportHash === enabled.prepared.reportHash,
      'The active MongoDB audit differs from the staff-verified generation.');
  };
  await checkHead();
  await ensureRoom();
  const syncConfig = path.join(root, 'sync.json');
  const syncReceipt = path.join(root, 'deployment-sync.json');
  const replicaGcEnabled = false;
  const previousWorker = await processEntry(syncName, pmEnv);
  if (previousWorker) {
    requireValue(matchingWorker(previousWorker, syncConfig) && previousWorker.pm2_env.status === 'online',
      'An existing audit sync process differs from the reviewed worker. Roll it back before starting another.');
    const previous = await jsonFile(syncReceipt);
    requireValue((durable[gcKey] ?? '0') === '0' && (previous.replicaGcEnabled ?? false) === false
      && (previous.gcRestoreReceiptSha256 ?? null) === null,
    'The running audit worker has different retention settings or evidence. Roll it back before a reviewed restart.');
    return { status: 'already-supervised', generation, replicaGcEnabled };
  }
  await runScript('driverAuditStage.js', [...stageArgs, '--with-baseline'], child, 'The private driver audit sync baseline could not be staged and verified.');
  await checkHead();
  await ensureRoom();
  const receipt = {
    commit, manifest, generation, staffVerificationSha256: evidence, replicaGcEnabled, gcRestoreReceiptSha256,
    requestedAt: new Date().toISOString(),
  };
  await atomicWrite(syncReceipt, JSON.stringify(receipt) + '\n');
  let settingsWritten = false;
  try {
    await writeDriverAuditEnvironment(serverRoot, activeSettings);
    settingsWritten = true;
    await checkWorkerConfig(syncConfig, pmEnv);
    const startedAt = Date.now();
    await pm2(['start', syncScript, '--name', syncName, '--cwd', serverRoot,
      '--interpreter', process.execPath, '--restart-delay', '5000', '--kill-timeout', '30000', '--', '--config', syncConfig], pmEnv);
    await waitForWorker(syncConfig, pmEnv, startedAt);
    await pm2(['save'], pmEnv);
    await atomicWrite(syncReceipt, JSON.stringify({ ...receipt, supervisedAt: new Date().toISOString() }) + '\n');
    return { status: 'supervised', generation, replicaGcEnabled, firstSyncPending: true };
  } catch {
    try {
      try {
        const worker = await processEntry(syncName, pmEnv);
        if (matchingWorker(worker, syncConfig)) {
          await pm2(['delete', syncName], pmEnv);
          await pm2(['save'], pmEnv);
        }
      } finally {
        if (settingsWritten) await writeDriverAuditEnvironment(serverRoot, activeSettings);
      }
    } catch {
      throw new DeploymentError('Audit sync startup failed and worker or retention rollback could not be confirmed. Run audit-rollback.');
    }
    throw new DeploymentError('The reviewed driver audit sync process was not confirmed.');
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2];
  const shell = { ...process.env };
  try {
    const deploymentMaintenance = ['deploy-worker-pause', 'deploy-worker-resume'].includes(operation);
    requireValue(process.argv.length === 3 && (deploymentMaintenance || ['audit-preflight', 'audit-seed-enable', 'audit-sync-start', 'audit-rollback', 'audit-builder-upgrade', 'audit-builder-rollback', retentionOperation].includes(operation)),
      'Choose an explicit driver audit deployment operation.');
    if (!deploymentMaintenance) await import('../loadEnv.js');
    const result = await release(operation, shell);
    console.log(deploymentMaintenance ? result.status : JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof DeploymentError ? error.message : 'Driver audit deployment failed during private preflight or execution.');
    process.exitCode = 1;
  }
}
