import { execFile, fork } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { driverAuditSourceHash, readPrivateDriverAuditSource, requirePrivateDriverAuditSourceDirectory, writeDriverAuditSourceState } from '../services/driverAuditSource.js';
import { withDriverAuditHeavyWork } from '../services/driverAuditHeavyWork.js';
import { hasDriverAuditBuildSpace } from '../services/driverAuditWorkspace.js';
import { createBudgetedAuditArchive } from '../vendor/driver-audits/integration/cloud/driver-audit-archive.mjs';
import { verifyAuditBuilder } from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { createHostedRpc } from '../vendor/driver-audits/integration/cloud/rpc.mjs';
import { createSupabaseArchiveTransport } from '../vendor/driver-audits/integration/hosted/supabase-archive.mjs';

const MiB = 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const keyPattern = /^[a-f0-9]{64}\.gz$/;
const serverRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const script = path.join(serverRoot, 'scripts', 'driverAuditQualificationChild.js');
const replayDiskReserve = 256 * MiB;
const memorySafetyReserve = 512 * MiB;
const priorSourcePeak = 4_086_464_512;
const archiveDownloadLimit = 192 * MiB;
const exec = promisify(execFile);

function requireQualification(condition, message) {
  if (!condition) throw new Error(message);
}

async function readArchiveBytes(archive, key, maxBytes, signal) {
  const chunks = [];
  let size = 0;
  for await (const chunk of await archive.readObject(key, { maxBytes, signal })) {
    size += chunk.length;
    requireQualification(size <= maxBytes, 'Qualification archive size exceeds its bound.');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  requireQualification(driverAuditSourceHash(bytes) + '.gz' === key, 'Qualification archive integrity failure.');
  return bytes;
}

export async function stageDriverAuditQualification({ root, fixtureSha256, runtimeManifestSha256, archive, signal }) {
  await requirePrivateDriverAuditSourceDirectory(root);
  requireQualification(hashPattern.test(fixtureSha256 ?? ''), 'A pinned source qualification fixture is required.');
  const compressed = await readArchiveBytes(archive, fixtureSha256 + '.gz', MiB, signal);
  const fixture = JSON.parse(gunzipSync(compressed, { maxOutputLength: 4 * MiB }));
  const { expected, savedState, objects } = fixture;
  requireQualification(fixture.version === 1 && fixture.runtimeManifestSha256 === runtimeManifestSha256
    && Object.keys(fixture).length === 5 && typeof savedState?.dataBase64 === 'string'
    && hashPattern.test(savedState.sha256 ?? ''), 'Qualification fixture identity differs.');
  const state = Buffer.from(savedState.dataBase64, 'base64');
  requireQualification(state.length > 0 && state.length <= 2 * MiB && state.toString('base64') === savedState.dataBase64
    && driverAuditSourceHash(state) === savedState.sha256 && Array.isArray(JSON.parse(state).rows), 'Qualification saved state integrity failure.');
  requireQualification(Array.isArray(objects) && objects.length > 0 && objects.length <= 128, 'Invalid qualification archive inventory.');
  const keys = new Set();
  let objectBytes = 0;
  for (const object of objects) {
    requireQualification(keyPattern.test(object?.key ?? '') && !keys.has(object.key)
      && Number.isSafeInteger(object.bytes) && object.bytes > 0 && object.bytes <= 8 * MiB, 'Invalid qualification archive inventory.');
    keys.add(object.key);
    objectBytes += object.bytes;
  }
  requireQualification(objectBytes <= 112 * MiB, 'Qualification archive size exceeds its bound.');
  requireQualification(['reportHash', 'generation', 'retainedSignature'].every(field => hashPattern.test(expected?.[field] ?? ''))
    && ['records', 'history', 'acceptedGrades', 'sourceRows'].every(field => Number.isSafeInteger(expected[field]) && expected[field] > 0)
    && Array.isArray(expected.writeKeys) && expected.writeKeys.length > 0 && expected.writeKeys.length <= 128
    && expected.writeKeys.every(key => keyPattern.test(key)), 'Invalid expected source qualification result.');
  const disk = await fs.statfs(root);
  requireQualification(disk.bavail * disk.bsize > objectBytes + state.length + replayDiskReserve, 'Qualification fixture does not fit the private work volume.');
  const objectsRoot = path.join(root, 'objects');
  const stateFile = path.join(root, 'saved-state.private.json');
  await fs.mkdir(objectsRoot, { mode: 0o700 });
  await fs.writeFile(stateFile, state, { flag: 'wx', mode: 0o600 });
  for (const { key, bytes } of objects) {
    const object = await readArchiveBytes(archive, key, bytes, signal);
    requireQualification(object.length === bytes, 'Qualification archive size differs.');
    await fs.writeFile(path.join(objectsRoot, key), object, { flag: 'wx', mode: 0o600 });
  }
  return { stateFile, objectsRoot, expected, savedStateSha256: savedState.sha256, objectBytes, objects: objects.length };
}

const readJson = async file => JSON.parse(await readPrivateDriverAuditSource(file));
const freeDisk = async directory => {
  const disk = await fs.statfs(directory);
  return disk.bavail * disk.bsize;
};

async function memoryAvailable() {
  const memory = await fs.readFile('/proc/meminfo', 'utf8');
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory);
  requireQualification(available, 'Linux available memory could not be measured.');
  return Number(available[1]) * 1024;
}

