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
const need = value => { if (!value) throw Error('Guard failed'); };
const applicationCommit = '701655794e1711b4d8c737e929360ecfe5d2f0ca';
const nginxHashes = Object.freeze({
  main: '4869cddce1030ceffb99bf88b1a64a0ec2b5d51c0c2377958f48533bae320522',
  site: 'ed8843629e6f3bde5231d4203be232f0835667b0fa51471e94fce8f5bc565a18',
});
const codeFiles = ['server/package.json', 'server/package-lock.json', 'server/services/driverAuditTransferCodec.js',
  'server/vendor/driver-audits/integration/hosted/worker-lock.mjs'];
const statIdentity = info => [info.dev, info.ino, info.uid, info.gid, info.mode].map(String).join(':');
const statSignature = info => [statIdentity(info), info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
const statMetadata = info => Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeNs', 'ctimeNs']
  .map(name => [name, String(info[name])]));

function recipient(value) {
  need(typeof value === 'string' && value.length <= 8192 && !value.includes('PRIVATE KEY')
    && /^-----BEGIN (?:RSA )?PUBLIC KEY-----[\s\S]+-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(value));
  const key = createPublicKey(value);
  need(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 3072);
  return key;
}

async function privateDirectory(folder) {
  const info = await fs.lstat(folder);
  need(info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077) && await fs.realpath(folder) === folder);
}

async function existingLockFiles(folder) {
  await privateDirectory(folder);
  for (const name of ['operator.lock', 'operator.lock.sqlite', 'operator.lock.sqlite-journal', 'operator.lock.sqlite-wal', 'operator.lock.sqlite-shm']) {
    const file = path.join(folder, name);
    const info = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) need(info.isFile() && info.uid === process.getuid() && !(info.mode & (name === 'operator.lock' ? 0o077 : 0o022))
      && await fs.realpath(file) === file);
  }
}

async function systemFile(file) {
  const realpath = await fs.realpath(file), before = await fs.lstat(realpath, { bigint: true });
  need(before.isFile() && before.uid === 0n && !(Number(before.mode) & 0o022) && before.size > 0n && before.size <= 65536n);
  const handle = await fs.open(realpath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    need(statSignature(await handle.stat({ bigint: true })) === statSignature(before));
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      need(bytesRead > 0); offset += bytesRead;
    }
    need((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0
      && statSignature(await handle.stat({ bigint: true })) === statSignature(before)
      && statSignature(await fs.lstat(realpath, { bigint: true })) === statSignature(before) && await fs.realpath(file) === realpath);
    return { realpath, uid: 0, mode: Number(before.mode), bytes: bytes.length, sha256: sha(bytes) };
  } finally { await handle.close(); }
}

async function workers(rows, appRoot, readSystemFile) {
  need(Array.isArray(rows) && rows.length <= 512);
  const named = name => rows.filter(row => row?.name === name);
  const api = named('matter-delivery-api'), sync = named('matter-driver-audit-sync');
  need(api.length === 1 && sync.length === 1 && named('matter-driver-audit-source').length === 0
    && named('matter-driver-reports-api').length === 0);
  const business = api[0], settings = business.pm2_env, server = path.join(appRoot, 'server');
  const npm = await readSystemFile('/usr/bin/npm');
  need(Number.isSafeInteger(business.pm_id) && business.pm_id >= 0 && Number.isSafeInteger(business.pid) && business.pid > 0
    && settings?.status === 'online' && settings.pm_cwd === appRoot
    && JSON.stringify(settings.args) === '["start","--prefix","server"]'
    && npm.uid === 0 && !(npm.mode & 0o022) && npm.bytes > 0 && npm.bytes <= 65536 && digest(npm.sha256)
    && /^\/usr\/(?:share\/nodejs|(?:local\/)?lib\/node_modules)\/npm\/bin\/npm-cli\.js$/.test(npm.realpath)
    && ['/usr/bin/npm', npm.realpath].includes(settings.pm_exec_path));
  const stopped = sync[0], env = stopped.pm2_env;
  const [flag, file, ...extra] = Array.isArray(env?.args) ? env.args : [];
  const root = typeof file === 'string' ? path.dirname(file) : '';
  need(Number.isSafeInteger(stopped.pm_id) && stopped.pm_id >= 0 && stopped.pid === 0 && env.status === 'stopped'
    && env.pm_cwd === server && env.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js')
    && !extra.length && flag === '--config' && path.dirname(root) === path.join(server, '.private/driver-audits')
    && digest(path.basename(root)) && file === path.join(root, 'sync.json'));
  const projection = row => ({ name: row.name, id: row.pm_id, pid: row.pid, status: row.pm2_env.status,
    script: row.pm2_env.pm_exec_path, cwd: row.pm2_env.pm_cwd, args: row.pm2_env.args });
  return { rows: [business, stopped].map(projection), npmIdentitySha256: sha(JSON.stringify([npm.realpath, npm.sha256])) };
}

