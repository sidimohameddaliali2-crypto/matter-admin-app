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
