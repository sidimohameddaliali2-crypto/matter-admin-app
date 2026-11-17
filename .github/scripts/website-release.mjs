import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const marker = 'website-release.json';
const idPattern = /^(?:[a-f0-9]{40}-\d+-\d+|bootstrap-\d+)$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const info = file => fs.lstat(file).catch(missing);
const safeRelative = name => typeof name === 'string' && name.length > 0 && !name.includes('\\')
  && !name.includes(':') && name.split('/').every(part => part && part !== '.' && part !== '..');

async function filesIn(root, relative = '') {
  const results = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (!safeRelative(name)) throw Error('Unsafe website asset path.');
    if (entry.isDirectory()) results.push(...await filesIn(root, name));
    else if (entry.isFile()) results.push(name);
    else throw Error('Website assets must not contain links or special files.');
  }
  return results.sort();
}

async function checkBuild(source, releaseId, legacy) {
  if (!idPattern.test(releaseId)) throw Error('Invalid website release identity.');
  if (!(await info(source))?.isDirectory() || (await info(source)).isSymbolicLink()) throw Error('Website source must be a real directory.');
  const assets = JSON.parse(await fs.readFile(path.join(source, 'asset-manifest.json'), 'utf8')).files;
  const prefix = legacy ? '/' : `/website-releases/${releaseId}/`;
  if (typeof assets?.['main.js'] !== 'string') throw Error('Completed website main.js is required.');
  const html = await fs.readFile(path.join(source, 'index.html'), 'utf8');
  if (!html.includes(assets['main.js'])) throw Error('Website HTML does not reference its main bundle.');
  for (const asset of Object.values(assets)) {
    if (typeof asset !== 'string' || !asset.startsWith(prefix)) throw Error('Website assets must use the release URL prefix.');
    const relative = asset.slice(prefix.length);
    if (!safeRelative(relative)) throw Error('Unsafe asset manifest path.');
    const assetInfo = await info(path.join(source, relative));
    if (!assetInfo?.isFile() || assetInfo.isSymbolicLink() || assetInfo.size === 0) throw Error('Website asset is unavailable.');
  }
}

export async function sealWebsite(source, releaseId, { legacy = false } = {}) {
  await checkBuild(source, releaseId, legacy);
  if (await info(path.join(source, marker))) throw Error('Website build is already sealed.');
  const names = await filesIn(source);
  const files = {};
  for (const name of names) files[name] = hash(await fs.readFile(path.join(source, name)));
  const manifest = { version: 1, releaseId, legacy, files };
  await fs.writeFile(path.join(source, marker), JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o644 });
  return manifest;
}

export async function verifyWebsite(source, releaseId) {
  const manifest = JSON.parse(await fs.readFile(path.join(source, marker), 'utf8'));
  if (manifest.version !== 1 || manifest.releaseId !== releaseId || !idPattern.test(releaseId)
    || !manifest.files || Array.isArray(manifest.files) || typeof manifest.legacy !== 'boolean'
    || manifest.legacy !== releaseId.startsWith('bootstrap-')) throw Error('Website identity mismatch.');
  await checkBuild(source, releaseId, manifest.legacy);
  const names = (await filesIn(source)).filter(name => name !== marker);
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(manifest.files).sort())) throw Error('Website file set changed.');
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(manifest.files[name]) || hash(await fs.readFile(path.join(source, name))) !== manifest.files[name]) {
      throw Error('Website asset integrity check failed.');
    }
  }
  return manifest;
}

async function managedDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Website deployment directories must not be symlinks.');
}

async function withStore(appRoot, action) {
  if (process.platform === 'win32') throw Error('Website publication requires the Linux deployment host.');
  const root = path.join(await fs.realpath(appRoot), '.website');
  await managedDirectory(root);
  await managedDirectory(path.join(root, 'releases'));
  const lock = path.join(root, 'publish.lock');
  await fs.mkdir(lock);
  try { return await action(root); }
  finally { await fs.rmdir(lock); }
}

async function currentId(root, name = 'current') {
  const link = path.join(root, name);
  const stat = await info(link);
  if (!stat) return null;
  if (!stat.isSymbolicLink()) throw Error('Website pointer must be a symlink.');
  const target = await fs.readlink(link);
  const id = target.slice('releases/'.length);
  if (!target.startsWith('releases/') || !idPattern.test(id)) throw Error('Unsafe website pointer.');
  return id;
}

async function point(root, name, releaseId) {
  await currentId(root, name);
  const temporary = path.join(root, `.${name}-${randomUUID()}`);
  await fs.symlink(`releases/${releaseId}`, temporary);
  try { await fs.rename(temporary, path.join(root, name)); }
  finally { await fs.unlink(temporary).catch(missing); }
}

