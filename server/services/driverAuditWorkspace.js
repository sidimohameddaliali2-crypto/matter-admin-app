import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createGzip,createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {readDriverAuditSeedConfig} from './driverAuditDirectImport.js';
import {privateAuditJson,privateAuditWrite} from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';

const digest = /^[a-f0-9]{64}$/;
const attemptName = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

// The saved-data replay used 1.32 GB of working space. Retain additional room
// for a larger capture while allowing the active and previous builds to coexist.
const minimumBuildBytes = 2560 * 1024 * 1024;

export function requireDriverAuditBuildSpace(availableBytes) {
  if (!Number.isSafeInteger(availableBytes) || availableBytes < minimumBuildBytes) {
    throw Object.assign(Error('Audit disk reserve unavailable'), {code:'AUDIT_CAPACITY'});
  }
}

async function optionalJson(file) {
  return privateAuditJson(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

// Called only by the single sync writer between builds. Original staging data,
// the current/previous candidates and all MongoDB-protected generations stay.
export async function pruneDriverAuditWorkspace({root, receiptRoot, protectedManifests = [], maxCacheBytes = 512 * 1024 * 1024}) {
  if (!path.isAbsolute(root) || !Array.isArray(protectedManifests) || protectedManifests.some(value => !digest.test(value))
    || !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0) {
    throw Error('Invalid audit workspace retention bounds');
  }
  const pointer = await optionalJson(path.join(root, 'current.private.json'));
  const keepRoots = new Set([pointer?.privateRoot, pointer?.previous?.privateRoot, pointer?.baselineRoot].filter(Boolean).map(value => path.dirname(value)));
  const keepManifests = new Set(protectedManifests.filter(value => digest.test(value)));
  const attempts = path.join(root, 'attempts');
  for (const directory of [root, attempts, path.join(root, 'archive-cache')]) {
    const stat = await fs.lstat(directory).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && !stat.isDirectory()) throw Error('Audit workspace directory must be a real directory');
  }
  let attemptsCompacted = 0;
  for (const entry of await fs.readdir(attempts, {withFileTypes: true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!entry.isDirectory() || !attemptName.test(entry.name)) continue;
    const directory = path.join(attempts, entry.name);
    if (keepRoots.has(directory)) continue;
    const accepted = await optionalJson(path.join(directory, 'accepted.private.json'));
    const seed = await readDriverAuditSeedConfig(path.join(directory, 'direct-seed.private.json')).catch(() => null);
    if (!accepted || !seed || keepManifests.has(accepted.manifestSha256)) continue;
    if (accepted.privateRoot !== path.join(directory, 'server-data') || seed.manifestSha256 !== accepted.manifestSha256
      || accepted.sourceBasis !== seed.sourceBasis || accepted.collectorRevision !== seed.collectorRevision) continue;
    const journalPath=path.join(directory,'compacted-files.private.json');
    const journal=await optionalJson(journalPath) || {version:1,complete:false,files:[]};
    if(journal.version!==1 || !Array.isArray(journal.files)) throw Error('Invalid audit compaction journal');
    if(journal.complete===true) continue;
    const record=async entry=>{
      const prior=journal.files.find(item=>item.path===entry.path);
      if(prior && JSON.stringify(prior)!==JSON.stringify(entry)) throw Error('Audit compaction receipt changed');
      if(!prior) journal.files.push(entry);
      await privateAuditWrite(journalPath,JSON.stringify(journal));
    };
    await compactFiles(directory, directory, receiptRoot, record);
    await privateAuditWrite(journalPath,JSON.stringify({...journal,complete:true}));
    attemptsCompacted++;
  }
  const cache = path.join(root, 'archive-cache');
  const cached = [];
  for (const entry of await fs.readdir(cache, {withFileTypes: true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.gz$/.test(entry.name)) continue;
    const file = path.join(cache, entry.name), stat = await fs.lstat(file);
    if (stat.isFile()) cached.push({file, bytes: stat.size, modified: stat.mtimeMs});
  }
  let cachedBytes = cached.reduce((sum, file) => sum + file.bytes, 0), cacheBytesRemoved = 0;
  for (const entry of cached.sort((left, right) => left.modified - right.modified)) {
    if (cachedBytes <= maxCacheBytes) break;
    await fs.unlink(entry.file);
    cachedBytes -= entry.bytes;
    cacheBytesRemoved += entry.bytes;
  }
  return {attemptsCompacted, cacheBytesRemoved, cachedBytes};
}

async function hashFile(file, compressed = false) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = compressed ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  for await (const part of stream) { hash.update(part); bytes += part.length; }
  return {sha256:hash.digest('hex'),bytes};
}

// Preserve all validation receipts and inputs byte-for-byte in compressed form.
// Only hash-addressed replicas with an exact archive receipt are removed.
async function compactFiles(root, directory, receiptRoot, record) {
  for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
    const file = path.join(directory,entry.name);
    if (entry.isDirectory()) { await compactFiles(root,file,receiptRoot,record); continue; }
    if (!entry.isFile() || /\.retained\.gz(?:\.[a-f0-9-]{36})?$/.test(entry.name) || entry.name==='compacted-files.private.json') continue;
    const stat = await fs.lstat(file);
    if (stat.size < 1024*1024) continue;
    const original = await hashFile(file);
    const key = entry.name.match(/^(?:archive-)?([a-f0-9]{64})(?:\.gz|\.private\.bin)$/)?.[1];
    const receipt = key && receiptRoot ? await optionalJson(path.join(receiptRoot,key+'.gz.json')) : null;
    if (key===original.sha256 && receipt?.target==='matter-report-archive' && receipt.key===key+'.gz' && receipt.verified===true
      && receipt.sha256===original.sha256 && receipt.bytes===original.bytes) {
      await record({path:path.relative(root,file),...original,archiveKey:receipt.key});
      await fs.unlink(file);
      continue;
    }
    const target=file+'.retained.gz',temporary=target+'.'+randomUUID();
    try {
      await pipeline(createReadStream(file),createGzip(),createWriteStream(temporary,{mode:0o600,flags:'wx'}));
      const restored=await hashFile(temporary,true);
      if (restored.sha256!==original.sha256 || restored.bytes!==original.bytes) throw Error('Retained audit copy failed verification');
      if ((await fs.stat(temporary)).size>=stat.size) continue;
      await fs.link(temporary,target).catch(async error=>{
        if(error.code!=='EEXIST') throw error;
        const retained=await fs.lstat(target);
        if(!retained.isFile() || retained.mode&0o077 || retained.uid!==process.getuid()) throw Error('Retained audit copy must be an owner-only regular file');
        const existing=await hashFile(target,true);
        if(existing.sha256!==original.sha256 || existing.bytes!==original.bytes) throw Error('Conflicting retained audit copy');
      });
      await record({path:path.relative(root,file),...original,retainedPath:path.relative(root,target)});
      await fs.unlink(file);
    } finally { await fs.rm(temporary,{force:true}); }
  }
}
