import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const execute = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const need = value => { if (!value) throw Error('Guard failed'); };
const relative = value => typeof value === 'string' && value.length <= 512
  && value.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '.' && part !== '..');
const signature = value => [value.dev, value.ino, value.uid, value.gid, value.mode, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
const codeFiles = ['server/package.json', 'server/package-lock.json', 'server/loadEnv.js',
  'server/services/driverAuditTransferCodec.js', 'server/vendor/driver-audits/integration/hosted/worker-lock.mjs'];

function recipient(value) {
  need(typeof value === 'string' && value.length <= 8192 && !value.includes('PRIVATE KEY')
    && /^-----BEGIN (?:RSA )?PUBLIC KEY-----[\s\S]+-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(value));
  const key = createPublicKey(value);
  need(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072);
  return key;
}

async function directory(file, privateMode = true) {
  const info = await fs.lstat(file);
  need(info.isDirectory() && info.uid === process.getuid() && !(info.mode & (privateMode ? 0o077 : 0o022))
    && await fs.realpath(file) === file);
}

async function read(file, { maximum = 2 * 1024 ** 2, privateMode = true, optional = false } = {}) {
  let before;
  try { before = await fs.lstat(file, { bigint: true }); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  need(before.isFile() && !before.isSymbolicLink() && (before.uid === BigInt(process.getuid()) || !privateMode && before.uid === 0n)
    && !(Number(before.mode) & (privateMode ? 0o077 : 0o022)) && before.size <= BigInt(maximum)
    && await fs.realpath(file) === file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    need(signature(await handle.stat({ bigint: true })) === signature(before));
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      need(result.bytesRead > 0); offset += result.bytesRead;
    }
    need((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0);
    need(signature(await handle.stat({ bigint: true })) === signature(before)
      && signature(await fs.lstat(file, { bigint: true })) === signature(before) && await fs.realpath(file) === file);
    return { path: file, sha256: sha(bytes), bytes: bytes.length, data: bytes };
  } finally { await handle.close(); }
}

const metadata = file => file && { path: file.path, sha256: file.sha256, bytes: file.bytes };
const select = (value, names) => Object.fromEntries(names.filter(name => Object.hasOwn(value, name)).map(name => [name, value[name]]));

async function systemFile(file) {
  const realpath = await fs.realpath(file);
  const saved = await read(realpath, { maximum: 64 * 1024, privateMode: false });
  const info = await fs.lstat(realpath);
  return { realpath, uid: info.uid, mode: info.mode, bytes: saved.bytes, sha256: saved.sha256 };
}

async function workers(entries, appRoot, readSystemFile) {
  need(Array.isArray(entries) && entries.length <= 512);
  const named = name => entries.filter(row => row?.name === name);
  const api = named('matter-delivery-api');
  need(api.length === 1 && Number.isInteger(api[0].pm_id) && Number.isSafeInteger(api[0].pid) && api[0].pid > 0);
  const env = api[0].pm2_env;
  const npm = await readSystemFile('/usr/bin/npm');
  need(env?.status === 'online' && env.pm_cwd === appRoot && JSON.stringify(env.args) === '["start","--prefix","server"]'
    && npm.uid === 0 && !(npm.mode & 0o022) && npm.bytes > 0 && npm.bytes <= 64 * 1024 && digest(npm.sha256)
    && /^\/usr\/(?:share\/nodejs|(?:local\/)?lib\/node_modules)\/npm\/bin\/npm-cli\.js$/.test(npm.realpath)
    && ['/usr/bin/npm', npm.realpath].includes(env.pm_exec_path));
  const server = path.join(appRoot, 'server'), sync = named('matter-driver-audit-sync'), source = named('matter-driver-audit-source');
  need(sync.length === 1 && source.length <= 1 && named('matter-driver-reports-api').length === 0);
  for (const row of [...sync, ...source]) {
    const settings = row.pm2_env, base = row.name === 'matter-driver-audit-sync' ? 'driver-audits' : 'driver-audit-source';
    const script = row.name === 'matter-driver-audit-sync' ? 'driverAuditSync.js' : 'driverAuditSource.js';
    const [flag, file, ...extra] = settings?.args ?? [], root = typeof file === 'string' ? path.dirname(file) : '';
    need(Number.isInteger(row.pm_id) && row.pid === 0 && settings.status === 'stopped' && !extra.length && flag === '--config'
      && settings.pm_cwd === server && settings.pm_exec_path === path.join(server, 'scripts', script)
      && path.dirname(root) === path.join(server, '.private', base) && digest(path.basename(root))
      && file === path.join(root, base === 'driver-audits' ? 'sync.json' : 'source.json'));
  }
  const projection = row => ({ name: row.name, id: row.pm_id, pid: row.pid,
    ...select(row.pm2_env, ['status', 'pm_exec_path', 'pm_cwd', 'args', 'exec_interpreter', 'pm_uptime']) });
  return { rows: [api[0], ...sync, ...source].map(projection), syncFile: sync[0].pm2_env.args[1],
    npm: { identitySha256: sha(JSON.stringify([npm.realpath, npm.sha256])) } };
}

async function tree(root, files, manifestName = 'runtime-manifest.json') {
  need(files && typeof files === 'object' && !Array.isArray(files) && Object.keys(files).length <= 4096);
  const allowed = new Set(); let total = 0;
  for (const [name, hash] of Object.entries(files)) {
    need(relative(name) && digest(hash));
    const saved = await read(path.join(root, name), { maximum: 16 * 1024 ** 2 });
    need(saved.sha256 === hash && (total += saved.bytes) <= 16 * 1024 ** 2); allowed.add(name);
  }
  async function visit(folder, prefix = '') {
    await directory(folder);
    const entries = await fs.readdir(folder, { withFileTypes: true }); need(entries.length <= 4096);
    for (const entry of entries) {
      const name = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await visit(path.join(folder, entry.name), name);
      else need(entry.isFile() && (allowed.has(name) || name === manifestName));
    }
  }
  await visit(root);
  return { files: allowed.size, bytes: total };
}

async function syncMetadata(file, server) {
  const saved = await read(file), config = JSON.parse(saved.data), root = path.dirname(file);
  need(config.version === 1 && config.root === root && path.dirname(root) === path.join(server, '.private/driver-audits')
    && config.codeRoot === path.join(root, 'builder') && config.baselineRoot === path.join(root, 'baseline')
    && config.rendererBuild?.path === path.join(root, 'baseline/build.private.json')
    && config.journals?.path === path.join(root, 'validation-journals.private.json') && digest(config.builderSha256));
  await directory(root);
  const manifest = await read(path.join(config.codeRoot, 'runtime-manifest.json'));
  need(manifest.sha256 === config.builderSha256);
  const parsed = JSON.parse(manifest.data); need(parsed.version === 1 && parsed.files?.['scripts/run-automatic-report.mjs']);
  const builder = { ...metadata(manifest), ...await tree(config.codeRoot, parsed.files) };
  const renderer = await read(config.rendererBuild.path), journals = await read(config.journals.path);
  need(renderer.sha256 === config.rendererBuild.sha256 && journals.sha256 === config.journals.sha256);
  const baseline = await read(path.join(config.baselineRoot, 'files.private.json')), seed = await read(path.join(root, 'seed.json'));
  const seedValue = JSON.parse(seed.data); need(seedValue.manifestSha256 === baseline.sha256);
  const pointers = {};
  for (const name of ['current', 'previous']) {
    const pointer = await read(path.join(root, 'work', name + '.private.json'), { optional: true });
    if (pointer) pointers[name] = { ...metadata(pointer), value: select(JSON.parse(pointer.data),
      ['version', 'privateRoot', 'manifestSha256', 'collectorRevision', 'sourceRevision', 'sourceBasis', 'reportHash', 'generation']) };
  }
  const recipe = config.legacyBuildRecipe === null ? null : config.legacyBuildRecipe && select(config.legacyBuildRecipe,
    ['builderSha256', 'rendererSha256', 'journalsSha256', 'baselineManifestSha256']);
  need(recipe === undefined || recipe === null || Object.values(recipe).every(value => value === null || digest(value)));
  return { config: { ...select(config, ['version', 'root', 'codeRoot', 'baselineRoot', 'builderSha256']),
    rendererBuild: select(config.rendererBuild, ['path', 'sha256']), journals: select(config.journals, ['path', 'sha256']),
    ...(recipe === undefined ? {} : { legacyBuildRecipe: recipe }) },
    configFile: metadata(saved), builder, renderer: metadata(renderer), journals: metadata(journals), baseline: metadata(baseline),
    seed: { ...metadata(seed), value: select(seedValue, ['version', 'collectorRevision', 'manifestSha256', 'generation', 'reportHash', 'sourceBasis', 'privateRoot']) }, pointers };
}

async function sourceMetadata(server) {
  const root = path.join(server, '.private/driver-audit-source'); await directory(root);
  const names = (await fs.readdir(root)).filter(digest).sort(); need(names.length <= 16);
  const releases = [];
  for (const name of names) {
    const folder = path.join(root, name); await directory(folder);
    const configFile = await read(path.join(folder, 'source.json')), config = JSON.parse(configFile.data);
    need(config.version === 1 && config.root === folder && config.runtimeRoot === path.join(folder, 'runtime')
      && config.manifestSha256 === name && config.environment?.path === path.join(folder, 'environment.private.json')
      && path.isAbsolute(config.nodeExecutable ?? '') && /^v\d+\.\d+\.\d+$/.test(config.nodeVersion ?? ''));
    const manifest = await read(path.join(config.runtimeRoot, 'manifest.private.json'));
    need(manifest.sha256 === name);
    const parsed = JSON.parse(manifest.data);
    need(parsed.schemaVersion === 1 && Array.isArray(parsed.files) && parsed.files.length <= 4096
      && Array.isArray(parsed.entrypoints) && parsed.entrypoints.length <= 128);
    let bytes = 0;
    for (const row of parsed.files) {
      need(relative(row.path) && row.path.startsWith('source/') && digest(row.sha256));
      const code = await read(path.join(config.runtimeRoot, row.path), { maximum: 16 * 1024 ** 2 });
      need(code.sha256 === row.sha256 && code.bytes === row.bytes && (bytes += code.bytes) <= 16 * 1024 ** 2);
    }
    need(new Set(parsed.files.map(row => row.path)).size === parsed.files.length);
    await tree(config.runtimeRoot, Object.fromEntries(parsed.files.map(row => [row.path, row.sha256])), 'manifest.private.json');
    const environment = await read(config.environment.path, { maximum: 64 * 1024 });
    need(environment.sha256 === config.environment.sha256);
    releases.push({ configFile: metadata(configFile), root: folder, runtimeRoot: config.runtimeRoot, manifestSha256: name,
      nodeExecutable: config.nodeExecutable, nodeVersion: config.nodeVersion, files: parsed.files.length, codeBytes: bytes,
      schedules: parsed.entrypoints.map(row => select(row,
        ['id', 'module', 'exportName', 'method', 'path', 'schedule', 'timeZone', 'task', 'maxDurationSeconds', 'requiredEnvironment'])),
      environment: { path: environment.path, bytes: environment.bytes, referenceMatched: true } });
  }
  return { root, releases };
}

async function configuration(server, load) {
  const dotenv = await load('node_modules/dotenv/lib/main.js');
  const files = await Promise.all(['.env', '.env.local'].map(name => read(path.join(server, name),
    { maximum: 256 * 1024, privateMode: false, optional: true })));
  const env = Object.assign({}, ...files.filter(Boolean).map(file => dotenv.parse(file.data)));
  const secret = env.DRIVER_AUDIT_SUPABASE_SECRET || env.MATTER_SUPABASE_SECRET;
  let spaces = null;
  if (env.SPACES_ENDPOINT) {
    const match = /^(?:https:\/\/)?([a-z][a-z0-9-]{1,19})\.digitaloceanspaces\.com\/?$/.exec(env.SPACES_ENDPOINT);
    need(match);
    const endpoint = `https://${match[1]}.digitaloceanspaces.com`, region = env.SPACES_REGION || match[1];
    need(region === match[1]);
    spaces = { configured: Boolean(env.SPACES_KEY && env.SPACES_SECRET && env.SPACES_BUCKET),
      identitySha256: sha(JSON.stringify([endpoint, region, env.SPACES_BUCKET])) };
  } else if (env.SPACES_BUCKET || env.SPACES_KEY || env.SPACES_SECRET) spaces = { configured: false, identitySha256: null };
  return { pin: files.map(file => file?.sha256 ?? null), value: {
    supabase: { secretConfigured: typeof secret === 'string' && secret.length > 0,
      projectIdentitySha256: sha('https://trhhjfgfmxofxhnzocks.supabase.co') },
    jwtConfigured: typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0, spaces } };
}

async function nginx(root) {
  const paths = [path.join(root, 'nginx.conf')];
  for (const folder of ['sites-enabled', 'conf.d']) {
    let entries;
    try { entries = await fs.readdir(path.join(root, folder)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    need(entries.length <= 64);
    for (const name of entries) { need(relative(name) && !name.includes('/')); paths.push(path.join(root, folder, name)); }
  }
  need(paths.length <= 64);
  const result = [];
  for (const file of paths) {
    const realpath = await fs.realpath(file); need(realpath.startsWith(root + path.sep));
    const saved = await read(realpath, { maximum: 256 * 1024, privateMode: false });
    result.push({ ...metadata(saved), configuredPath: file });
  }
  return result;
}

export async function runDriverAuditSupabaseHandoff({ operation, appRoot, expectedSha, recipientPublicKey }, adapters = {}) {
  let phase = 'inputs'; const locks = [];
  const exec = adapters.exec ?? ((file, args) => execute(file, args, { cwd: appRoot, timeout: 10_000, maxBuffer: 4 * 1024 ** 2 }));
  const load = adapters.load ?? (name => import(pathToFileURL(path.join(appRoot, 'server', name)).href));
  try {
    need(operation === 'inspect-supabase-host' && (adapters.platform ?? process.platform) === 'linux' && commit(expectedSha)
      && path.isAbsolute(appRoot) && await fs.realpath(appRoot) === appRoot);
    const key = recipient(recipientPublicKey), server = path.join(appRoot, 'server');
    const checkout = async () => {
      need((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim() === expectedSha);
      await exec('git', ['ls-files', '--error-unmatch', ...codeFiles]);
      await exec('git', ['diff', '--quiet', 'HEAD', '--', 'server']);
    };
    phase = 'checkout'; await checkout();
    const snapshotWorkers = async () => workers(JSON.parse((await exec('pm2', ['jlist'])).stdout), appRoot, adapters.systemFile ?? systemFile);
    const first = await snapshotWorkers();
    phase = 'locks';
    const lockRoot = path.join(server, '.private/driver-report-supabase-handoff');
    await directory(path.dirname(lockRoot));
    await fs.mkdir(lockRoot, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await directory(lockRoot);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    for (const file of [path.join(lockRoot, 'operator.lock'), path.join(server, '.private/driver-audit-source/source-deployment.lock'),
      path.join(server, '.private/driver-audit-source/source-worker.lock'), path.join(server, '.private/driver-audits/sync-worker.lock')]) {
      await directory(path.dirname(file)); locks.push(await acquireWorkerLock(file));
    }
    const heavy = path.join(server, '.private/driver-audit-heavy-work');
    try { await directory(heavy); locks.push(await acquireWorkerLock(path.join(heavy, 'work.lock'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const collect = async () => {
      const config = await configuration(server, load);
      return { configurationPin: config.pin, metadata: { applicationCommit: expectedSha, appRoot, serverRoot: server,
        workers: await snapshotWorkers(), sync: await syncMetadata(first.syncFile, server), source: await sourceMetadata(server),
        configuration: config.value, nginx: await nginx(adapters.nginxRoot ?? '/etc/nginx'),
        node: { executable: await fs.realpath(process.execPath), version: process.version, platform: adapters.platform ?? process.platform },
        mongoConnections: 0 } };
    };
    phase = 'inspect-metadata'; const before = await collect();
    phase = 'readback'; const after = await collect(); await checkout();
    need(JSON.stringify(first) === JSON.stringify(after.metadata.workers) && JSON.stringify(before) === JSON.stringify(after));
    const raw = Buffer.from(JSON.stringify(before.metadata)); need(raw.length <= 2 * 1024 ** 2);
    const packed = gzipSync(raw); need(packed.length <= 96 * 1024);
    phase = 'seal'; const { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
    const capsule = sealTransferSecrets(key, { version: 1, kind: 'supabase-host-inspection-capsule-v1',
      applicationCommit: expectedSha, metadataSha256: sha(raw), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
    return { status: 'supabase-host-inspected', operation, applicationCommit: expectedSha, metadataSha256: sha(raw),
      recipientSha256: sha(recipientPublicKey), capsule, readOnly: true, workersStarted: false, routingChanged: false };
  } catch { throw Object.assign(Error('Supabase handoff stopped at ' + phase), { phase }); }
  finally {
    let failed = false;
    for (const lock of locks.reverse()) try { await lock.release(); } catch { failed = true; }
    if (failed) throw Object.assign(Error('Supabase handoff stopped at cleanup'), { phase: 'cleanup' });
  }
}
