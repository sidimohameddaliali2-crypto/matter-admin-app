import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
let phase = 'checkout';

export function mongoLocation(uri, localAddresses) {
  if (typeof uri !== 'string') return 'unknown';
  if (uri.startsWith('mongodb+srv://')) return 'remote';
  const hosts = /^mongodb:\/\/(?:[^/@]+@)?([^/]+)(?:\/|$)/.exec(uri)?.[1];
  if (!hosts) return 'unknown';
  const names = hosts.split(',').map(host => host.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));
  return names.every(host => localAddresses.has(host)) ? 'local' : 'remote';
}

async function inspect(appRoot) {
  phase = 'environment';
  const load = name => import(pathToFileURL(path.join(appRoot, 'server', name)).href);
  await load('loadEnv.js');
  phase = 'processes';
  const { stdout } = await exec('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  const entries = JSON.parse(stdout);
  const matching = name => entries.filter(entry => entry.name === name);
  if (matching('matter-delivery-api').length !== 1 || matching('matter-driver-audit-sync').length !== 1) {
    throw Error('The managed application and reporting worker are required');
  }
  const [worker] = matching('matter-driver-audit-sync');
  phase = 'sync-configuration';
  const args = worker.pm2_env?.args;
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1])) {
    throw Error('The managed reporting configuration is required');
  }
  const { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } = await load('services/driverAuditSource.js');
  const syncRoot = path.dirname(args[1]);
  await requirePrivateDriverAuditSourceDirectory(syncRoot);
  const config = JSON.parse(await readPrivateDriverAuditSource(args[1], 1024 * 1024));
  if (config.root !== syncRoot || !syncRoot.startsWith(path.join(appRoot, 'server/.private/driver-audits') + path.sep)) {
    throw Error('Unexpected managed reporting root');
  }
  const { default: mongoose } = await load('node_modules/mongoose/index.js');
  phase = 'database';
  const connection = mongoose.createConnection(process.env.MONGODB_URI, {
    autoCreate: false, autoIndex: false, maxPoolSize: 1, serverSelectionTimeoutMS: 10000,
  });
  try {
    await connection.asPromise();
    const { readDriverAuditDataCapacity } = await load('services/driverAuditDataBackend.js');
    const { createHostedRpc } = await load('vendor/driver-audits/integration/cloud/rpc.mjs');
    const { createCloudState } = await load('vendor/driver-audits/integration/cloud/cloud-state.mjs');
    const { collectDriverAuditReceiptRoots } = await load('services/driverAuditLiveImport.js');
    phase = 'source-configuration';
    const secret = process.env.DRIVER_AUDIT_SUPABASE_SECRET || process.env.MATTER_SUPABASE_SECRET;
    if (!secret) throw Error('The existing report source is unavailable');
    const source = createCloudState({ rpc: createHostedRpc({ secret }) });
    phase = 'source-head';
    const collector = await source.read('collector-state');
    phase = 'collector-census';
    const census = await collectDriverAuditReceiptRoots({ db: connection.db,
      documents: [{ key: 'collector-state', revision: collector.revision, body_text: collector.body }], syncRoot });
    const after = await source.read('collector-state');
    if (after.revision !== collector.revision || after.body !== collector.body) throw Error('Source advanced during inspection');
    const locals = new Set(['localhost', '127.0.0.1', '::1', os.hostname(),
      ...Object.values(os.networkInterfaces()).flatMap(rows => (rows || []).map(row => row.address))]);
    const authority = await connection.db.collection('driverAuditNativeControl').findOne({ _id: 'authority' });
    const disk = await fs.statfs(appRoot);
    phase = 'capacity';
    return { version: 1, status: 'target-inspected', checkedAt: new Date().toISOString(),
      targetDatabase: connection.db.databaseName, mongoLocation: mongoLocation(process.env.MONGODB_URI, locals),
      mongo: await readDriverAuditDataCapacity(connection.db), nodeExecutable: process.execPath, nodeVersion: process.version,
      freeDiskBytes: disk.bavail * disk.bsize, syncRoot, sourceRevision: collector.revision,
      sourceBodySha256: hash(collector.body), collectorCensus: census,
      processes: entries.filter(row => ['matter-delivery-api', 'matter-driver-audit-sync', 'matter-driver-audit-source'].includes(row.name))
        .map(row => ({ name: row.name, status: row.pm2_env?.status })),
      nativeHandoffActivated: authority?.status === 'active' };
  } finally { await connection.close(); }
}

async function main() {
  const appRoot = await fs.realpath(process.cwd());
  const expected = process.env.EXPECTED_DEPLOYED_SHA;
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000 });
  if (process.platform !== 'linux' || !/^[a-f0-9]{40}$/.test(expected || '') || stdout.trim() !== expected) {
    throw Error('Unexpected production checkout');
  }
  const operation = process.env.NATIVE_HANDOFF_OPERATION;
  if (['pause-builder', 'resume-builder'].includes(operation)) {
    phase = 'builder-' + operation.split('-')[0];
    const action = operation === 'pause-builder' ? 'deploy-worker-pause' : 'deploy-worker-resume';
    const { stdout: result } = await exec(process.execPath, [path.join(appRoot, 'server/scripts/driverAuditDeploy.js'), action], {
      cwd: appRoot, env: { ...process.env, DRIVER_AUDIT_DEPLOY_SHA: expected }, timeout: 240_000, maxBuffer: 65536,
    });
    const status = result.trim();
    if (!['paused', 'resumed', 'not-registered'].includes(status)) throw Error('Unexpected builder transition');
    console.log(JSON.stringify({ status, operation, applicationCommit: expected, dataStoreChanged: false }));
    return;
  }
  if (operation !== 'inspect') throw Error('Unsupported handoff operation');
  console.log(JSON.stringify(await inspect(appRoot)));
}

if (process.argv.includes('--run')) main().catch(error => {
  const reason = ['An unresolved staged report must be drained before selecting receipt roots',
    'Collector root needs a fresh source snapshot', 'Serving and retained workspace collector roots differ',
    'The managed reporting configuration is required'].includes(error.message) ? '; ' + error.message : '';
  const status = [400, 401, 403, 404, 409, 429, 500, 503].includes(error.status) ? '; status=' + error.status : '';
  console.error('Native handoff operation stopped at ' + phase + reason + status + '; existing report authority is unchanged.');
  process.exitCode = 1;
});
