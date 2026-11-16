import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  readDriverAuditSourceConfig,
  readPrivateDriverAuditSource,
  requirePrivateDriverAuditSourceDirectory,
  verifyDriverAuditSourceRelease,
  writeDriverAuditSourceState,
} from '../services/driverAuditSource.js';
import { checkDriverAuditSource } from './driverAuditSource.js';
import { stageDriverAuditSource, stageDriverAuditSourceProof } from './driverAuditSourceStage.js';

const exec = promisify(execFile);
const serverRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const appRoot = path.dirname(serverRoot);
const sourceScript = path.join(serverRoot, 'scripts/driverAuditSource.js');
const sourceRoot = path.join(serverRoot, '.private', 'driver-audit-source');
const sourceName = 'matter-driver-audit-source';
const digestPattern = /^[a-f0-9]{64}$/;

function requireDeployment(condition, message) {
  if (!condition) throw new Error(message);
}

// The adapter keeps process supervision separate from the source data plane.
// Every activation retains the exact reviewed file identities for recovery.
export async function manageDriverAuditSource({ operation, config, adapter, now = new Date() }) {
  let worker = await adapter.worker();
  requireDeployment(!worker || worker.config === config.file, 'Registered source worker configuration differs.');
  if (operation === 'check') {
    await adapter.check();
    return { status: 'checked', manifestSha256: config.manifestSha256, configSha256: config.configSha256 };
  }
  if (operation === 'pause') {
    if (!worker || worker.status === 'stopped') return { status: 'inactive' };
    await adapter.stop();
    await adapter.save();
    return { status: 'paused' };
  }
  const activation = await adapter.readActivation();
  const matches = activation?.version === 1 && activation.verified === true
    && activation.configSha256 === config.configSha256 && activation.manifestSha256 === config.manifestSha256;
  if (operation === 'rollback') {
    requireDeployment(matches, 'Source rollback requires its exact activation receipt.');
    if (worker && worker.status !== 'stopped') await adapter.stop();
    await adapter.writeActivation({ ...activation, status: 'rolled-back', rolledBackAt: now.toISOString() });
    await adapter.save();
    return { status: 'rolled-back', oldWriterResumePending: true };
  }
  requireDeployment(operation === 'start' || operation === 'resume', 'Invalid source deployment operation.');
  await adapter.check();
  if (operation === 'start' && worker?.status === 'online') {
    requireDeployment(matches && activation.status === 'active', 'Active source worker lacks its matching activation receipt.');
    await adapter.wait(worker.startedAt);
    return { status: 'already-started' };
  }
  if (operation === 'resume') {
    requireDeployment(worker?.status === 'stopped' && matches && activation.status === 'active',
      'Source resume requires the paused worker and active activation receipt.');
  } else {
    const verified = await adapter.verifyRelease();
    await adapter.writeActivation({
      version: 1, verified: true, status: 'active', configSha256: config.configSha256,
      manifestSha256: config.manifestSha256, verifiedAt: now.toISOString(), release: verified.reference,
    });
  }
  const startedAt = Date.now();
  try {
    await adapter.start();
    await adapter.wait(startedAt);
    await adapter.save();
  } catch (error) {
    await adapter.stop();
    await adapter.save();
    throw error;
  }
  return { status: operation === 'start' ? 'started' : 'resumed', productionAcceptancePending: true };
}

function pm2Environment(shell) {
  return Object.fromEntries(Object.entries(shell).filter(([key]) =>
    ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'PM2_HOME'].includes(key) || key.startsWith('LC_')));
}

async function pm2(args, shell) {
  try {
    return (await exec('pm2', args, { cwd: appRoot, env: pm2Environment(shell), timeout: 360_000, maxBuffer: 1024 * 1024 })).stdout;
  } catch {
    throw new Error('Source process supervision failed. Inspect the private source status.');
  }
}

async function registeredWorker(shell) {
  const entries = JSON.parse(await pm2(['jlist'], shell)).filter(entry => entry.name === sourceName);
  requireDeployment(entries.length <= 1, 'The source worker must have exactly one managed registration.');
  const worker = entries[0];
  if (!worker) return null;
  const env = worker.pm2_env;
  const args = env?.args;
  const config = args?.[1];
  const segments = typeof config === 'string' ? path.relative(sourceRoot, config).split(path.sep) : [];
  requireDeployment(env?.pm_exec_path === sourceScript && env.pm_cwd === serverRoot && args?.length === 2
    && args[0] === '--config' && segments.length === 2 && digestPattern.test(segments[0])
    && segments[1] === 'source.json' && config === path.join(sourceRoot, ...segments)
    && Number.isInteger(worker.pm_id), 'The named source process differs from the managed worker.');
  return { id: worker.pm_id, status: env.status, config, startedAt: env.pm_uptime, interpreter: env.exec_interpreter };
}

