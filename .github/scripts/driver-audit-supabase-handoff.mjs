import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const execute = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const need = value => { if (!value) throw Error('Guard failed'); };
const relative = value => typeof value === 'string' && value.length <= 1024
  && value.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
const nginxName = value => typeof value === 'string' && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const signature = value => [value.dev, value.ino, value.uid, value.gid, value.mode, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
const codeFiles = ['server/package.json', 'server/package-lock.json', 'server/loadEnv.js',
  'server/services/driverAuditTransferCodec.js', 'server/vendor/driver-audits/integration/hosted/worker-lock.mjs'];
const originalEnvironmentKeys = ['CRON_SECRET', 'MATTER_SUPABASE_SECRET', 'MATTER_DELIVERY_API_KEY', 'AI_GATEWAY_API_KEY',
  'MATTER_DELIVERY_ENABLED', 'MATTER_PHOTO_READ_ENABLED', 'MATTER_PHOTO_GRADE_ENABLED', 'MATTER_GPS_ENABLED', 'MATTER_GPS_PUBLICATION_ENABLED'];
const preparationPins = Object.freeze({
  release: '4a00becfe4954b8139df6ac3c6058c2a592484d2',
  source: '8577fd973097dc543953b5af4ea9a3704b1d2c54bd016dd910a13e8560397fcc', sourceFiles: 140,
  oldSource: 'e1650c0a521271976629fafc1ad6d6eb0abf39074b5eeaf909f2d93f929f9d9d',
  builder: '76790677571490ea75f63c8954ac0c798311b80458b45bf1ccbf54f00ae0701d', builderFiles: 73,
  oldBuilder: '5780bdb95450558e4cc7dba91b3ed593fdd0b149648a6602b7c5ed441dec84c3',
  baseline: '16bee9ba4531ac532bdf90e0b2fdf6271c86ee4b15db91de12449258b902bbf3', baselineRevision: 2118,
  candidate: '83580f6e97ec429e46fd668db533fae601a72ab357b1aaad48ce242f70303f19', candidateRevision: 5771,
  candidateBasis: '24977fe9e0c60d569e3139ec385b8425bf8b8ab67e70d8142e05cb1f432d22c5',
  servingCurrent: { collectorRevision: 5463, manifestSha256: '3ac4484fe65910ce356eee487e8ebe4a50b0f52e64d81e892fb2c4b1ea8325c2', generation: '15d10c15a4e3ca405ba8a39b328f14023be977e91cc3ee003622d6c086da8709' },
  servingPrevious: { collectorRevision: 4775, manifestSha256: 'c60efc0dee8b7bc53219097ba0a32c37cef08b616773159a39a4edf43b913afd', generation: '484f92f87280e6c07e5ee89c1210a335f03529d16e53e6a1082bac8b44cf8066' },
});
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function recipient(value) {
  need(typeof value === 'string' && value.length <= 8192 && !value.includes('PRIVATE KEY')
    && /^-----BEGIN (?:RSA )?PUBLIC KEY-----[\s\S]+-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(value));
  const key = createPublicKey(value);
  need(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072);
  return key;
}

async function directory(file, privateMode = true) {
  const info = await fs.lstat(file);
  need(info.isDirectory() && (info.uid === process.getuid() || !privateMode && info.uid === 0) && !(info.mode & (privateMode ? 0o077 : 0o022))
    && await fs.realpath(file) === file);
  return info;
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

async function syncMetadata(file, server, setPhase) {
  setPhase('sync-config');
  const saved = await read(file), config = JSON.parse(saved.data), root = path.dirname(file);
  need(config.version === 1 && config.root === root && path.dirname(root) === path.join(server, '.private/driver-audits')
    && config.codeRoot === path.join(root, 'builder') && config.baselineRoot === path.join(root, 'baseline')
    && config.rendererBuild?.path === path.join(root, 'baseline/build.private.json')
    && config.journals?.path === path.join(root, 'validation-journals.private.json') && digest(config.builderSha256));
  await directory(root);
  setPhase('builder-manifest');
  const manifest = await read(path.join(config.codeRoot, 'runtime-manifest.json'));
  need(manifest.sha256 === config.builderSha256);
  const parsed = JSON.parse(manifest.data); need(parsed.version === 1 && parsed.files?.['scripts/run-automatic-report.mjs']);
  setPhase('builder-tree');
  const builder = { ...metadata(manifest), ...await tree(config.codeRoot, parsed.files) };
  setPhase('renderer');
  const renderer = await read(config.rendererBuild.path); need(renderer.sha256 === config.rendererBuild.sha256);
  setPhase('journals');
  const journals = await read(config.journals.path); need(journals.sha256 === config.journals.sha256);
  setPhase('baseline');
  const baseline = await read(path.join(config.baselineRoot, 'files.private.json'));
  setPhase('seed');
  const seed = await read(path.join(root, 'seed.json'));
  const seedValue = JSON.parse(seed.data); need(seedValue.manifestSha256 === baseline.sha256);
  setPhase('pointers');
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
  return { pin: files.map(file => file?.sha256 ?? null), environment: env, value: {
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
    for (const name of entries) { need(nginxName(name)); paths.push(path.join(root, folder, name)); }
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

const directoryIdentity = value => [value.dev, value.ino, value.uid, value.gid, value.mode].map(String).join(':');

async function inDirectory(folder, callback, privateMode = true) {
  const initial = await directory(folder, privateMode);
  const before = await fs.lstat(folder, { bigint: true });
  need(directoryIdentity(before) === directoryIdentity(initial));
  const handle = await fs.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const check = async () => need(directoryIdentity(await handle.stat({ bigint: true })) === directoryIdentity(before)
    && directoryIdentity(await fs.lstat(folder, { bigint: true })) === directoryIdentity(before) && await fs.realpath(folder) === folder);
  try {
    await check();
    // Linux mutations stay attached to the opened parent if its name is moved.
    // The pathname is still checked before and after every mutation.
    const anchored = process.platform === 'linux' ? '/proc/self/fd/' + handle.fd : folder;
    const result = await callback(anchored); await check(); await handle.sync(); return result;
  } finally { await handle.close(); }
}

async function mkdirPrivate(folder) {
  need(path.isAbsolute(folder) && path.normalize(folder) === folder);
  const missing = []; let parent = folder;
  while (true) {
    try { await fs.lstat(parent); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(path.basename(parent)); parent = path.dirname(parent); }
  }
  // Reject an existing symlink ancestor before mkdir can traverse through it.
  await directory(parent, missing.length === 0);
  for (const name of missing.reverse()) {
    need(relative(name) && !name.includes('/'));
    await inDirectory(parent, async anchored => {
      await fs.mkdir(path.join(anchored, name), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }, false);
    parent = path.join(parent, name); await directory(parent);
  }
}

async function writeOnce(file, bytes) {
  need(Buffer.isBuffer(bytes));
  try { need((await read(file, { maximum: Math.max(bytes.length, 1) })).data.equals(bytes)); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await inDirectory(path.dirname(file), async anchored => {
    const handle = await fs.open(path.join(anchored, path.basename(file)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }, false);
  need((await read(file, { maximum: Math.max(bytes.length, 1) })).data.equals(bytes));
}

async function fileHash(file, { maximum = 512 * 1024 ** 2, privateMode = true, phase = () => {} } = {}) {
  phase('metadata');
  const before = await fs.lstat(file, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maximum)
    && (before.uid === BigInt(process.getuid()) || !privateMode && before.uid === 0n)
    && !(Number(before.mode) & (privateMode ? 0o077 : 0o022)) && await fs.realpath(file) === file);
  phase('open');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash('sha256');
  try {
    need(signature(await handle.stat({ bigint: true })) === signature(before));
    phase('read'); const chunk = Buffer.alloc(1024 * 1024); let offset = 0;
    while (offset < Number(before.size)) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, Number(before.size) - offset), offset);
      need(bytesRead > 0); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    phase('readback'); need((await handle.read(chunk, 0, 1, offset)).bytesRead === 0
      && signature(await handle.stat({ bigint: true })) === signature(before)
      && signature(await fs.lstat(file, { bigint: true })) === signature(before) && await fs.realpath(file) === file);
    return { path: file, sha256: hash.digest('hex'), bytes: offset, stat: before };
  } finally { await handle.close(); }
}

async function withPrivatePackageDirectory(folder, boundary, operation, { mutating = false } = {}) {
  need(path.isAbsolute(boundary || '') && path.normalize(boundary) === boundary
    && path.isAbsolute(folder) && path.normalize(folder) === folder
    && (folder === boundary || folder.startsWith(boundary + path.sep)));
  await directory(boundary);
  const relativePath = path.relative(boundary, folder), parts = relativePath ? relativePath.split(path.sep) : [];
  need(parts.length <= 64 && parts.every(part => relative(part) && !part.includes('/')));
  const paths = [boundary]; for (const part of parts) paths.push(path.join(paths.at(-1), part));
  const opened = [];
  try {
    for (const file of paths) {
      const before = await fs.lstat(file, { bigint: true });
      need(before.isDirectory() && before.uid === BigInt(process.getuid()) && await fs.realpath(file) === file
        && (file !== boundary || !(Number(before.mode) & 0o077)));
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      opened.push({ file, before, handle });
      need(signature(await handle.stat({ bigint: true })) === signature(before));
    }
    const check = async identity => {
      for (const item of opened) need(identity(await item.handle.stat({ bigint: true })) === identity(item.before)
        && identity(await fs.lstat(item.file, { bigint: true })) === identity(item.before) && await fs.realpath(item.file) === item.file);
    };
    await check(signature); const value = await operation(); await check(mutating ? directoryIdentity : signature); return value;
  } finally { for (const item of opened.reverse()) await item.handle.close(); }
}

async function packageFiles(root, expectedManifest, { objects = false, archiveBackedManifest = false,
  privateDirectoryBoundary, phase = () => {}, observe = () => {} } = {}) {
  need(!objects || !archiveBackedManifest && privateDirectoryBoundary === undefined);
  need(!privateDirectoryBoundary || archiveBackedManifest);
  const inspect = async () => {
  const observing = (file, declaredSha256 = null, alreadyReadSha256 = null) => observe({ root, file, declaredSha256, alreadyReadSha256 });
  phase('root');
  observing(root);
  if (!privateDirectoryBoundary) await directory(root);
  let manifest = null;
  if (!objects) {
    phase('manifest-read');
    observing(path.join(root, 'files.private.json'), expectedManifest);
    manifest = await read(path.join(root, 'files.private.json'), { maximum: 8 * 1024 ** 2 });
    observing(manifest.path, expectedManifest, manifest.sha256);
    phase('manifest-pin');
    need(manifest.sha256 === expectedManifest);
  }
  phase('manifest-schema'); const declared = manifest ? JSON.parse(manifest.data) : null;
  need(!declared || typeof declared === 'object' && !Array.isArray(declared) && Object.keys(declared).length <= 100000
    && Object.entries(declared).every(([name, hash]) => relative(name) && digest(hash)));
  const files = []; let total = 0;
  async function visit(folder, prefix = '') {
    phase('directory-metadata'); observing(folder);
    const inspectDirectory = async () => {
    phase('directory-metadata');
    observing(folder);
    if (!privateDirectoryBoundary) await directory(folder);
    phase('directory-listing');
    const names = (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    need(names.length <= 100000);
    for (const entry of names) {
      phase('entry-name');
      need(relative(entry.name) && !entry.name.includes('/'));
      const name = prefix ? prefix + '/' + entry.name : entry.name, file = path.join(folder, entry.name);
      if (entry.isDirectory()) { need(!objects); await visit(file, name); }
      else {
        const expectedHash = declared?.[name] ?? (objects && /^[a-f0-9]{64}\.gz$/.test(name) ? name.slice(0, 64)
          : name === 'files.private.json' ? expectedManifest : null);
        observing(file, expectedHash);
        const saved = await fileHash(file, { phase: name => phase('file-' + name) });
        observing(file, expectedHash, saved.sha256);
        phase('file-bounds');
        need(files.length < 100000 && (total += saved.bytes) <= 16 * 1024 ** 3);
        if (objects) { phase('object-identity'); need(/^[a-f0-9]{64}\.gz$/.test(name) && name === saved.sha256 + '.gz' && saved.bytes <= 8 * 1024 ** 2); }
        files.push({ name, ...saved });
      }
    }
    };
    if (privateDirectoryBoundary) return withPrivatePackageDirectory(folder, privateDirectoryBoundary, inspectDirectory);
    return inspectDirectory();
  }
  await visit(root);
  phase('manifest-members');
  const present = new Map(files.map(row => [row.name, row])), missingArchiveReferences = [];
  if (declared) for (const [name, hash] of Object.entries(declared)) {
    const actual = present.get(name); observing(path.join(root, name), hash, actual?.sha256 ?? null);
    if (!actual && archiveBackedManifest && name === 'archive-' + hash + '.private.bin') {
      const absent = await fs.lstat(path.join(root, name)).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
      need(absent); missingArchiveReferences.push(hash);
    } else need(actual?.sha256 === hash);
  }
  missingArchiveReferences.sort();
  phase('inventory'); const inventorySha256 = sha(JSON.stringify(files.map(({ name, sha256, bytes }) => ({ name, sha256, bytes }))));
  return { root, files, bytes: total, inventorySha256, manifestSha256: manifest?.sha256 ?? null,
    archiveBackedManifest, privateDirectoryBoundary, declaredFiles: declared ? Object.keys(declared).length : 0, missingArchiveReferences,
    missingArchiveReferencesSha256: sha(JSON.stringify(missingArchiveReferences)) };
  };
  if (privateDirectoryBoundary) {
    phase('root'); observe({ root, file: root });
    return withPrivatePackageDirectory(root, privateDirectoryBoundary, inspect);
  }
  return inspect();
}

function sameArchiveMask(value, current) {
  return JSON.stringify(value) === JSON.stringify({ version: 1, kind: 'archive-backed-package-presence-v1',
    manifestSha256: current.manifestSha256, inventorySha256: current.inventorySha256,
    declaredFiles: current.declaredFiles, physicalFiles: current.files.length, missingArchiveReferences: current.missingArchiveReferences });
}

async function linkPackage(saved, target, presenceFile, targetBoundary) {
  await mkdirPrivate(target);
  for (const row of saved.files) {
    const file = path.join(target, row.name); await mkdirPrivate(path.dirname(file));
    const mutate = async () => {
    if (row.name === 'files.private.json') { await writeOnce(file, (await read(row.path, { maximum: 8 * 1024 ** 2 })).data); return; }
    await inDirectory(path.dirname(file), async anchored => {
      try { await fs.link(row.path, path.join(anchored, path.basename(file))); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    });
    };
    const copy = () => saved.privateDirectoryBoundary
      ? withPrivatePackageDirectory(path.dirname(file), targetBoundary, mutate, { mutating: true }) : mutate();
    if (saved.privateDirectoryBoundary) await withPrivatePackageDirectory(path.dirname(row.path), saved.privateDirectoryBoundary, copy);
    else await copy();
    const current = await fileHash(file);
    need(current.sha256 === row.sha256 && current.bytes === row.bytes);
    if (row.name !== 'files.private.json') need(current.stat.dev === row.stat.dev && current.stat.ino === row.stat.ino
      && current.stat.mtimeNs === row.stat.mtimeNs);
  }
  const checked = await packageFiles(target, saved.manifestSha256,
    { objects: saved.manifestSha256 === null, archiveBackedManifest: saved.archiveBackedManifest,
      privateDirectoryBoundary: saved.privateDirectoryBoundary ? targetBoundary : undefined });
  need(checked.inventorySha256 === saved.inventorySha256 && checked.missingArchiveReferencesSha256 === saved.missingArchiveReferencesSha256);
  let archiveReferences;
  if (saved.archiveBackedManifest) {
    need(path.isAbsolute(presenceFile || '')); await mkdirPrivate(path.dirname(presenceFile));
    const bytes = Buffer.from(JSON.stringify({ version: 1, kind: 'archive-backed-package-presence-v1',
      manifestSha256: checked.manifestSha256, inventorySha256: checked.inventorySha256,
      declaredFiles: checked.declaredFiles, physicalFiles: checked.files.length,
      missingArchiveReferences: checked.missingArchiveReferences }));
    need(bytes.length <= 8 * 1024 ** 2); await writeOnce(presenceFile, bytes);
    archiveReferences = { path: presenceFile, sha256: sha(bytes), bytes: bytes.length,
      locallyMissing: checked.missingArchiveReferences.length, remoteAvailabilityVerified: false };
  }
  return { root: target, files: checked.files.length, bytes: checked.bytes, inventorySha256: checked.inventorySha256,
    manifestSha256: checked.manifestSha256, ...(archiveReferences ? { archiveBackedManifest: true,
      privateDirectoryBoundary: checked.privateDirectoryBoundary, declaredFiles: checked.declaredFiles,
      missingArchiveReferencesSha256: checked.missingArchiveReferencesSha256, archiveReferences } : {}) };
}

function codeArchive(ref, expectedManifest, name, count) {
  need(exactKeys(ref, ['sha256', 'bytes', 'dataBase64']) && digest(ref.sha256)
    && Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= 2 * 1024 ** 2
    && typeof ref.dataBase64 === 'string' && ref.dataBase64.length <= 3 * 1024 ** 2);
  const bytes = Buffer.from(ref.dataBase64, 'base64'); need(bytes.toString('base64') === ref.dataBase64 && bytes.length === ref.bytes && sha(bytes) === ref.sha256);
  const bundle = JSON.parse(gunzipSync(bytes, { maxOutputLength: 16 * 1024 ** 2 }));
  need(exactKeys(bundle, ['version', 'manifestSha256', 'files']) && bundle.version === 1 && bundle.manifestSha256 === expectedManifest
    && Array.isArray(bundle.files) && bundle.files.length === count + 1);
  const files = new Map(); let total = 0;
  for (const row of bundle.files) {
    need(exactKeys(row, ['path', 'dataBase64']) && relative(row.path) && !files.has(row.path) && typeof row.dataBase64 === 'string');
    const data = Buffer.from(row.dataBase64, 'base64'); need(data.toString('base64') === row.dataBase64 && (total += data.length) <= 16 * 1024 ** 2);
    files.set(row.path, data);
  }
  need(files.has(name) && sha(files.get(name)) === expectedManifest);
  const manifest = JSON.parse(files.get(name));
  const entries = name === 'runtime-manifest.json' ? Object.entries(manifest.files ?? {}).map(([path, sha256]) => ({ path, sha256 })) : manifest.files;
  need((name === 'runtime-manifest.json' ? manifest.version === 1 : manifest.schemaVersion === 1)
    && Array.isArray(entries) && entries.length === count && new Set(entries.map(row => row.path)).size === count
    && entries.every(row => relative(row.path) && files.has(row.path) && digest(row.sha256) && sha(files.get(row.path)) === row.sha256
      && (name === 'runtime-manifest.json' || row.path.startsWith('source/') && row.bytes === files.get(row.path).length)));
  return { bytes, bundle, files, manifest };
}

async function decodeBootstrap(archive, bootstrapSha256) {
  need((await archive.assertPrivate())?.public === false);
  const chunks = []; let total = 0;
  for await (const chunk of await archive.readObject(bootstrapSha256 + '.gz', { maxBytes: 2 * 1024 ** 2, signal: AbortSignal.timeout(30000) })) {
    total += chunk.length; need(total <= 2 * 1024 ** 2); chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks); need(total > 0 && sha(bytes) === bootstrapSha256);
  const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: 16 * 1024 ** 2 }));
  need(exactKeys(value, ['version', 'kind', 'releaseSha', 'packageLockSha256', 'inspectionMetadataSha256', 'expected', 'retained', 'builder', 'source'])
    && value.version === 1 && value.kind === 'driver-reports-supabase-bootstrap-v1' && commit(value.releaseSha)
    && digest(value.packageLockSha256) && digest(value.inspectionMetadataSha256)
    && exactKeys(value.expected, ['syncConfigSha256', 'seedSha256', 'currentPointerSha256', 'sourceConfigSha256', 'sourceEnvironmentSha256'])
    && Object.values(value.expected).every(digest) && Array.isArray(value.retained) && value.retained.length === 2);
  return { value, bytes };
}

async function dependencyInventory(root) {
  await directory(root, false);
  const rows = []; let directories = 0, total = 0;
  async function visit(folder, prefix = '', depth = 0) {
    need(depth <= 32 && ++directories <= 20000); await directory(folder, false);
    const names = (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    need(names.length <= 100000);
    for (const entry of names) {
      need(entry.name.length <= 256 && !/[\x00-\x1f\x7f/\\]/.test(entry.name) && !['.', '..'].includes(entry.name) && rows.length < 100000);
      const name = prefix ? prefix + '/' + entry.name : entry.name, file = path.join(folder, entry.name);
      need(name.length <= 2048);
      if (entry.isDirectory()) { rows.push({ name, kind: 'directory' }); await visit(file, name, depth + 1); }
      else if (entry.isSymbolicLink()) {
        const before = await fs.lstat(file, { bigint: true }), target = await fs.readlink(file), real = await fs.realpath(file);
        need(before.uid === BigInt(process.getuid()) && target.length <= 2048 && !path.isAbsolute(target)
          && real.startsWith(root + path.sep) && signature(await fs.lstat(file, { bigint: true })) === signature(before));
        rows.push({ name, kind: 'symlink', target });
      } else {
        const saved = await fileHash(file, { maximum: 128 * 1024 ** 2, privateMode: false });
        need(saved.stat.uid === BigInt(process.getuid()) && (total += saved.bytes) <= 1024 ** 3);
        rows.push({ name, kind: 'file', sha256: saved.sha256, bytes: saved.bytes, mode: Number(saved.stat.mode) & 0o777 });
      }
    }
  }
  await visit(root);
  return { sha256: sha(JSON.stringify(rows)), entries: rows.length, bytes: total };
}

async function prepareDependencies({ targetServer, packageLockSha256, npmIdentitySha256, node, exec }) {
  const root = path.join(targetServer, 'node_modules'), controls = path.join(targetServer, '.private/dependencies');
  await mkdirPrivate(controls);
  const planFile = path.join(controls, 'plan.private.json'), receiptFile = path.join(controls, 'receipt.private.json');
  const plan = { version: 1, mode: 'isolated-npm-ci-v1', packageLockSha256, npmIdentitySha256,
    nodeExecutable: node.executable, nodeVersion: node.version };
  const planBytes = Buffer.from(JSON.stringify(plan)), existingPlan = await read(planFile, { optional: true });
  if (existingPlan) need(existingPlan.data.equals(planBytes));
  const present = await fs.lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (present) { need(existingPlan && present.isDirectory()); await directory(root, false); }
  await writeOnce(planFile, planBytes);
  const lock = async () => need((await read(path.join(targetServer, 'package-lock.json'), { privateMode: false })).sha256 === packageLockSha256);
  const options = { cwd: targetServer, timeout: 300000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', CI: 'true',
    NODE_OPTIONS: '--max-old-space-size=1024', npm_config_jobs: '2', npm_config_maxsockets: '4',
    npm_config_fetch_retries: '1', npm_config_fetch_timeout: '30000', npm_config_cache: path.join(controls, 'cache'),
    npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null', npm_config_update_notifier: 'false' } };
  const existingReceipt = await read(receiptFile, { optional: true });
  if (!existingReceipt) {
    need(!await read(path.join(targetServer, '.env.local'), { optional: true }));
    await mkdirPrivate(options.env.npm_config_cache); await lock();
    await exec('/usr/bin/npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], options); await lock();
  }
  const check = async () => {
    await lock();
    const output = (await exec('/usr/bin/npm', ['ls', '--omit=dev', '--all', '--json'], { ...options, timeout: 30000 })).stdout;
    need(Buffer.byteLength(output) <= 8 * 1024 ** 2);
    const tree = JSON.parse(output); need(tree && typeof tree === 'object' && !Array.isArray(tree) && !tree.error && !tree.problems);
    const inventory = await dependencyInventory(root); await lock();
    return { ...plan, treeSha256: sha(output), inventory };
  };
  const value = await check(), bytes = Buffer.from(JSON.stringify(value));
  if (existingReceipt) need(existingReceipt.data.equals(bytes));
  else await writeOnce(receiptFile, bytes);
  return { path: root, mode: plan.mode, packageLockSha256, receiptPath: receiptFile, receiptSha256: sha(bytes),
    inventory: value.inventory, async recheck() { need(Buffer.from(JSON.stringify(await check())).equals(bytes)
      && (await read(receiptFile)).data.equals(bytes)); } };
}

async function secureReleasePackageCopies({ releaseRoot, targetServer, exec, releaseCheck }) {
  await directory(releaseRoot); await releaseCheck();
  await inDirectory(releaseRoot, async anchored => {
    const before = await fs.lstat(targetServer, { bigint: true });
    need(before.isDirectory() && before.uid === BigInt(process.getuid()) && [0o700, 0o755, 0o775].includes(Number(before.mode) & 0o7777)
      && await fs.realpath(targetServer) === targetServer);
    const serverHandle = await fs.open(path.join(anchored, 'server'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const files = [];
    const serverCheck = async expected => need(signature(await serverHandle.stat({ bigint: true })) === signature(expected)
      && signature(await fs.lstat(targetServer, { bigint: true })) === signature(expected) && await fs.realpath(targetServer) === targetServer);
    try {
      await serverCheck(before);
      const parent = process.platform === 'linux' ? '/proc/self/fd/' + serverHandle.fd : targetServer;
      for (const name of ['package.json', 'package-lock.json']) {
        const result = await exec('git', ['-C', releaseRoot, 'show', '--no-ext-diff', '--no-textconv', 'HEAD:server/' + name],
          { encoding: 'buffer', maxBuffer: 2 * 1024 ** 2 });
        const blob = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout, 'utf8');
        need(blob.length > 0 && blob.length <= 2 * 1024 ** 2);
        const file = path.join(targetServer, name), initial = await fs.lstat(file, { bigint: true });
        need(initial.isFile() && initial.uid === BigInt(process.getuid()) && initial.nlink === 1n
          && [0o600, 0o644, 0o664].includes(Number(initial.mode) & 0o7777)
          && initial.size === BigInt(blob.length) && await fs.realpath(file) === file);
        const handle = await fs.open(path.join(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        files.push({ file, initial, handle, sha256: sha(blob) });
        need(signature(await handle.stat({ bigint: true })) === signature(initial));
        const bytes = Buffer.alloc(blob.length);
        for (let offset = 0; offset < bytes.length;) {
          const result = await handle.read(bytes, offset, bytes.length - offset, offset);
          need(result.bytesRead > 0); offset += result.bytesRead;
        }
        need((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0 && bytes.equals(blob));
      }
      // Only these new checkout copies are tightened. Never follow a changed
      // pathname or chmod a shared inode, original package or retained data.
      await releaseCheck(); await serverCheck(before);
      const fileCheck = async ({ file, handle }, expected) => {
        const opened = await handle.stat({ bigint: true }), named = await fs.lstat(file, { bigint: true });
        need(opened.nlink === 1n && named.nlink === 1n && signature(opened) === signature(expected)
          && signature(named) === signature(expected) && await fs.realpath(file) === file);
      };
      for (const file of files) await fileCheck(file, file.initial);
      if ((Number(before.mode) & 0o7777) !== 0o700) await serverHandle.chmod(0o700);
      const after = await serverHandle.stat({ bigint: true });
      need(after.ino === before.ino && after.dev === before.dev && after.uid === before.uid && after.gid === before.gid
        && after.size === before.size && after.mtimeNs === before.mtimeNs && (Number(after.mode) & 0o7777) === 0o700);
      await serverCheck(after);
      for (const file of files) {
        await fileCheck(file, file.initial); await serverCheck(after);
        if ((Number(file.initial.mode) & 0o7777) !== 0o600) await file.handle.chmod(0o600);
        const checked = await file.handle.stat({ bigint: true });
        need(checked.ino === file.initial.ino && checked.dev === file.initial.dev && checked.uid === file.initial.uid
          && checked.gid === file.initial.gid && checked.size === file.initial.size && checked.nlink === 1n
          && checked.mtimeNs === file.initial.mtimeNs && (Number(checked.mode) & 0o7777) === 0o600);
        await fileCheck(file, checked);
        need((await read(file.file)).sha256 === file.sha256); await fileCheck(file, checked);
      }
      await serverCheck(after); await releaseCheck();
    } finally {
      for (const file of files) await file.handle.close();
      await serverHandle.close();
    }
  });
}

const receiptCodePaths = ['scripts/driverAuditSync.js', 'services/driverAuditDataBackend.js',
  'vendor/driver-audits/integration/hosted/supabase-archive.mjs', 'vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs'];
const receiptArchive = { project: 'https://trhhjfgfmxofxhnzocks.supabase.co', bucket: 'matter-report-archive' };

async function archiveReceiptNamespace(server, exec, appRoot, target = false, expectedCommit) {
  const names = [...receiptCodePaths, ...(target ? ['services/driverAuditSupabaseAppBackend.js', 'services/driverAuditSupabaseArchive.js'] : [])];
  need(commit(expectedCommit));
  const clean = async () => {
    need((await exec('git', ['-C', appRoot, 'rev-parse', 'HEAD'])).stdout.trim() === expectedCommit);
    await exec('git', ['-C', appRoot, 'diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...names.map(name => 'server/' + name)]);
  };
  await clean();
  await exec('git', ['-C', appRoot, 'ls-files', '--error-unmatch', ...names.map(name => 'server/' + name)]);
  const files = [];
  for (const name of names) {
    const result = await exec('git', ['-C', appRoot, 'show', '--no-ext-diff', '--no-textconv', 'HEAD:server/' + name],
      { encoding: 'buffer', maxBuffer: 512 * 1024 });
    const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout, 'utf8');
    need(bytes.length > 0 && bytes.length <= 512 * 1024);
    files.push({ name, sha256: sha(bytes), bytes: bytes.length });
    if (name.endsWith('/supabase-archive.mjs')) {
      const text = bytes.toString('utf8');
      need(/\bconst\s+base\s*=\s*(['"])https:\/\/trhhjfgfmxofxhnzocks\.supabase\.co\/storage\/v1\1\s*;/.test(text)
        && /\bconst\s+bucket\s*=\s*(['"])matter-report-archive\1\s*[,;]/.test(text));
    }
    if (name.endsWith('/driver-audit-handoff.mjs')) need(/\bconst\s+archiveName\s*=\s*(['"])matter-report-archive\1\s*;/.test(bytes.toString('utf8')));
  }
  await clean();
  return { archiveIdentitySha256: sha(JSON.stringify(receiptArchive)), files };
}

async function archiveReceiptInventory(folder, boundary) {
  try { await directory(folder); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { present: false, root: folder, files: [], bytes: 0, objectBytes: 0, inventorySha256: sha('[]'), physicalInventorySha256: sha('[]') };
  }
  return withPrivatePackageDirectory(folder, boundary, async () => {
    const before = await fs.lstat(folder, { bigint: true }), entries = (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    need(entries.length <= 100000); const files = []; let bytes = 0, objectBytes = 0;
    for (const entry of entries) {
      need(entry.isFile() && /^[a-f0-9]{64}\.gz\.json$/.test(entry.name));
      const saved = await read(path.join(folder, entry.name), { maximum: 2048 }), value = JSON.parse(saved.data), key = entry.name.slice(0, -5);
      need(Buffer.from(JSON.stringify(value)).equals(saved.data)
        && exactKeys(value, ['target', 'key', 'sha256', 'bytes', 'verified']) && value.target === receiptArchive.bucket
        && value.key === key && value.sha256 === key.slice(0, 64) && value.verified === true
        && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 8 * 1024 ** 2
        && (bytes += saved.bytes) <= 64 * 1024 ** 2);
      objectBytes += value.bytes;
      files.push({ name: entry.name, sha256: saved.sha256, bytes: saved.bytes, objectBytes: value.bytes,
        physicalSignature: signature(await fs.lstat(saved.path, { bigint: true })), data: saved.data });
    }
    need(signature(await fs.lstat(folder, { bigint: true })) === signature(before));
    const inventory = files.map(({ name, sha256, bytes, objectBytes }) => ({ name, sha256, bytes, objectBytes }));
    return { present: true, root: folder, files, bytes, objectBytes, inventorySha256: sha(JSON.stringify(inventory)),
      physicalInventorySha256: sha(JSON.stringify(files.map(({ name, physicalSignature }) => ({ name, physicalSignature })))) };
  });
}

async function originalArchiveReceiptSource({ server, before, exec, load }) {
  const expected = before.metadata.workers.rows.find(row => row.name === 'matter-driver-audit-sync');
  const rows = JSON.parse((await exec('pm2', ['jlist'])).stdout); need(Array.isArray(rows) && rows.length <= 512);
  const matches = rows.filter(row => row.name === 'matter-driver-audit-sync'); need(matches.length === 1);
  const row = matches[0], settings = row.pm2_env;
  need(row.pm_id === expected.id && row.pid === 0 && settings.status === 'stopped' && settings.pm_cwd === server
    && settings.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js') && settings.exec_interpreter === before.metadata.node.executable
    && JSON.stringify(settings.args) === JSON.stringify(['--config', before.metadata.sync.configFile.path]));
  const inherited = {}, keys = ['DRIVER_AUDIT_DATA_STORE', 'DRIVER_AUDIT_EXECUTION_HOST', 'DRIVER_AUDIT_SUPABASE_SECRET', 'MATTER_SUPABASE_SECRET', 'NODE_OPTIONS'];
  for (const name of keys) {
    const flat = settings[name], nested = settings.env?.[name];
    need(flat === undefined || typeof flat === 'string'); need(nested === undefined || typeof nested === 'string');
    need(flat === undefined || nested === undefined || flat === nested);
    if (flat !== undefined || nested !== undefined) inherited[name] = flat ?? nested;
  }
  const dotenv = await load('node_modules/dotenv/lib/main.js');
  const environmentFiles = await Promise.all(['.env', '.env.local'].map(name => read(path.join(server, name), { maximum: 256 * 1024, privateMode: false, optional: true })));
  need(JSON.stringify(environmentFiles.map(value => value?.sha256 ?? null)) === JSON.stringify(before.configurationPin));
  const effective = { ...(environmentFiles[0] ? dotenv.parse(environmentFiles[0].data) : {}), ...inherited,
    ...(environmentFiles[1] ? dotenv.parse(environmentFiles[1].data) : {}) };
  const secret = effective.DRIVER_AUDIT_SUPABASE_SECRET || effective.MATTER_SUPABASE_SECRET;
  need((effective.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase'
    && [undefined, '', 'sidi'].includes(effective.DRIVER_AUDIT_EXECUTION_HOST)
    && typeof secret === 'string' && secret.length > 0 && secret.length <= 8192 && !/[\r\n]/.test(secret)
    && (effective.NODE_OPTIONS === undefined || /^--max-old-space-size=\d{3,5}$/.test(effective.NODE_OPTIONS))
    && (settings.node_args === undefined || JSON.stringify(settings.node_args) === '[]'));
  const namespace = await archiveReceiptNamespace(server, exec, path.dirname(server), false, before.metadata.applicationCommit);
  const source = { applicationCommit: before.metadata.applicationCommit, syncRoot: before.metadata.sync.config.root,
    syncConfigSha256: before.metadata.sync.configFile.sha256, dataStore: 'supabase', environmentPin: before.configurationPin,
    runtimeSelectionSha256: sha(JSON.stringify([row.pm_id, effective.DRIVER_AUDIT_DATA_STORE || 'supabase', effective.DRIVER_AUDIT_EXECUTION_HOST || null,
      effective.NODE_OPTIONS ?? null, sha(secret)])), ...namespace };
  return { source, inventory: await archiveReceiptInventory(path.join(source.syncRoot, 'archive-receipts'), source.syncRoot) };
}

async function stageArchiveReceiptPrefix({ saved, syncRoot, targetServer, releaseRoot, releaseSha, stagingReceiptSha256, exec }) {
  const namespace = await archiveReceiptNamespace(targetServer, exec, releaseRoot, true, releaseSha);
  need(saved.source.archiveIdentitySha256 === namespace.archiveIdentitySha256);
  const target = path.join(syncRoot, 'archive-receipts'); await mkdirPrivate(target);
  for (const row of saved.inventory.files) {
    const original = await read(path.join(saved.inventory.root, row.name), { maximum: 2048 });
    need(original.sha256 === row.sha256 && original.bytes === row.bytes);
    await writeOnce(path.join(target, row.name), original.data);
  }
  const proof = { version: 1, kind: 'retained-supabase-archive-receipts-v1', stagingReceiptSha256,
    source: { ...saved.source, directoryPresent: saved.inventory.present, inventorySha256: saved.inventory.inventorySha256,
      physicalInventorySha256: saved.inventory.physicalInventorySha256 },
    destination: { releaseSha, root: target, ...namespace },
    receipts: saved.inventory.files.map(({ name, sha256, bytes, objectBytes }) => ({ name, sha256, bytes, objectBytes })),
    retainedVerificationMetadataBytes: saved.inventory.bytes, originalVerifiedObjectBytes: saved.inventory.objectBytes,
    freshRemoteObjectBytesVerified: false, remoteAvailabilityAsserted: false, originalReceiptsChanged: false };
  const bytes = Buffer.from(JSON.stringify(proof)), proofFile = path.join(syncRoot, 'retained/archive-verification-receipts.private.json');
  need(bytes.length <= 32 * 1024 ** 2); await writeOnce(proofFile, bytes);
  const recheck = async () => {
    const current = await archiveReceiptInventory(saved.inventory.root, saved.source.syncRoot);
    need(current.present === saved.inventory.present && current.inventorySha256 === saved.inventory.inventorySha256
      && current.physicalInventorySha256 === saved.inventory.physicalInventorySha256);
    const actual = await archiveReceiptInventory(target, syncRoot), byName = new Map(actual.files.map(row => [row.name, row]));
    for (const row of saved.inventory.files) need(byName.get(row.name)?.sha256 === row.sha256 && byName.get(row.name)?.bytes === row.bytes);
    need((await read(proofFile, { maximum: 32 * 1024 ** 2 })).sha256 === sha(bytes)
      && JSON.stringify(await archiveReceiptNamespace(targetServer, exec, releaseRoot, true, releaseSha)) === JSON.stringify(namespace));
  };
  await recheck();
  const result = { path: proofFile, sha256: sha(bytes), bytes: bytes.length, receipts: proof.receipts.length,
    retainedVerificationMetadataBytes: saved.inventory.bytes, originalVerifiedObjectBytes: saved.inventory.objectBytes,
    stagingReceiptSha256, freshRemoteObjectBytesVerified: false, remoteAvailabilityAsserted: false };
  Object.defineProperty(result, 'recheck', { value: recheck }); return result;
}

async function prepareHost({ appRoot, server, before, environment, bootstrapSha256, exec, load, adapters, setPhase, observeFailure }) {
  const pins = adapters.pins ?? preparationPins;
  setPhase('source-credentials');
  const oldSource = before.metadata.source.releases.find(row => row.manifestSha256 === pins.oldSource); need(oldSource);
  const oldSourceConfig = await read(oldSource.configFile.path), sourceConfig = JSON.parse(oldSourceConfig.data);
  const sourceEnvironmentFile = await read(sourceConfig.environment.path, { maximum: 64 * 1024 });
  need(sourceEnvironmentFile.sha256 === sourceConfig.environment.sha256);
  const oldEnvironment = JSON.parse(sourceEnvironmentFile.data);
  need(oldEnvironment && !Array.isArray(oldEnvironment) && originalEnvironmentKeys.every(key => typeof oldEnvironment[key] === 'string'));
  const originalEnvironment = Object.fromEntries(originalEnvironmentKeys.map(key => [key, oldEnvironment[key]]));
  setPhase('bootstrap');
  const archive = adapters.bootstrapArchive ?? (await load('vendor/driver-audits/integration/hosted/supabase-archive.mjs'))
    .createSupabaseArchiveTransport({ secret: originalEnvironment.MATTER_SUPABASE_SECRET });
  const { value: bootstrap, bytes: bootstrapBytes } = await decodeBootstrap(archive, bootstrapSha256);
  const sync = before.metadata.sync, expected = bootstrap.expected;
  need(bootstrap.releaseSha === pins.release && bootstrap.inspectionMetadataSha256 === sha(JSON.stringify(before.metadata))
    && expected.syncConfigSha256 === sync.configFile.sha256 && expected.seedSha256 === sync.seed.sha256
    && expected.currentPointerSha256 === sync.pointers.current?.sha256 && expected.sourceConfigSha256 === oldSourceConfig.sha256
    && sync.config.builderSha256 === pins.oldBuilder && sync.baseline.sha256 === pins.baseline
    && sync.seed.value.collectorRevision === pins.baselineRevision && sync.pointers.previous === undefined);
  const pointerFile = await read(sync.pointers.current.path), current = JSON.parse(pointerFile.data);
  need(current.version === 1 && current.collectorRevision === pins.candidateRevision && current.manifestSha256 === pins.candidate
    && current.sourceBasis === pins.candidateBasis && uuid(path.basename(path.dirname(current.privateRoot)))
    && current.privateRoot === path.join(sync.config.root, 'work/attempts', path.basename(path.dirname(current.privateRoot)), 'server-data'));
  const candidate = { ...current, role: 'candidate', attemptId: path.basename(path.dirname(current.privateRoot)), acceptedSha256: null, directSeedSha256: null };
  for (const [role, pin] of [['serving-current', pins.servingCurrent], ['serving-previous', pins.servingPrevious]]) {
    const matches = bootstrap.retained.filter(row => row?.role === role); need(matches.length === 1);
    const row = matches[0]; need(exactKeys(row, ['version', 'privateRoot', 'collectorRevision', 'sourceBasis', 'manifestSha256', 'generation',
      'reportHash', 'attemptId', 'acceptedSha256', 'directSeedSha256', 'role']) && row.version === 1
      && uuid(row.attemptId) && row.collectorRevision === pin.collectorRevision
      && row.manifestSha256 === pin.manifestSha256 && row.generation === pin.generation && digest(row.sourceBasis) && digest(row.reportHash)
      && digest(row.acceptedSha256) && (row.directSeedSha256 === null || digest(row.directSeedSha256))
      && row.privateRoot === path.join(sync.config.root, 'work/attempts', row.attemptId, 'server-data'));
  }
  setPhase('code-archives');
  const builder = codeArchive(bootstrap.builder, pins.builder, 'runtime-manifest.json', pins.builderFiles);
  const source = codeArchive(bootstrap.source, pins.source, 'manifest.private.json', pins.sourceFiles);
  setPhase('node');
  const node = adapters.node ?? { executable: await fs.realpath(process.execPath), version: process.version };
  need(node.version === 'v22.23.4' && node.executable === '/usr/bin/node' && sourceConfig.nodeExecutable === node.executable
    && sourceConfig.nodeVersion === node.version);
  const nodeProof = adapters.node ?? await fileHash(node.executable, { maximum: 256 * 1024 ** 2, privateMode: false });
  if (!adapters.node) need(nodeProof.stat.uid === 0n && !(Number(nodeProof.stat.mode) & 0o022) && await fs.realpath('/proc/self/exe') === node.executable);
  setPhase('archive-receipts-source');
  const receiptSource = await originalArchiveReceiptSource({ server, before, exec, load });
  const packagePhase = prefix => name => setPhase(prefix + '-' + name);
  const observeRole = role => value => observeFailure({ role, ...value });
  const baseline = await packageFiles(sync.config.baselineRoot, pins.baseline,
    { archiveBackedManifest: true, privateDirectoryBoundary: sync.config.root, phase: packagePhase('baseline'), observe: observeRole('baseline') });
  const retained = [];
  for (const row of [candidate, ...bootstrap.retained]) {
    need(['candidate', 'serving-current', 'serving-previous'].includes(row.role));
    setPhase(row.role + '-accepted-read');
    const parent = path.dirname(row.privateRoot), acceptedPath = path.join(parent, 'accepted.private.json');
    observeRole(row.role)({ root: parent, file: acceptedPath, declaredSha256: row.acceptedSha256 });
    const accepted = await read(acceptedPath, { optional: true });
    observeRole(row.role)({ root: parent, file: acceptedPath, declaredSha256: row.acceptedSha256, alreadyReadSha256: accepted?.sha256 });
    setPhase(row.role + '-accepted-pin');
    if (row.role !== 'candidate') need(accepted?.sha256 === row.acceptedSha256);
    if (accepted) {
      setPhase(row.role + '-accepted-validation');
      const value = JSON.parse(accepted.data);
      need(value.version === 1 && value.privateRoot === row.privateRoot && value.collectorRevision === row.collectorRevision
        && value.manifestSha256 === row.manifestSha256 && value.sourceBasis === row.sourceBasis);
    }
    setPhase(row.role + '-direct-seed-read');
    const seedPath = path.join(parent, 'direct-seed.private.json');
    observeRole(row.role)({ root: parent, file: seedPath, declaredSha256: row.directSeedSha256 });
    const seed = await read(seedPath, { maximum: 1024 * 1024, optional: true });
    observeRole(row.role)({ root: parent, file: seedPath, declaredSha256: row.directSeedSha256, alreadyReadSha256: seed?.sha256 });
    setPhase(row.role + '-direct-seed-pin');
    if (row.role !== 'candidate') need((seed?.sha256 ?? null) === row.directSeedSha256);
    let objects = null;
    if (seed) {
      setPhase(row.role + '-direct-seed-validation');
      const value = JSON.parse(seed.data);
      need(value.version === 1 && value.mode === 'sync' && value.collectorRevision === row.collectorRevision
        && value.manifestSha256 === row.manifestSha256 && value.sourceBasis === row.sourceBasis
        && value.bundleRoot === path.join(parent, 'audit-objects') && digest(value.pointer?.generation) && digest(value.pointer?.reportHash)
        && (!row.generation || value.pointer.generation === row.generation) && (!row.reportHash || value.pointer.reportHash === row.reportHash));
      objects = await packageFiles(value.bundleRoot, null, { objects: true, phase: packagePhase(row.role + '-audit-objects'), observe: observeRole(row.role) });
    }
    retained.push({ value: row, files: await packageFiles(row.privateRoot, row.manifestSha256,
      { archiveBackedManifest: true, privateDirectoryBoundary: sync.config.root,
        phase: packagePhase(row.role + '-package'), observe: observeRole(row.role) }), accepted, seed, objects });
  }
  setPhase('release');
  const releaseGit = async (step, args, timeout = 10_000) => {
    setPhase('release-' + step);
    try { return await exec('git', args, { timeout }); }
    catch (error) {
      observeFailure({ releaseCommand: true, step, exitCode: Number.isInteger(error.code) ? error.code : null,
        signal: typeof error.signal === 'string' ? error.signal.slice(0, 32) : null, killed: error.killed === true,
        stdout: String(error.stdout ?? '').slice(0, 8192), stderr: String(error.stderr ?? '').slice(0, 8192),
        message: String(error.message ?? '').slice(0, 4096) });
      throw error;
    }
  };
  const rootId = sha(JSON.stringify(['driver-reports-supabase-sync-v1', bootstrap.releaseSha, pins.source, pins.builder, pins.baseline, pins.candidate]));
  const releases = path.join(server, '.private/driver-report-app-releases'), releaseRoot = path.join(releases, bootstrap.releaseSha);
  await mkdirPrivate(releases);
  try { await directory(releaseRoot); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await releaseGit('commit', ['cat-file', '-e', bootstrap.releaseSha + '^{commit}']); }
    catch {
      await releaseGit('fetch', ['fetch', '--no-tags', 'origin', bootstrap.releaseSha], 120_000);
      await releaseGit('fetched-commit', ['cat-file', '-e', bootstrap.releaseSha + '^{commit}']);
    }
    await mkdirPrivate(releaseRoot);
    await releaseGit('clone', ['clone', '--shared', '--dissociate', '--no-checkout', '--', appRoot, releaseRoot], 120_000);
    await releaseGit('checkout', ['-C', releaseRoot, 'checkout', '--detach', bootstrap.releaseSha], 60_000);
    await fs.chmod(releaseRoot, 0o700); await directory(releaseRoot);
  }
  const targetServer = path.join(releaseRoot, 'server');
  const releaseCheck = async () => {
    need((await exec('git', ['-C', releaseRoot, 'rev-parse', 'HEAD'])).stdout.trim() === bootstrap.releaseSha);
    need((await exec('git', ['-C', releaseRoot, 'rev-parse', '--show-toplevel'])).stdout.trim() === releaseRoot);
    const status = (await exec('git', ['-C', releaseRoot, 'status', '--porcelain', '--untracked-files=all', '--', 'server'])).stdout;
    need(!status.trim());
    const alternates = await read(path.join(releaseRoot, '.git/objects/info/alternates'), { privateMode: false, optional: true }); need(!alternates);
    await exec('git', ['-C', releaseRoot, 'ls-files', '--error-unmatch', 'server/package.json', 'server/package-lock.json',
      'server/scripts/driverAuditHttp.js', 'server/scripts/driverAuditSourceStage.js', 'server/services/driverAuditSource.js',
      'server/services/driverAuditSupabaseReplica.js', 'server/services/driverAuditSupabaseSync.js']);
  };
  setPhase('release-readback'); await releaseCheck();
  setPhase('release-permissions'); await secureReleasePackageCopies({ releaseRoot, targetServer, exec, releaseCheck });
  const originalLock = await read(path.join(server, 'package-lock.json'), { privateMode: false });
  const targetLock = await read(path.join(targetServer, 'package-lock.json'), { privateMode: false });
  need(originalLock.sha256 === bootstrap.packageLockSha256 && targetLock.sha256 === originalLock.sha256);
  setPhase('dependencies');
  const dependencies = await prepareDependencies({ targetServer, packageLockSha256: originalLock.sha256,
    npmIdentitySha256: before.metadata.workers.npm.identitySha256, node, exec });
  setPhase('stage-directories');
  const syncRoot = path.join(targetServer, '.private/driver-audits', rootId), sourceRoot = path.join(targetServer, '.private/driver-audit-source');
  for (const folder of [syncRoot, sourceRoot, path.join(syncRoot, 'work/archive-cache'), path.join(syncRoot, 'retained')]) await mkdirPrivate(folder);
  setPhase('stage-packages');
  const presenceFile = role => path.join(syncRoot, 'retained/package-presence', role + '.private.json');
  const packages = [{ role: 'baseline-builder-input', ...await linkPackage(baseline, path.join(syncRoot, 'baseline'),
    presenceFile('baseline-builder-input'), syncRoot) }], stagedObjects = [], copiedControls = [];
  const copyControl = async (file, bytes) => { await writeOnce(file, bytes); copiedControls.push({ file, sha256: sha(bytes) }); };
  await copyControl(path.join(syncRoot, 'retained/original-sync.private.json'), (await read(sync.configFile.path)).data);
  await copyControl(path.join(syncRoot, 'retained/original-seed.private.json'), (await read(sync.seed.path)).data);
  await copyControl(path.join(syncRoot, 'retained/original-current.private.json'), pointerFile.data);
  const releaseLoad = name => adapters.loadRelease ? adapters.loadRelease(name, releaseRoot)
    : import(pathToFileURL(path.join(targetServer, name)).href);
  for (const row of retained) {
    const folder = path.join(syncRoot, 'retained', row.value.role); await mkdirPrivate(folder);
    const data = await linkPackage(row.files, path.join(folder, 'server-data'), presenceFile(row.value.role), syncRoot);
    if (row.accepted) await copyControl(path.join(folder, 'accepted.original.private.json'), row.accepted.data);
    let descriptorVerified = false;
    if (row.seed) {
      await copyControl(path.join(folder, 'direct-seed.original.private.json'), row.seed.data);
      const objects = await linkPackage(row.objects, path.join(folder, 'audit-objects')), value = JSON.parse(row.seed.data);
      stagedObjects.push(objects);
      const head = { ...value.pointer, servingPackage: { version: 1, dataStore: 'supabase', collectorRevision: value.collectorRevision,
        sourceBasis: value.sourceBasis, manifestSha256: value.manifestSha256 }, visibleCutoffAt: value.visibleCutoffAt,
      closureReceipt: value.closureReceipt, restore: value.restore, previous: value.pointer.previous ?? null };
      const verify = adapters.verifyPackage ?? (await releaseLoad('services/driverAuditSupabaseReplica.js')).verifyDriverAuditSupabaseServingPackage;
      await verify({ head, archive: { async readObject(key, { maxBytes }) {
        need(/^[a-f0-9]{64}\.gz$/.test(key) && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 8 * 1024 ** 2);
        return [(await read(path.join(objects.root, key), { maximum: maxBytes })).data];
      } } }); descriptorVerified = true;
    }
    packages.push({ role: row.value.role, collectorRevision: row.value.collectorRevision, sourceBasis: row.value.sourceBasis,
      ...data, originalAcceptedSha256: row.accepted?.sha256 ?? null, originalDirectSeedSha256: row.seed?.sha256 ?? null,
      descriptorVerified, servingSelectionPending: true });
  }
  setPhase('stage-builder');
  const codeRoot = path.join(syncRoot, 'builder'); await mkdirPrivate(codeRoot);
  for (const [name, bytes] of builder.files) { const file = path.join(codeRoot, name); await mkdirPrivate(path.dirname(file)); await writeOnce(file, bytes); }
  await tree(codeRoot, builder.manifest.files);
  const rendererFile = path.join(syncRoot, 'baseline/build.private.json'), journalsFile = path.join(syncRoot, 'validation-journals.private.json');
  await writeOnce(rendererFile, (await read(sync.renderer.path)).data); await writeOnce(journalsFile, (await read(sync.journals.path)).data);
  const syncConfig = { ...JSON.parse((await read(sync.configFile.path)).data), root: syncRoot, codeRoot, baselineRoot: path.join(syncRoot, 'baseline'),
    builderSha256: pins.builder, rendererBuild: { path: rendererFile, sha256: sync.renderer.sha256 },
    journals: { path: journalsFile, sha256: sync.journals.sha256 } };
  await writeOnce(path.join(syncRoot, 'sync.json'), Buffer.from(JSON.stringify(syncConfig)));
  setPhase('stage-source');
  const sourceEnvironment = { ...originalEnvironment, MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: path.join(syncRoot, 'work/archive-cache'), DRIVER_AUDIT_EXECUTION_HOST: 'sidi' };
  const environmentBytes = Buffer.from(JSON.stringify(sourceEnvironment));
  need(sha(environmentBytes) === expected.sourceEnvironmentSha256);
  const wrappedSource = gzipSync(Buffer.from(JSON.stringify({ ...source.bundle, nodeExecutable: node.executable, nodeVersion: node.version })));
  const stageSource = adapters.stageSource ?? (await releaseLoad('scripts/driverAuditSourceStage.js')).stageDriverAuditSource;
  const staged = await stageSource({ sourceRoot, compressed: wrappedSource, expectedBundleSha256: sha(wrappedSource),
    expectedManifestSha256: pins.source, environmentBytes, nodeExecutable: node.executable });
  need(staged.configFile === path.join(sourceRoot, pins.source, 'source.json'));
  const stagedSource = await sourceMetadata(targetServer);
  need(stagedSource.releases.length === 1 && stagedSource.releases[0].manifestSha256 === pins.source
    && stagedSource.releases[0].files === pins.sourceFiles);
  setPhase('stage-environment');
  const selected = Object.fromEntries(['JWT_SECRET', 'SPACES_ENDPOINT', 'SPACES_REGION', 'SPACES_BUCKET', 'SPACES_KEY', 'SPACES_SECRET']
    .filter(name => Object.hasOwn(environment, name)).map(name => [name, environment[name]]));
  need(typeof selected.JWT_SECRET === 'string' && selected.JWT_SECRET.length > 0);
  Object.assign(selected, { MATTER_SUPABASE_SECRET: originalEnvironment.MATTER_SUPABASE_SECRET,
    DRIVER_AUDIT_SUPABASE_SECRET: originalEnvironment.MATTER_SUPABASE_SECRET, DRIVER_AUDIT_EXECUTION_HOST: 'sidi',
    DRIVER_AUDIT_DATA_STORE: 'supabase', MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: sourceEnvironment.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY,
    DRIVER_AUDIT_RELEASE_SHA: bootstrap.releaseSha, DRIVER_AUDIT_ENABLED: '0', DRIVER_AUDIT_IMPORT_ENABLED: '0', DRIVER_AUDIT_REPLICA_GC_ENABLED: '0' });
  const envBytes = Buffer.from(Object.entries(selected).map(([name, value]) => name + '=' + JSON.stringify(value)).join('\n') + '\n');
  const dotenv = await load('node_modules/dotenv/lib/main.js'); need(JSON.stringify(dotenv.parse(envBytes)) === JSON.stringify(selected));
  await writeOnce(path.join(targetServer, '.env.local'), envBytes);
  let receiptPrefix;
  const recheck = async () => {
    for (const row of [baseline, ...retained.flatMap(item => [item.files, ...(item.objects ? [item.objects] : [])])]) {
      const current = await packageFiles(row.root, row.manifestSha256,
        { objects: row.manifestSha256 === null, archiveBackedManifest: row.archiveBackedManifest, privateDirectoryBoundary: row.privateDirectoryBoundary });
      need(current.inventorySha256 === row.inventorySha256 && current.missingArchiveReferencesSha256 === row.missingArchiveReferencesSha256);
    }
    for (const row of retained) for (const [name, original] of [['accepted.private.json', row.accepted], ['direct-seed.private.json', row.seed]]) {
      const actual = await read(path.join(path.dirname(row.value.privateRoot), name), { maximum: 1024 * 1024, optional: true });
      need((actual?.sha256 ?? null) === (original?.sha256 ?? null));
    }
    for (const row of [...packages, ...stagedObjects]) {
      const actual = await packageFiles(row.root, row.manifestSha256,
        { objects: row.manifestSha256 === null, archiveBackedManifest: row.archiveBackedManifest, privateDirectoryBoundary: row.privateDirectoryBoundary });
      need(actual.inventorySha256 === row.inventorySha256);
      if (row.archiveBackedManifest) {
        need(actual.missingArchiveReferencesSha256 === row.missingArchiveReferencesSha256
          && actual.declaredFiles === row.declaredFiles && actual.missingArchiveReferences.length === row.archiveReferences.locallyMissing);
        const mask = await read(row.archiveReferences.path, { maximum: 8 * 1024 ** 2 });
        need(mask.sha256 === row.archiveReferences.sha256 && mask.bytes === row.archiveReferences.bytes
          && sameArchiveMask(JSON.parse(mask.data), actual));
      }
    }
    for (const ref of copiedControls) need((await read(ref.file)).sha256 === ref.sha256);
    need((await read(oldSourceConfig.path)).sha256 === oldSourceConfig.sha256
      && (await read(sourceEnvironmentFile.path, { maximum: 64 * 1024 })).sha256 === sourceEnvironmentFile.sha256);
    need(JSON.stringify(await sourceMetadata(targetServer)) === JSON.stringify(stagedSource)
      && (await read(path.join(codeRoot, 'runtime-manifest.json'))).sha256 === pins.builder);
    await tree(codeRoot, builder.manifest.files);
    need((await read(path.join(syncRoot, 'sync.json'))).data.equals(Buffer.from(JSON.stringify(syncConfig)))
      && (await read(rendererFile)).sha256 === sync.renderer.sha256 && (await read(journalsFile)).sha256 === sync.journals.sha256);
    await releaseCheck();
    await dependencies.recheck();
    need((await read(path.join(targetServer, '.env.local'))).data.equals(envBytes));
    if (!adapters.node) need((await fileHash(node.executable, { maximum: 256 * 1024 ** 2, privateMode: false })).sha256 === nodeProof.sha256);
    const currentReceipts = await originalArchiveReceiptSource({ server, before, exec, load });
    need(JSON.stringify(currentReceipts.source) === JSON.stringify(receiptSource.source)
      && currentReceipts.inventory.inventorySha256 === receiptSource.inventory.inventorySha256
      && currentReceipts.inventory.physicalInventorySha256 === receiptSource.inventory.physicalInventorySha256);
    if (receiptPrefix) await receiptPrefix.recheck();
    for (const name of ['seed.json', 'work/current.private.json']) {
      try { await fs.lstat(path.join(syncRoot, name)); need(false); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  await copyControl(path.join(syncRoot, 'retained/bootstrap.private.json.gz'), bootstrapBytes);
  setPhase('staging-readback'); await recheck();
  const prepared = { releaseRoot, releaseSha: bootstrap.releaseSha, syncRoot, syncConfig: path.join(syncRoot, 'sync.json'),
    nodeExecutable: node.executable, nodeVersion: node.version, rootId, bootstrapSha256, packages,
    dependencies,
    sourceManifestSha256: pins.source, builderSha256: pins.builder, sourceConfig: staged.configFile,
    sourceEnvironmentSha256: sha(environmentBytes), appEnvironmentSha256: sha(envBytes), offHostRebasedEnvironmentBackupPending: true,
    seedSelected: false, registrationsChanged: false, workersStarted: false, routingChanged: false,
    bootstrapTransport: 'private-supabase-https-sha256', sourceEnvironmentValuesExported: false };
  // Keep staging.private.json byte-compatible with prior preparation. The
  // separately pinned prefix can be adopted without rewriting that receipt.
  const stagingBytes = Buffer.from(JSON.stringify({ version: 1, kind: 'supabase-sidi-host-staging-receipt-v1',
    inspectionMetadataSha256: sha(JSON.stringify(before.metadata)), ...prepared }));
  const existingStaging = await read(path.join(syncRoot, 'staging.private.json'), { maximum: 2 * 1024 ** 2, optional: true });
  need(!existingStaging || existingStaging.data.equals(stagingBytes));
  setPhase('stage-archive-receipts');
  receiptPrefix = await stageArchiveReceiptPrefix({ saved: receiptSource, syncRoot, targetServer, releaseRoot,
    releaseSha: bootstrap.releaseSha, stagingReceiptSha256: sha(stagingBytes), exec });
  await recheck(); Object.defineProperty(prepared, 'archiveReceiptPrefix', { value: receiptPrefix });
  Object.defineProperty(prepared, 'recheck', { value: recheck });
  return prepared;
}

async function sealedPackageFailure({ target, phase, operation, expectedSha, recipientKey, exec, load }) {
  if (target?.releaseCommand === true && recipientKey && /^[a-z-]+$/.test(target.step || '')
    && phase === 'prepare-release-' + target.step && target.step.length <= 32) {
    const raw = Buffer.from(JSON.stringify({ version: 1, kind: 'supabase-release-command-failure-v1',
      applicationCommit: expectedSha, operation, operatorPhase: phase,
      command: { step: target.step, exitCode: target.exitCode, signal: target.signal, killed: target.killed,
        stdout: target.stdout, stderr: target.stderr, message: target.message } }));
    need(raw.length <= 32 * 1024);
    if ((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim() !== expectedSha) return null;
    await exec('git', ['diff', '--quiet', 'HEAD', '--', 'server/services/driverAuditTransferCodec.js']);
    const packed = gzipSync(raw), { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
    const metadataSha256 = sha(raw);
    const capsule = sealTransferSecrets(recipientKey, { version: 1, kind: 'supabase-release-command-failure-capsule-v1',
      applicationCommit: expectedSha, metadataSha256, metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
    return { status: 'supabase-host-stopped', applicationCommit: expectedSha, operatorPhase: phase, metadataSha256, capsule };
  }
  if (!target || !recipientKey || !/^prepare-(?:baseline|candidate|serving-current|serving-previous)-[a-z-]+$/.test(phase)) return null;
  const relativePath = path.relative(target.root, target.file);
  if (!['baseline', 'candidate', 'serving-current', 'serving-previous'].includes(target.role)
    || relativePath && !relative(relativePath) || !path.isAbsolute(target.root)
    || target.file !== target.root && !target.file.startsWith(target.root + path.sep)) return null;
  let info, statKind = 'unavailable', realpathMatches = null;
  try {
    info = await fs.lstat(target.file);
    statKind = info.isSymbolicLink() ? 'symbolic-link' : info.isFile() ? 'regular-file' : info.isDirectory() ? 'directory' : 'other';
    realpathMatches = await fs.realpath(target.file).then(value => value === target.file, () => null);
  } catch (error) { if (error.code === 'ENOENT') statKind = 'missing'; }
  const value = { version: 1, kind: 'supabase-package-first-failure-v1', applicationCommit: expectedSha,
    operation, operatorPhase: phase, role: target.role, relativePath, statKind,
    ownerUid: Number.isSafeInteger(info?.uid) ? info.uid : null, mode: info ? info.mode & 0o7777 : null,
    bytes: Number.isSafeInteger(info?.size) ? info.size : null, realpathMatches,
    declaredSha256: digest(target.declaredSha256) ? target.declaredSha256 : null,
    alreadyReadSha256: digest(target.alreadyReadSha256) ? target.alreadyReadSha256 : null };
  const raw = Buffer.from(JSON.stringify(value)); if (raw.length > 8192) return null;
  // No unsafe file is opened for diagnostics. A hash can only have come from
  // the already completed, guarded reader; this branch reads metadata only.
  if ((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim() !== expectedSha) return null;
  await exec('git', ['ls-files', '--error-unmatch', 'server/services/driverAuditTransferCodec.js']);
  await exec('git', ['diff', '--quiet', 'HEAD', '--', 'server/services/driverAuditTransferCodec.js']);
  const packed = gzipSync(raw), { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
  const metadataSha256 = sha(raw);
  const capsule = sealTransferSecrets(recipientKey, { version: 1, kind: 'supabase-package-first-failure-capsule-v1',
    applicationCommit: expectedSha, metadataSha256, metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
  return { status: 'supabase-host-stopped', applicationCommit: expectedSha, operatorPhase: phase, metadataSha256, capsule };
}

async function sealedPreparationFailure({ phase, operation, expectedSha, recipientKey, exec, load, error, appRoot, releaseSha }) {
  if (!recipientKey || !/^(?:prepare-[a-z-]+|staging-final-readback)$/.test(phase) || phase.length > 79) return null;
  const bounded = (value, limit) => Buffer.from(String(value ?? '')).subarray(0, limit).toString('utf8');
  const releaseMetadata = [];
  if (phase.startsWith('prepare-release') && commit(releaseSha)) {
    const root = path.join(appRoot, 'server/.private/driver-report-app-releases', releaseSha);
    for (const name of ['', '.git', 'server', 'server/package-lock.json']) {
      try {
        const info = await fs.lstat(path.join(root, name));
        releaseMetadata.push({ name, kind: info.isSymbolicLink() ? 'symbolic-link' : info.isDirectory() ? 'directory' : info.isFile() ? 'regular-file' : 'other',
          uid: info.uid, mode: info.mode & 0o7777, bytes: info.size });
      } catch (error) { releaseMetadata.push({ name, unavailable: bounded(error.code, 32) }); }
    }
  }
  const raw = Buffer.from(JSON.stringify({ version: 1, kind: 'supabase-preparation-failure-v1',
    applicationCommit: expectedSha, operation, operatorPhase: phase, releaseMetadata,
    cause: { name: bounded(error?.name, 128), message: bounded(error?.message, 4096), stack: bounded(error?.stack, 8192),
      code: bounded(error?.code, 128), signal: bounded(error?.signal, 32), killed: error?.killed === true,
      stdout: bounded(error?.stdout, 4096), stderr: bounded(error?.stderr, 8192) } }));
  need(raw.length <= 32 * 1024);
  if ((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim() !== expectedSha) return null;
  await exec('git', ['diff', '--quiet', 'HEAD', '--', 'server/services/driverAuditTransferCodec.js']);
  const packed = gzipSync(raw), { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
  const metadataSha256 = sha(raw);
  const capsule = sealTransferSecrets(recipientKey, { version: 1, kind: 'supabase-preparation-failure-capsule-v1',
    applicationCommit: expectedSha, metadataSha256, metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
  return { status: 'supabase-host-stopped', applicationCommit: expectedSha, operatorPhase: phase, metadataSha256, capsule };
}

export async function runDriverAuditSupabaseHandoff({ operation, appRoot, expectedSha, recipientPublicKey, bootstrapSha256 }, adapters = {}) {
  let phase = 'inputs', failureTarget, recipientKey, originalUmask; const locks = [];
  const exec = adapters.exec ?? ((file, args, options = {}) => execute(file, args,
    { cwd: appRoot, timeout: 10_000, maxBuffer: 8 * 1024 ** 2, ...options }));
  const load = adapters.load ?? (name => import(pathToFileURL(path.join(appRoot, 'server', name)).href));
  try {
    need(['inspect-supabase-host', 'prepare-supabase-host'].includes(operation) && (adapters.platform ?? process.platform) === 'linux' && commit(expectedSha)
      && (operation !== 'prepare-supabase-host' || digest(bootstrapSha256))
      && path.isAbsolute(appRoot) && await fs.realpath(appRoot) === appRoot);
    if (operation === 'prepare-supabase-host') originalUmask = process.umask(0o077);
    const key = recipient(recipientPublicKey), server = path.join(appRoot, 'server'); recipientKey = key;
    const checkout = async () => {
      need((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim() === expectedSha);
      await exec('git', ['ls-files', '--error-unmatch', ...codeFiles]);
      await exec('git', ['diff', '--quiet', 'HEAD', '--', 'server']);
    };
    phase = 'checkout'; await checkout();
    const snapshotWorkers = async () => workers(JSON.parse((await exec('pm2', ['jlist'])).stdout), appRoot, adapters.systemFile ?? systemFile);
    phase = 'workers';
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
    let effectiveEnvironment;
    const collect = async prefix => {
      const setPhase = name => { phase = prefix + '-' + name; };
      setPhase('configuration');
      const config = await configuration(server, load);
      effectiveEnvironment = config.environment;
      setPhase('workers'); const currentWorkers = await snapshotWorkers();
      const sync = await syncMetadata(first.syncFile, server, setPhase);
      setPhase('source'); const source = await sourceMetadata(server);
      setPhase('nginx'); const currentNginx = await nginx(adapters.nginxRoot ?? '/etc/nginx');
      setPhase('node'); const executable = adapters.node?.executable ?? await fs.realpath(process.execPath);
      return { configurationPin: config.pin, metadata: { applicationCommit: expectedSha, appRoot, serverRoot: server,
        workers: currentWorkers, sync, source, configuration: config.value, nginx: currentNginx,
        node: { executable, version: adapters.node?.version ?? process.version, platform: adapters.platform ?? process.platform },
        mongoConnections: 0 } };
    };
    const before = await collect('inspect');
    let preparation;
    if (operation === 'prepare-supabase-host') {
      phase = 'bootstrap-reader-checkout';
      await exec('git', ['ls-files', '--error-unmatch', 'server/vendor/driver-audits/integration/hosted/supabase-archive.mjs']);
      preparation = await prepareHost({ appRoot, server, before, environment: effectiveEnvironment, bootstrapSha256, exec, load, adapters,
        setPhase: name => { phase = 'prepare-' + name; }, observeFailure: value => { failureTarget = { ...value }; } });
    }
    const after = await collect('readback');
    phase = 'readback-checkout'; await checkout();
    phase = 'readback-consistency';
    need(JSON.stringify(first) === JSON.stringify(after.metadata.workers) && JSON.stringify(before) === JSON.stringify(after));
    if (preparation) {
      phase = 'staging-final-readback'; await preparation.recheck();
      await writeOnce(path.join(preparation.syncRoot, 'staging.private.json'), Buffer.from(JSON.stringify({ version: 1,
        kind: 'supabase-sidi-host-staging-receipt-v1', inspectionMetadataSha256: sha(JSON.stringify(before.metadata)), ...preparation })));
    }
    const raw = Buffer.from(JSON.stringify(preparation ? { ...before.metadata, preparation,
      archiveReceiptPrefix: preparation.archiveReceiptPrefix } : before.metadata)); need(raw.length <= 2 * 1024 ** 2);
    const packed = gzipSync(raw); need(packed.length <= 96 * 1024);
    phase = 'seal'; const { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
    const capsule = sealTransferSecrets(key, { version: 1, kind: 'supabase-host-inspection-capsule-v1',
      applicationCommit: expectedSha, metadataSha256: sha(raw), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
    return { status: preparation ? 'supabase-host-prepared' : 'supabase-host-inspected', operation, applicationCommit: expectedSha, metadataSha256: sha(raw),
      ...(preparation ? { releaseCommit: preparation.releaseSha, sourceManifestSha256: preparation.sourceManifestSha256,
        builderSha256: preparation.builderSha256, seedSelected: false } : {}),
      recipientSha256: sha(recipientPublicKey), capsule, readOnly: !preparation,
      ...(preparation ? { stagingOnly: true, databaseWrites: false } : {}), workersStarted: false, routingChanged: false };
  } catch (cause) {
    const failure = Object.assign(Error('Supabase handoff stopped at ' + phase), { phase });
    try {
      const receipt = await sealedPackageFailure({ target: failureTarget, phase, operation, expectedSha, recipientKey, exec, load })
        ?? await sealedPreparationFailure({ phase, operation, expectedSha, recipientKey, exec, load, error: cause,
          appRoot, releaseSha: (adapters.pins ?? preparationPins).release });
      if (receipt) Object.defineProperty(failure, 'supabaseHostStopped', { value: receipt });
    } catch { /* Preserve the original closed guard if private sealing fails. */ }
    throw failure;
  }
  finally {
    let failed = false;
    for (const lock of locks.reverse()) try { await lock.release(); } catch { failed = true; }
    if (originalUmask !== undefined) process.umask(originalUmask);
    if (failed) throw Object.assign(Error('Supabase handoff stopped at cleanup'), { phase: 'cleanup' });
  }
}