async function memoryForProcess(pid, includeChildren = false) {
  const status = await fs.readFile('/proc/' + pid + '/status', 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!status) return null;
  const bytes = field => Number(new RegExp('^' + field + ':\\s+(\\d+) kB$', 'm').exec(status)?.[1] ?? 0) * 1024;
  let rssBytes = bytes('VmRSS');
  if (includeChildren) {
    const children = await fs.readFile('/proc/' + pid + '/task/' + pid + '/children', 'utf8').catch(() => '');
    for (const child of children.trim().split(/\s+/).filter(id => /^\d+$/.test(id))) {
      rssBytes += (await memoryForProcess(Number(child), true))?.rssBytes ?? 0;
    }
  }
  return { rssBytes, peakRssBytes: bytes('VmHWM') };
}

function meter({ apiPid, syncPid, directory }) {
  const observations = {};
  const measure = async (phase, children) => {
    const [minimumAvailableBytes, minimumDiskBytes, api, sync, childMetrics] = await Promise.all([
      memoryAvailable(), freeDisk(directory), memoryForProcess(apiPid, true), memoryForProcess(syncPid),
      Promise.all(children.map(([name, pid]) => memoryForProcess(pid).then(metric => [name, metric]))),
    ]);
    const values = observations[phase] ?? { samples: 0, minimumAvailableBytes, minimumDiskBytes,
      peakApiRssBytes: 0, peakSyncRssBytes: 0, syncLifetimePeakRssBytes: 0, childPeaks: {} };
    values.samples++;
    values.minimumAvailableBytes = Math.min(values.minimumAvailableBytes, minimumAvailableBytes);
    values.minimumDiskBytes = Math.min(values.minimumDiskBytes, minimumDiskBytes);
    values.peakApiRssBytes = Math.max(values.peakApiRssBytes, api?.rssBytes ?? 0);
    values.peakSyncRssBytes = Math.max(values.peakSyncRssBytes, sync?.rssBytes ?? 0);
    values.syncLifetimePeakRssBytes = Math.max(values.syncLifetimePeakRssBytes, sync?.peakRssBytes ?? 0);
    for (const [name, metric] of childMetrics) {
      values.childPeaks[name] = Math.max(values.childPeaks[name] ?? 0, metric?.peakRssBytes ?? 0);
    }
    observations[phase] = values;
    requireQualification(api?.rssBytes > 0 && sync?.rssBytes > 0, 'Managed API or sync disappeared during qualification.');
    if (minimumAvailableBytes < memorySafetyReserve) throw Object.assign(new Error('Qualification memory reserve reached.'), { code: 'memory' });
  };
  return { measure, observations };
}

