import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createGzip,createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {readDriverAuditSeedConfig} from './driverAuditDirectImport.js';
import {retireAbandonedDriverAuditAttempt,retireDriverAuditAttempt} from './driverAuditWorkspaceRetirement.js';
import {privateAuditJson,privateAuditWrite} from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';

const digest = /^[a-f0-9]{64}$/;
const attemptName = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

// The saved-data replay used 1.32 GB of working space. Retain additional room
// for a larger capture.
const minimumBuildBytes = 2560 * 1024 * 1024;
const buildStartOverheadBytes = 8 * 1024 * 1024;

export function hasDriverAuditBuildSpace(availableBytes) {
  return Number.isSafeInteger(availableBytes) && availableBytes >= minimumBuildBytes;
}

export function requireDriverAuditBuildSpace(availableBytes) {
  if (!hasDriverAuditBuildSpace(availableBytes)) {
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
export async function pruneDriverAuditWorkspace({root, receiptRoot, retirement, protectedManifests = [], maxCacheBytes = 512 * 1024 * 1024, abandoned = 'off'}) {
  if (!path.isAbsolute(root) || !Array.isArray(protectedManifests) || protectedManifests.some(value => !digest.test(value))
    || !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0 || !['off','plan','apply'].includes(abandoned)) {
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
  let attemptsRetired = 0;
  let retirementDeferred = 0;
  const orphaned={attempts:0,files:0,bytes:0,allocatedBytes:0,freeDiskDeltaBytes:0};
  const statusPath=path.join(root,'status.private.json');
  const buildStatus=abandoned==='off'?null:await optionalJson(statusPath).catch(()=>null);
  const latestAttempt=buildStatus?.attempt?.id??buildStatus?.id;
  const lastBuildAt=attemptName.test(latestAttempt)?(await fs.lstat(statusPath).catch(()=>null))?.mtimeMs:0;
  const retainedRoots=[pointer,pointer?.previous,retirement?.retainedBaseline]
    .filter(candidate=>digest.test(candidate?.manifestSha256)&&path.isAbsolute(candidate.privateRoot??candidate.root??''))
    .map(candidate=>({root:candidate.privateRoot??candidate.root,manifestSha256:candidate.manifestSha256}));
  const freeDisk=async()=>{const disk=await fs.statfs(root);return disk.bavail*disk.bsize;};
  for (const entry of await fs.readdir(attempts, {withFileTypes: true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!entry.isDirectory() || !attemptName.test(entry.name)) continue;
    const directory = path.join(attempts, entry.name);
    if (keepRoots.has(directory)) continue;
    const acceptedPath=path.join(directory,'accepted.private.json');
    const accepted=await optionalJson(acceptedPath).catch(()=>null);
    const seedPath=path.join(directory,'direct-seed.private.json');
    if(!accepted&&abandoned!=='off'&&pointer&&lastBuildAt&&entry.name!==latestAttempt&&(await fs.lstat(directory)).birthtimeMs<=lastBuildAt){
      // Existing seed metadata still protects an attempt when its config cannot be read.
      const present=async file=>fs.lstat(file).then(()=>true,error=>error.code!=='ENOENT');
      if(await present(acceptedPath)||await present(seedPath))continue;
      const before=abandoned==='apply'?await freeDisk():0;
      const result=await retireAbandonedDriverAuditAttempt({directory,protectedManifests:keepManifests,retainedRoots,receiptRoot,retirement,apply:abandoned==='apply'});
      if(result==='proof-unavailable')retirementDeferred++;
      else if(result){
        orphaned.attempts++;
        for(const field of ['files','bytes','allocatedBytes'])orphaned[field]+=result[field];
        if(abandoned==='apply')orphaned.freeDiskDeltaBytes+=await freeDisk()-before;
      }
      continue;
    }
    if(abandoned==='plan')continue;
    const seed = await readDriverAuditSeedConfig(seedPath).catch(() => null);
    if (!accepted || !seed || keepManifests.has(accepted.manifestSha256)) continue;
    if (accepted.privateRoot !== path.join(directory, 'server-data') || seed.manifestSha256 !== accepted.manifestSha256
      || accepted.sourceBasis !== seed.sourceBasis || accepted.collectorRevision !== seed.collectorRevision) continue;
    if(Number.isSafeInteger(pointer?.collectorRevision)&&accepted.collectorRevision<pointer.collectorRevision){
      const retired=await retireDriverAuditAttempt({directory,seed,accepted,receiptRoot,retirement});
      if(retired==='proof-unavailable')retirementDeferred++;
      else if(retired){if(retired==='retired')attemptsRetired++;continue;}
    }
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
  if(abandoned==='plan')return {abandoned:orphaned,retirementDeferred};
  return {attemptsCompacted, attemptsRetired, retirementDeferred, abandoned:orphaned,
    ...await pruneArchiveCache(root,{maxCacheBytes})};
}

// The saved source loader fills this cache only from hash-verified immutable
// archive objects. A cache miss uses its normal verified archive read.
export async function reclaimDriverAuditBuildCache(root, availableBytes) {
  if (!path.isAbsolute(root) || !Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw Error('Invalid audit cache headroom');
  }
  if (hasDriverAuditBuildSpace(availableBytes)) return {cacheBytesRemoved:0,cacheAllocatedBytesRemoved:0};
  return pruneArchiveCache(root,{bytesToReclaim:minimumBuildBytes-availableBytes+buildStartOverheadBytes});
}

async function pruneArchiveCache(root,{maxCacheBytes=Infinity,bytesToReclaim=0}) {
  const cache = path.join(root, 'archive-cache');
  for (const directory of [root,cache]) {
    const stat=await fs.lstat(directory).catch(error=>{
      if(error.code==='ENOENT')return null;
      throw error;
    });
    if(stat&&!stat.isDirectory())throw Error('Audit cache directory must be a real directory');
  }
  const cached = [];
  for (const entry of await fs.readdir(cache, {withFileTypes: true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.gz$/.test(entry.name)) continue;
    const file = path.join(cache, entry.name), stat = await fs.lstat(file);
    if (stat.isFile()) cached.push({file,bytes:stat.size,modified:stat.mtimeMs,allocated:stat.nlink===1?stat.blocks*512:0});
  }
  let cachedBytes = cached.reduce((sum, file) => sum + file.bytes, 0), cacheBytesRemoved = 0, cacheAllocatedBytesRemoved=0;
  for (const entry of cached.sort((left, right) => left.modified - right.modified)) {
    if (cachedBytes <= maxCacheBytes && cacheAllocatedBytesRemoved >= bytesToReclaim) break;
    if (cachedBytes <= maxCacheBytes && !entry.allocated) continue;
    await fs.unlink(entry.file);
    cachedBytes -= entry.bytes;
    cacheBytesRemoved += entry.bytes;
    cacheAllocatedBytesRemoved += entry.allocated;
  }
  return {cacheBytesRemoved,cachedBytes,cacheAllocatedBytesRemoved};
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