async function inspectHost(shell, commit) {
  const candidates = [...new Set([shell.DRIVER_AUDIT_SOURCE_NODE, process.execPath,
    '/usr/local/bin/node', '/usr/bin/node', '/opt/node24/bin/node'].filter(Boolean))];
  const nodes = [];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const executable = await fs.realpath(candidate);
      const { stdout } = await exec(executable, ['--input-type=module', '-e',
        'import fs from "node:fs/promises";let sqlite=false;try{await import("node:sqlite");sqlite=true}catch{};console.log(JSON.stringify({version:process.version,sqlite,fetch:typeof fetch==="function",abortAny:typeof AbortSignal.any==="function",statfs:typeof fs.statfs==="function"}))'],
      { env: pm2Environment(shell), timeout: 10000, maxBuffer: 4096 });
      nodes.push({ executable, ...JSON.parse(stdout) });
    } catch { nodes.push({ executable: candidate, available: false }); }
  }
  const processes = JSON.parse(await pm2(['jlist'], shell)).filter(entry =>
    ['matter-delivery-api', 'matter-driver-audit-sync', sourceName].includes(entry.name)).map(entry => ({
    name: entry.name, status: entry.pm2_env?.status, pid: entry.pid,
    interpreter: entry.pm2_env?.exec_interpreter,
  }));
  const disk = await fs.statfs(appRoot);
  const memory = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory);
  return { status: 'host-checked', deployedSha: commit, platform: process.platform, architecture: process.arch, nodes, processes,
    freeDiskBytes: disk.bavail * disk.bsize, freeMemoryBytes: available ? Number(available[1]) * 1024 : os.freemem() };
}

async function stageSource(shell) {
  requireDeployment(/^[a-f0-9-]{36}$/.test(shell.DRIVER_AUDIT_SOURCE_STAGE_TOKEN ?? ''), 'Private source transfer identity is required.');
  const incoming = path.join(sourceRoot, 'incoming', shell.DRIVER_AUDIT_SOURCE_STAGE_TOKEN);
  await requirePrivateDriverAuditSourceDirectory(incoming);
  const bundleFile = path.join(incoming, 'bundle.private.gz');
  const environmentFile = path.join(incoming, 'environment.private.json');
  const compressed = await readPrivateDriverAuditSource(bundleFile, 1024 * 1024);
  const environmentBytes = await readPrivateDriverAuditSource(environmentFile, 48 * 1024);
  const base = path.dirname(sourceRoot);
  for (const directory of [base, sourceRoot]) {
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await requirePrivateDriverAuditSourceDirectory(directory);
  }
  const { acquireWorkerLock } = await import('../vendor/driver-audits/integration/hosted/worker-lock.mjs');
  const lock = await acquireWorkerLock(path.join(sourceRoot, 'source-deployment.lock'));
  try {
    const result = await stageDriverAuditSource({ sourceRoot, compressed, environmentBytes,
      expectedBundleSha256: shell.DRIVER_AUDIT_SOURCE_BUNDLE_SHA256,
      expectedManifestSha256: shell.DRIVER_AUDIT_SOURCE_MANIFEST, nodeExecutable: shell.DRIVER_AUDIT_SOURCE_NODE });
    await fs.unlink(bundleFile);
    await fs.unlink(environmentFile);
    await fs.rmdir(incoming);
    return result;
  } finally { await lock.release(); }
}

async function stageProof(shell) {
  requireDeployment(digestPattern.test(shell.DRIVER_AUDIT_SOURCE_MANIFEST ?? ''), 'A source manifest is required.');
  const root = path.join(sourceRoot, shell.DRIVER_AUDIT_SOURCE_MANIFEST);
  const encoded = shell.DRIVER_AUDIT_SOURCE_PROOF_B64;
  requireDeployment(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= 48 * 1024,
    'A bounded private source proof envelope is required.');
  const compressed = Buffer.from(encoded, 'base64');
  requireDeployment(compressed.toString('base64') === encoded, 'Invalid source proof encoding.');
  const { acquireWorkerLock } = await import('../vendor/driver-audits/integration/hosted/worker-lock.mjs');
  const lock = await acquireWorkerLock(path.join(sourceRoot, 'source-deployment.lock'));
  try {
    return await stageDriverAuditSourceProof({ root, compressed, expectedSha256: shell.DRIVER_AUDIT_SOURCE_PROOF_SHA256 });
  } finally { await lock.release(); }
}

