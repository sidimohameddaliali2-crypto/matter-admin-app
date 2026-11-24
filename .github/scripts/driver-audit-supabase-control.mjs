import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const need = value => { if (!value) throw Error('Guard failed'); };
const relative = value => typeof value === 'string' && value.length <= 1024
  && value.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
const signature = value => [value.dev, value.ino, value.uid, value.gid, value.mode, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
const same = (left,right) => JSON.stringify(left) === JSON.stringify(right);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
const pins = Object.freeze({
  base:'701655794e1711b4d8c737e929360ecfe5d2f0ca', release:'4a00becfe4954b8139df6ac3c6058c2a592484d2',
  bootstrap:'05a9082f4c1e1e9485a60293b327690b17611fe859367cd5a6eda03f283b97f7', bootstrapBytes:634271,
  source:'8577fd973097dc543953b5af4ea9a3704b1d2c54bd016dd910a13e8560397fcc',sourceFiles:140,
  sourceEnvironment:'10292a368acfb14b6a356b3e39795659eb3679d1d0a58a0302deafc9fe1be762',sourceEnvironmentBytes:761,
  builder:'76790677571490ea75f63c8954ac0c798311b80458b45bf1ccbf54f00ae0701d',builderFiles:73,
  baseline:'16bee9ba4531ac532bdf90e0b2fdf6271c86ee4b15db91de12449258b902bbf3',
  candidate:'83580f6e97ec429e46fd668db533fae601a72ab357b1aaad48ce242f70303f19',
  fixture:'59a48e6a8474a4fcd952b3a0179be8327cba7a35fcc7687c319f070351a4bcc7',fixtureObjects:45,
  backupProof:'6a8391c5fd04b3d53c78e6be2fe9f1d5ff8c189c2e843c7c36c97e00472cd5f0',
  collector:{revision:5771,bodySha256:'836c9507dd7704b40c876bf050e55fe487cddfc124b6a38f4f4af87993f5ad62',
    sourceBasis:'24977fe9e0c60d569e3139ec385b8425bf8b8ab67e70d8142e05cb1f432d22c5'},
  current:{revision:5463,manifest:'3ac4484fe65910ce356eee487e8ebe4a50b0f52e64d81e892fb2c4b1ea8325c2',generation:'15d10c15a4e3ca405ba8a39b328f14023be977e91cc3ee003622d6c086da8709'},
  previous:{revision:4775,manifest:'c60efc0dee8b7bc53219097ba0a32c37cef08b616773159a39a4edf43b913afd',generation:'484f92f87280e6c07e5ee89c1210a335f03529d16e53e6a1082bac8b44cf8066'},
});
const codeFiles=['loadEnv.js','package.json','package-lock.json','scripts/driverAuditSync.js','scripts/driverAuditHttp.js',
  'scripts/driverAuditSourceDeploy.js','scripts/driverAuditSourceQualify.js','scripts/driverAuditQualificationChild.js',
  'services/driverAuditSource.js','services/driverAuditSupabaseSync.js','services/driverAuditSupabaseReplica.js',
  'services/driverAuditHttp.js','services/driverAuditSupabaseAppBackend.js','services/driverAuditReadCache.js',
  'services/driverAuditCollectorReadCache.js','services/driverAuditSupabaseTransfer.js','services/driverAuditTransferCodec.js',
  'services/driverAuditSpacesArchive.js','services/driverAuditSupabaseArchive.js','services/driverAuditPollProgress.js',
  'services/driverAuditFixedHostBudget.js','services/driverAuditHeavyWork.js','vendor/driver-audits/integration/hosted/worker-lock.mjs'];

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

async function fileHash(file, { maximum = 512 * 1024 ** 2, privateMode = true } = {}) {
  const before = await fs.lstat(file, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maximum)
    && (before.uid === BigInt(process.getuid()) || !privateMode && before.uid === 0n)
    && !(Number(before.mode) & (privateMode ? 0o077 : 0o022)) && await fs.realpath(file) === file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash('sha256');
  try {
    need(signature(await handle.stat({ bigint: true })) === signature(before));
    const chunk = Buffer.alloc(1024 * 1024); let offset = 0;
    while (offset < Number(before.size)) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, Number(before.size) - offset), offset);
      need(bytesRead > 0); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    need((await handle.read(chunk, 0, 1, offset)).bytesRead === 0
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
  return { root, files, declared, bytes: total, inventorySha256, manifestSha256: manifest?.sha256 ?? null,
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
        && exact(value, ['target', 'key', 'sha256', 'bytes', 'verified']) && value.target === receiptArchive.bucket
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

async function copiedArchiveReceiptPrefix(context, controls) {
  const proofFile = await read(path.join(context.syncRoot, 'retained/archive-verification-receipts.private.json'), { maximum: 32 * 1024 ** 2 });
  const proof = JSON.parse(proofFile.data), expectedKeys = ['version', 'kind', 'stagingReceiptSha256', 'source', 'destination', 'receipts',
    'retainedVerificationMetadataBytes', 'originalVerifiedObjectBytes', 'freshRemoteObjectBytesVerified', 'remoteAvailabilityAsserted', 'originalReceiptsChanged'];
  need(Buffer.from(JSON.stringify(proof)).equals(proofFile.data) && exact(proof, expectedKeys)
    && proof.version === 1 && proof.kind === 'retained-supabase-archive-receipts-v1'
    && proof.stagingReceiptSha256 === context.preparedReceiptSha256 && proof.originalReceiptsChanged === false
    && proof.freshRemoteObjectBytesVerified === false && proof.remoteAvailabilityAsserted === false);
  const source = proof.source, destination = proof.destination, oldServer = path.join(context.appRoot, 'server');
  need(source.applicationCommit === context.p.base && source.syncRoot === context.oldConfig.root
    && source.syncConfigSha256 === context.oldConfigFile.sha256 && source.dataStore === 'supabase'
    && destination.releaseSha === context.p.release && destination.root === path.join(context.syncRoot, 'archive-receipts'));
  const oldNamespace = await archiveReceiptNamespace(oldServer, controls.exec, context.appRoot, false, context.p.base);
  const newNamespace = await archiveReceiptNamespace(context.server, controls.exec, context.releaseRoot, true, context.p.release);
  need(source.archiveIdentitySha256 === oldNamespace.archiveIdentitySha256 && destination.archiveIdentitySha256 === newNamespace.archiveIdentitySha256
    && oldNamespace.archiveIdentitySha256 === newNamespace.archiveIdentitySha256
    && same(source.files, oldNamespace.files) && same(destination.files, newNamespace.files));
  const envFiles = await Promise.all(['.env', '.env.local'].map(name => read(path.join(oldServer, name),
    { maximum: 256 * 1024, privateMode: false, optional: true })));
  need(same(source.environmentPin, envFiles.map(file => file?.sha256 ?? null)));
  const observed = (await controls.rows()).filter(row => row.name === 'matter-driver-audit-sync'); need(observed.length <= 1);
  let original = observed[0];
  if (original?.pm2_env.pm_exec_path !== path.join(oldServer, 'scripts/driverAuditSync.js')) {
    const saved = await read(path.join(context.controlRoot, 'old-sync-registration.original.private.json'), { maximum: 4 * 1024 ** 2 });
    const plan = JSON.parse((await read(path.join(context.controlRoot, 'sync-retarget-plan.private.json'))).data);
    original = JSON.parse(saved.data);
    need(plan.version === 1 && plan.preparedReceiptSha256 === context.preparedReceiptSha256
      && plan.originalRegistrationSha256 === saved.sha256 && plan.oldRegistrationId === original.pm_id
      && plan.oldLaunchSha256 === sha(JSON.stringify(launch(original))));
  }
  const settings = original?.pm2_env;
  need(original?.name === 'matter-driver-audit-sync' && Number.isInteger(original.pm_id) && original.pid === 0
    && settings?.status === 'stopped' && settings.pm_cwd === oldServer
    && settings.pm_exec_path === path.join(oldServer, 'scripts/driverAuditSync.js')
    && settings.exec_interpreter === context.node.executable && same(settings.args, ['--config', context.oldConfigFile.path]));
  const inherited = {};
  for (const name of ['DRIVER_AUDIT_DATA_STORE', 'DRIVER_AUDIT_EXECUTION_HOST', 'DRIVER_AUDIT_SUPABASE_SECRET', 'MATTER_SUPABASE_SECRET', 'NODE_OPTIONS']) {
    const flat = settings[name], nested = settings.env?.[name];
    need(flat === undefined || typeof flat === 'string'); need(nested === undefined || typeof nested === 'string');
    need(flat === undefined || nested === undefined || flat === nested);
    if (flat !== undefined || nested !== undefined) inherited[name] = flat ?? nested;
  }
  const dotenv = await context.load('node_modules/dotenv/lib/main.js');
  const effective = { ...(envFiles[0] ? dotenv.parse(envFiles[0].data) : {}), ...inherited,
    ...(envFiles[1] ? dotenv.parse(envFiles[1].data) : {}) };
  const secret = effective.DRIVER_AUDIT_SUPABASE_SECRET || effective.MATTER_SUPABASE_SECRET;
  need((effective.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase'
    && [undefined, '', 'sidi'].includes(effective.DRIVER_AUDIT_EXECUTION_HOST)
    && typeof secret === 'string' && secret.length > 0 && secret.length <= 8192 && !/[\r\n]/.test(secret)
    && (effective.NODE_OPTIONS === undefined || /^--max-old-space-size=\d{3,5}$/.test(effective.NODE_OPTIONS))
    && (settings.node_args === undefined || same(settings.node_args, []))
    && source.runtimeSelectionSha256 === sha(JSON.stringify([original.pm_id, effective.DRIVER_AUDIT_DATA_STORE || 'supabase',
      effective.DRIVER_AUDIT_EXECUTION_HOST || null, effective.NODE_OPTIONS ?? null, sha(secret)])));
  const retained = await archiveReceiptInventory(path.join(context.oldConfig.root, 'archive-receipts'), context.oldConfig.root);
  const rows = retained.files.map(({ name, sha256, bytes, objectBytes }) => ({ name, sha256, bytes, objectBytes }));
  need(source.directoryPresent === retained.present && source.inventorySha256 === retained.inventorySha256
    && source.physicalInventorySha256 === retained.physicalInventorySha256 && same(proof.receipts, rows)
    && proof.retainedVerificationMetadataBytes === retained.bytes && proof.originalVerifiedObjectBytes === retained.objectBytes);
  const current = await archiveReceiptInventory(destination.root, context.syncRoot), byName = new Map(current.files.map(row => [row.name, row]));
  for (const row of rows) need(byName.get(row.name)?.sha256 === row.sha256 && byName.get(row.name)?.bytes === row.bytes);
  if (!context.archiveReceiptPrefix) context.fixedFiles.push(proofFile);
  else need(context.archiveReceiptPrefix.sha256 === proofFile.sha256);
  context.archiveReceiptPrefix = { path: proofFile.path, sha256: proofFile.sha256, bytes: proofFile.bytes,
    receipts: rows.length, originalVerifiedObjectBytes: retained.objectBytes,
    freshRemoteObjectBytesVerified: false, remoteAvailabilityAsserted: false };
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

function execute(file, args, options) {
  return new Promise((resolve, reject) => {
    let completed = false, closed = false, result, failure;
    const finish = () => { if (completed && closed) failure ? reject(failure) : resolve(result); };
    const child = execFile(file, args, { timeout: 30000, maxBuffer: 8 * 1024 ** 2, ...options }, (error, stdout) => {
      failure = error; result = { stdout }; completed = true; finish();
    });
    child.once('close', () => { closed = true; finish(); });
  });
}

const environment = source => Object.fromEntries(Object.entries(source).filter(([name]) =>
  ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG'].includes(name) || name.startsWith('LC_')));
const launch = row => ({ name: row.name, id: row.pm_id, script: row.pm2_env.pm_exec_path, cwd: row.pm2_env.pm_cwd,
  args: row.pm2_env.args ?? [], interpreter: row.pm2_env.exec_interpreter, nodeArgs: row.pm2_env.node_args ?? [],
  environment: row.pm2_env.env ?? null, nodeOptions: row.pm2_env.NODE_OPTIONS ?? row.pm2_env.env?.NODE_OPTIONS ?? null });
const processIdentity = row => ({ ...launch(row), pid: row.pid, status: row.pm2_env.status, startedAt: row.pm2_env.pm_uptime });

async function inspectWorkers(rows, context, { reportRequired = false, reportMayStop = false, allowMissingSync = false } = {}) {
  need(Array.isArray(rows) && rows.length <= 512);
  const one = name => { const matches = rows.filter(row => row.name === name); need(matches.length <= 1); return matches[0]; };
  const main = one('matter-delivery-api'), sync = one('matter-driver-audit-sync'), report = one('matter-driver-reports-api');
  need(main?.pm2_env?.status === 'online' && Number.isInteger(main.pm_id) && Number.isSafeInteger(main.pid) && main.pid > 0
    && main.pm2_env.pm_cwd === context.appRoot && ['/usr/bin/npm', context.npm.realpath].includes(main.pm2_env.pm_exec_path)
    && same(main.pm2_env.args, ['start', '--prefix', 'server']) && !one('matter-driver-audit-source'));
  if (!sync) { need(allowMissingSync); }
  else need(Number.isInteger(sync.pm_id) && sync.pid === 0 && sync.pm2_env.status === 'stopped');
  const old = sync?.pm2_env.pm_exec_path === path.join(context.appRoot, 'server/scripts/driverAuditSync.js');
  const server = old ? path.join(context.appRoot, 'server') : context.server;
  const configFile = sync?.pm2_env.args?.[1], root = typeof configFile === 'string' ? path.dirname(configFile) : '';
  if (sync) need(sync.pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js') && sync.pm2_env.pm_cwd === server
    && same(sync.pm2_env.args, ['--config', path.join(root, 'sync.json')])
    && path.dirname(root) === path.join(server, '.private/driver-audits') && digest(path.basename(root))
    && (old || configFile === context.receipt.syncConfig));
  if (reportRequired) need(report);
  if (report) {
    need(Number.isInteger(report.pm_id) && report.pm2_env.pm_exec_path === path.join(context.server, 'scripts/driverAuditHttp.js')
      && report.pm2_env.pm_cwd === context.server && same(report.pm2_env.args ?? [], [])
      && report.pm2_env.exec_interpreter === context.node.executable && same(report.pm2_env.node_args ?? [], [])
      && (report.pm2_env.status === 'online' && Number.isSafeInteger(report.pid) && report.pid > 0
        || reportMayStop && report.pm2_env.status === 'stopped' && report.pid === 0));
  }
  return { main, sync, report, oldSync: old };
}

async function checkedNode(adapters) {
  const node = adapters.node ?? { executable: await fs.realpath(process.execPath), version: process.version };
  need(node.executable === '/usr/bin/node' && node.version === 'v22.23.4');
  if (!adapters.node) {
    const saved = await fileHash(node.executable, { maximum: 256 * 1024 ** 2, privateMode: false });
    need(saved.stat.uid === 0n && !(Number(saved.stat.mode) & 0o022) && await fs.realpath('/proc/self/exe') === node.executable);
    node.sha256 = saved.sha256;
  }
  return node;
}

async function checkedNpm(adapters) {
  const npm = await (adapters.systemFile ?? systemFile)('/usr/bin/npm');
  need(npm.uid === 0 && !(npm.mode & 0o022) && npm.bytes > 0 && npm.bytes <= 64 * 1024 && digest(npm.sha256)
    && /^\/usr\/(?:share\/nodejs|(?:local\/)?lib\/node_modules)\/npm\/bin\/npm-cli\.js$/.test(npm.realpath));
  return { ...npm, identitySha256: sha(JSON.stringify([npm.realpath, npm.sha256])) };
}

async function preservedBaseEvent(root) {
  const name = 'server/routes/Event.js', file = path.join(root, name), parents = [];
  need(path.isAbsolute(root) && path.normalize(root) === root);
  try {
    for (const folder of [root, path.join(root, 'server'), path.join(root, 'server/routes')]) {
      const before = await fs.lstat(folder, { bigint: true });
      need(before.isDirectory() && before.uid === BigInt(process.getuid()) && !(Number(before.mode) & 0o002)
        && await fs.realpath(folder) === folder);
      const handle = await fs.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      parents.push({ folder, before, handle });
      need(directoryIdentity(await handle.stat({ bigint: true })) === directoryIdentity(before));
    }
    const checkParents = async () => {
      for (const item of parents) need(directoryIdentity(await item.handle.stat({ bigint: true })) === directoryIdentity(item.before)
        && directoryIdentity(await fs.lstat(item.folder, { bigint: true })) === directoryIdentity(item.before)
        && await fs.realpath(item.folder) === item.folder);
    };
    await checkParents();
    const before = await fs.lstat(file, { bigint: true });
    need(before.isFile() && before.uid === BigInt(process.getuid()) && before.nlink === 1n
      && [0o600, 0o644, 0o664].includes(Number(before.mode) & 0o7777) && before.size <= 512n * 1024n
      && await fs.realpath(file) === file);
    const openedPath = process.platform === 'linux' ? '/proc/self/fd/' + parents.at(-1).handle.fd + '/Event.js' : file;
    const handle = await fs.open(openedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const check = async () => {
        for (const info of [await handle.stat({ bigint: true }), await fs.lstat(file, { bigint: true })])
          need(signature(info) === signature(before) && info.nlink === 1n);
        need(await fs.realpath(file) === file); await checkParents();
      };
      await check(); const bytes = Buffer.alloc(Number(before.size));
      for (let offset = 0; offset < bytes.length;) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        need(result.bytesRead > 0); offset += result.bytesRead;
      }
      need((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0); await check();
      return { path: name, sha256: sha(bytes), bytes: bytes.length,
        signature: [signature(before), ...parents.map(item => directoryIdentity(item.before))].join('|'), nlink: '1' };
    } finally { await handle.close(); }
  } finally { for (const item of parents.reverse()) await item.handle.close(); }
}

async function checkout(root, expected, exec, files, { preserveBaseEvent = false, preservedBaseFiles } = {}) {
  need((await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim() === expected
    && (await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'])).stdout.trim() === root);
  await exec('git', ['-C', root, 'ls-files', '--error-unmatch', ...files.map(name => 'server/' + name)]);
  const status = (await exec('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all', '--', 'server'])).stdout;
  need(status === '' || preserveBaseEvent && status === '?? server/routes/Event.js\n');
  const preserved = status ? [await preservedBaseEvent(root)] : [];
  if (preserved.length) need((await exec('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all', '--', 'server'])).stdout === status);
  if (preservedBaseFiles !== undefined) need(same(preserved, preservedBaseFiles));
  return preserved;
}

async function verifiedTree(root, files, manifestName) {
  need(files && typeof files === 'object' && !Array.isArray(files) && Object.keys(files).length <= 4096);
  let count = 0, bytes = 0;
  for (const [name, expected] of Object.entries(files)) {
    need(relative(name) && digest(expected)); const value = await read(path.join(root, name), { maximum: 16 * 1024 ** 2 });
    need(value.sha256 === expected && (bytes += value.bytes) <= 16 * 1024 ** 2);
  }
  async function visit(folder, prefix = '') {
    await directory(folder); const names = await fs.readdir(folder, { withFileTypes: true }); need(names.length <= 4096);
    for (const item of names) {
      const name = prefix ? prefix + '/' + item.name : item.name;
      if (item.isDirectory()) await visit(path.join(folder, item.name), name);
      else { need(item.isFile() && (Object.hasOwn(files, name) || name === manifestName)); count++; }
    }
  }
  await visit(root); need(count === Object.keys(files).length + 1);
}

async function admittedContext(args, adapters, exec, setPhase) {
  const p = adapters.pins ?? pins, { appRoot, expectedSha, preparedReceiptSha256 } = args;
  need(expectedSha === p.base && path.isAbsolute(appRoot) && await fs.realpath(appRoot) === appRoot);
  const releaseRoot = path.join(appRoot, 'server/.private/driver-report-app-releases', p.release), server = path.join(releaseRoot, 'server');
  const rootId = sha(JSON.stringify(['driver-reports-supabase-sync-v1', p.release, p.source, p.builder, p.baseline, p.candidate]));
  const syncRoot = path.join(server, '.private/driver-audits', rootId), sourceRoot = path.join(server, '.private/driver-audit-source');
  const receiptFile = path.join(syncRoot, 'staging.private.json'), saved = await read(receiptFile);
  need(saved.sha256 === preparedReceiptSha256); const receipt = JSON.parse(saved.data);
  need(receipt.version === 1 && receipt.kind === 'supabase-sidi-host-staging-receipt-v1'
    && receipt.releaseSha === p.release && receipt.releaseRoot === releaseRoot && receipt.syncRoot === syncRoot && receipt.rootId === rootId
    && receipt.syncConfig === path.join(syncRoot, 'sync.json') && receipt.sourceConfig === path.join(sourceRoot, p.source, 'source.json')
    && receipt.sourceManifestSha256 === p.source && receipt.builderSha256 === p.builder && receipt.bootstrapSha256 === p.bootstrap
    && receipt.sourceEnvironmentSha256 === p.sourceEnvironment && digest(receipt.appEnvironmentSha256)
    && receipt.seedSelected === false && receipt.registrationsChanged === false && receipt.workersStarted === false && receipt.routingChanged === false);
  setPhase('checkout');
  const preservedBaseFiles = await checkout(appRoot, expectedSha, exec, ['loadEnv.js', 'package.json', 'package-lock.json', 'services/driverAuditTransferCodec.js',
    'vendor/driver-audits/integration/hosted/worker-lock.mjs'], { preserveBaseEvent: true });
  await checkout(releaseRoot, p.release, exec, codeFiles);
  need(!await read(path.join(releaseRoot, '.git/objects/info/alternates'), { optional: true, privateMode: false }));
  setPhase('node'); const node = await checkedNode(adapters), npm = await checkedNpm(adapters);
  need(receipt.nodeExecutable === node.executable && receipt.nodeVersion === node.version);
  const load = name => adapters.load ? adapters.load(name, releaseRoot) : import(pathToFileURL(path.join(server, name)).href);
  const dotenv = await load('node_modules/dotenv/lib/main.js');
  const envFile = path.join(server, '.env.local'), envBytes = await read(envFile, { maximum: 256 * 1024 });
  const env = dotenv.parse(envBytes.data);
  need(env.DRIVER_AUDIT_EXECUTION_HOST === 'sidi' && env.DRIVER_AUDIT_DATA_STORE === 'supabase'
    && ['0', '1'].includes(env.DRIVER_AUDIT_ENABLED) && env.DRIVER_AUDIT_IMPORT_ENABLED === '0'
    && env.DRIVER_AUDIT_REPLICA_GC_ENABLED === '0' && env.DRIVER_AUDIT_RELEASE_SHA === p.release
    && env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY === path.join(syncRoot, 'work/archive-cache')
    && !Object.keys(env).some(name => /MONGO|NATIVE_CAPACITY|OIDC|NODE_OPTIONS|NODE_PATH|LD_PRELOAD/.test(name)));
  const configFile = await read(receipt.sourceConfig), config = JSON.parse(configFile.data);
  const sourceEnvironment = await read(path.join(sourceRoot, p.source, 'environment.private.json'), { maximum: 64 * 1024 });
  need(sourceEnvironment.sha256 === p.sourceEnvironment && sourceEnvironment.bytes === p.sourceEnvironmentBytes);
  const original = JSON.parse(sourceEnvironment.data), expectedConfig = { version: 1, root: path.join(sourceRoot, p.source),
    runtimeRoot: path.join(sourceRoot, p.source, 'runtime'), manifestSha256: p.source,
    nodeExecutable: node.executable, nodeVersion: node.version,
    environment: { path: sourceEnvironment.path, sha256: sourceEnvironment.sha256 },
    gatewayCredential: original.AI_GATEWAY_API_KEY ? { environmentKey: 'AI_GATEWAY_API_KEY' } : null };
  need(same(config, expectedConfig) && original.DRIVER_AUDIT_EXECUTION_HOST === 'sidi'
    && original.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY === env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY
    && original.MATTER_SUPABASE_SECRET === env.MATTER_SUPABASE_SECRET && original.MATTER_SUPABASE_SECRET === env.DRIVER_AUDIT_SUPABASE_SECRET);
  setPhase('source-tree');
  const sourceManifest = await read(path.join(config.runtimeRoot, 'manifest.private.json')); need(sourceManifest.sha256 === p.source);
  const source = JSON.parse(sourceManifest.data); need(source.schemaVersion === 1 && source.files.length === p.sourceFiles);
  await verifiedTree(config.runtimeRoot, Object.fromEntries(source.files.map(row => [row.path, row.sha256])), 'manifest.private.json');
  setPhase('builder-tree');
  const syncFile = await read(receipt.syncConfig), sync = JSON.parse(syncFile.data);
  need(sync.version === 1 && sync.root === syncRoot && sync.codeRoot === path.join(syncRoot, 'builder')
    && sync.baselineRoot === path.join(syncRoot, 'baseline') && sync.builderSha256 === p.builder);
  const builderFile = await read(path.join(sync.codeRoot, 'runtime-manifest.json')); need(builderFile.sha256 === p.builder);
  const builder = JSON.parse(builderFile.data); need(builder.version === 1 && Object.keys(builder.files).length === p.builderFiles);
  await verifiedTree(sync.codeRoot, builder.files, 'runtime-manifest.json');
  for (const [ref, file] of [[sync.rendererBuild, path.join(syncRoot, 'baseline/build.private.json')],
    [sync.journals, path.join(syncRoot, 'validation-journals.private.json')]]) need(ref.path === file && (await read(file)).sha256 === ref.sha256);
  setPhase('dependencies');
  const dependencyReceipt = receipt.dependencies;
  need(dependencyReceipt?.mode === 'isolated-npm-ci-v1' && dependencyReceipt.path === path.join(server, 'node_modules')
    && dependencyReceipt.receiptPath === path.join(server, '.private/dependencies/receipt.private.json'));
  const dependencyBytes = await read(dependencyReceipt.receiptPath);
  const dependencies = JSON.parse(dependencyBytes.data), lock = await read(path.join(server, 'package-lock.json'), { privateMode: false });
  need(dependencyBytes.sha256 === dependencyReceipt.receiptSha256 && dependencies.packageLockSha256 === lock.sha256
    && dependencyReceipt.packageLockSha256 === lock.sha256 && dependencies.npmIdentitySha256 === npm.identitySha256
    && dependencies.nodeExecutable === node.executable && dependencies.nodeVersion === node.version
    && same(await dependencyInventory(dependencyReceipt.path), dependencies.inventory)
    && same(dependencyReceipt.inventory, dependencies.inventory));
  setPhase('retained-packages');
  need(Array.isArray(receipt.packages) && receipt.packages.length === 4);
  const presenceFiles = [], retainedPackages = new Map();
  for (const [role, expectedRoot, manifest] of [
    ['baseline-builder-input', path.join(syncRoot, 'baseline'), p.baseline],
    ['candidate', path.join(syncRoot, 'retained/candidate/server-data'), p.candidate],
    ['serving-current', path.join(syncRoot, 'retained/serving-current/server-data'), p.current.manifest],
    ['serving-previous', path.join(syncRoot, 'retained/serving-previous/server-data'), p.previous.manifest],
  ]) {
    const entries = receipt.packages.filter(row => row.role === role); need(entries.length === 1);
    const row = entries[0]; need(row.root === expectedRoot && row.manifestSha256 === manifest);
    need(row.archiveBackedManifest === true && row.privateDirectoryBoundary === syncRoot
      && row.archiveReferences?.path === path.join(syncRoot, 'retained/package-presence', role + '.private.json'));
    const actual = await packageFiles(row.root, manifest, { archiveBackedManifest: true, privateDirectoryBoundary: syncRoot });
    const mask = await read(row.archiveReferences.path, { maximum: 8 * 1024 ** 2 }); presenceFiles.push(mask);
    need(actual.inventorySha256 === row.inventorySha256 && actual.bytes === row.bytes && actual.files.length === row.files
      && actual.missingArchiveReferencesSha256 === row.missingArchiveReferencesSha256
      && actual.declaredFiles === row.declaredFiles && actual.missingArchiveReferences.length === row.archiveReferences.locallyMissing
      && mask.sha256 === row.archiveReferences.sha256 && mask.bytes === row.archiveReferences.bytes
      && sameArchiveMask(JSON.parse(mask.data), actual));
    if (role.startsWith('serving-')) retainedPackages.set(role, actual);
  }
  const bootstrapFile = await read(path.join(syncRoot, 'retained/bootstrap.private.json.gz'));
  need(bootstrapFile.sha256 === p.bootstrap && bootstrapFile.bytes === p.bootstrapBytes);
  const bootstrap = JSON.parse(gunzipSync(bootstrapFile.data, { maxOutputLength: 16 * 1024 ** 2 }));
  need(bootstrap.version === 1 && bootstrap.releaseSha === p.release && bootstrap.packageLockSha256 === lock.sha256);
  const controlRoot = path.join(syncRoot, 'controls');
  return { p, appRoot, releaseRoot, server, syncRoot, sourceRoot, controlRoot, receipt, receiptFile, preparedReceiptSha256,
    node, npm, load, env, envFile, envBytes, sourceEnvironment, config, source, sync, syncFile, bootstrap, retainedPackages, preservedBaseFiles,
    fixedFiles: [saved, configFile, sourceEnvironment, syncFile, builderFile, sourceManifest, bootstrapFile, dependencyBytes, lock, ...presenceFiles] };
}

function selectedPaths(context) {
  const hash = sha(JSON.stringify(['driver-reports-supabase-selected-v1', context.receipt.rootId, context.p.current.manifest]));
  const id = hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-4' + hash.slice(13, 16) + '-a' + hash.slice(17, 20) + '-' + hash.slice(20, 32);
  return { privateRoot: path.join(context.syncRoot, 'work/attempts', id, 'server-data'),
    bundleRoot: path.join(context.syncRoot, 'selected/audit-objects') };
}

function headFromSeed(seed) {
  return { version: 1, generation: seed.pointer.generation, reportHash: seed.pointer.reportHash, descriptor: seed.pointer.descriptor,
    servingPackage: { version: 1, dataStore: 'supabase', collectorRevision: seed.collectorRevision,
      sourceBasis: seed.sourceBasis, manifestSha256: seed.manifestSha256 }, visibleCutoffAt: seed.visibleCutoffAt,
    closureReceipt: seed.closureReceipt, restore: seed.restore };
}

function comparableHead(head) {
  if (!head) return null;
  const { sourceRevision, sourceBodySha256, publishedAt, previous, ...value } = head;
  return { ...value, ...(previous ? { previous: comparableHead(previous) } : {}) };
}

async function readRuntimeExtent(extent, boundary) {
  return withPrivatePackageDirectory(path.dirname(extent.path), boundary, async () => {
    const before = await fs.lstat(extent.path, { bigint: true }), original = extent.saved.stat;
    need(before.isFile() && before.uid === BigInt(process.getuid()) && !(Number(before.mode) & 0o077)
      && await fs.realpath(extent.path) === extent.path && before.dev === original.dev && before.ino === original.ino
      && before.size === BigInt(extent.saved.bytes) && before.mtimeNs === original.mtimeNs);
    const fd = await fs.open(extent.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      need(signature(await fd.stat({ bigint: true })) === signature(before));
      const bytes = Buffer.alloc(extent.size);
      for (let offset = 0; offset < bytes.length;) {
        const result = await fd.read(bytes, offset, bytes.length - offset, extent.offset + offset);
        need(result.bytesRead > 0); offset += result.bytesRead;
      }
      need(sha(bytes) === extent.sha256 && signature(await fd.stat({ bigint: true })) === signature(before)
        && signature(await fs.lstat(extent.path, { bigint: true })) === signature(before) && await fs.realpath(extent.path) === extent.path);
      return bytes;
    } finally { await fd.close(); }
  });
}

function localServingArchive({ head, folder, sourcePackage, boundary }) {
  need(sourcePackage?.declared && Array.isArray(sourcePackage.files));
  let descriptor, extents;
  const runtime = new Map(sourcePackage.files.map(row => [row.name, row]));
  const runtimeExtent = (key, size) => {
    if (!extents) {
      need(descriptor && typeof descriptor.files === 'object' && !Array.isArray(descriptor.files)); extents = new Map();
      for (const [name, ref] of Object.entries(descriptor.files)) {
        const saved = runtime.get(name);
        if (!saved || sourcePackage.declared[name] !== ref.sha256 || saved.sha256 !== ref.sha256 || saved.bytes !== ref.size) continue;
        need(Array.isArray(ref.chunks));
        for (const chunk of ref.chunks) {
          need(digest(chunk.sha256) && Number.isSafeInteger(chunk.offset) && chunk.offset >= 0
            && Number.isSafeInteger(chunk.size) && chunk.size > 0 && chunk.size <= 8 * 1024 ** 2
            && chunk.offset + chunk.size <= saved.bytes);
          const chunkKey = chunk.sha256 + '.gz', prior = extents.get(chunkKey); need(!prior || prior.size === chunk.size);
          const whole = chunk.offset === 0 && chunk.size === saved.bytes && chunk.sha256 === saved.sha256;
          if (!prior || whole && prior.kind !== 'whole-runtime') extents.set(chunkKey,
            { kind: whole ? 'whole-runtime' : 'partial-runtime', path: path.join(sourcePackage.root, name),
              saved, offset: chunk.offset, size: chunk.size, sha256: chunk.sha256 });
        }
      }
    }
    const found = extents.get(key); need(found && found.size === size); return found;
  };
  const locate = async (key, maxBytes) => {
    need(/^[a-f0-9]{64}\.gz$/.test(key) && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 8 * 1024 ** 2);
    try {
      const file = await read(path.join(folder, 'audit-objects', key), { maximum: maxBytes });
      need(file.bytes === maxBytes && file.sha256 === key.slice(0, 64));
      return { kind: 'bundle', path: file.path, size: file.bytes, sha256: file.sha256, data: file.data };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const extent = runtimeExtent(key, maxBytes); return { ...extent, data: await readRuntimeExtent(extent, boundary) };
  };
  return {
    async readObject(key, { maxBytes }) {
      const value = await locate(key, maxBytes);
      if (key === head.descriptor.sha256 + '.gz') descriptor = JSON.parse(value.data);
      return [value.data];
    },
    async source(key, size) {
      const { data, ...record } = await locate(key, size); return record;
    },
  };
}

async function seedInputs(context) {
  const { p, syncRoot, load, receipt } = context, seeds = [], proofs = [];
  const verify = (await load('services/driverAuditSupabaseReplica.js')).verifyDriverAuditSupabaseServingPackage;
  for (const [role, pin] of [['serving-current', p.current], ['serving-previous', p.previous]]) {
    const folder = path.join(syncRoot, 'retained', role), row = receipt.packages.find(item => item.role === role);
    const original = await read(path.join(folder, 'direct-seed.original.private.json'), { maximum: 1024 * 1024 });
    need(original.sha256 === row.originalDirectSeedSha256 && row.descriptorVerified === true);
    const seed = JSON.parse(original.data);
    need(seed.version === 1 && ['bootstrap', 'sync'].includes(seed.mode) && seed.collectorRevision === pin.revision
      && seed.manifestSha256 === pin.manifest && seed.pointer.generation === pin.generation && seed.sourceBasis === row.sourceBasis);
    const head = headFromSeed(seed), archive = localServingArchive({ head, folder,
      sourcePackage: context.retainedPackages.get(role), boundary: syncRoot });
    proofs.push({ role, folder, original, archive, proof: await verify({ head, archive }) }); seeds.push(seed);
  }
  const paths = selectedPaths(context), previous = headFromSeed(seeds[1]), current = headFromSeed(seeds[0]);
  current.previous = previous;
  const seed = { version: 1, mode: 'bootstrap', bundleRoot: paths.bundleRoot, collectorRevision: seeds[0].collectorRevision,
    sourceBasis: seeds[0].sourceBasis, manifestSha256: seeds[0].manifestSha256,
    pointer: { version: 1, generation: current.generation, reportHash: current.reportHash,
      descriptor: current.descriptor, previous }, visibleCutoffAt: current.visibleCutoffAt,
    closureReceipt: current.closureReceipt, restore: current.restore };
  const pointer = { version: 1, privateRoot: paths.privateRoot, collectorRevision: seed.collectorRevision,
    sourceBasis: seed.sourceBasis, manifestSha256: seed.manifestSha256, generation: current.generation, reportHash: current.reportHash };
  return { paths, proofs, seed, head: current, pointer };
}

async function linkImmutable(source, target, expectedHash, expectedBytes, expectedStat) {
  const before = await fileHash(source); need(before.sha256 === expectedHash && (expectedBytes === undefined || before.bytes === expectedBytes));
  if (expectedStat) need(before.stat.dev === expectedStat.dev && before.stat.ino === expectedStat.ino && before.stat.mtimeNs === expectedStat.mtimeNs);
  await mkdirPrivate(path.dirname(target));
  await inDirectory(path.dirname(target), async anchor => {
    try { await fs.link(source, path.join(anchor, path.basename(target))); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  });
  const after = await fileHash(target);
  need(after.sha256 === before.sha256 && after.bytes === before.bytes && after.stat.ino === before.stat.ino
    && after.stat.dev === before.stat.dev && after.stat.mtimeNs === before.stat.mtimeNs);
}

async function derivedServingChunk(file, bytes) {
  need(bytes.length > 0 && bytes.length <= 8 * 1024 ** 2 && path.basename(file) === sha(bytes) + '.gz');
  try { const present = await read(file, { maximum: bytes.length }); need(present.data.equals(bytes)); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await inDirectory(path.dirname(file), async anchored => {
    const entries = await fs.readdir(anchored);
    need(entries.length <= 8200 && entries.filter(name => /^\.runtime-derived-[a-f0-9]{32}\.tmp$/.test(name)).length < 8);
    const temporary = '.runtime-derived-' + randomBytes(16).toString('hex') + '.tmp', temp = path.join(anchored, temporary);
    let fd, created = false;
    try {
      fd = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true; await fd.writeFile(bytes); await fd.sync(); await fd.close(); fd = null;
      const checked = await read(path.join(path.dirname(file), temporary), { maximum: bytes.length }); need(checked.data.equals(bytes));
      try { await fs.link(temp, path.join(anchored, path.basename(file))); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      need((await read(file, { maximum: bytes.length })).data.equals(bytes));
    } finally { await fd?.close(); if (created) await fs.unlink(temp); }
  });
}

async function openHead(context) {
  const backend = await (await context.load('services/driverAuditSupabaseAppBackend.js')).createDriverAuditSupabaseAppBackend({ env: context.env });
  need(backend.kind === 'supabase' && backend.executionHost === 'sidi' && backend.transferAccounting === 'supabase-http-bytes-v1');
  const { createCloudState } = await context.load('vendor/driver-audits/integration/cloud/cloud-state.mjs');
  const { createDriverAuditSupabaseReplica } = await context.load('services/driverAuditSupabaseReplica.js');
  return { backend, replica: createDriverAuditSupabaseReplica({ state: createCloudState({ rpc: backend.rpc }), archive: backend.archive }) };
}

async function prepareServing(context, controls) {
  controls.phase('seed-inputs'); const inputs = await seedInputs(context);
  const client = await openHead(context);
  try {
    const before = await client.replica.head(); need(!before || same(comparableHead(before), comparableHead(inputs.head)));
    controls.phase('select-local-seed');
    const row = context.receipt.packages.find(item => item.role === 'serving-current');
    const data = await packageFiles(row.root, row.manifestSha256,
      { archiveBackedManifest: true, privateDirectoryBoundary: context.syncRoot }); await mkdirPrivate(inputs.paths.privateRoot);
    for (const file of data.files) {
      const target = path.join(inputs.paths.privateRoot, file.name); await mkdirPrivate(path.dirname(target));
      await withPrivatePackageDirectory(path.dirname(file.path), context.syncRoot, async () => {
        if (file.name === 'files.private.json') {
          need(file.bytes > 0 && file.bytes <= 8 * 1024 ** 2 && file.sha256 === row.manifestSha256);
          const manifest = await read(file.path, { maximum: file.bytes });
          need(manifest.bytes === file.bytes && manifest.sha256 === file.sha256); await writeOnce(target, manifest.data);
        }
        else await linkImmutable(file.path, target, file.sha256, file.bytes);
      });
    }
    await mkdirPrivate(inputs.paths.bundleRoot); const objects = new Map();
    for (const item of inputs.proofs) {
      const head = item.role === 'serving-current' ? inputs.head : inputs.head.previous;
      for (const ref of [head.descriptor, ...Object.values(item.proof.descriptor.files)]) for (const chunk of ref.chunks) {
        const key = chunk.sha256 + '.gz', old = objects.get(key), source = await item.archive.source(key, chunk.size);
        need(!old || old.size === chunk.size);
        const priority = value => ['bundle', 'whole-runtime', 'partial-runtime'].indexOf(value.kind);
        if (!old || priority(source) < priority(old)) objects.set(key, source);
      }
    }
    need(objects.size <= 8192 && [...objects.values()].reduce((sum, item) => sum + item.size, 0) <= 2 * 1024 ** 3);
    const derivedBytes = [...objects.values()].filter(item => item.kind === 'partial-runtime').reduce((sum, item) => sum + item.size, 0);
    need(derivedBytes <= 256 * 1024 ** 2);
    let additionalBytes = 0;
    for (const [key, item] of objects) if (item.kind === 'partial-runtime') {
      const existing = await read(path.join(inputs.paths.bundleRoot, key), { maximum: item.size, optional: true });
      if (existing) need(existing.bytes === item.size && existing.sha256 === key.slice(0, 64));
      else additionalBytes += item.size;
    }
    if (additionalBytes) {
      const disk = await fs.statfs(inputs.paths.bundleRoot, { bigint: true });
      need(disk.bavail >= 0n && disk.bsize > 0n && disk.bavail * disk.bsize >= BigInt(1024 ** 3 + additionalBytes));
    }
    for (const [key, item] of objects) {
      const target = path.join(inputs.paths.bundleRoot, key);
      if (item.kind === 'partial-runtime') await derivedServingChunk(target, await readRuntimeExtent(item, context.syncRoot));
      else await withPrivatePackageDirectory(path.dirname(item.path), context.syncRoot,
        () => linkImmutable(item.path, target, key.slice(0, 64), item.size, item.saved?.stat));
    }
    await writeOnce(path.join(context.syncRoot, 'seed.json'), Buffer.from(JSON.stringify(inputs.seed)));
    await writeOnce(path.join(context.syncRoot, 'work/current.private.json'), Buffer.from(JSON.stringify(inputs.pointer)));
    const selected = { version: 1, kind: 'supabase-serving-selection-v1', preparedReceiptSha256: context.preparedReceiptSha256,
      seedSha256: sha(JSON.stringify(inputs.seed)), pointerSha256: sha(JSON.stringify(inputs.pointer)),
      currentManifestSha256: context.p.current.manifest, previousManifestSha256: context.p.previous.manifest,
      currentOriginalSeedSha256: inputs.proofs[0].original.sha256, previousOriginalSeedSha256: inputs.proofs[1].original.sha256 };
    await writeOnce(path.join(context.controlRoot, 'serving-selection.private.json'), Buffer.from(JSON.stringify(selected)));
    await controls.recheck();
    controls.phase('seed-cli');
    const result = await controls.exec(context.node.executable,
      [path.join(context.server, 'scripts/driverAuditSync.js'), '--config', context.receipt.syncConfig, '--seed-only'],
      { cwd: context.releaseRoot, env: { ...controls.shell, ...context.env }, timeout: 54 * 60_000, signal: controls.signal });
    const output = JSON.parse(result.stdout.trim());
    need(['published', 'unchanged'].includes(output.status) && output.dataStore === 'supabase' && output.executionHost === 'sidi'
      && output.activeGeneration === context.p.current.generation);
    controls.phase('seed-readback');
    const after = await client.replica.head(); need(after && same(comparableHead(after), comparableHead(inputs.head)));
    return { status: 'serving-prepared', generation: after.generation, collectorRevision: after.servingPackage.collectorRevision,
      previousGeneration: after.previous.generation, seedSha256: selected.seedSha256,
      servingHeadRevision: after.sourceRevision, servingHeadBodySha256: after.sourceBodySha256, candidateSelected: false };
  } finally { await client.backend.close?.(); }
}

async function selectedServing(context, { allowBuiltCandidate = false } = {}) {
  const inputs = await seedInputs(context);
  const seed = await read(path.join(context.syncRoot, 'seed.json')), pointer = await read(path.join(context.syncRoot, 'work/current.private.json'));
  need(seed.data.equals(Buffer.from(JSON.stringify(inputs.seed))));
  if (!pointer.data.equals(Buffer.from(JSON.stringify(inputs.pointer)))) {
    need(allowBuiltCandidate); await candidatePackage(context);
  }
  const receipt = JSON.parse((await read(path.join(context.controlRoot, 'serving-selection.private.json'))).data);
  need(receipt.version === 1 && receipt.preparedReceiptSha256 === context.preparedReceiptSha256
    && receipt.seedSha256 === seed.sha256 && receipt.pointerSha256 === sha(JSON.stringify(inputs.pointer)));
  const copy = await packageFiles(inputs.paths.privateRoot, context.p.current.manifest,
    { archiveBackedManifest: true, privateDirectoryBoundary: context.syncRoot });
  const original = context.receipt.packages.find(row => row.role === 'serving-current');
  need(copy.inventorySha256 === original.inventorySha256 && copy.missingArchiveReferencesSha256 === original.missingArchiveReferencesSha256);
  return inputs;
}

async function enabledEnvironment(context, commitChange = false) {
  const beforeFile = path.join(context.controlRoot, 'app-environment.before.private.env');
  const afterFile = path.join(context.controlRoot, 'app-environment.after.private.env');
  const planFile = path.join(context.controlRoot, 'app-environment-plan.private.json');
  let before = await read(beforeFile, { maximum: 256 * 1024, optional: true });
  const actual = await read(context.envFile, { maximum: 256 * 1024 });
  if (!before) {
    need(actual.sha256 === context.receipt.appEnvironmentSha256);
    before = actual;
  }
  need(before.sha256 === context.receipt.appEnvironmentSha256);
  const text = before.data.toString('utf8'); need(Buffer.from(text).equals(before.data)
    && (text.match(/^DRIVER_AUDIT_ENABLED="0"$/gm) || []).length === 1);
  const afterBytes = Buffer.from(text.replace(/^DRIVER_AUDIT_ENABLED="0"$/m, 'DRIVER_AUDIT_ENABLED="1"'));
  const plan = { version: 1, kind: 'supabase-report-enable-plan-v1', preparedReceiptSha256: context.preparedReceiptSha256,
    beforeSha256: before.sha256, afterSha256: sha(afterBytes), changedKey: 'DRIVER_AUDIT_ENABLED' };
  if (!commitChange) {
    if (actual.sha256 === before.sha256) return { enabled: false, bytes: actual };
    need(actual.data.equals(afterBytes) && (await read(planFile)).data.equals(Buffer.from(JSON.stringify(plan)))
      && (await read(afterFile, { maximum: 256 * 1024 })).data.equals(afterBytes));
    return { enabled: true, bytes: actual };
  }
  await writeOnce(beforeFile, before.data); await writeOnce(afterFile, afterBytes);
  await writeOnce(planFile, Buffer.from(JSON.stringify(plan)));
  if (actual.data.equals(afterBytes)) return { enabled: true, bytes: actual };
  need(actual.sha256 === before.sha256);
  const pending = path.join(context.controlRoot, 'app-environment.pending.private.env'); await writeOnce(pending, afterBytes);
  await inDirectory(path.dirname(context.envFile), async target => {
    await inDirectory(context.controlRoot, async source => {
      need((await read(context.envFile, { maximum: 256 * 1024 })).data.equals(before.data)
        && (await read(pending, { maximum: 256 * 1024 })).data.equals(afterBytes));
      // Preserve an independent setting edit rather than restoring old bytes.
      need((await read(context.envFile, { maximum: 256 * 1024 })).data.equals(before.data));
      await fs.rename(path.join(source, path.basename(pending)), path.join(target, '.env.local'));
    });
  }, false);
  const saved = await read(context.envFile, { maximum: 256 * 1024 }); need(saved.data.equals(afterBytes));
  return { enabled: true, bytes: saved };
}

async function listenerFor(pid) {
  const listeners = [];
  for (const name of ['tcp', 'tcp6']) {
    const bytes = await fs.readFile('/proc/net/' + name); need(bytes.length <= 1024 * 1024);
    for (const line of bytes.toString('utf8').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && fields[1]?.endsWith(':138A')) listeners.push({ address: fields[1], inode: fields[9], uid: Number(fields[7]), family: name });
    }
  }
  if (!pid) return listeners.length === 0;
  if (listeners.length !== 1 || listeners[0].address !== '0100007F:138A' || listeners[0].uid !== process.getuid()) return false;
  const descriptors = await fs.readdir('/proc/' + pid + '/fd'); need(descriptors.length <= 4096);
  for (const name of descriptors) if (await fs.readlink('/proc/' + pid + '/fd/' + name).catch(() => null) === 'socket:[' + listeners[0].inode + ']') return true;
  return false;
}

async function realProcess(row, context, adapters) {
  if (adapters.inspectProcess) return adapters.inspectProcess(row, context);
  need(await fs.realpath('/proc/' + row.pid + '/exe') === context.node.executable
    && await fs.realpath('/proc/' + row.pid + '/cwd') === context.server);
}

async function health(context, controls, row, reportHash, expected = context.p.current) {
  await realProcess(row, context, controls.adapters);
  need(await (controls.adapters.listenerFor ?? listenerFor)(row.pid));
  const response = await (controls.adapters.fetch ?? fetch)('http://127.0.0.1:5002/health', {
    method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([controls.signal, AbortSignal.timeout(5000)]) });
  need(response.status === 200 && !response.redirected);
  const pieces = []; let size = 0;
  try { for await (const piece of response.body) { need((size += piece.length) <= 16 * 1024); pieces.push(Buffer.from(piece)); } }
  finally { Promise.resolve(response.body?.cancel?.()).catch(() => {}); }
  const value = JSON.parse(Buffer.concat(pieces, size));
  need(exact(value, ['service', 'dataStore', 'executionHost', 'ready', 'generation', 'reportHash', 'collectorRevision', 'release'])
    && value.service === 'driver-reports' && value.dataStore === 'supabase' && value.executionHost === 'sidi' && value.ready === true
    && value.generation === expected.generation && value.reportHash === reportHash
    && value.collectorRevision === expected.revision && value.release === context.p.release);
  return value;
}

async function savedBoot(context, controls, prefix) {
  const home = controls.adapters.pm2Home ?? path.join(await fs.realpath(os.homedir()), '.pm2');
  need(!process.env.PM2_HOME || await fs.realpath(process.env.PM2_HOME) === home); await directory(home, false);
  const file = await read(path.join(home, 'dump.pm2'), { maximum: 16 * 1024 ** 2 });
  const parsed = JSON.parse(file.data); need(Array.isArray(parsed) && parsed.length <= 512);
  const backup = await read(path.join(home, 'dump.pm2.bak'), { maximum: 16 * 1024 ** 2, optional: true });
  const planFile = path.join(context.controlRoot, prefix + '-boot-plan.private.json');
  const plan = await read(planFile, { optional: true });
  if (plan) {
    const value = JSON.parse(plan.data);
    need(value.version === 1 && value.preparedReceiptSha256 === context.preparedReceiptSha256
      && (await read(path.join(context.controlRoot, prefix + '-dump.original.private.json'), { maximum: 16 * 1024 ** 2 })).sha256 === value.dumpSha256);
    if (value.backupSha256) need((await read(path.join(context.controlRoot, prefix + '-dump-backup.original.private.json'),
      { maximum: 16 * 1024 ** 2 })).sha256 === value.backupSha256);
  } else {
    await writeOnce(path.join(context.controlRoot, prefix + '-dump.original.private.json'), file.data);
    if (backup) await writeOnce(path.join(context.controlRoot, prefix + '-dump-backup.original.private.json'), backup.data);
    await writeOnce(planFile, Buffer.from(JSON.stringify({ version: 1, preparedReceiptSha256: context.preparedReceiptSha256,
      dumpSha256: file.sha256, backupSha256: backup?.sha256 ?? null })));
  }
  return { file, backup, home };
}

async function startReport(context, controls) {
  controls.phase('selected-serving'); const inputs = await selectedServing(context), client = await openHead(context);
  let ownId, attemptedStart = false;
  try {
    need(same(comparableHead(await client.replica.head()), comparableHead(inputs.head)));
    const workers = await controls.workers({ reportMayStop: true });
    if (workers.report?.pm2_env.status !== 'online') need(await (controls.adapters.listenerFor ?? listenerFor)(null));
    controls.phase('report-enable'); await enabledEnvironment(context, true);
    context.env.DRIVER_AUDIT_ENABLED = '1';
    await controls.recheck();
    if (!workers.report || workers.report.pm2_env.status === 'stopped') {
      controls.phase('report-supervision-backup');
      const originalRegistration = path.join(context.controlRoot, 'old-sync-registration.original.private.json');
      if (!await read(originalRegistration, { optional: true, maximum: 4 * 1024 ** 2 }))
        await writeOnce(originalRegistration, Buffer.from(JSON.stringify(workers.sync)));
      await savedBoot(context, controls, 'before-report');
      controls.phase('report-start');
      attemptedStart = true;
      if (workers.report) {
        ownId = workers.report.pm_id; await controls.pm2(['restart', String(ownId)]);
      } else {
        await controls.pm2(['start', path.join(context.server, 'scripts/driverAuditHttp.js'), '--name', 'matter-driver-reports-api',
          '--cwd', context.server, '--interpreter', context.node.executable, '--restart-delay', '5000', '--kill-timeout', '40000']);
        ownId = (await controls.workers({ reportMayStop: true })).report.pm_id;
      }
    }
    controls.phase('report-health'); let ready, row;
    for (let attempt = 0; attempt < 60; attempt++) {
      controls.signal.throwIfAborted();
      try { row = (await controls.workers({ reportMayStop: true })).report; if (row?.pm2_env.status === 'online') ready = await health(context, controls, row, inputs.head.reportHash); }
      catch { if (attempt === 59) throw Error('Report service did not become ready'); }
      if (ready) break;
      await controls.wait(500);
    }
    need(ready); await controls.pm2(['save']);
    await controls.recheck();
    const after = await controls.workers({ reportRequired: true }); need(after.report.pid === row.pid);
    need(same(comparableHead(await client.replica.head()), comparableHead(inputs.head)));
    return { status: 'report-started', generation: ready.generation, collectorRevision: ready.collectorRevision,
      processId: row.pid, registrationId: row.pm_id, loopbackPort: 5002, reportEnvironmentSha256: (await read(context.envFile)).sha256 };
  } catch (error) {
    if (attemptedStart) for (;;) {
      try {
        if (ownId === undefined) {
          const matches = (await controls.rows()).filter(row => row.name === 'matter-driver-reports-api');
          need(matches.length <= 1);
          if (matches[0]) {
            need(Number.isInteger(matches[0].pm_id) && matches[0].pm2_env.pm_exec_path === path.join(context.server, 'scripts/driverAuditHttp.js')
              && matches[0].pm2_env.pm_cwd === context.server && matches[0].pm2_env.exec_interpreter === context.node.executable
              && same(matches[0].pm2_env.args ?? [], []) && same(matches[0].pm2_env.node_args ?? [], []));
            ownId = matches[0].pm_id;
          } else {
            await controls.pm2(['save']);
            need(!(await controls.rows()).some(row => row.name === 'matter-driver-reports-api'));
            break;
          }
        }
        await controls.stopOwned('matter-driver-reports-api', ownId); break;
      } catch { /* Lost ACK/observation must not release exclusion or stop a foreign registration. */ }
      await controls.wait(250);
    }
    throw error;
  } finally { await client.backend.close?.(); }
}

async function environmentBackup(context, controls, expectedSha256) {
  need(expectedSha256 === context.p.backupProof);
  const client = await openHead(context);
  try {
    await client.backend.archive.assertPrivate();
    const pieces = []; let bytes = 0;
    for await (const piece of await client.backend.archive.readObject(expectedSha256 + '.gz', { maxBytes: 64 * 1024, signal: controls.signal })) {
      need((bytes += piece.length) <= 64 * 1024); pieces.push(Buffer.from(piece));
    }
    const packed = Buffer.concat(pieces, bytes); need(sha(packed) === expectedSha256);
    const raw = gunzipSync(packed, { maxOutputLength: 32 * 1024 }), proof = JSON.parse(raw), backup = proof.backup;
    need(exact(proof, ['version', 'kind', 'verified', 'releaseSha', 'bootstrapSha256', 'sourceManifestSha256',
      'environmentSha256', 'originalEnvironmentValuesMatched', 'backup', 'verifiedAt'])
      && proof.version === 1 && proof.kind === 'driver-report-source-environment-off-host-backup-v1' && proof.verified === true
      && proof.releaseSha === context.p.release && proof.bootstrapSha256 === context.p.bootstrap
      && proof.sourceManifestSha256 === context.p.source && proof.environmentSha256 === context.sourceEnvironment.sha256
      && proof.originalEnvironmentValuesMatched === 9
      && exact(backup, ['kind', 'readbackReceiptSha256', 'environmentSha256', 'environmentBytes', 'bootstrapSha256', 'bootstrapBytes'])
      && backup.kind === 'owner-private-recovery-volume' && digest(backup.readbackReceiptSha256)
      && backup.environmentSha256 === context.sourceEnvironment.sha256 && backup.environmentBytes === context.sourceEnvironment.bytes
      && backup.bootstrapSha256 === context.p.bootstrap && backup.bootstrapBytes === context.p.bootstrapBytes
      && typeof proof.verifiedAt === 'string' && new Date(proof.verifiedAt).toISOString() === proof.verifiedAt
      && Date.parse(proof.verifiedAt) <= Date.now());
    await writeOnce(path.join(context.controlRoot, 'source-environment-backup-proof.private.json.gz'), packed);
    await writeOnce(path.join(context.controlRoot, 'source-environment-backup-proof.private.json'), raw);
    return { compressedSha256: expectedSha256, receiptSha256: sha(raw), environmentSha256: proof.environmentSha256,
      readbackReceiptSha256: backup.readbackReceiptSha256 };
  } finally { await client.backend.close?.(); }
}

async function syncRetarget(context, controls) {
  const planFile = path.join(context.controlRoot, 'sync-retarget-plan.private.json'), receiptFile = path.join(context.controlRoot, 'sync-retarget.private.json');
  let planBytes = await read(planFile, { optional: true, maximum: 4 * 1024 ** 2 });
  const rows = await controls.rows(), main = rows.find(row => row.name === 'matter-delivery-api'), matches = rows.filter(row => row.name === 'matter-driver-audit-sync');
  need(matches.length <= 1); let sync = matches[0];
  if (!planBytes) {
    need(sync?.pid === 0 && sync.pm2_env.status === 'stopped'
      && sync.pm2_env.pm_exec_path === path.join(context.appRoot, 'server/scripts/driverAuditSync.js'));
    const backupFile = path.join(context.controlRoot, 'old-sync-registration.original.private.json');
    const oldBackup = await read(backupFile, { optional: true, maximum: 4 * 1024 ** 2 });
    if (oldBackup) need(same(launch(JSON.parse(oldBackup.data)), launch(sync)));
    else await writeOnce(backupFile, Buffer.from(JSON.stringify(sync)));
    await savedBoot(context, controls, 'before-sync-retarget');
    const nodeOptions = sync.pm2_env.NODE_OPTIONS ?? sync.pm2_env.env?.NODE_OPTIONS ?? null;
    need(nodeOptions === null || /^--max-old-space-size=\d{3,5}$/.test(nodeOptions));
    const plan = { version: 1, kind: 'supabase-sync-retarget-plan-v1', preparedReceiptSha256: context.preparedReceiptSha256,
      originalRegistrationSha256: (await read(backupFile, { maximum: 4 * 1024 ** 2 })).sha256,
      oldRegistrationId: sync.pm_id, oldLaunchSha256: sha(JSON.stringify(launch(sync))), mainIdentitySha256: sha(JSON.stringify(processIdentity(main))),
      newScript: path.join(context.server, 'scripts/driverAuditSync.js'), newCwd: context.server,
      configFile: context.receipt.syncConfig, interpreter: context.node.executable, nodeOptions };
    await writeOnce(planFile, Buffer.from(JSON.stringify(plan))); planBytes = await read(planFile);
  }
  const plan = JSON.parse(planBytes.data), backupFile = path.join(context.controlRoot, 'old-sync-registration.original.private.json');
  need(plan.version === 1 && plan.preparedReceiptSha256 === context.preparedReceiptSha256
    && plan.mainIdentitySha256 === sha(JSON.stringify(processIdentity(main)))
    && plan.originalRegistrationSha256 === (await read(backupFile, { maximum: 4 * 1024 ** 2 })).sha256
    && plan.newScript === path.join(context.server, 'scripts/driverAuditSync.js') && plan.newCwd === context.server
    && plan.configFile === context.receipt.syncConfig && plan.interpreter === context.node.executable
    && (plan.nodeOptions === null || /^--max-old-space-size=\d{3,5}$/.test(plan.nodeOptions)));
  const existing = await read(receiptFile, { optional: true });
  if (existing) {
    const value = JSON.parse(existing.data);
    need(sync?.pid === 0 && sync.pm2_env.status === 'stopped' && value.planSha256 === planBytes.sha256
      && value.registrationId === sync.pm_id && value.launchSha256 === sha(JSON.stringify(launch(sync))));
    return plan;
  }
  const { withDriverAuditHeavyWork } = await context.load('services/driverAuditHeavyWork.js');
  const heavyRoot = path.join(context.server, '.private/driver-audit-heavy-work'); await mkdirPrivate(heavyRoot);
  await withDriverAuditHeavyWork({ root: heavyRoot, owner: 'source', signal: controls.signal }, async () => {
    let newId;
    try {
      await controls.recheck(); const observed = await controls.rows();
      need(same(processIdentity(observed.find(row => row.name === 'matter-delivery-api')), processIdentity(main))
        && !observed.some(row => row.name === 'matter-driver-audit-source'));
      const found = observed.filter(row => row.name === 'matter-driver-audit-sync'); need(found.length <= 1); sync = found[0];
      if (sync && sync.pm2_env.pm_exec_path !== plan.newScript) {
        need(sync.pm_id === plan.oldRegistrationId && sync.pid === 0 && sync.pm2_env.status === 'stopped'
          && sha(JSON.stringify(launch(sync))) === plan.oldLaunchSha256);
        await controls.pm2(['delete', String(sync.pm_id)]); sync = null;
      }
      if (sync) {
        need(sync.pm2_env.pm_exec_path === plan.newScript && sync.pm2_env.pm_cwd === plan.newCwd
          && same(sync.pm2_env.args, ['--config', plan.configFile]) && sync.pm2_env.exec_interpreter === plan.interpreter);
        newId = sync.pm_id; need(sync.pid === 0 && sync.pm2_env.status === 'stopped');
      } else {
        const env = { ...controls.shell, ...(plan.nodeOptions ? { NODE_OPTIONS: plan.nodeOptions } : {}) };
        await controls.pm2(['start', plan.newScript, '--name', 'matter-driver-audit-sync', '--cwd', plan.newCwd,
          '--interpreter', plan.interpreter, '--restart-delay', '5000', '--kill-timeout', '330000', '--', '--config', plan.configFile], { env });
        const started = (await controls.rows()).filter(row => row.name === 'matter-driver-audit-sync');
        need(started.length === 1); newId = started[0].pm_id;
      }
    } finally {
      // A rejected/lost start acknowledgement can still have created a live
      // process. Keep exclusion until the actual registration is resolved.
      for (;;) {
        try {
          const matches = (await controls.rows()).filter(row => row.name === 'matter-driver-audit-sync'); need(matches.length <= 1);
          const row = matches[0];
          if (row?.pm2_env.pm_exec_path === plan.newScript && row.pm2_env.pm_cwd === plan.newCwd
            && row.pm2_env.exec_interpreter === plan.interpreter && same(row.pm2_env.args, ['--config', plan.configFile])) {
            newId = row.pm_id; await controls.stopOwned('matter-driver-audit-sync', newId); break;
          }
          need(!row || row.pm_id === plan.oldRegistrationId && row.pid === 0 && row.pm2_env.status === 'stopped'
            && sha(JSON.stringify(launch(row))) === plan.oldLaunchSha256);
          await controls.pm2(['save']);
          const after = (await controls.rows()).filter(item => item.name === 'matter-driver-audit-sync');
          need(!row ? after.length === 0 : after.length === 1 && after[0].pid === 0 && after[0].pm2_env.status === 'stopped'
            && sha(JSON.stringify(launch(after[0]))) === plan.oldLaunchSha256);
          break;
        } catch { await controls.wait(250); }
      }
    }
  });
  const after = await controls.workers({ reportRequired: true }); need(!after.oldSync);
  await writeOnce(receiptFile, Buffer.from(JSON.stringify({ version: 1, kind: 'supabase-sync-retarget-v1',
    planSha256: planBytes.sha256, registrationId: after.sync.pm_id, launchSha256: sha(JSON.stringify(launch(after.sync))), held: true })));
  return plan;
}

async function qualificationReceipt(context, inputs, receiptSha256, { recent = false } = {}) {
  need(digest(receiptSha256));
  const plan = JSON.parse((await read(path.join(context.controlRoot, 'sync-retarget-plan.private.json'))).data);
  need(plan.preparedReceiptSha256 === context.preparedReceiptSha256);
  const { readDriverAuditSourceConfig } = await context.load('services/driverAuditSource.js');
  const config = await readDriverAuditSourceConfig(context.receipt.sourceConfig);
  const { verifyDriverAuditSourceHostQualification } = await context.load('scripts/driverAuditSourceQualify.js');
  const receipt = await verifyDriverAuditSourceHostQualification({ config, commit: context.p.release,
    reference: { fixtureSha256: context.p.fixture, receiptSha256 },
    builder: { baselineRoot: inputs.paths.privateRoot, baselineManifestSha256: context.p.current.manifest,
      cacheRoot: path.join(context.syncRoot, 'work/archive-cache'), codeRoot: context.sync.codeRoot,
      builderSha256: context.p.builder, initialBaseline: context.sync.baselineRoot,
      rendererBuild: context.sync.rendererBuild, journals: context.sync.journals, compactDirectBuildVersion: 1 },
    nodeExecutable: context.node.executable, nodeVersion: context.node.version, nodeArgs: plan.nodeOptions ? [plan.nodeOptions] : [] });
  need(receipt.fixtureArchive?.objects === context.p.fixtureObjects);
  if (recent) need(Date.now() - Date.parse(receipt.checkedAt) <= 30 * 60_000);
  const raw = await read(path.join(config.root, 'qualification-' + context.p.fixture + '.private.json'));
  need(raw.sha256 === receiptSha256);
  await writeOnce(path.join(context.controlRoot, 'host-qualification-' + receiptSha256 + '.private.json'), raw.data);
  return receipt;
}

async function qualifySource(context, controls, args) {
  need(args.qualificationFixtureSha256 === context.p.fixture && args.environmentBackupProofSha256 === context.p.backupProof);
  controls.phase('qualification-inputs'); const inputs = await selectedServing(context);
  need((await enabledEnvironment(context)).enabled); context.env.DRIVER_AUDIT_ENABLED = '1';
  const workers = await controls.workers({ reportRequired: true }); await health(context, controls, workers.report, inputs.head.reportHash);
  const proof = await environmentBackup(context, controls, args.environmentBackupProofSha256);
  controls.phase('sync-retarget'); const plan = await syncRetarget(context, controls);
  await controls.recheck(); controls.phase('held-source-qualification');
  const env = { ...controls.shell, ...context.env, DRIVER_AUDIT_DEPLOY_SHA: context.p.release,
    DRIVER_AUDIT_SOURCE_MANIFEST: context.p.source, DRIVER_AUDIT_SOURCE_NODE: context.node.executable,
    DRIVER_AUDIT_SOURCE_QUALIFICATION_SHA256: context.p.fixture };
  await controls.releaseSourceDeployment();
  try {
    const output = await controls.exec(context.node.executable, [path.join(context.server, 'scripts/driverAuditSourceDeploy.js'),
      'audit-source-qualify-held'], { cwd: context.releaseRoot, env, timeout: 54 * 60_000, signal: controls.signal });
    const result = JSON.parse(output.stdout.trim());
    need(result.status === 'verified' && result.verified === true && digest(result.receiptSha256));
    controls.phase('qualification-readback');
    const receipt = await qualificationReceipt(context, inputs, result.receiptSha256);
    return { status: 'source-qualified', fixtureSha256: context.p.fixture, receiptSha256: result.receiptSha256,
      sourceManifestSha256: context.p.source, environmentBackupProofSha256: proof.compressedSha256,
      transferAccounting: receipt.transferAccounting, measurements: receipt.measurements, transferUsage: receipt.transferUsage };
  } finally { await controls.acquireSourceDeployment(); }
}

async function candidatePackage(context) {
  const pointerFile = await read(path.join(context.syncRoot, 'work/current.private.json'));
  const pointer = JSON.parse(pointerFile.data), prefix = path.join(context.syncRoot, 'work/attempts') + path.sep;
  need(pointer.version === 1 && pointer.collectorRevision === context.p.collector.revision
    && pointer.sourceBasis === context.p.collector.sourceBasis && digest(pointer.manifestSha256)
    && typeof pointer.privateRoot === 'string' && pointer.privateRoot.startsWith(prefix)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/server-data$/.test(pointer.privateRoot.slice(prefix.length)));
  const files = await packageFiles(pointer.privateRoot, pointer.manifestSha256,
    { archiveBackedManifest: true, privateDirectoryBoundary: context.syncRoot });
  need((await read(pointerFile.path)).sha256 === pointerFile.sha256);
  return { pointerFile, pointer, files };
}

async function compareCandidateBusiness(context) {
  const generated = await candidatePackage(context);
  const retained = context.receipt.packages.find(row => row.role === 'candidate');
  const before = JSON.parse((await read(path.join(retained.root, 'files.private.json'), { maximum: 8 * 1024 ** 2 })).data);
  const after = JSON.parse((await read(path.join(generated.pointer.privateRoot, 'files.private.json'), { maximum: 8 * 1024 ** 2 })).data);
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const differences = names.filter(name => before[name] !== after[name]);
  const comparison = { version: 1, kind: 'supabase-same-input-business-comparison-v1',
    retainedManifestSha256: context.p.candidate, generatedManifestSha256: generated.pointer.manifestSha256,
    declaredFiles: names.length, declaredFileIdentitiesSha256: sha(JSON.stringify(canonical(after))),
    allDeclaredFilesEqual: differences.length === 0, differences: differences.map(name => ({ name, before: before[name] ?? null, after: after[name] ?? null })),
    permittedMetadataDeltas: [] };
  if (differences.length) {
    // Keep an unexplained change available privately; never rebaseline a golden
    // or omit a clock/policy field to make the pre-publication comparison pass.
    const raw = Buffer.from(JSON.stringify(comparison));
    await writeOnce(path.join(context.controlRoot, 'report-business-difference-' + sha(raw) + '.private.json'), raw);
    need(false);
  }
  if (generated.pointer.manifestSha256 !== context.p.candidate) comparison.permittedMetadataDeltas.push('files.private.json-key-order-only');
  const publicationFile = await read(path.join(generated.pointer.privateRoot, 'publication.private.json'), { maximum: 16 * 1024 ** 2 });
  const browserFile = await read(path.join(generated.pointer.privateRoot, 'browser-data.private.json.gz'), { maximum: 64 * 1024 ** 2 });
  need(publicationFile.sha256 === after['publication.private.json'] && browserFile.sha256 === after['browser-data.private.json.gz']);
  const publication = JSON.parse(publicationFile.data), browser = JSON.parse(gunzipSync(browserFile.data, { maxOutputLength: 256 * 1024 ** 2 }));
  const queryId = browser.matter?.validatedReporting?.queryId, rows = browser.queries?.[queryId]?.rows;
  need(Array.isArray(rows) && rows.length <= 100000 && publication.head?.records === rows.length
    && Number.isSafeInteger(publication.head.history) && publication.head.history >= 0
    && digest(publication.head.reportHash) && digest(publication.head.manifest?.sha256));
  comparison.fingerprints = { records: rows.length, history: publication.head.history, reportHash: publication.head.reportHash,
    acceptedGrades: rows.filter(row => row.photo?.grade !== null && row.photo?.grade !== undefined && row.photo?.grade !== '').length,
    generation: publication.head.manifest.sha256,
    retainedSignature: sha(JSON.stringify(rows.map(({ key, assessmentHash, photo, findings, delivery }) => ({ key, assessmentHash, photo, findings, delivery })))) };
  return { ...generated, comparison };
}

// Fixed internal runner: paths and pins arrive over the parent-owned pipe, not
// command arguments, workflow strings or a new public command interface.
const tickChildCode = String.raw`
import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
import{createHash}from'node:crypto';import{getHeapStatistics}from'node:v8';
const need=x=>{if(!x)throw Error('Report child guard failed');},sha=x=>createHash('sha256').update(x).digest('hex');
const stop=new AbortController();for(const event of ['SIGTERM','SIGINT','SIGHUP'])process.on(event,()=>stop.abort(Error('Report child stopped')));
let worker,backend,pending,sequence=0;const measurements={samples:0,peakRssBytes:0,minimumAvailableBytes:null};
const sample=()=>{const available=process.availableMemory();need(Number.isSafeInteger(available)&&available>0);measurements.samples++;
 measurements.peakRssBytes=Math.max(measurements.peakRssBytes,process.memoryUsage().rss);
 measurements.minimumAvailableBytes=measurements.minimumAvailableBytes===null?available:Math.min(measurements.minimumAvailableBytes,available);
 if(available<1024**3)stop.abort(Error('Report child memory reserve unavailable'));};
const timer=setInterval(sample,250);timer.unref();
process.on('message',message=>{if(message?.type!=='publication-admission'||!pending||message.id!==pending.id)return;
 const saved=pending;pending=null;message.allowed===true?saved.resolve():saved.reject(Error('Report publication admission rejected'));});
stop.signal.addEventListener('abort',()=>{if(pending){const saved=pending;pending=null;saved.reject(Error('Report child stopped'));}});
let failure=false;
try{
 let input='',byteCount=0;for await(const piece of process.stdin){byteCount+=piece.length;need(byteCount<=16*1024);input+=piece;}const options=JSON.parse(input);
 need(options.version===1&&process.version===options.nodeVersion&&(process.env.NODE_OPTIONS??null)===options.nodeOptions);
 need(process.env.DRIVER_AUDIT_EXECUTION_HOST==='sidi'&&process.env.DRIVER_AUDIT_DATA_STORE==='supabase'&&!process.env.MONGODB_URI);
 const handle=await fs.open(options.configFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 let bytes;try{const before=await handle.stat();need(before.isFile()&&before.uid===process.getuid()&&!(before.mode&0o077)&&before.size>0&&before.size<=1024*1024
  &&await fs.realpath(options.configFile)===options.configFile);bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,offset);need(result.bytesRead>0);offset+=result.bytesRead;}
  const after=await handle.stat(),named=await fs.lstat(options.configFile);for(const key of ['dev','ino','uid','mode','size','mtimeMs','ctimeMs'])need(before[key]===after[key]&&before[key]===named[key]);
 }finally{await handle.close();}need(sha(bytes)===options.configSha256);const config=JSON.parse(bytes);
 need(config.root===options.syncRoot&&config.builderSha256===options.builderSha256&&options.configFile===path.join(options.syncRoot,'sync.json'));
 const [{createDriverAuditSupabaseAppBackend},{createDriverAuditSupabaseSync}]=await Promise.all([
  import(pathToFileURL(path.join(options.server,'services/driverAuditSupabaseAppBackend.js'))),
  import(pathToFileURL(path.join(options.server,'services/driverAuditSupabaseSync.js')))]);
 backend=await createDriverAuditSupabaseAppBackend({env:process.env});
 const allowed=new Set(['matter_hosted_state_read','matter_hosted_state_read_if_changed','matter_hosted_state_receipts','matter_hosted_state_cas',
  'matter_hosted_archive_capacity','matter_hosted_archive_reserve','matter_hosted_archive_consume','matter_hosted_archive_release']);
 const wrap=rpc=>async(name,parameters)=>{stop.signal.throwIfAborted();need(allowed.has(name));
  if(name==='matter_hosted_state_cas'){
   need(parameters.p_key==='app-sidi-report-head'&&Buffer.byteLength(JSON.stringify(parameters))<=512*1024&&!pending);
   await new Promise((resolve,reject)=>{pending={id:++sequence,resolve,reject};process.send({type:'publication-candidate',id:sequence,parameters},error=>{if(error&&pending){const saved=pending;pending=null;saved.reject(error);}});});
   stop.signal.throwIfAborted();}
  const result=await rpc(name,parameters);
  if(parameters.p_key==='collector-state'){
   if(['matter_hosted_state_read','matter_hosted_state_read_if_changed'].includes(name))need(result.revision===options.collector.revision
    &&(result.body_text===null&&result.unchanged===true||typeof result.body_text==='string'&&sha(result.body_text)===options.collector.bodySha256));
   else if(name==='matter_hosted_state_receipts')need(Array.isArray(result)&&result.every(row=>row.revision===options.collector.revision
    &&row.body_sha256===options.collector.bodySha256&&sha(row.body_text)===options.collector.bodySha256));}
  return result;};
 sample();stop.signal.throwIfAborted();
 worker=await createDriverAuditSupabaseSync({config,file:options.configFile,backend:{...backend,rpc:wrap(backend.rpc),
  rpcForResponseLimit:maximum=>wrap(backend.rpcForResponseLimit(maximum))},signal:stop.signal});
 await worker.tick();stop.signal.throwIfAborted();sample();
 process.send({type:'report-tick-complete',measurements:{...measurements,pid:process.pid,nodeVersion:process.version,
  nodeOptions:process.env.NODE_OPTIONS??null,heapSizeLimitBytes:getHeapStatistics().heap_size_limit},transferUsage:await backend.readTransferUsage()});
}catch(error){failure=true;process.exitCode=1;if(process.connected)process.send({type:'report-tick-failed',failure:{name:String(error?.name??'Error').slice(0,80),
 code:typeof error?.code==='string'?error.code.slice(0,80):null,message:String(error?.message??'').slice(0,2048),stack:String(error?.stack??'').slice(0,8192)}});}finally{
 clearInterval(timer);try{await worker?.close();}catch{failure=true;process.exitCode=1;}finally{try{await backend?.close?.();}catch{failure=true;process.exitCode=1;}}
 if(failure&&process.connected)process.send({type:'report-tick-failed'});if(process.connected)process.disconnect();
}
`;

async function runTickChild(context, controls, admit) {
  const plan = JSON.parse((await read(path.join(context.controlRoot, 'sync-retarget-plan.private.json'))).data);
  need(plan.preparedReceiptSha256 === context.preparedReceiptSha256 && (plan.nodeOptions === null || /^--max-old-space-size=\d{3,5}$/.test(plan.nodeOptions)));
  const env = { ...controls.shell, ...context.env }; if (plan.nodeOptions !== null) env.NODE_OPTIONS = plan.nodeOptions;
  const child = (controls.adapters.spawn ?? spawn)(controls.adapters.childExecutable ?? context.node.executable,
    ['--input-type=module', '-e', tickChildCode], { cwd: context.releaseRoot, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let overflow = false, size = 0, complete, failed = false, childFailure, admission, admissionFailure, forced = false;
  const stdout = [], stderr = [], timers = [];
  const terminate = () => { if (!child.killed) child.kill('SIGTERM');
    timers.push(setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 45_000)); };
  const capture = pieces => piece => { size += piece.length; if (size > 128 * 1024) { overflow = true; terminate(); }
    else pieces.push(Buffer.from(piece)); };
  child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
  controls.signal.addEventListener('abort', terminate, { once: true });
  timers.push(setTimeout(terminate, 54 * 60_000));
  child.on('message', message => {
    if (message?.type === 'publication-candidate') {
      if (admission || !Number.isSafeInteger(message.id) || message.id < 1 || !message.parameters
        || Buffer.byteLength(JSON.stringify(message)) > 512 * 1024) { failed = true; terminate(); return; }
      admission = Promise.resolve().then(() => admit(message.parameters)).then(() => {
        controls.signal.throwIfAborted(); if (child.connected) child.send({ type: 'publication-admission', id: message.id, allowed: true });
      }).catch(error => { admissionFailure = error; if (child.connected) child.send({ type: 'publication-admission', id: message.id, allowed: false }); });
    } else if (message?.type === 'report-tick-complete') {
      if (complete || Buffer.byteLength(JSON.stringify(message)) > 16 * 1024) { failed = true; terminate(); } else complete = message;
    } else if (message?.type === 'report-tick-failed') {
      failed = true; if (message.failure && Buffer.byteLength(JSON.stringify(message.failure)) <= 16 * 1024) childFailure = message.failure;
    }
    else { failed = true; terminate(); }
  });
  const closed = new Promise(resolve => { child.once('error', () => { failed = true; }); child.once('close', (code, signal) => resolve({ code, signal })); });
  const input = { version: 1, server: context.server, syncRoot: context.syncRoot, configFile: context.receipt.syncConfig,
    configSha256: context.syncFile.sha256, builderSha256: context.p.builder, collector: context.p.collector,
    nodeVersion: controls.adapters.childVersion ?? context.node.version, nodeOptions: plan.nodeOptions };
  child.stdin.on('error', () => { failed = true; }); child.stdin.end(JSON.stringify(input));
  if (controls.signal.aborted) terminate();
  let exit;
  try { exit = await closed; if (admission) await admission; }
  finally { for (const timer of timers) clearTimeout(timer); controls.signal.removeEventListener('abort', terminate); }
  if (admissionFailure || failed || overflow || exit.code !== 0 || !complete || controls.signal.aborted) {
    const evidence = Buffer.from(JSON.stringify({ version: 1, kind: 'supabase-one-report-child-failure-v1',
      preparedReceiptSha256: context.preparedReceiptSha256, exit, overflow, forced, phase: 'one-report-child',
      childFailure, stdoutBase64: Buffer.concat(stdout).toString('base64'), stderrBase64: Buffer.concat(stderr).toString('base64') }));
    const file = path.join(context.controlRoot, 'report-child-failure-' + sha(evidence) + '.private.json');
    await writeOnce(file, evidence); context.privateFailure = { path: file, sha256: sha(evidence), bytes: evidence.length,
      exit, overflow, forced, childFailure, stdoutExcerptBase64: Buffer.concat(stdout).subarray(0,2048).toString('base64'),
      stderrExcerptBase64: Buffer.concat(stderr).subarray(0,2048).toString('base64') };
    throw admissionFailure ?? Error('Report child stopped');
  }
  need(complete.measurements?.samples > 0 && complete.measurements.peakRssBytes > 0
    && complete.measurements.minimumAvailableBytes >= 1024 ** 3 && complete.measurements.nodeOptions === plan.nodeOptions
    && complete.measurements.nodeVersion === input.nodeVersion && complete.measurements.heapSizeLimitBytes > 0);
  return { measurements: complete.measurements, transferUsage: complete.transferUsage };
}

async function runReportOnce(context, controls, args) {
  need(args.qualificationFixtureSha256 === context.p.fixture && args.environmentBackupProofSha256 === context.p.backupProof
    && digest(args.qualificationReceiptSha256));
  controls.phase('one-report-admission');
  const inputs = await selectedServing(context, { allowBuiltCandidate: true });
  need((await enabledEnvironment(context)).enabled); context.env.DRIVER_AUDIT_ENABLED = '1';
  const workers = await controls.workers({ reportRequired: true }); need(!workers.oldSync);
  const qualification = await qualificationReceipt(context, inputs, args.qualificationReceiptSha256, { recent: true });
  await environmentBackup(context, controls, args.environmentBackupProofSha256);
  const client = await openHead(context), { backend, replica } = client;
  let childResult;
  try {
    const { createCloudState } = await context.load('vendor/driver-audits/integration/cloud/cloud-state.mjs');
    const { automaticReleaseBasis } = await import(pathToFileURL(path.join(context.sync.codeRoot, 'integration/cloud/automatic-release.mjs')).href);
    need(typeof automaticReleaseBasis === 'function');
    const rawState = createCloudState({ rpc: backend.rpc });
    const sourceSnapshot = async () => {
      const saved = await rawState.read('collector-state');
      need(saved.revision === context.p.collector.revision && typeof saved.body === 'string'
        && sha(saved.body) === context.p.collector.bodySha256 && automaticReleaseBasis(JSON.parse(saved.body)) === context.p.collector.sourceBasis);
      const [receipt] = await rawState.receipts('collector-state', { after: saved.revision - 1 });
      need(receipt?.revision === saved.revision && receipt.body_text === saved.body && receipt.body_sha256 === context.p.collector.bodySha256);
      return { revision: saved.revision, bodySha256: sha(saved.body), sourceBasis: context.p.collector.sourceBasis,
        receiptSha256: sha(JSON.stringify(canonical(receipt))) };
    };
    const protectedKeys = ['photo-grading-budget', 'review-journal', 'preview-gps-map-20261106:review-journal'];
    const protectedHeads = async () => {
      const result = [];
      for (const key of protectedKeys) {
        const saved = await rawState.read(key);
        result.push({ key, revision: saved.revision, bodySha256: saved.body === null ? null : sha(saved.body) });
      }
      return result;
    };
    const source = await sourceSnapshot(), protectedBefore = await protectedHeads();
    const before = await replica.head(), intentsRoot = path.join(context.controlRoot, 'report-once-intents');
    await mkdirPrivate(intentsRoot);
    const savedIntents = await fs.readdir(intentsRoot);
    need(savedIntents.length <= 8 && savedIntents.every(name => /^[a-f0-9]{64}\.private\.json$/.test(name)));
    const fileFor = bodySha256 => { need(digest(bodySha256)); return path.join(intentsRoot, bodySha256 + '.private.json'); };
    let intentBytes = before?.servingPackage?.collectorRevision === context.p.collector.revision
      ? await read(fileFor(before.sourceBodySha256), { optional: true }) : null;
    let intent = intentBytes && JSON.parse(intentBytes.data), parity;
    const validProtectedHeads = value => Array.isArray(value) && value.length === protectedKeys.length
      && value.every((row, index) => row.key === protectedKeys[index] && Number.isSafeInteger(row.revision) && row.revision >= 0
        && (row.bodySha256 === null && row.revision === 0 || digest(row.bodySha256)));
    const intentMatches = (value, active) => need(value.version === 1 && value.kind === 'supabase-one-report-publication-intent-v1'
      && value.preparedReceiptSha256 === context.preparedReceiptSha256 && value.releaseSha === context.p.release
      && value.sourceManifestSha256 === context.p.source && value.builderSha256 === context.p.builder
      && same(value.source, source) && validProtectedHeads(value.protectedHeads)
      && (active ? protectedBefore.every((row, index) => row.revision >= value.protectedHeads[index].revision
        && (row.revision > value.protectedHeads[index].revision || row.bodySha256 === value.protectedHeads[index].bodySha256))
        : same(value.protectedHeads, protectedBefore))
      && value.qualificationReceiptSha256 === args.qualificationReceiptSha256
      && typeof value.publicationBody === 'string' && sha(value.publicationBody) === value.publicationBodySha256
      && (!active || active.sourceRevision === value.expectedServingRevision + 1
        && active.sourceBodySha256 === value.publicationBodySha256
        && same(comparableHead(active), comparableHead(JSON.parse(value.publicationBody)))));
    if (before?.servingPackage?.collectorRevision === context.p.collector.revision) {
      controls.phase('one-report-recovery'); need(intent); intentMatches(intent, before);
      parity = await compareCandidateBusiness(context);
      need(same(parity.comparison, intent.businessParity));
    } else {
      need(before && same(comparableHead(before), comparableHead(inputs.head)));
      await health(context, controls, workers.report, before.reportHash);
      const admit = async parameters => {
          controls.signal.throwIfAborted();
          controls.phase('one-report-prepublication');
          need(parameters.p_key === 'app-sidi-report-head' && parameters.p_expected === before.sourceRevision);
          const proposed = JSON.parse(parameters.p_body_text);
          need(proposed.servingPackage?.collectorRevision === context.p.collector.revision
            && proposed.servingPackage.sourceBasis === context.p.collector.sourceBasis
            && proposed.previous && same(comparableHead(proposed.previous), comparableHead({ ...before, previous: undefined })));
          need(same(await sourceSnapshot(), source) && same(await protectedHeads(), protectedBefore));
          await qualificationReceipt(context, inputs, args.qualificationReceiptSha256, { recent: true });
          parity = await compareCandidateBusiness(context);
          need(proposed.servingPackage.manifestSha256 === parity.pointer.manifestSha256
            && proposed.generation === parity.comparison.fingerprints.generation && proposed.reportHash === parity.comparison.fingerprints.reportHash);
          await controls.recheck();
          const planned = { version: 1, kind: 'supabase-one-report-publication-intent-v1', preparedReceiptSha256: context.preparedReceiptSha256,
            releaseSha: context.p.release, sourceManifestSha256: context.p.source, builderSha256: context.p.builder,
            qualificationReceiptSha256: args.qualificationReceiptSha256, source, protectedHeads: protectedBefore,
            expectedServingRevision: before.sourceRevision, expectedServingBodySha256: before.sourceBodySha256,
            publicationBody: parameters.p_body_text, publicationBodySha256: sha(parameters.p_body_text), businessParity: parity.comparison };
          const intentFile = fileFor(planned.publicationBodySha256);
          if (!savedIntents.includes(path.basename(intentFile))) need(savedIntents.length < 8);
          await writeOnce(intentFile, Buffer.from(JSON.stringify(planned)));
          intentBytes = await read(intentFile); intent = JSON.parse(intentBytes.data); intentMatches(intent);
          // The final source/review reads remain real responses. No replacement
          // body, revision or receipt is supplied to the actual Sync service.
          need(same(await sourceSnapshot(), source) && same(await protectedHeads(), protectedBefore));
      };
      controls.phase('one-report-build');
      // This factory owns its real worker and heavy-work locks. The parent only
      // holds deployment/source exclusion; preflight drain locks were released.
      childResult = await runTickChild(context, controls, admit);
    }
    controls.phase('one-report-readback');
    const after = await replica.head(); need(intent && parity); intentMatches(intent, after);
    need(after.servingPackage.collectorRevision === context.p.collector.revision
      && after.previous?.servingPackage.collectorRevision === context.p.current.revision
      && same(await sourceSnapshot(), source) && same(await protectedHeads(), protectedBefore));
    const expected = { revision: context.p.collector.revision, generation: after.generation };
    let healthy = false;
    for (let attempt = 0; attempt < 60 && !healthy; attempt++) {
      try { await health(context, controls, (await controls.workers({ reportRequired: true })).report, after.reportHash, expected); healthy = true; }
      catch { controls.signal.throwIfAborted(); if (attempt === 59) throw Error('Report health pending'); await controls.wait(250); }
    }
    const advanced = protectedBefore.filter((row, index) => row.revision > intent.protectedHeads[index].revision).map(row => row.key);
    const proof = { version: 1, kind: 'supabase-one-report-completion-v1', preparedReceiptSha256: context.preparedReceiptSha256,
      publicationIntentSha256: intentBytes.sha256, generation: after.generation, collectorRevision: after.servingPackage.collectorRevision,
      servingHeadRevision: after.sourceRevision, servingHeadBodySha256: after.sourceBodySha256, previousGeneration: after.previous.generation,
      qualificationReceiptSha256: args.qualificationReceiptSha256, source, businessParity: parity.comparison,
      protectedHeads: protectedBefore, protectedHeadsAdvancedSincePublication: advanced,
      transferAccounting: qualification.transferAccounting, sourceStarted: false };
    const completionIdentity = sha(JSON.stringify([after.sourceBodySha256, protectedBefore]));
    await writeOnce(path.join(context.controlRoot, 'report-once-complete-' + completionIdentity + '.private.json'), Buffer.from(JSON.stringify(proof)));
    return { status: 'report-generated', ...proof, ...(childResult ? { oneTimeChild: childResult } : {}) };
  } finally { await backend.close?.(); }
}

function boundedFailureText(value, maximum) {
  const bytes = Buffer.isBuffer(value) ? value.length : typeof value === 'string' ? Buffer.byteLength(value) : 0;
  const raw = Buffer.isBuffer(value) ? value.subarray(0, maximum) : Buffer.from(typeof value === 'string' ? value.slice(0, maximum) : '');
  let text = raw.subarray(0, maximum).toString('utf8');
  while (Buffer.byteLength(text) > maximum) text = text.slice(0, -1);
  return { text, bytes, truncated: bytes > Buffer.byteLength(text) };
}

function boundedFailureCause(cause) {
  const result = {};
  for (const [name, maximum] of [['name', 128], ['code', 128], ['message', 2048], ['stack', 4096], ['stdout', 2048], ['stderr', 4096]]) {
    let value; try { value = cause?.[name]; if (name === 'code' && Number.isSafeInteger(value)) value = String(value); } catch { /* Optional error getters cannot replace the stopped result. */ }
    const part = boundedFailureText(value, maximum); result[name] = part.text;
    if (!['name', 'code'].includes(name)) { result[name + 'Bytes'] = part.bytes; result[name + 'Truncated'] = part.truncated; }
  }
  return result;
}

export async function runDriverAuditSupabaseControl(args = {}, adapters = {}) {
  let phase = 'inputs', context, controls, key, outwardFailure; const locks = new Map(), listeners = [];
  const controller = new AbortController();
  const signal = adapters.signal ? AbortSignal.any([controller.signal, adapters.signal]) : controller.signal;
  const shell = environment(adapters.shell ?? process.env);
  const exec = adapters.exec ?? ((file, argv, options) => execute(file, argv, { cwd: args.appRoot, env: shell, ...options }));
  const setPhase = name => { phase = name; };
  try {
    const fields = ['operation', 'appRoot', 'expectedSha', 'preparedReceiptSha256', 'recipientPublicKey'];
    const qualifying = args.operation === 'held-qualify-source', once = args.operation === 'run-report-once';
    const proofFields = ['qualificationFixtureSha256', 'environmentBackupProofSha256'];
    need(exact(args, once ? [...fields, ...proofFields, 'qualificationReceiptSha256'] : qualifying ? [...fields, ...proofFields] : fields)
      && ['prepare-serving', 'start-report', 'held-qualify-source', 'run-report-once'].includes(args.operation)
      && (adapters.platform ?? process.platform) === 'linux' && commit(args.expectedSha) && digest(args.preparedReceiptSha256)
      && (!(qualifying || once) || digest(args.qualificationFixtureSha256) && digest(args.environmentBackupProofSha256))
      && (!once || digest(args.qualificationReceiptSha256)));
    key = recipient(args.recipientPublicKey);
    for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const interrupt = () => controller.abort(Error('Supabase control interrupted'));
      process.on(event, interrupt); listeners.push([event, interrupt]);
    }
    context = await admittedContext(args, adapters, exec, setPhase);
    const { acquireWorkerLock } = await context.load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    const lock = async (name, file) => { await directory(path.dirname(file)); need(!locks.has(name)); locks.set(name, await acquireWorkerLock(file)); };
    const unlock = async name => { const value = locks.get(name); if (value) { await value.release(); locks.delete(name); } };
    const oldSync = await read(path.join(context.syncRoot, 'retained/original-sync.private.json'));
    need(oldSync.sha256 === context.bootstrap.expected.syncConfigSha256);
    const oldConfig = JSON.parse(oldSync.data), oldServer = path.join(context.appRoot, 'server');
    need(oldConfig.version === 1 && path.dirname(oldConfig.root) === path.join(oldServer, '.private/driver-audits')
      && digest(path.basename(oldConfig.root)));
    const oldConfigFile = await read(path.join(oldConfig.root, 'sync.json')); need(oldConfigFile.sha256 === oldSync.sha256);
    context.oldConfig = oldConfig; context.oldConfigFile = oldConfigFile;
    const originalFiles = [oldConfigFile];
    for (const file of ['.env', '.env.local']) {
      const value = await read(path.join(oldServer, file), { maximum: 256 * 1024, privateMode: false, optional: true });
      originalFiles.push(value ?? { path: path.join(oldServer, file), sha256: null });
    }
    for (const file of adapters.nginxFiles ?? ['/etc/nginx/nginx.conf', '/etc/nginx/sites-available/matter'])
      originalFiles.push(await read(file, { maximum: 256 * 1024, privateMode: false }));
    const pm2 = (argv, options) => exec('pm2', argv, { cwd: context.appRoot, env: shell, timeout: 360000, ...options });
    const rows = async () => JSON.parse((await pm2(['jlist'])).stdout);
    const initialRows = await rows(), retargetPlan = await read(path.join(context.controlRoot, 'sync-retarget-plan.private.json'), { optional: true });
    const allowMissingSync = qualifying && Boolean(retargetPlan);
    const initial = await inspectWorkers(initialRows, context, { reportMayStop: true, allowMissingSync });
    if (initial.oldSync) need(initial.sync.pm2_env.args[1] === oldConfigFile.path);
    const unchangedOthers = initialRows.filter(row => !['matter-driver-audit-sync', 'matter-driver-reports-api'].includes(row.name)).map(processIdentity);
    setPhase('locks');
    await lock('operator', path.join(oldServer, '.private/driver-report-supabase-handoff/operator.lock'));
    await lock('old-deployment', path.join(oldServer, '.private/driver-audit-source/source-deployment.lock'));
    await lock('old-source', path.join(oldServer, '.private/driver-audit-source/source-worker.lock'));
    await lock('old-sync', path.join(oldServer, '.private/driver-audits/sync-worker.lock'));
    const oldHeavy = path.join(oldServer, '.private/driver-audit-heavy-work');
    if (await fs.lstat(oldHeavy).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }))
      await lock('old-heavy', path.join(oldHeavy, 'work.lock'));
    await lock('new-deployment', path.join(context.sourceRoot, 'source-deployment.lock'));
    await lock('new-source', path.join(context.sourceRoot, 'source-worker.lock'));
    await mkdirPrivate(context.controlRoot);
    const checkWorkers = async options => {
      const observed = await rows();
      need(same(observed.filter(row => !['matter-driver-audit-sync', 'matter-driver-reports-api'].includes(row.name)).map(processIdentity), unchangedOthers));
      const value = await inspectWorkers(observed, context, { reportMayStop: true, allowMissingSync, ...options });
      need(same(processIdentity(value.main), processIdentity(initial.main)));
      if (value.oldSync) need(value.sync.pm2_env.args[1] === oldConfigFile.path);
      return value;
    };
    const sourceDeploymentFile = path.join(context.sourceRoot, 'source-deployment.lock');
    const recheck = async () => {
      signal.throwIfAborted(); await checkout(context.appRoot, args.expectedSha, exec,
        ['loadEnv.js', 'package.json', 'package-lock.json', 'services/driverAuditTransferCodec.js'],
        { preserveBaseEvent: true, preservedBaseFiles: context.preservedBaseFiles });
      await checkout(context.releaseRoot, context.p.release, exec, codeFiles);
      for (const file of context.fixedFiles) need((await read(file.path, { maximum: Math.max(file.bytes, 1),
        privateMode: !file.path.endsWith('/package-lock.json') })).sha256 === file.sha256);
      for (const file of originalFiles) need((await read(file.path, { maximum: 256 * 1024, privateMode: false, optional: true }))?.sha256 === file.sha256
        || file.sha256 === null && !await read(file.path, { maximum: 256 * 1024, privateMode: false, optional: true }));
      for (const row of context.receipt.packages) {
        const current = await packageFiles(row.root, row.manifestSha256,
          { archiveBackedManifest: true, privateDirectoryBoundary: context.syncRoot });
        need(current.inventorySha256 === row.inventorySha256 && current.missingArchiveReferencesSha256 === row.missingArchiveReferencesSha256);
      }
      need(same(await dependencyInventory(context.receipt.dependencies.path), context.receipt.dependencies.inventory));
      need((await checkedNpm(adapters)).identitySha256 === context.npm.identitySha256);
      if (!adapters.node) need((await checkedNode(adapters)).sha256 === context.node.sha256);
      const priorPhase = phase; setPhase('receipt-prefix'); await copiedArchiveReceiptPrefix(context, controls); setPhase(priorPhase);
      for (const name of ['deployment-source.private.json', 'source-state.private.json'])
        need(!await read(path.join(path.dirname(context.receipt.sourceConfig), name), { optional: true }));
      await enabledEnvironment(context); await checkWorkers();
    };
    const drain = async () => {
      await lock('new-sync-drain', path.join(path.dirname(context.syncRoot), 'sync-worker.lock'));
      try {
        const heavy = path.join(context.server, '.private/driver-audit-heavy-work'); await mkdirPrivate(heavy);
        await lock('new-heavy-drain', path.join(heavy, 'work.lock')); await unlock('new-heavy-drain');
      } finally { await unlock('new-sync-drain'); }
    };
    controls = { adapters, signal, shell, exec, rows, phase: setPhase, recheck, workers: checkWorkers,
      wait: adapters.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
      pm2, releaseSourceDeployment: () => unlock('new-deployment'),
      acquireSourceDeployment: () => lock('new-deployment', sourceDeploymentFile),
      async stopOwned(name, id) {
        const script = path.join(context.server, 'scripts', name === 'matter-driver-audit-sync' ? 'driverAuditSync.js' : 'driverAuditHttp.js');
        for (;;) {
          try {
            const matches = (await rows()).filter(row => row.name === name); need(matches.length === 1);
            const row = matches[0]; need(row.pm_id === id && row.pm2_env.pm_exec_path === script && row.pm2_env.pm_cwd === context.server
              && row.pm2_env.exec_interpreter === context.node.executable
              && same(row.pm2_env.args ?? [], name === 'matter-driver-audit-sync' ? ['--config', context.receipt.syncConfig] : []));
            if (row.pm2_env.status !== 'stopped' || row.pid !== 0) await pm2(['stop', String(id)]);
            await pm2(['save']);
            const stopped = (await rows()).find(row => row.name === name);
            if (stopped?.pm_id === id && stopped.pid === 0 && stopped.pm2_env.status === 'stopped') return;
          } catch { /* Retain exclusion until the owned process is stopped and saved. */ }
          await this.wait(250);
        }
      } };
    await drain(); setPhase('preflight-readback'); await recheck();
    let result;
    if (args.operation === 'prepare-serving') result = await prepareServing(context, controls);
    else if (args.operation === 'start-report') result = await startReport(context, controls);
    else if (qualifying) result = await qualifySource(context, controls, args);
    else result = await runReportOnce(context, controls, args);
    setPhase('final-readback'); await drain(); await recheck();
    const observed = await checkWorkers({ reportRequired: args.operation !== 'prepare-serving' });
    need(observed.sync?.pid === 0 && observed.sync.pm2_env.status === 'stopped');
    const metadata = Buffer.from(JSON.stringify({ version: 1, operation: args.operation, applicationCommit: args.expectedSha,
      releaseCommit: context.p.release, preparedReceiptSha256: context.preparedReceiptSha256,
      releaseRoot: context.releaseRoot, syncConfig: context.receipt.syncConfig, sourceConfig: context.receipt.sourceConfig,
      sourceEnvironmentSha256: context.sourceEnvironment.sha256, nodeExecutable: context.node.executable, nodeVersion: context.node.version,
      archiveReceiptPrefix: context.archiveReceiptPrefix, result,
      sourceStarted: false, syncSteadyStarted: false, routingChanged: false, sourceReleasePending: true }));
    need(metadata.length <= 96 * 1024); const packed = gzipSync(metadata);
    const { sealTransferSecrets } = await context.load('services/driverAuditTransferCodec.js');
    const capsule = sealTransferSecrets(key, { version: 1, kind: 'supabase-host-control-capsule-v1', applicationCommit: args.expectedSha,
      metadataSha256: sha(metadata), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
    return { status: result.status, operation: args.operation, applicationCommit: args.expectedSha, releaseCommit: context.p.release,
      dataStore: 'supabase', sourceStarted: false, syncSteadyStarted: false, routingChanged: false,
      sourceReleasePending: true, metadataSha256: sha(metadata), capsule };
  } catch (cause) {
    const failure = Object.assign(Error('Supabase control stopped at ' + phase), { phase });
    outwardFailure = failure;
    if (context && key) try {
      await checkout(context.releaseRoot, context.p.release, exec, ['services/driverAuditTransferCodec.js']);
      const details = { version: 1, kind: 'supabase-host-control-failure-v1',
        operation: args.operation, applicationCommit: args.expectedSha, releaseCommit: context.p.release,
        preparedReceiptSha256: context.preparedReceiptSha256, operatorPhase: phase, child: context.privateFailure ?? null,
        cause: boundedFailureCause(cause), sourceStarted: false, syncSteadyStarted: false, routingChanged: false, acceptedAsVerified: false };
      let metadata = Buffer.from(JSON.stringify(details));
      for (let shrink = 0; metadata.length > 24 * 1024 && shrink < 16; shrink++) {
        for (const name of ['stdout', 'stderr', 'stack', ...(shrink >= 8 ? ['message'] : [])]) {
          details.cause[name] = details.cause[name].slice(0, Math.floor(details.cause[name].length / 2));
          details.cause[name + 'Truncated'] = true;
        }
        metadata = Buffer.from(JSON.stringify(details));
      }
      if (metadata.length > 24 * 1024 && context.privateFailure) {
        details.child = { ...select(context.privateFailure, ['path', 'sha256', 'bytes', 'exit', 'overflow', 'forced']),
          diagnosticExcerptOmitted: true };
        metadata = Buffer.from(JSON.stringify(details));
      }
      need(metadata.length <= 24 * 1024); const packed = gzipSync(metadata);
      const { sealTransferSecrets } = await context.load('services/driverAuditTransferCodec.js');
      const capsule = sealTransferSecrets(key, { version: 1, kind: 'supabase-host-control-capsule-v1', applicationCommit: args.expectedSha,
        metadataSha256: sha(metadata), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
      Object.defineProperty(failure, 'supabaseControlStopped', { value: { status: 'supabase-control-stopped', applicationCommit: args.expectedSha,
        operatorPhase: phase, metadataSha256: sha(metadata), capsule } });
    } catch { /* A diagnostic cannot replace the original closed guard. */ }
    throw failure;
  } finally {
    let failure = false;
    for (const value of [...locks.values()].reverse()) try { await value.release(); } catch { failure = true; }
    // Keep our interruption handlers installed through the final awaited
    // release. Cancellation during sealing/cleanup cannot mint a success.
    const interrupted = signal.aborted;
    for (const [event, handler] of listeners) process.off(event, handler);
    if (failure) throw Object.assign(Error('Supabase control stopped at cleanup'), { phase: 'cleanup' });
    if (interrupted && !outwardFailure) throw Object.assign(Error('Supabase control stopped at interrupted'), { phase: 'interrupted' });
  }
}

// The release continuation reuses the exact reviewed host admissions without
// invoking a preparation, publication or process action.
export const driverAuditSupabaseControlHost = Object.freeze({ version: 1, admittedContext, copiedArchiveReceiptPrefix,
  read, fileHash, directory, inDirectory, mkdirPrivate, writeOnce, checkout, dependencyInventory, checkedNode, checkedNpm,
  selectedServing, qualificationReceipt, enabledEnvironment, environmentBackup, health, processIdentity, launch,
  codeFiles: Object.freeze([...codeFiles]) });