async function nginxSnapshot({ filesystem, root, hashes, handles, setPhase }) {
  const directories = [];
  for (const folder of [root, path.join(root, 'sites-enabled'), path.join(root, 'sites-available')]) {
    setPhase('nginx-directories');
    const info = await filesystem.lstat(folder, { bigint: true });
    need(info.isDirectory() && info.uid === 0n && !(Number(info.mode) & 0o022) && await filesystem.realpath(folder) === folder);
    directories.push({ path: folder, identity: statIdentity(info) });
  }
  const files = [];
  async function openFile(file, expected) {
    const before = await filesystem.lstat(file, { bigint: true });
    need(before.isFile() && before.uid === 0n && !(Number(before.mode) & 0o022) && before.size > 0n
      && before.size <= 128n * 1024n && await filesystem.realpath(file) === file);
    const handle = await filesystem.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); handles.push(handle);
    need(statSignature(await handle.stat({ bigint: true })) === statSignature(before));
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      need(bytesRead > 0); offset += bytesRead;
    }
    need((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0 && sha(bytes) === expected);
    const check = async () => need(statSignature(await handle.stat({ bigint: true })) === statSignature(before)
      && statSignature(await filesystem.lstat(file, { bigint: true })) === statSignature(before) && await filesystem.realpath(file) === file);
    await check();
    files.push({ path: file, sha256: expected, bytes: bytes.length, contentBase64: bytes.toString('base64'), stat: statMetadata(before), check });
  }
  setPhase('nginx-main'); await openFile(path.join(root, 'nginx.conf'), hashes.main);
  setPhase('nginx-link');
  const link = path.join(root, 'sites-enabled/matter'), target = path.join(root, 'sites-available/matter');
  const linkStat = await filesystem.lstat(link, { bigint: true }), linkTarget = await filesystem.readlink(link);
  need(linkStat.isSymbolicLink() && linkStat.uid === 0n && ['../sites-available/matter', target].includes(linkTarget)
    && await filesystem.realpath(link) === target);
  const checkLink = async () => need(statSignature(await filesystem.lstat(link, { bigint: true })) === statSignature(linkStat)
    && await filesystem.readlink(link) === linkTarget && await filesystem.realpath(link) === target);
  await checkLink();
  setPhase('nginx-site'); await openFile(target, hashes.site);
  const verify = async () => {
    for (const folder of directories) {
      const current = await filesystem.lstat(folder.path, { bigint: true });
      need(current.isDirectory() && statIdentity(current) === folder.identity && await filesystem.realpath(folder.path) === folder.path);
    }
    await checkLink(); for (const file of files) await file.check();
  };
  await verify();
  return { verify, metadata: { files: files.map(({ check, ...file }) => file),
    link: { path: link, target: linkTarget, resolvedTarget: target, stat: statMetadata(linkStat) } } };
}