export function runDriverAuditQualificationChild({ mode, inputFile, executable, args, root, readRoots,
  timeoutMs, signal, readArchive, pid: onPid = () => {} }) {
  const child = fork(script, [inputFile, mode], {
    execPath: executable, cwd: root, env: { HOME: root, LANG: 'C', TZ: 'UTC' },
    execArgv: [...args, '--permission', '--allow-fs-write=' + root, ...[
      root, path.join(serverRoot, 'package.json'), path.join(serverRoot, 'services', 'driverAuditSource.js'), ...readRoots,
    ].map(file => '--allow-fs-read=' + file)],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let pendingReads = Promise.resolve();
  let settled = false;
  let closing = false;
  let failure;
  const stopped = new Promise(resolve => child.once('close', resolve));
  const stop = () => {
    closing = true;
    child.kill('SIGKILL');
  };
  const abort = () => { failure = signal.reason; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => {
    failure = Object.assign(new Error('Qualification child timed out.'), { code: 'timeout' });
    stop();
  }, timeoutMs);
  onPid(child.pid);
  const result = new Promise((resolve, reject) => {
    child.once('error', error => { failure = error; });
    child.on('message', message => {
      if (message?.kind === 'failed') failure = Object.assign(new Error('Isolated qualification failed.'),
        { code: message.code, line: Number.isSafeInteger(message.line) ? message.line : null,
          phase: /^[a-z-]{1,64}$/.test(message.phase ?? '') ? message.phase : null });
      if (message?.kind === 'result' && !settled && !closing) {
        settled = true;
        clearTimeout(timer);
        resolve(message.result);
      }
      if (message?.kind === 'read-archive' && !closing && readArchive) {
        // The parent performs only budgeted, content-addressed archive reads.
        pendingReads = pendingReads.then(async () => {
          if (closing) return;
          const key = message.key;
          const reply = { kind: 'archive', key };
          try { reply.file = await readArchive(key, message.maxBytes); }
          catch (error) { reply.code = error.code === 'AUDIT_BUDGET' ? 'AUDIT_BUDGET' : 'archive'; }
          if (child.connected) child.send(reply, () => {});
        });
      }
    });
    child.once('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!settled) reject(failure ?? new Error('Isolated qualification process exited.'));
    });
  });
  return { result, pid: child.pid, async stop() { stop(); await stopped; await pendingReads; } };
}

function checkedWorkers(rows) {
  return ['matter-delivery-api', 'matter-driver-audit-sync'].map(name => {
    const matches = rows.filter(row => row.name === name);
    const row = matches[0];
    requireQualification(matches.length === 1 && row.pm2_env?.status === 'online'
      && Number.isSafeInteger(row.pid) && row.pid > 0, 'Matching online API and audit sync are required.');
    return row;
  });
}

const noSourceActive = rows => requireQualification(rows.filter(row => row.name === 'matter-driver-audit-source')
  .every(row => row.pm2_env?.status === 'stopped'), 'Stop the source worker before pre-switch qualification.');

async function builderInputs(sync) {
  const [flag, file, ...extra] = sync.pm2_env.args ?? [];
  const root = typeof file === 'string' ? path.dirname(file) : '';
  const work = path.join(root, 'work');
  requireQualification(flag === '--config' && !extra.length
    && sync.pm2_env.pm_cwd === serverRoot && sync.pm2_env.pm_exec_path === path.join(serverRoot, 'scripts', 'driverAuditSync.js')
    && path.dirname(root) === path.join(serverRoot, '.private', 'driver-audits') && hashPattern.test(path.basename(root))
    && file === path.join(root, 'sync.json'), 'Managed sync configuration differs.');
  const config = await readJson(file);
  requireQualification(config.version === 1 && config.root === root && config.codeRoot === path.join(root, 'builder')
    && config.baselineRoot === path.join(root, 'baseline')
    && config.journals?.path === path.join(root, 'validation-journals.private.json')
    && config.rendererBuild?.path === path.join(config.baselineRoot, 'build.private.json'), 'Pinned builder configuration differs.');
  await verifyAuditBuilder(config.codeRoot, config.builderSha256);
  const { compactDirectBuildVersion } = await import(pathToFileURL(path.join(config.codeRoot, 'integration/cloud/automatic-release-build.mjs')).href);
  const compact = compactDirectBuildVersion === 1;
  const candidate = await readJson(path.join(work, 'current.private.json'));
  const parent = path.dirname(candidate.privateRoot);
  requireQualification(path.dirname(parent) === path.join(work, 'attempts')
    && /^[a-f0-9-]{36}$/.test(path.basename(parent)) && candidate.privateRoot === path.join(parent, 'server-data')
    && hashPattern.test(candidate.manifestSha256), 'Pinned builder baseline differs.');
  await requirePrivateDriverAuditSourceDirectory(parent);
  requireQualification(driverAuditSourceHash(await readPrivateDriverAuditSource(path.join(candidate.privateRoot, 'files.private.json')))
    === candidate.manifestSha256, 'Pinned builder baseline manifest differs.');
  for (const ref of [config.rendererBuild, config.journals]) {
    requireQualification(hashPattern.test(ref.sha256 ?? '') && driverAuditSourceHash(await readPrivateDriverAuditSource(ref.path)) === ref.sha256,
      'Pinned builder evidence differs.');
  }
  const executable = await fs.realpath('/proc/' + sync.pid + '/exe');
  const nodeOptions = (await fs.readFile('/proc/' + sync.pid + '/environ', 'utf8')).split('\0').find(value => value.startsWith('NODE_OPTIONS='));
  const heap = nodeOptions?.slice('NODE_OPTIONS='.length);
  requireQualification((!heap || /^--max-old-space-size=\d{3,5}$/.test(heap)) && !sync.pm2_env.node_args?.length,
    'The live sync Node options could not be reproduced.');
  const { stdout } = await exec(executable, ['--version'], { env: {}, timeout: 5000, maxBuffer: 4096 });
  const nodeVersion = stdout.trim();
  requireQualification(/^v\d+\.\d+\.\d+$/.test(nodeVersion), 'Managed builder Node version is unavailable.');
  return {
    builder: { baselineRoot: candidate.privateRoot, baselineManifestSha256: candidate.manifestSha256, cacheRoot: path.join(work, 'archive-cache'),
      codeRoot: config.codeRoot, builderSha256: config.builderSha256, initialBaseline: config.baselineRoot,
      rendererBuild: config.rendererBuild, journals: config.journals, compactDirectBuildVersion: compactDirectBuildVersion ?? null },
    compact, executable, nodeVersion, args: heap ? [heap] : [],
  };
}

async function stageBuilderBaseline(source, target, manifestSha256, startReserve, signal) {
  const bytes = await readPrivateDriverAuditSource(path.join(source, 'files.private.json'));
  requireQualification(driverAuditSourceHash(bytes) === manifestSha256, 'Builder baseline manifest changed.');
  const files = Object.entries(JSON.parse(bytes));
  requireQualification(files.length > 0 && files.length <= 32_768 && files.every(([name, hash]) =>
    name.length <= 512 && name.split('/').every(component => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(component))
    && hashPattern.test(hash)), 'Invalid qualification builder baseline inventory.');
  await fs.mkdir(target, { mode: 0o700 });
  for (const [name, hash] of files) {
    signal.throwIfAborted();
    // The archive-backed builder accepts an omitted local immutable chunk.
    // Its independent, verified object reader uses the original as a cache.
    if (name === 'archive-' + hash + '.private.bin') continue;
    const from = path.join(source, name);
    const to = path.join(target, name);
    const info = await fs.lstat(from);
    requireQualification(info.isFile() && info.uid === process.getuid() && !(info.mode & 0o077)
      && await fs.realpath(from) === from, 'Unsafe qualification builder baseline file.');
    await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
    if (await freeDisk(target) < startReserve + info.size) {
      throw Object.assign(new Error('Qualification workspace reserve unavailable.'), { code: 'disk' });
    }
    await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
  }
  await fs.writeFile(path.join(target, 'files.private.json'), bytes, { flag: 'wx', mode: 0o600 });
}

async function measureChild({ phase, specification, measure, retained = [], signal }) {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const child = runDriverAuditQualificationChild({ ...specification, signal: combined });
  let timer;
  let done = false;
  const sample = async () => {
    try {
      await measure(phase, [...retained, [specification.mode, child.pid]]);
      if (!done) timer = setTimeout(sample, 350);
    } catch (error) { controller.abort(error); }
  };
  try {
    await sample();
    const result = await child.result;
    requireQualification(result?.status === 'verified' && result.platform === 'linux' && result.networkAttempts === 0
      && Number.isSafeInteger(result.peakRssBytes) && result.peakRssBytes > 0, 'Isolated qualification receipt differs.');
    combined.throwIfAborted();
    return { ...child, result };
  } catch (error) {
    await child.stop();
    throw error;
  } finally { done = true; clearTimeout(timer); }
}

function archiveForBuilder({ archive, root, signal }) {
  const files = new Map();
  let bytes = 0;
  let opens = 0;
  const read = async (key, requestedBytes) => {
    requireQualification(keyPattern.test(key ?? '') && Number.isSafeInteger(requestedBytes)
      && requestedBytes > 0 && requestedBytes <= 256 * MiB, 'Invalid builder archive request.');
    const existing = files.get(key);
    if (existing) return existing;
    requireQualification(++opens <= 4096, 'Builder archive object limit reached.');
    const limit = Math.min(requestedBytes, 8 * MiB, archiveDownloadLimit - bytes);
    requireQualification(limit > 0 && await freeDisk(root) >= replayDiskReserve + limit, 'Builder archive fixture limit reached.');
    const received = await readArchiveBytes(archive, key, limit, signal);
    bytes += received.length;
    const file = path.join(root, key);
    await fs.writeFile(file, received, { flag: 'wx', mode: 0o600 });
    files.set(key, file);
    return file;
  };
  return { read, stats: () => ({ objects: files.size, bytes }) };
}

export async function qualifyDriverAuditSource({ config, commit, fixtureSha256, supervisor }) {
  requireQualification(process.platform === 'linux' && hashPattern.test(fixtureSha256 ?? ''), 'Exact Linux host qualification is required.');
  const first = await supervisor();
  noSourceActive(first);
  const [api, sync] = checkedWorkers(first);
  const entrypoint = config.runtime.entrypoints.find(entry => entry.path === '/api/collector?task=delivery');
  requireQualification(entrypoint, 'Saved source collector schedule is unavailable.');
  const secret = config.environment.MATTER_SUPABASE_SECRET;
  const rpc = createHostedRpc({ secret });
  const remote = createSupabaseArchiveTransport({ secret });
  await remote.assertPrivate();
  const { readBounded } = createBudgetedAuditArchive({ rpc, state: createCloudState({ rpc }), remote, receiptRoot: config.root,
    requestBytes: 4096 + 2 * Buffer.byteLength(secret), approvedNovemberRelease: true,
    approvedNovemberSync: true, approvedNovemberRecovery: true, approvedNovemberOvernight: true });
  const archive = { readObject: readBounded };
  const directory = await fs.mkdtemp(path.join(config.root, 'host-qualification-'));
  const privateRoot = path.dirname(path.dirname(config.root));
  const { observations, measure } = meter({ apiPid: api.pid, syncPid: sync.pid, directory });
  const receipt = { version: 1, verified: false, status: 'partial', commit, configSha256: config.configSha256,
    manifestSha256: config.manifestSha256, environmentSha256: config.environmentReference.sha256,
    fixtureSha256, nodeExecutable: config.nodeExecutable, nodeVersion: config.nodeVersion,
    source: null, builder: null, sourceAfterBuilder: null, measurements: observations };
  const controller = new AbortController();
  const { signal } = controller;
  const interrupt = () => controller.abort(Object.assign(new Error('Host qualification interrupted.'), { code: 'interrupted' }));
  const interrupts = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const event of interrupts) process.once(event, interrupt);
  try {
    const saved = await stageDriverAuditQualification({ root: directory, fixtureSha256,
      runtimeManifestSha256: config.manifestSha256, archive, signal });
    receipt.savedStateSha256 = saved.savedStateSha256;
    receipt.fixtureArchive = { objects: saved.objects, bytes: saved.objectBytes };
    async function runSource(phase, retained = [], failPublication = false, measuredPeak = priorSourcePeak) {
      signal.throwIfAborted();
      await measure(phase, retained);
      if (await memoryAvailable() < measuredPeak + memorySafetyReserve) {
        throw Object.assign(new Error('Measured source replay exceeds current headroom.'), { code: 'memory' });
      }
      const root = path.join(directory, phase);
      await fs.mkdir(root, { mode: 0o700 });
      const inputFile = path.join(root, 'input.private.json');
      await writeDriverAuditSourceState(inputFile, { root, ...saved, runtimeRoot: config.runtimeRoot, entrypoint, failPublication });
      const child = await measureChild({ phase, retained, measure, signal, specification: { mode: 'source', root, inputFile,
        executable: process.execPath, args: ['--max-old-space-size=3072'], readRoots: [directory, config.runtimeRoot],
        timeoutMs: entrypoint.maxDurationSeconds * 1000 } });
      try {
        requireQualification(child.result.nodeVersion === config.nodeVersion, 'Qualified source Node version changed.');
        return { root, result: child.result };
      } finally { await child.stop(); }
    }
    await withDriverAuditHeavyWork({ root: path.join(privateRoot, 'driver-audit-heavy-work'), owner: 'source',
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) }, async () => {
      const source = await runSource('source', [], true);
      receipt.source = source.result;
      const available = await freeDisk(directory);
      if (!hasDriverAuditBuildSpace(available, { compact: true })) {
        receipt.blocked = { phase: 'builder', reason: 'disk', availableBytes: available, requiredBytes: MiB * 1024 };
        return;
      }
      let builderConfiguration;
      try { builderConfiguration = await builderInputs(sync); }
      catch { receipt.blocked = { phase: 'builder', reason: 'configuration' }; return; }
      const { builder, compact, executable, nodeVersion, args } = builderConfiguration;
      const diskReserve = { start: (compact ? 1024 : 2560) * MiB, inProgress: (compact ? 256 : 2560) * MiB };
      if (!hasDriverAuditBuildSpace(available, { compact })) {
        receipt.blocked = { phase: 'builder', reason: 'disk', availableBytes: available, requiredBytes: diskReserve.start };
        return;
      }
      if (await memoryAvailable() < priorSourcePeak + memorySafetyReserve) {
        receipt.blocked = { phase: 'builder', reason: 'memory' };
        return;
      }
      const root = path.join(directory, 'builder');
      await fs.mkdir(root, { mode: 0o700 });
      const inputFile = path.join(root, 'input.private.json');
      const loader = archiveForBuilder({ archive, root, signal });
      let builderChild;
      try {
        const workingBaseline = path.join(root, 'baseline');
        await stageBuilderBaseline(builder.baselineRoot, workingBaseline, builder.baselineManifestSha256, diskReserve.start, signal);
        await writeDriverAuditSourceState(inputFile, { root, objectsRoot: saved.objectsRoot, sourceRoot: source.root,
          builder: { ...builder, baselineRoot: workingBaseline, archiveBaseline: builder.baselineRoot }, diskReserve });
        builderChild = await measureChild({ phase: 'builder', measure, signal, specification: { mode: 'builder', root, inputFile, executable, args,
          readRoots: [directory, builder.codeRoot, builder.baselineRoot, builder.cacheRoot, builder.initialBaseline, builder.journals.path],
          timeoutMs: 35 * 60_000, readArchive: loader.read } });
        requireQualification(builderChild.result.nodeVersion === nodeVersion, 'Managed builder Node version changed.');
        receipt.builder = { ...builderChild.result, nodeExecutable: executable, nodeArgs: args,
          rendererSha256: builder.rendererBuild.sha256, journalsSha256: builder.journals.sha256, downloadedArchive: loader.stats() };
        receipt.sourceAfterBuilder = (await runSource('source-after-builder', [['builder', builderChild.pid]], false, source.result.peakRssBytes)).result;
        requireQualification(await memoryForProcess(builderChild.pid), 'Builder exited before retained-memory qualification.');
        receipt.verified = true;
        receipt.status = 'verified';
      } catch (error) {
        receipt.blocked = { phase: receipt.builder ? 'source-after-builder' : 'builder',
          reason: ['disk', 'memory', 'budget', 'timeout', 'interrupted'].includes(error.code) ? error.code : 'replay' };
      } finally { await builderChild?.stop(); }
    });
    signal.throwIfAborted();
    const after = await supervisor();
    noSourceActive(after);
    const workers = checkedWorkers(after);
    requireQualification([api, sync].every((row, i) => workers[i].pid === row.pid
      && workers[i].pm2_env.pm_uptime === row.pm2_env.pm_uptime), 'Managed API or audit sync changed during qualification.');
  } catch (error) {
    receipt.verified = false;
    receipt.status = 'partial';
    receipt.blocked = { phase: receipt.source ? 'host-readback' : 'source',
      reason: error.code === 'AUDIT_BUDGET' ? 'budget' : ['disk', 'memory', 'timeout', 'interrupted', 'AUDIT_ADMISSION_CANCELLED'].includes(error.code) ? error.code : 'replay',
      ...(Number.isSafeInteger(error.line) ? { line: error.line } : {}), ...(error.phase ? { workerPhase: error.phase } : {}) };
  } finally {
    for (const event of interrupts) process.off(event, interrupt);
    await fs.rm(directory, { recursive: true, force: true });
  }
  receipt.checkedAt = new Date().toISOString();
  const receiptFile = path.join(config.root, 'qualification-' + fixtureSha256 + '.private.json');
  await writeDriverAuditSourceState(receiptFile, receipt);
  return { ...receipt, receiptSha256: driverAuditSourceHash(await readPrivateDriverAuditSource(receiptFile)) };
}

