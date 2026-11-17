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
    phase = 'target-metadata';
    const control = await connection.db.collection('driverAuditControl').findOne({ _id: 'head' });
    const optional = async relative => {
      try { return JSON.parse(await readPrivateDriverAuditSource(path.join(syncRoot, relative), 1024 * 1024)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const pointer = await optional('work/current.private.json');
    const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
    const revision = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
    const safe = value => value ? { keys: Object.keys(value).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).slice(0, 40), collectorRevision: revision(value.collectorRevision),
      sourceRevision: revision(value.sourceRevision), basis: digest(value.basis), sourceBasis: digest(value.sourceBasis),
      manifestSha256: digest(value.manifestSha256), privateRoot: typeof value.privateRoot === 'string'
        && value.privateRoot.startsWith(syncRoot + '/work/attempts/') ? value.privateRoot : undefined,
      generation: digest(value.generation), source: value.source ? { revision: revision(value.source.revision) } : undefined } : null;
    const workspaces = [];
    const wanted = new Set([pointer?.privateRoot, pointer?.previous?.privateRoot].filter(Boolean));
    for (const directory of wanted) {
      const relative = path.relative(syncRoot, path.dirname(directory));
      if (!/^work\/attempts\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(relative)) {
        throw Error('Unexpected candidate metadata path');
      }
      workspaces.push({ relative, accepted: safe(await optional(relative + '/accepted.private.json')),
        directSeed: safe(await optional(relative + '/direct-seed.private.json')),
        retired: safe(await optional(relative + '/retired-workspace.private.json')) });
    }
    const code = await readPrivateDriverAuditSource(path.join(config.codeRoot, 'integration/cloud/automatic-release.mjs'), 1024 * 1024);
    const bootstrap = await optional('seed.json');
    const baselineFile = path.join(syncRoot, 'baseline/files.private.json');
    const baselineInfo = await fs.lstat(baselineFile);
    const baselinePrivate = baselineInfo.isFile() && !(baselineInfo.mode & 0o077) && baselineInfo.uid === process.getuid();
    const baselineManifest = { bytes: baselineInfo.size, ownerPrivate: baselinePrivate,
      sha256: baselinePrivate && baselineInfo.size <= 16 * 1024 * 1024
        ? hash(await readPrivateDriverAuditSource(baselineFile, 16 * 1024 * 1024)) : undefined };
    console.log(JSON.stringify({ status: 'target-metadata', sourceRevision: collector.revision,
      targetDatabase: connection.db.databaseName, mongo: await readDriverAuditDataCapacity(connection.db),
      mongoLocation: mongoLocation(process.env.MONGODB_URI, new Set(['localhost', '127.0.0.1', '::1', os.hostname(),
        ...Object.values(os.networkInterfaces()).flatMap(rows => (rows || []).map(row => row.address))])),
      serving: { current: safe(control?.head), previous: safe(control?.head?.previous),
        currentManifest: digest(control?.head?.directImport?.manifestSha256), previousManifest: digest(control?.head?.previous?.directImport?.manifestSha256) },
      pointer: safe(pointer), previousPointer: safe(pointer?.previous), workspaces,
      bootstrap: safe(bootstrap), baselineManifest, builderModuleSha256: hash(code) }));
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
  if (operation === 'inspect-bindings') {
    phase = 'private-host-bindings';
    const encoded = process.env.NATIVE_TRANSFER_PLAN_B64;
    if (!encoded || encoded.length > 24576 || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw Error('Bounded public recipient required');
    const load = name => import(pathToFileURL(path.join(appRoot, 'server', name)).href);
    const { validateDriverAuditTransferPlan } = await load('services/driverAuditTransferSession.js');
    const { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
    const { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } = await load('services/driverAuditSource.js');
    const request = validateDriverAuditTransferPlan(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
    const { stdout } = await exec(process.execPath, [path.join(appRoot, 'server/scripts/driverAuditSourceDeploy.js'), 'audit-source-host-check'], {
      cwd: appRoot, env: { ...process.env, DRIVER_AUDIT_DEPLOY_SHA: expected }, timeout: 60000, maxBuffer: 256 * 1024,
    });
    const checked = stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      .find(value => value.status === 'host-checked' && value.deployedSha === expected);
    if (!checked) throw Error('Private host bindings are unavailable');
    const entries = JSON.parse((await exec('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout);
    const workers = entries.filter(row => row.name === 'matter-driver-audit-sync');
    const args = workers[0]?.pm2_env?.args;
    if (workers.length !== 1 || !Array.isArray(args) || args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1])) {
      throw Error('The managed reporting configuration is required');
    }
    const syncRoot = path.dirname(args[1]);
    if (!syncRoot.startsWith(path.join(appRoot, 'server/.private/driver-audits') + '/')) throw Error('Unexpected managed reporting root');
    await requirePrivateDriverAuditSourceDirectory(syncRoot);
    const config = JSON.parse(await readPrivateDriverAuditSource(args[1], 1024 * 1024));
    if (config.root !== syncRoot || config.codeRoot !== path.join(syncRoot, 'builder')) throw Error('Unexpected managed reporting configuration');
    const seed = JSON.parse(await readPrivateDriverAuditSource(path.join(syncRoot, 'seed.json'), 1024 * 1024));
    const capsule = sealTransferSecrets(request.recipientPublicKey, { version: 1, applicationCommit: expected,
      appRoot, syncRoot, host: checked, bootstrap: { collectorRevision: seed.collectorRevision, manifestSha256: seed.manifestSha256 },
      checkedAt: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'private-bindings-inspected', applicationCommit: expected,
      recipientSha256: hash(request.recipientPublicKey), capsule }));
    return;
  }
  if (['create-profile', 'plan-import', 'stage-import', 'verify-import', 'stage-builder', 'stage-source', 'stage-lineage', 'diagnose-roots'].includes(operation)) {
    phase = 'native-import-' + operation;
    const encoded = process.env.NATIVE_IMPORT_CODE;
    if (!encoded || encoded.length > 256 * 1024 || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw Error('Reviewed import operator required');
    const code = Buffer.from(encoded, 'base64');
    if (code.toString('base64') !== encoded) throw Error('Reviewed import operator encoding differs');
    const load = name => import(pathToFileURL(path.join(appRoot, 'server', name)).href);
    const { readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory } = await load('services/driverAuditSource.js');
    const operators = path.join(appRoot, 'server/.private/driver-audit-native-operators');
    await fs.mkdir(operators, { recursive: true, mode: 0o700 });
    await requirePrivateDriverAuditSourceDirectory(operators);
    const filename = path.join(operators, hash(code) + '.mjs');
    try { await fs.writeFile(filename, code, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (hash(await readPrivateDriverAuditSource(filename, 256 * 1024)) !== hash(code)) throw Error('Reviewed import operator hash differs');
    const { runDriverAuditNativeImport } = await import(pathToFileURL(filename).href);
    let recipientPublicKey;
    if (operation === 'diagnose-roots' && process.env.NATIVE_TRANSFER_PLAN_B64) {
      const encodedPlan = process.env.NATIVE_TRANSFER_PLAN_B64;
      if (encodedPlan.length > 24576 || !/^[A-Za-z0-9+/]+=*$/.test(encodedPlan)) throw Error('Bounded public diagnostic recipient required');
      const { validateDriverAuditTransferPlan } = await load('services/driverAuditTransferSession.js');
      recipientPublicKey = validateDriverAuditTransferPlan(JSON.parse(Buffer.from(encodedPlan, 'base64').toString('utf8'))).recipientPublicKey;
    }
    const allPages = operation === 'diagnose-roots' && process.env.NATIVE_DIAGNOSTIC_PAGE === 'all';
    const argumentsFor = diagnosticPage => ({ operation, appRoot, expectedSha: expected,
      sessionId: process.env.NATIVE_TRANSFER_SESSION_ID, templateSha256: process.env.NATIVE_IMPORT_TEMPLATE_SHA256 || undefined,
      profileSha256: process.env.NATIVE_IMPORT_PROFILE_SHA256 || undefined,
      recipientPublicKey, diagnosticPage });
    const selectedPage = allPages || !process.env.NATIVE_DIAGNOSTIC_PAGE ? 0 : Number(process.env.NATIVE_DIAGNOSTIC_PAGE);
    const first = await runDriverAuditNativeImport(argumentsFor(selectedPage));
    console.log(JSON.stringify(first));
    if (allPages) {
      if (!Number.isSafeInteger(first.diagnosticPages) || first.diagnosticPages < 1 || first.diagnosticPages > 16) {
        throw Error('Use individual pages for a larger diagnostic envelope');
      }
      for (let page = 1; page < first.diagnosticPages; page++) {
        const next = await runDriverAuditNativeImport(argumentsFor(page));
        if (next.rootMetadataSha256 !== first.rootMetadataSha256 || next.diagnosticPages !== first.diagnosticPages) {
          throw Error('Diagnostic control metadata changed between pages');
        }
        console.log(JSON.stringify(next));
      }
    }
    return;
  }
  if (['prepare-transfer', 'receive-transfer'].includes(operation)) {
    phase = 'encrypted-native-transfer';
    const { stdout: result } = await exec(process.execPath, [path.join(appRoot, 'server/scripts/driverAuditNativeTransfer.js')], {
      cwd: appRoot, env: process.env, timeout: 55 * 60 * 1000, maxBuffer: 256 * 1024,
    });
    const values = result.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const receipt = values.find(value => /^transfer-(?:prepared|received|already-received)$/.test(value.status || ''));
    if (!receipt) throw Error('Native transfer receipt is unavailable');
    console.log(JSON.stringify(receipt));
    return;
  }
  if (['pause-builder', 'resume-builder'].includes(operation)) {
    phase = 'builder-' + operation.split('-')[0];
    const action = operation === 'pause-builder' ? 'deploy-worker-pause' : 'deploy-worker-resume';
    const { stdout: result } = await exec(process.execPath, [path.join(appRoot, 'server/scripts/driverAuditDeploy.js'), action], {
      cwd: appRoot, env: { ...process.env, DRIVER_AUDIT_DEPLOY_SHA: expected }, timeout: 240_000, maxBuffer: 65536,
    });
    const status = result.trim();
    if (!['paused', 'resumed', 'inactive'].includes(status)) throw Error('Unexpected builder transition');
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
  const censusLines = phase === 'collector-census' ? [...(error.stack || '').matchAll(/driverAuditLiveImport\.js:(\d+):\d+/g)]
    .map(match => Number(match[1])).filter(line => line > 0 && line < 10000).slice(0, 8) : [];
  const location = censusLines.length ? '; censusLines=' + censusLines.join(',') : '';
  const fileCode = ['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code) ? '; fileCode=' + error.code : '';
  console.error('Native handoff operation stopped at ' + phase + reason + status + location + fileCode + '; existing report authority is unchanged.');
  process.exitCode = 1;
});