async function storeBuild(root, source, releaseId) {
  await verifyWebsite(source, releaseId);
  const destination = path.join(root, 'releases', releaseId);
  if (await info(destination)) {
    await verifyWebsite(destination, releaseId);
    if (await fs.readFile(path.join(destination, marker), 'utf8') !== await fs.readFile(path.join(source, marker), 'utf8')) {
      throw Error('An immutable website release already exists with different bytes.');
    }
    return destination;
  }
  const pending = path.join(root, `.pending-${randomUUID()}`);
  try {
    await fs.cp(source, pending, { recursive: true, errorOnExist: true, force: false });
    await verifyWebsite(pending, releaseId);
    const directoryModes = async dir => {
      await fs.chmod(dir, 0o755);
      for (const child of await fs.readdir(dir, { withFileTypes: true })) {
        if (child.isDirectory()) await directoryModes(path.join(dir, child.name));
      }
    };
    await directoryModes(pending);
    for (const name of await filesIn(pending)) await fs.chmod(path.join(pending, name), 0o644);
    await fs.chmod(pending, 0o755);
    await fs.rename(pending, destination);
  } finally { await fs.rm(pending, { recursive: true, force: true }); }
  return destination;
}

export async function checkPublicWebsite(source, origin, { fetchImpl = fetch } = {}) {
  const local = JSON.parse(await fs.readFile(path.join(source, marker), 'utf8'));
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('An HTTPS website origin is required.');
  const response = await fetchImpl(`${url.origin}/${marker}?release=${local.releaseId}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok || (await response.json()).releaseId !== local.releaseId) throw Error('Nginx is not serving the selected website release.');
  const assets = JSON.parse(await fs.readFile(path.join(source, 'asset-manifest.json'), 'utf8')).files;
  const bundle = await fetchImpl(url.origin + assets['main.js'], { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
  const relative = assets['main.js'].slice((local.legacy ? '/' : `/website-releases/${local.releaseId}/`).length);
  if (!bundle.ok || hash(Buffer.from(await bundle.arrayBuffer())) !== local.files[relative]) throw Error('Nginx release asset routing failed.');
}

export async function publishWebsite(appRoot, source, releaseId, { checkPublic } = {}) {
  return withStore(appRoot, async root => {
    const previous = await currentId(root);
    if (!previous) throw Error('Bootstrap the website before publishing.');
    const destination = await storeBuild(root, source, releaseId);
    await point(root, 'current', releaseId);
    try {
      if (checkPublic) await checkPublic(destination);
      if (previous !== releaseId) await point(root, 'previous', previous);
    }
    catch (error) { await point(root, 'current', previous); throw error; }
    return { releaseId, previous };
  });
}

export async function bootstrapWebsite(appRoot) {
  return withStore(appRoot, async root => {
    if (await currentId(root)) throw Error('Website is already bootstrapped.');
    const source = path.join(path.resolve(appRoot), 'client', 'build');
    const id = `bootstrap-${Date.now()}`;
    const pending = path.join(root, `.bootstrap-${randomUUID()}`);
    try {
      await fs.cp(source, pending, { recursive: true, dereference: false });
      await sealWebsite(pending, id, { legacy: true });
      await storeBuild(root, pending, id);
      if (await info(path.join(root, 'legacy-static'))) throw Error('Legacy static asset pointer already exists.');
      await fs.symlink(`releases/${id}/static`, path.join(root, 'legacy-static'));
      await point(root, 'current', id);
      return { releaseId: id, nginxRoot: path.join(root, 'current') };
    } finally { await fs.rm(pending, { recursive: true, force: true }); }
  });
}

export async function rollbackWebsite(appRoot) {
  return withStore(appRoot, async root => {
    const id = await currentId(root, 'previous');
    if (!id) throw Error('No previous website release is available.');
    await verifyWebsite(path.join(root, 'releases', id), id);
    await point(root, 'current', id);
    return { releaseId: id };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    let result;
    if (command === 'seal' && args.length === 2) result = await sealWebsite(...args);
    else if (command === 'verify' && args.length === 2) result = await verifyWebsite(...args);
    else if (command === 'bootstrap' && args.length === 1) result = await bootstrapWebsite(args[0]);
    else if (command === 'publish' && args.length === 4) result = await publishWebsite(args[0], args[1], args[2], { checkPublic: source => checkPublicWebsite(source, args[3]) });
    else if (command === 'check' && args.length === 2) {
      const source = await fs.realpath(args[0]);
      await verifyWebsite(source, JSON.parse(await fs.readFile(path.join(source, marker), 'utf8')).releaseId);
      await checkPublicWebsite(source, args[1]);
      result = { healthy: true };
    }
    else if (command === 'rollback' && args.length === 1) result = await rollbackWebsite(args[0]);
    else throw Error('Use seal SOURCE ID, bootstrap APP_ROOT, check CURRENT ORIGIN, publish APP_ROOT SOURCE ID ORIGIN, or rollback APP_ROOT.');
    console.log(JSON.stringify({ ...result, files: undefined }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