export async function runDriverAuditSupabaseRouting({ operation, appRoot, expectedSha, recipientPublicKey }, adapters = {}) {
  let phase = 'inputs', lock;
  const handles = [];
  const exec = adapters.exec ?? ((file, args) => execute(file, args, { cwd: appRoot, timeout: 10000, maxBuffer: 4 * 1024 ** 2 }));
  const load = adapters.load ?? (name => import(pathToFileURL(path.join(appRoot, 'server', name)).href));
  try {
    need(operation === 'inspect-supabase-routing' && expectedSha === applicationCommit
      && (adapters.platform ?? process.platform) === 'linux' && path.isAbsolute(appRoot) && await fs.realpath(appRoot) === appRoot);
    const key = recipient(recipientPublicKey), server = path.join(appRoot, 'server');
    const checkout = async () => {
      need((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim() === expectedSha);
      await exec('git', ['ls-files', '--error-unmatch', ...codeFiles]);
      await exec('git', ['diff', '--quiet', 'HEAD', '--', 'server']);
    };
    phase = 'checkout'; await checkout();
    const snapshotWorkers = async () => workers(JSON.parse((await exec('pm2', ['jlist'])).stdout), appRoot, adapters.systemFile ?? systemFile);
    phase = 'workers'; const beforeWorkers = await snapshotWorkers();
    phase = 'lock';
    const lockRoot = path.join(server, '.private/driver-report-supabase-handoff'); await existingLockFiles(lockRoot);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(lockRoot, 'operator.lock'));
    const nginx = await nginxSnapshot({ filesystem: adapters.filesystem ?? fs, root: adapters.nginxRoot ?? '/etc/nginx',
      hashes: adapters.nginxHashes ?? nginxHashes, handles, setPhase(value) { phase = value; } });
    const verify = async () => {
      await checkout(); need(JSON.stringify(await snapshotWorkers()) === JSON.stringify(beforeWorkers)); await nginx.verify();
    };
    phase = 'readback'; await verify();
    const metadata = { version: 1, kind: 'supabase-routing-inspection-v1', applicationCommit: expectedSha,
      checkedAt: new Date().toISOString(), nginx: nginx.metadata, workers: beforeWorkers };
    const bytes = Buffer.from(JSON.stringify(metadata)), compressed = gzipSync(bytes);
    need(bytes.length <= 384 * 1024 && compressed.length <= 40 * 1024);
    phase = 'seal'; const { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
    const capsule = sealTransferSecrets(key, { version: 1, kind: 'supabase-routing-inspection-capsule-v1', applicationCommit: expectedSha,
      metadataSha256: sha(bytes), metadataGzipSha256: sha(compressed), metadataGzipBase64: compressed.toString('base64') });
    phase = 'readback'; await verify();
    return { status: 'supabase-routing-inspected', operation, applicationCommit: expectedSha, metadataSha256: sha(bytes),
      recipientSha256: sha(recipientPublicKey), capsule, readOnly: true, routingChanged: false,
      workersStarted: false, applicationDatabaseConnections: 0, networkRequests: 0 };
  } catch { throw Object.assign(Error('Supabase routing inspection stopped at ' + phase), { phase }); }
  finally {
    let failed = false;
    for (const handle of handles.reverse()) try { await handle.close(); } catch { failed = true; }
    try { await lock?.release(); } catch { failed = true; }
    if (failed) throw Object.assign(Error('Supabase routing inspection stopped at cleanup'), { phase: 'cleanup' });
  }
}

const storageRelease = '4a00becfe4954b8139df6ac3c6058c2a592484d2';
const storageSync = 'f5a09e956d0c0cba5e8cca8b71190efe755c2bf4f679a1b9e9f692b6cbab56c4';
const storageSignature = info => statSignature(info) + ':' + String(info.nlink) + ':' + String(info.blocks);
const storageMetadata = info => ({ ...statMetadata(info), nlink: String(info.nlink), blocks: String(info.blocks) });

async function storageBoundary(filesystem, home, folder) {
  const relative = path.relative(home, folder);
  need(relative && !relative.startsWith('..') && !path.isAbsolute(relative) || folder === home);
  const ancestors = [], parts = relative ? relative.split(path.sep) : [];
  let current = home, leaf;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    let info;
    try { info = await filesystem.lstat(current, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return { status: 'missing', path: folder }; throw error; }
    if (!info.isDirectory() || info.uid !== BigInt(process.getuid()) || Number(info.mode) & 0o002)
      return { status: 'unsafe-root', path: folder, unsafeAt: current, stat: storageMetadata(info) };
    need(await filesystem.realpath(current) === current);
    leaf = info;
    ancestors.push({ path: current, identity: statIdentity(info) });
  }
  const verify = async () => {
    for (const row of ancestors) {
      const info = await filesystem.lstat(row.path, { bigint: true });
      need(info.isDirectory() && statIdentity(info) === row.identity && await filesystem.realpath(row.path) === row.path);
    }
  };
  await verify(); return { status: 'present', path: folder, stat: storageMetadata(leaf), verify };
}

async function storageCacheInventory(filesystem, home, definition) {
  const boundary = await storageBoundary(filesystem, home, definition.path);
  const basic = { ...definition, fileContentsRead: 0, deletionAuthorized: false, reclaimableBytesProven: false };
  if (boundary.status !== 'present') return { ...basic, ...boundary, complete: boundary.status === 'missing',
    eligibleForSeparateCleanupReview: false, inventorySha256: sha(JSON.stringify(boundary)) };
  const digest = createHash('sha256'), inodes = new Set(), top = [];
  let entries = 0, files = 0, directories = 0, symlinks = 0, otherEntries = 0, foreignEntries = 0,
    hardLinkedFiles = 0, unsafeEntries = 0, logicalBytes = 0n, allocatedBytes = 0n, complete = true, reason = null;
  const bounded = value => { complete = false; reason ??= value; };
  const record = (relative, type, info) => {
    digest.update(JSON.stringify({ relative, type, ...storageMetadata(info) }) + '\n'); entries++;
    if (info.uid !== BigInt(process.getuid())) foreignEntries++;
    if (info.uid !== BigInt(process.getuid()) || Number(info.mode) & 0o6022) unsafeEntries++;
  };
  const visit = async (folder, relative, depth, expected, anchoredFile = folder) => {
    if (depth > 20 || entries >= 250000) { bounded(depth > 20 ? 'depth-limit' : 'entry-limit'); return; }
    const before = await filesystem.lstat(anchoredFile, { bigint: true });
    need(before.isDirectory() && !before.isSymbolicLink() && await filesystem.realpath(folder) === folder);
    if (expected) need(storageSignature(before) === storageSignature(expected));
    record(relative, 'directory', before); directories++;
    if (before.uid !== BigInt(process.getuid()) || Number(before.mode) & 0o002) { bounded('unsafe-directory'); return; }
    const fd = await filesystem.open(anchoredFile, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const check = async () => need(storageSignature(await fd.stat({ bigint: true })) === storageSignature(before)
      && storageSignature(await filesystem.lstat(folder, { bigint: true })) === storageSignature(before)
      && await filesystem.realpath(folder) === folder);
    try {
      await check(); const anchored = process.platform === 'linux' ? '/proc/self/fd/' + fd.fd : folder;
      const names = [], stream = await filesystem.opendir(anchored);
      try {
        for await (const entry of stream) {
          need(entry.name && entry.name !== '.' && entry.name !== '..' && !/[\/\\\0]/.test(entry.name));
          if (names.length >= 32768) { bounded('directory-entry-limit'); break; }
          names.push(entry.name);
        }
      } finally { await stream.close().catch(error => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
      await check();
      for (const name of names.sort()) {
        if (entries >= 250000) { bounded('entry-limit'); break; }
        const child = path.join(folder, name), childRelative = relative ? relative + '/' + name : name;
        if (childRelative.length > 1024) { bounded('path-length-limit'); break; }
        const anchoredChild = path.join(anchored, name), info = await filesystem.lstat(anchoredChild, { bigint: true });
        if (info.isDirectory()) await visit(child, childRelative, depth + 1, info, anchoredChild);
        else {
          const type = info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other'; record(childRelative, type, info);
          if (info.isFile()) {
            need(info.size >= 0n && info.blocks >= 0n); files++; logicalBytes += info.size;
            if (info.nlink > 1n) hardLinkedFiles++;
            const inode = String(info.dev) + ':' + String(info.ino);
            if (!inodes.has(inode)) { inodes.add(inode); allocatedBytes += info.blocks * 512n; }
            top.push({ relative: childRelative, bytes: String(info.size), allocatedBytes: String(info.blocks * 512n),
              uid: String(info.uid), mode: String(info.mode), nlink: String(info.nlink) });
            top.sort((a, b) => BigInt(a.bytes) === BigInt(b.bytes) ? a.relative < b.relative ? -1 : 1 : BigInt(a.bytes) > BigInt(b.bytes) ? -1 : 1);
            if (top.length > 16) top.pop();
          } else if (info.isSymbolicLink()) symlinks++; else otherEntries++;
          need(storageSignature(await filesystem.lstat(anchoredChild, { bigint: true })) === storageSignature(info));
        }
        await check();
      }
      await check();
    } finally { await fd.close(); }
  };
  await boundary.verify(); await visit(definition.path, '', 0); await boundary.verify();
  return { ...basic, status: complete ? 'inventoried' : 'bounded-incomplete', complete, reason, entries, files, directories,
    symlinks, otherEntries, foreignEntries, hardLinkedFiles, unsafeEntries, logicalBytes: String(logicalBytes),
    uniqueAllocatedBlockBytes: String(allocatedBytes), allocatedBlockBytesAreNotGuaranteedReclaimable: true,
    eligibleForSeparateCleanupReview: complete && !symlinks && !otherEntries && !unsafeEntries && !hardLinkedFiles,
    inventorySha256: digest.digest('hex'), topFiles: top, omittedEntriesUnknown: !complete };
}

async function storageDisk(filesystem, home, folder) {
  const boundary = await storageBoundary(filesystem, home, folder); need(boundary.status === 'present');
  await boundary.verify(); const info = await filesystem.statfs(folder, { bigint: true }); await boundary.verify();
  need(info.bsize > 0n && info.blocks >= 0n && info.bfree >= 0n && info.bavail >= 0n && info.bavail <= info.bfree);
  return { filesystemType: String(info.type), blockSize: String(info.bsize), blocks: String(info.blocks),
    freeBytes: String(info.bfree * info.bsize), availableBytes: String(info.bavail * info.bsize),
    files: String(info.files), freeInodes: String(info.ffree), oneGiBReserveBytes: String(1024 ** 3),
    meetsOneGiBReserveOnly: info.bavail * info.bsize >= 1024n ** 3n,
    seedAdditionalBytesNotIncluded: true };
}

// This separate operation accepts no cache path and reads no cache/file bodies.
// Its metadata is an inspection, never authorization to discard any cache.
export async function runDriverAuditSupabaseStorageInspection(args, adapters = {}) {
  let phase = 'inputs', lock;
  const exec = adapters.exec ?? ((file, argv) => execute(file, argv,
    { cwd: args.appRoot, timeout: 10000, maxBuffer: 4 * 1024 ** 2 }));
  const load = adapters.load ?? (name => import(pathToFileURL(path.join(args.appRoot, 'server', name)).href));
  try {
    need(args && Object.keys(args).sort().join(',') === 'appRoot,expectedSha,operation,recipientPublicKey'
      && args.operation === 'inspect-supabase-storage' && args.expectedSha === applicationCommit
      && (adapters.platform ?? process.platform) === 'linux');
    const home = adapters.storageHomeRoot ?? '/home/matter';
    need(path.isAbsolute(home) && path.resolve(home) === home && args.appRoot === path.join(home, 'matter-delivery-tracker')
      && await fs.realpath(args.appRoot) === args.appRoot);
    const key = recipient(args.recipientPublicKey), filesystem = adapters.storageFilesystem ?? fs;
    const server = path.join(args.appRoot, 'server'), releaseServer = path.join(server, '.private/driver-report-app-releases', storageRelease, 'server');
    const sync = path.join(releaseServer, '.private/driver-audits', storageSync);
    const checkout = async () => {
      need((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim() === args.expectedSha);
      await exec('git', ['ls-files', '--error-unmatch', ...codeFiles]);
      await exec('git', ['diff', '--quiet', 'HEAD', '--', 'server']);
    };
    phase = 'checkout'; await checkout();
    const inspectWorkers = async () => workers(JSON.parse((await exec('pm2', ['jlist'])).stdout), args.appRoot, adapters.systemFile ?? systemFile);
    phase = 'workers'; const beforeWorkers = await inspectWorkers();
    phase = 'lock'; const lockRoot = path.join(server, '.private/driver-report-supabase-handoff'); await existingLockFiles(lockRoot);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(lockRoot, 'operator.lock'));
    const definitions = [
      { id: 'home-npm-cache', path: path.join(home, '.npm'), classification: 'package-manager-download-cache' },
      { id: 'base-npm-cache', path: path.join(server, '.private/dependencies/cache'), classification: 'package-manager-download-cache' },
      { id: 'staged-npm-cache', path: path.join(releaseServer, '.private/dependencies/cache'), classification: 'package-manager-download-cache' },
    ];
    phase = 'disk'; const disks = [];
    for (const [id, folder] of [['business-app-volume', server], ['isolated-report-volume', releaseServer]])
      disks.push({ id, path: folder, before: await storageDisk(filesystem, home, folder) });
    phase = 'cache-metadata'; const caches = [];
    for (const row of definitions) caches.push(await storageCacheInventory(filesystem, home, row));
    const protectedDefinitions = [
      ['original-uploads', path.join(server, 'uploads')], ['original-report-trees', path.join(server, '.private/driver-audits')],
      ['original-source', path.join(server, '.private/driver-audit-source')],
      ['original-transfer-inputs', path.join(server, '.private/driver-audit-native-transfer')],
      ['staged-retained-reports', path.join(sync, 'retained')], ['staged-report-work-and-archive-cache', path.join(sync, 'work')],
      ['installed-report-dependencies', path.join(releaseServer, 'node_modules')],
    ];
    const protectedRoots = [];
    for (const [id, folder] of protectedDefinitions) {
      const boundary = await storageBoundary(filesystem, home, folder);
      protectedRoots.push({ id, path: folder, status: boundary.status, scan: 'identity-only-protected', deletionAuthorized: false,
        ...(boundary.stat ? { stat: boundary.stat } : {}) });
    }
    const verify = async () => {
      await checkout(); need(JSON.stringify(await inspectWorkers()) === JSON.stringify(beforeWorkers));
      for (let index = 0; index < definitions.length; index++)
        need(JSON.stringify(await storageCacheInventory(filesystem, home, definitions[index])) === JSON.stringify(caches[index]));
    };
    phase = 'readback'; await verify();
    for (const row of disks) row.after = await storageDisk(filesystem, home, row.path);
    const metadata = { version: 1, kind: 'supabase-storage-inspection-v1', applicationCommit: args.expectedSha,
      checkedAt: new Date().toISOString(), releaseCommit: storageRelease, disks, caches, protectedRoots, workers: beforeWorkers,
      fileContentsRead: 0, deletionAuthorized: false, reclaimableBytesProven: false,
      originalTransferInputsProtected: true, transferSessionRootClassification: 'original controls and inputs; not a disposable download cache',
      oneGiBSeedReserveUnchanged: true, seedReadyClaimed: false };
    const bytes = Buffer.from(JSON.stringify(metadata)), packed = gzipSync(bytes);
    need(bytes.length <= 384 * 1024 && packed.length <= 40 * 1024);
    phase = 'seal'; const { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
    const capsule = sealTransferSecrets(key, { version: 1, kind: 'supabase-storage-inspection-capsule-v1', applicationCommit: args.expectedSha,
      metadataSha256: sha(bytes), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
    phase = 'readback'; await verify();
    return { status: 'supabase-storage-inspected', operation: args.operation, applicationCommit: args.expectedSha,
      metadataSha256: sha(bytes), recipientSha256: sha(args.recipientPublicKey), capsule,
      readOnly: true, deletedFiles: 0, workersStarted: false, routingChanged: false, applicationDatabaseConnections: 0, networkRequests: 0 };
  } catch { throw Object.assign(Error('Supabase storage inspection stopped at ' + phase), { phase }); }
  finally { try { await lock?.release(); } catch { throw Object.assign(Error('Supabase storage inspection stopped at cleanup'), { phase: 'cleanup' }); } }
}

async function fixedDuExecutable() {
  const file = '/usr/bin/du', before = await fs.lstat(file, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.uid === 0n && !(Number(before.mode) & 0o6022)
    && Number(before.mode) & 0o111 && before.size > 0n && before.size <= 1024n ** 2n && await fs.realpath(file) === file);
  const verify = async () => need(storageSignature(await fs.lstat(file, { bigint: true })) === storageSignature(before)
    && await fs.realpath(file) === file);
  await verify(); return { metadata: { path: file, realpath: file, stat: storageMetadata(before) }, verify };
}

function duRows(bytes, folder, maximumBytes, maximumRows) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximumBytes && bytes.at(-1) === 0
    && Buffer.from(bytes.toString('utf8')).equals(bytes));
  const rows = bytes.toString('utf8').slice(0, -1).split('\0'); need(rows.length <= maximumRows);
  const seen = new Set();
  return rows.map(row => {
    const tab = row.indexOf('\t'), size = row.slice(0, tab), file = row.slice(tab + 1);
    need(tab > 0 && /^(?:0|[1-9][0-9]{0,31})$/.test(size) && file.length <= 4096 && path.isAbsolute(file)
      && path.normalize(file) === file && (file === folder || file.startsWith(folder + '/')) && !seen.has(file));
    const relative = path.relative(folder, file); need(!relative || relative.split('/').length <= 3);
    seen.add(file); return { path: file, bytes: size };
  });
}

function duErrorText(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : '');
  let text = bytes.subarray(0, 2048).toString('utf8');
  while (Buffer.byteLength(text) > 2048) text = text.slice(0, -1);
  return { text, bytes: bytes.length, truncated: bytes.length > Buffer.byteLength(text) };
}

// Usage attribution is deliberately separate from the fixed cache inventory.
// du observes changing filesystem metadata; it does not prove reclaimability.
export async function runDriverAuditSupabaseDiskUsage(args, adapters = {}) {
  let phase = 'inputs', lock; const handles = [], rootGuards = [];
  const exec = adapters.exec ?? ((file, argv, options = {}) => execute(file, argv,
    { cwd: args.appRoot, timeout: 10000, maxBuffer: 4 * 1024 ** 2, ...options }));
  const load = adapters.load ?? (name => import(pathToFileURL(path.join(args.appRoot, 'server', name)).href));
  try {
    need(args && Object.keys(args).sort().join(',') === 'appRoot,expectedSha,operation,recipientPublicKey'
      && args.operation === 'inspect-supabase-disk-usage' && args.expectedSha === applicationCommit
      && (adapters.platform ?? process.platform) === 'linux');
    const home = adapters.storageHomeRoot ?? '/home/matter';
    need(path.isAbsolute(home) && path.resolve(home) === home && args.appRoot === path.join(home, 'matter-delivery-tracker')
      && await fs.realpath(args.appRoot) === args.appRoot);
    const key = recipient(args.recipientPublicKey), filesystem = adapters.storageFilesystem ?? fs, server = path.join(args.appRoot, 'server');
    const checkout = async () => {
      need((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim() === args.expectedSha);
      await exec('git', ['ls-files', '--error-unmatch', ...codeFiles]);
      await exec('git', ['diff', '--quiet', 'HEAD', '--', 'server']);
    };
    phase = 'checkout'; await checkout();
    const inspectWorkers = async () => workers(JSON.parse((await exec('pm2', ['jlist'])).stdout), args.appRoot, adapters.systemFile ?? systemFile);
    phase = 'workers'; const beforeWorkers = await inspectWorkers();
    phase = 'lock'; const lockRoot = path.join(server, '.private/driver-report-supabase-handoff'); await existingLockFiles(lockRoot);
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    lock = await acquireWorkerLock(path.join(lockRoot, 'operator.lock'));
    phase = 'executable'; const executable = await fixedDuExecutable();
    const definitions = [
      { id: 'pm2-logs', path: path.join(home, '.pm2/logs'), classification: 'active-process-logs-protected' },
      { id: 'client-build-cache', path: path.join(args.appRoot, 'client/node_modules/.cache'), classification: 'generated-build-cache-review-only' },
      { id: 'client-build', path: path.join(args.appRoot, 'client/build'), classification: 'current-client-build-protected' },
      { id: 'reporting-private', path: path.join(server, '.private'), classification: 'original-report-source-review-history-controls-protected' },
      { id: 'original-uploads', path: path.join(server, 'uploads'), classification: 'original-uploads-protected' },
      { id: 'home-cache', path: path.join(home, '.cache'), classification: 'unclassified-cache-review-only' },
      { id: 'original-report-attempts', path: path.join(server, '.private/driver-audits/a9d21452a101850150b84fa4b5a15ea165490e2fc7bcb9a56482269c00897d61/work/attempts'),
        classification: 'original-derived-workspaces-protected' },
    ];
    const startedAt = new Date().toISOString(), diskBefore = await storageDisk(filesystem, home, server), observations = [];
    for (const definition of definitions) {
      phase = 'roots'; const boundary = await storageBoundary(filesystem, home, definition.path);
      const maximumBytes = (definition.id === 'original-report-attempts' ? 2 * 1024 : 512) * 1024;
      const maximumRows = definition.id === 'original-report-attempts' ? 16384 : 4096;
      const basic = { ...definition, rootBytes: null, complete: false, deletionAuthorized: false,
        reclaimableBytesProven: false, fileContentsRead: 0, stdoutMaximumBytes: maximumBytes, maximumRows };
      if (boundary.status !== 'present') {
        observations.push({ ...basic, status: boundary.status, recordsObserved: null, entries: [], entriesOmitted: false,
          ...(boundary.stat ? { stat: boundary.stat, unsafeAt: boundary.unsafeAt } : {}) }); continue;
      }
      const before = await filesystem.lstat(definition.path, { bigint: true });
      const fd = await filesystem.open(definition.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(fd);
      const check = async () => {
        await boundary.verify();
        need(statIdentity(await fd.stat({ bigint: true })) === statIdentity(before)
          && statIdentity(await filesystem.lstat(definition.path, { bigint: true })) === statIdentity(before)
          && await filesystem.realpath(definition.path) === definition.path);
      };
      rootGuards.push(check); await check(); await executable.verify();
      const commandStartedAt = new Date().toISOString(); let result, failure;
      phase = 'du';
      try {
        result = await exec('/usr/bin/du', ['--one-file-system', '--block-size=1', '--max-depth=3', '--null', '--', definition.path],
          { encoding: 'buffer', timeout: 60000, maxBuffer: maximumBytes,
            env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
      } catch (error) { failure = error; result = error; }
      const commandCompletedAt = new Date().toISOString(); await check(); await executable.verify();
      const stdout = Buffer.isBuffer(result?.stdout) ? result.stdout : Buffer.from(typeof result?.stdout === 'string' ? result.stdout : '');
      let rows = [], valid = false;
      try { rows = duRows(stdout, definition.path, maximumBytes, maximumRows); valid = true; } catch { /* An incomplete or invalid stream is never a complete usage claim. */ }
      const rootBytes = rows.find(row => row.path === definition.path)?.bytes ?? null;
      const complete = !failure && valid && rootBytes !== null;
      const selected = [...rows].sort((a, b) => BigInt(a.bytes) === BigInt(b.bytes) ? a.path < b.path ? -1 : 1 : BigInt(a.bytes) > BigInt(b.bytes) ? -1 : 1).slice(0, 32);
      observations.push({ ...basic, status: complete ? 'measured' : !valid && stdout.length ? 'invalid-output' : failure ? 'partial' : 'invalid-output',
        rootBytes: valid ? rootBytes : null, complete, recordsObserved: valid ? rows.length : null, entries: selected,
        entriesOmitted: valid && rows.length > selected.length, rowsSha256: valid ? sha(JSON.stringify(rows)) : null,
        stdoutSha256: sha(stdout), stdoutBytes: stdout.length, commandStartedAt, commandCompletedAt,
        rootBefore: storageMetadata(before), rootAfter: storageMetadata(await filesystem.lstat(definition.path, { bigint: true })),
        diagnostic: duErrorText(result?.stderr), exitCode: failure && Number.isSafeInteger(failure.code) ? failure.code : failure ? null : 0,
        signal: typeof failure?.signal === 'string' && /^[A-Z0-9]{1,32}$/.test(failure.signal) ? failure.signal : null,
        commandErrorCode: typeof failure?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(failure.code) ? failure.code : null });
    }
    const verify = async () => {
      await checkout(); need(JSON.stringify(await inspectWorkers()) === JSON.stringify(beforeWorkers));
      await executable.verify(); for (const check of rootGuards) await check();
    };
    phase = 'readback'; await verify();
    const metadata = { version: 1, kind: 'supabase-disk-usage-inspection-v1', applicationCommit: args.expectedSha,
      startedAt, completedAt: new Date().toISOString(), duExecutable: executable.metadata,
      commandFlags: ['--one-file-system', '--block-size=1', '--max-depth=3', '--null', '--'],
      observations, workers: beforeWorkers, disk: { before: diskBefore, after: await storageDisk(filesystem, home, server) },
      fileContentsRead: 0, deletionAuthorized: false, reclaimableBytesProven: false, oneGiBSeedReserveUnchanged: true,
      usageSnapshotAtomic: false, hardlinkAndOverlappingRootAttributionMayDiffer: true,
      scope: 'Fixed filesystem usage observations only; not source parity, cleanup authorization or seed readiness' };
    let bytes, packed;
    for (let shrink = 0; shrink < 7; shrink++) {
      bytes = Buffer.from(JSON.stringify(metadata)); packed = gzipSync(bytes);
      if (bytes.length <= 384 * 1024 && packed.length <= 40 * 1024) break;
      for (const row of observations) if (row.entries.length) {
        row.entries = row.entries.slice(0, Math.floor(row.entries.length / 2)); row.entriesOmitted = true;
      }
    }
    need(bytes.length <= 384 * 1024 && packed.length <= 40 * 1024);
    phase = 'seal'; const { sealTransferSecrets } = await load('services/driverAuditTransferCodec.js');
    const capsule = sealTransferSecrets(key, { version: 1, kind: 'supabase-disk-usage-inspection-capsule-v1', applicationCommit: args.expectedSha,
      metadataSha256: sha(bytes), metadataGzipSha256: sha(packed), metadataGzipBase64: packed.toString('base64') });
    phase = 'readback'; await verify();
    return { status: 'supabase-disk-usage-inspected', operation: args.operation, applicationCommit: args.expectedSha,
      metadataSha256: sha(bytes), recipientSha256: sha(args.recipientPublicKey), capsule,
      readOnly: true, deletedFiles: 0, workersStarted: false, routingChanged: false, applicationDatabaseConnections: 0, networkRequests: 0 };
  } catch { throw Object.assign(Error('Supabase disk usage inspection stopped at ' + phase), { phase }); }
  finally {
    let failure = false;
    for (const handle of handles.reverse()) try { await handle.close(); } catch { failure = true; }
    try { await lock?.release(); } catch { failure = true; }
    if (failure) throw Object.assign(Error('Supabase disk usage inspection stopped at cleanup'), { phase: 'cleanup' });
  }
}
