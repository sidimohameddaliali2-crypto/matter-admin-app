import fs from 'node:fs/promises';
import path from 'node:path';
import { driverAuditNativeBackendSymbol, openDriverAuditDataBackend } from '../services/driverAuditDataBackend.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createDriverAuditSourceScheduler,
  invokeDriverAuditSourceHandler,
  readDriverAuditSourceConfig,
  readPrivateDriverAuditSource,
  runDriverAuditSourceChild,
  verifyDriverAuditSourceRelease,
  writeDriverAuditSourceState,
  driverAuditSourceUsesAppBackend,
  driverAuditSourceBackendEnvironment,
  requireDriverAuditSourceBackend,
} from '../services/driverAuditSource.js';

async function childMain(config) {
  if (!process.send) throw new Error('Source child requires its supervisor.');
  const orphaned = () => process.exit(1);
  process.once('disconnect', orphaned);
  const incoming = new Promise(resolve => process.once('message', resolve));
  process.send({ version: 1, ready: true });
  const message = await incoming;
  if (message?.version !== 1 || message.configSha256 !== config.configSha256) throw new Error('Source child configuration changed.');
  const entrypoint = config.runtime.entrypoints.find(entry => entry.id === message.id);
  if (!entrypoint) throw new Error('Source child schedule is unavailable.');
  const appDataStore = process.env.DRIVER_AUDIT_DATA_STORE || 'supabase';
  if (!message.probe && appDataStore !== config.dataStore) throw Error('App and source reporting stores differ.');
  if (!message.probe && (process.env.DRIVER_AUDIT_EXECUTION_HOST || null) !== config.executionHost)
    throw Error('App and source execution hosts differ.');
  Object.assign(process.env, config.environment);
  const load = async () => {
    const module = await import(pathToFileURL(path.join(config.runtimeRoot, entrypoint.module)).href);
    if (typeof module.default !== 'function') throw new Error('Source handler export is unavailable.');
    return module.default;
  };
  const send = async result => {
    await new Promise((resolve, reject) => process.send({ version: 1, ok: true, id: entrypoint.id, result }, error => error ? reject(error) : resolve()));
  };
  if (message.probe) {
    await load();
    await send({ httpStatus: 200, status: 'checked' });
    process.removeListener('disconnect', orphaned);
    process.disconnect();
  } else {
    const { withDriverAuditHeavyWork } = await import('../services/driverAuditHeavyWork.js');
    await withDriverAuditHeavyWork({ root: path.join(config.root, '../../driver-audit-heavy-work'), owner: 'source' }, async () => {
      const run = new Promise(resolve => process.once('message', resolve));
      process.send({ version: 1, admitted: true });
      const permit = await run;
      if (permit?.version !== 1 || permit.run !== true) throw new Error('Source execution permit is invalid.');
      let backend;
      let result;
      try {
        if (driverAuditSourceUsesAppBackend(config)) {
          const env = driverAuditSourceBackendEnvironment(config);
          backend = await openDriverAuditDataBackend({ env });
          requireDriverAuditSourceBackend(config, backend);
          globalThis[driverAuditNativeBackendSymbol] = backend;
          Object.assign(process.env, env);
        }
        result = await invokeDriverAuditSourceHandler(await load(), {
          entrypoint, environment: config.environment,
          gatewayCredential: new URL(entrypoint.path, 'https://source.invalid').searchParams.get('task') === 'photo-grade'
            ? config.gatewayCredential : null,
        });
      } finally { await backend?.close(); }
      await send(result);
      // Keep the OS lock until this memory-heavy child has exited.
      process.exit(0);
    });
  }
}

export async function checkDriverAuditSource(config) {
  const modules = new Map(config.runtime.entrypoints.map(entry => [entry.module, entry]));
  for (const entrypoint of modules.values()) await runDriverAuditSourceChild(config, entrypoint, { probe: true });
  return { status: 'checked', configSha256: config.configSha256, manifestSha256: config.manifestSha256,
    schedules: config.runtime.entrypoints.length, modules: modules.size, nodeVersion: process.version };
}

export async function runDriverAuditSource(config) {
  const activationFile = path.join(config.root, 'deployment-source.private.json');
  const activation = JSON.parse(await readPrivateDriverAuditSource(activationFile));
  if (activation.version !== 1 || activation.verified !== true || activation.status !== 'active'
    || activation.configSha256 !== config.configSha256)
    throw new Error('Source activation receipt does not match.');
  const { release } = await verifyDriverAuditSourceRelease(config, activation.release, new Date(activation.verifiedAt));
  const { acquireWorkerLock } = await import('../vendor/driver-audits/integration/hosted/worker-lock.mjs');
  const lock = await acquireWorkerLock(path.join(path.dirname(config.root), 'source-worker.lock'));
  let scheduler;
  let stopped = false;
  let wake;
  const stop = () => { stopped = true; scheduler?.stop(); wake?.(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const heartbeat = async status => {
    const state = scheduler?.snapshot();
    await writeDriverAuditSourceState(path.join(config.root, 'source-status.private.json'), {
      version: 1, status, pid: process.pid, configSha256: config.configSha256, manifestSha256: config.manifestSha256,
      checkedAt: new Date().toISOString(), lastScanAt: state?.lastScanAt ?? null,
      missedMinutes: state?.missedMinutes ?? 0, jobs: state?.jobs ?? {}, pendingJobs: state?.pending.length ?? 0,
    });
  };
  try {
    scheduler = await createDriverAuditSourceScheduler({
      entrypoints: config.runtime.entrypoints, stateFile: path.join(config.root, 'source-state.private.json'),
      configSha256: config.configSha256, initialCursor: release.initialCursor,
      invoke: (entrypoint, options) => runDriverAuditSourceChild(config, entrypoint, options),
    });
    await heartbeat('ready');
    while (!stopped) {
      await scheduler.tick();
      await heartbeat('ready');
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 1000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    await scheduler.drain();
    await heartbeat('stopped');
  } catch (error) {
    scheduler?.stop();
    await scheduler?.drain();
    await heartbeat('failed').catch(() => {});
    throw error;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await lock.release();
  }
}

async function main() {
  const [flag, file, mode] = process.argv.slice(2);
  if (flag !== '--config' || !path.isAbsolute(file ?? '') || ![undefined, '--check', '--child'].includes(mode)
    || process.argv.length > 5) throw new Error('Invalid source worker arguments.');
  await import('../loadEnv.js');
  const config = await readDriverAuditSourceConfig(file);
  if (mode === undefined && (process.env.DRIVER_AUDIT_DATA_STORE || 'supabase') !== config.dataStore) {
    throw Error('App and source reporting stores differ.');
  }
  if (mode === undefined && (process.env.DRIVER_AUDIT_EXECUTION_HOST || null) !== config.executionHost)
    throw Error('App and source execution hosts differ.');
  if (mode === '--child') await childMain(config);
  else if (mode === '--check') console.log(JSON.stringify(await checkDriverAuditSource(config)));
  else await runDriverAuditSource(config);
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Driver audit source worker failed. Check its private configuration and status.');
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}