export async function verifyDriverAuditSourceHostQualification({ config, commit, reference, builder, nodeExecutable, nodeVersion, nodeArgs }) {
  requireQualification(hashPattern.test(reference?.fixtureSha256 ?? '') && hashPattern.test(reference?.receiptSha256 ?? ''),
    'A verified host qualification reference is required.');
  const file = path.join(config.root, 'qualification-' + reference.fixtureSha256 + '.private.json');
  const raw = await readPrivateDriverAuditSource(file);
  requireQualification(driverAuditSourceHash(raw) === reference.receiptSha256, 'Host qualification receipt integrity failure.');
  const receipt = JSON.parse(raw);
  requireQualification(receipt.version === 1 && receipt.status === 'verified' && receipt.verified === true
    && Number.isFinite(Date.parse(receipt.checkedAt)) && Date.parse(receipt.checkedAt) <= Date.now()
    && receipt.fixtureSha256 === reference.fixtureSha256 && receipt.commit === commit && receipt.configSha256 === config.configSha256
    && receipt.manifestSha256 === config.manifestSha256 && receipt.environmentSha256 === config.environmentReference.sha256
    && receipt.nodeExecutable === config.nodeExecutable && receipt.nodeVersion === config.nodeVersion
    && [receipt.source, receipt.sourceAfterBuilder].every(row => row?.status === 'verified' && row.platform === 'linux'
      && row.nodeVersion === config.nodeVersion && row.networkAttempts === 0)
    && receipt.source.failureRetry === true && receipt.builder?.status === 'verified' && receipt.builder.platform === 'linux'
    && receipt.builder.networkAttempts === 0 && receipt.builder.builderSha256 === builder.builderSha256
    && receipt.builder.rendererSha256 === builder.rendererBuild.sha256 && receipt.builder.journalsSha256 === builder.journals.sha256
    && receipt.builder.nodeExecutable === nodeExecutable && receipt.builder.nodeVersion === nodeVersion
    && JSON.stringify(receipt.builder.nodeArgs) === JSON.stringify(nodeArgs)
    && ['source', 'builder', 'source-after-builder'].every(phase => receipt.measurements?.[phase]?.samples > 0
      && receipt.measurements[phase].peakApiRssBytes > 0 && receipt.measurements[phase].peakSyncRssBytes > 0
      && receipt.measurements[phase].minimumAvailableBytes >= memorySafetyReserve),
  'Host qualification is incomplete or the reviewed runtime changed.');
  return receipt;
}

export async function requireDriverAuditSourceHostQualification({ config, commit, reference, supervisor }) {
  const rows = await supervisor();
  noSourceActive(rows);
  const [, sync] = checkedWorkers(rows);
  const { builder, executable, nodeVersion, args } = await builderInputs(sync);
  return verifyDriverAuditSourceHostQualification({ config, commit, reference, builder, nodeExecutable: executable, nodeVersion, nodeArgs: args });
}