async function runtimeAdapter(config, shell) {
  const activationFile = path.join(config.root, 'deployment-source.private.json');
  const activation = async () => {
    try { return JSON.parse(await readPrivateDriverAuditSource(activationFile)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  return {
    worker: () => registeredWorker(shell),
    check: () => checkDriverAuditSource(config),
    async verifyRelease() {
      const reference = { path: shell.DRIVER_AUDIT_SOURCE_RELEASE_FILE, sha256: shell.DRIVER_AUDIT_SOURCE_RELEASE_SHA256 };
      await verifyDriverAuditSourceRelease(config, reference);
      return { reference };
    },
    readActivation: activation,
    writeActivation: value => writeDriverAuditSourceState(activationFile, value),
    async start() {
      const worker = await registeredWorker(shell);
      if (worker) {
        requireDeployment(worker.config === config.file && worker.status === 'stopped', 'The source worker is not paused.');
        requireDeployment(await fs.realpath(worker.interpreter) === await fs.realpath(process.execPath),
          'The registered source worker uses a different Node runtime.');
        await pm2(['restart', sourceName], shell);
      } else {
        await pm2(['start', sourceScript, '--name', sourceName, '--cwd', serverRoot,
          '--interpreter', process.execPath, '--restart-delay', '5000', '--kill-timeout', '330000',
          '--', '--config', config.file], shell);
      }
    },
    async stop() {
      const worker = await registeredWorker(shell);
      if (!worker) return;
      requireDeployment(worker.config === config.file, 'Source process changed during stop.');
      if (worker.status !== 'stopped') await pm2(['stop', sourceName], shell);
      const stopped = await registeredWorker(shell);
      requireDeployment(stopped?.id === worker.id && stopped.status === 'stopped', 'Source process did not stop.');
      // Wait for the worker's OS lock too. A PM2 status alone does not prove
      // that the last in-flight handler has left its critical section.
      const { acquireWorkerLock } = await import('../vendor/driver-audits/integration/hosted/worker-lock.mjs');
      const lock = await acquireWorkerLock(path.join(sourceRoot, 'source-worker.lock'));
      await lock.release();
    },
    async wait(startedAt) {
      const earliest = Number.isFinite(startedAt) ? startedAt : Date.now();
      for (let attempt = 0; attempt < 30; attempt++) {
        const current = await registeredWorker(shell);
        let status;
        try { status = JSON.parse(await readPrivateDriverAuditSource(path.join(config.root, 'source-status.private.json'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current?.status === 'online' && current.config === config.file && status?.version === 1
          && status.status === 'ready' && status.configSha256 === config.configSha256
          && Date.parse(status.checkedAt) >= earliest) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('The source worker did not confirm startup readiness.');
    },
    save: () => pm2(['save'], shell),
  };
}

export async function deployDriverAuditSource(operation, shell = process.env) {
  requireDeployment(/^[a-f0-9]{40}$/.test(shell.DRIVER_AUDIT_DEPLOY_SHA ?? ''), 'An exact reviewed application commit is required.');
  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot, env: shell })).stdout.trim();
  requireDeployment(head === shell.DRIVER_AUDIT_DEPLOY_SHA, 'The deployed application commit differs from the reviewed commit.');
  if (operation === 'audit-source-host-check') return inspectHost(shell, head);
  if (operation === 'audit-source-stage') return stageSource(shell);
  if (operation === 'audit-source-proof-stage') return stageProof(shell);
  const worker = await registeredWorker(shell);
  const maintenance = operation.startsWith('deploy-source-');
  const action = operation.replace(/^(?:audit|deploy)-source-/, '');
  requireDeployment(['check', 'start', 'pause', 'resume', 'rollback'].includes(action), 'Invalid source operation.');
  if (maintenance && action === 'pause' && (!worker || worker.status === 'stopped')) return { status: 'inactive' };
  const manifest = shell.DRIVER_AUDIT_SOURCE_MANIFEST;
  const file = maintenance ? worker?.config : digestPattern.test(manifest ?? '') ? path.join(sourceRoot, manifest, 'source.json') : worker?.config;
  requireDeployment(file, 'A reviewed source manifest or registered worker is required.');
  const configured = JSON.parse(await readPrivateDriverAuditSource(file));
  const executable = maintenance ? worker?.interpreter : shell.DRIVER_AUDIT_SOURCE_NODE || configured.nodeExecutable;
  requireDeployment(typeof executable === 'string' && path.isAbsolute(executable)
    && executable === configured.nodeExecutable, 'The qualified source Node executable is required.');
  if (await fs.realpath(executable) !== await fs.realpath(process.execPath)) {
    // Ordinary app deployments may use another Node major version. Re-execute
    // the control operation with the source worker's qualified interpreter.
    const output = await exec(executable, [fileURLToPath(import.meta.url), operation], {
      cwd: appRoot, env: shell, timeout: 360_000, maxBuffer: 1024 * 1024,
    });
    return JSON.parse(output.stdout.trim());
  }
  await requirePrivateDriverAuditSourceDirectory(sourceRoot);
  const config = await readDriverAuditSourceConfig(file);
  requireDeployment(path.basename(path.dirname(file)) === config.manifestSha256,
    'Source staging directory differs from its pinned manifest.');
  const adapter = await runtimeAdapter(config, shell);
  const { acquireWorkerLock } = await import('../vendor/driver-audits/integration/hosted/worker-lock.mjs');
  const lock = await acquireWorkerLock(path.join(sourceRoot, 'source-deployment.lock'));
  try { return await manageDriverAuditSource({ operation: action, config, adapter }); }
  finally { await lock.release(); }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    requireDeployment(process.argv.length === 3, 'Choose one explicit source operation.');
    const result = await deployDriverAuditSource(process.argv[2]);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('Driver audit source operation failed. Verify its private configuration, receipts and managed process.');
    process.exitCode = 1;
  }
}
