import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {archiveBytes,readManifestBytes} from './repository.mjs';
import {previewPhotoBindings} from './preview-photo-bindings.mjs';
import {prepareRemotePreviewPackage} from './remote-preview-package.mjs';
import {createCloudReportService} from './report-service.mjs';
import {createHostedReviews} from './hosted-reviews.mjs';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const filename=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/.test(value);
const codePath=value=>typeof value==='string'&&value.length<512&&value.split('/').every(filename)&&/\.(?:mjs|js)$/.test(value);
const runtimeCap=128*1024*1024;
const archiveName='matter-report-archive';

export async function privateAuditDirectory(root){
 if(!path.isAbsolute(root))throw Error('Absolute private audit directory required');
 await fs.mkdir(root,{recursive:true,mode:0o700});
 const stat=await fs.lstat(root);
 if(!stat.isDirectory()||stat.mode&0o077||await fs.realpath(root)!==root)throw Error('Owner-only audit directory required');
}

export async function privateAuditWrite(file,bytes){
 const tmp=file+'.'+randomUUID()+'.tmp';
 await fs.writeFile(tmp,bytes,{mode:0o600,flag:'wx'});
 try{await fs.rename(tmp,file);}catch(error){await fs.unlink(tmp);throw error;}
}

export async function privateAuditJson(file){
 if(!path.isAbsolute(file))throw Error('Absolute private audit file required');
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.mode&0o077||stat.size>16*1024*1024)throw Error('Owner-only audit input required');
 return JSON.parse(await fs.readFile(file,'utf8'));
}

async function verifiedBytes(source,key,size){
 const expected=key.slice(0,-3);
 if(!digest(expected)||key!==expected+'.gz'||!Number.isSafeInteger(size)||size<1||size>8*1024*1024)throw Error('Invalid audit archive object');
 const parts=[];
 let total=0;
 for await(const chunk of await source.readObject(key,{maxBytes:size})){
  total+=chunk.length;
  if(total>size)throw Error('Audit archive object size changed');
  parts.push(Buffer.from(chunk));
 }
 const bytes=Buffer.concat(parts,total);
 if(total!==size||sha256(bytes)!==expected)throw Error('Audit archive object hash changed');
 return bytes;
}

export function createVerifiedAuditArchive({remote,receiptRoot,upload,runObject}){
 async function existing(key,size){
  try{
   const saved=await privateAuditJson(path.join(receiptRoot,key+'.json'));
   if(saved.target!==archiveName||saved.key!==key||saved.sha256!==key.slice(0,-3)||saved.bytes!==size||saved.verified!==true)throw Error('Audit archive receipt mismatch');
   return saved;
  }catch(error){if(error.code!=='ENOENT')throw error;return null;}
 }
 async function read(key,size,local){
  await privateAuditDirectory(receiptRoot);
  const get=async(reservedUpload=upload)=>{
  let bytes;
  try{bytes=await verifiedBytes(remote,key,size);}
  catch(error){
   if(error.code!=='storage_not_found'||!local||!reservedUpload)throw error;
   bytes=await local();
   if(!Buffer.isBuffer(bytes)||bytes.length!==size||sha256(bytes)!==key.slice(0,-3))throw Error('Local audit archive hash mismatch');
   const saved=await reservedUpload(key,bytes);
   if(saved?.verified!==true||saved.key!==key||saved.sha256!==key.slice(0,-3))throw Error('Audit archive upload was not verified');
  }
  await privateAuditWrite(path.join(receiptRoot,key+'.json'),JSON.stringify({target:archiveName,key,sha256:key.slice(0,-3),bytes:size,verified:true}));
  return bytes;
  };
  return runObject?runObject(size,Boolean(local),get):get();
 }
 return {
  async verify(key,size,local){
   if(!/^[a-f0-9]{64}\.gz$/.test(key)||!Number.isSafeInteger(size)||size<1||size>8*1024*1024)throw Error('Invalid audit archive receipt identity');
   if(!await existing(key,size))await read(key,size,local);
   return {key,sha256:key.slice(0,-3),verified:true};
  },
  readObject(key,{maxBytes}){return read(key,maxBytes).then(bytes=>[bytes]);}
 };
}

export async function materializeAuditFile(root,name,reference,transport){
 if(!filename(name))throw Error('Unsafe audit file path');
 await privateAuditDirectory(root);
 const file=path.join(root,name);
 try{
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.mode&0o077)throw Error('Unsafe existing audit file');
  if(stat.size===reference.size&&sha256(await fs.readFile(file))===reference.sha256)return file;
 }catch(error){if(error.code!=='ENOENT')throw error;}
 const bytes=await readManifestBytes(transport,reference,{maxBytes:runtimeCap});
 await privateAuditWrite(file,bytes);
 return file;
}

async function eachBounded(values,operation,limit=8){
 for(let i=0;i<values.length;i+=limit){
  const results=await Promise.allSettled(values.slice(i,i+limit).map(operation));
  const failure=results.find(result=>result.status==='rejected');
  if(failure)throw failure.reason;
 }
}

// Verify only the files reachable from this generation. Older report generations
// retain their separate immutable catalog and are checked on demand by the reader.
export async function verifyAuditCatalog({publication,archive,localRoot,metadataRoot,refs=[],inspect}){
 const supplied=new Map(),shards=new Map();
 const local=key=>()=>fs.readFile(path.join(localRoot,'archive-'+key.slice(0,-3)+'.private.bin'));
 const localRead={async readObject(key,{maxBytes}){
  supplied.set(key,maxBytes);
  const cached=metadataRoot&&path.join(metadataRoot,key);
  for(const get of [local(key),...(cached?[()=>fs.readFile(cached)]:[])]){
   const bytes=await get().catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   if(!bytes)continue;
   if(bytes.length!==maxBytes||sha256(bytes)+'.gz'!==key)throw Error('Audit metadata hash changed');
   await archive.verify(key,maxBytes,()=>bytes);
   return [bytes];
  }
  const result=await archive.readObject(key,{maxBytes});
  if(!cached)return result;
  const bytes=Buffer.concat(await Array.fromAsync(result));
  if(bytes.length!==maxBytes||sha256(bytes)+'.gz'!==key)throw Error('Audit metadata hash changed');
  await privateAuditWrite(cached,bytes);
  return [bytes];
 }};
 if(metadataRoot)await privateAuditDirectory(metadataRoot);
 const catalog=JSON.parse(await readManifestBytes(localRead,publication.catalog,{maxBytes:8*1024*1024}));
 if(catalog.version!==1||!catalog.shards||!Number.isSafeInteger(catalog.fileCount))throw Error('Invalid audit archive catalog');
 async function resolve(name){
  const slash=name.indexOf('/'),domain=name.slice(0,slash),file=name.slice(slash+1);
  const group=domain+':'+sha256(file).slice(0,2);
  if(!catalog.shards[group])return null;
  if(!shards.has(group))shards.set(group,readManifestBytes(localRead,catalog.shards[group],{maxBytes:16*1024*1024}).then(bytes=>{
   const entries=JSON.parse(bytes),indexed=new Map();
   if(!Array.isArray(entries))throw Error('Invalid audit archive shard');
   for(const entry of entries){
    const key=entry.domain+'/'+entry.path;
    if(indexed.has(key))throw Error('Ambiguous audit archive entry');
    indexed.set(key,entry);
   }
   return indexed;
  }));
  return (await shards.get(group)).get(name)||null;
 }
 async function verify(ref){
  if(!Array.isArray(ref.chunks)||!digest(ref.sha256))throw Error('Invalid audit archive entry');
  let offset=0;
  for(const chunk of ref.chunks){
   if(chunk.offset!==offset||!digest(chunk.sha256)||!Number.isSafeInteger(chunk.size)||chunk.size<1||chunk.size>8*1024*1024)throw Error('Invalid audit archive chunk');
   offset+=chunk.size;
   const key=chunk.sha256+'.gz';
   if(supplied.has(key)&&supplied.get(key)!==chunk.size)throw Error('Conflicting audit archive size');
   supplied.set(key,chunk.size);
  }
  if(offset!==ref.size)throw Error('Invalid audit archive file size');
 }
 async function readFile(domain,name,{maxBytes}){
  const ref=await resolve(domain+'/'+name);
  if(!ref)throw Object.assign(Error('Audit archive path absent'),{code:'ENOENT'});
  return readManifestBytes(localRead,ref,{maxBytes});
 }
 const additional=inspect?await inspect({getHead:async()=>publication.head,publication,readFile}):[];
 await eachBounded([...refs,...additional],async names=>{
  for(const name of names){
   const ref=await resolve(name);
   if(ref){await verify(ref);return;}
  }
  throw Error('Required audit evidence is absent from the catalog');
 },64);
 await eachBounded([...supplied],([key,size])=>archive.verify(key,size,local(key)),64);
 return {catalogSha256:publication.catalog.sha256,verifiedObjects:supplied};
}

export async function verifyDirectAuditDependencies({privateRoot,archive,metadataRoot}){
 const read=async name=>fs.readFile(path.join(privateRoot,name));
 const publication=JSON.parse(await read('publication.private.json'));
 const view=JSON.parse(gunzipSync(await read('preview-read-view.private.json.gz'),{maxOutputLength:runtimeCap}));
 const registry=await read('preview-photo-bindings.private.json').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 const required=[],photoRefs=digest=>['objects/'+digest,'legacyObjects/'+digest,...retained('photos/'+digest+'.gz')];
 const retained=name=>['state/'+name,'archive/'+name];
 for(const name of view.allowedResources)if(name!==view.browser.url&&!view.deferredQueryFiles?.[name])required.push(retained('assets/'+name.slice('report-data/'.length)+'.gz'));
 for(const photo of new Set(previewPhotoBindings(view,registry).values()))if(photo)required.push(photoRefs(photo));
 required.push(retained('review-snapshots/'+publication.head.reportHash+'.json.gz'),retained('photo-generations/'+publication.head.reportHash+'.json'));
 for(const pointer of [publication.photoBindingRepair,publication.recoveredPhotoBindings,publication.evidenceOverlay,publication.routeEvidence,publication.directVisualReviews]){
  if(pointer?.path)required.push(['state/'+pointer.path]);
 }
 for(const list of Object.values(publication.cloudPhotoResults||{}))for(const result of list){
  if(!digest(result.sha256)||result.path!=='cloud-photo-results/'+result.sha256+'.json')throw Error('Invalid audit photo proposal pointer');
  required.push(['state/'+result.path]);
 }
 return verifyAuditCatalog({publication,archive,localRoot:privateRoot,metadataRoot,refs:required,async inspect(repository){
  const service=createCloudReportService({repository,reviewStore:{},identityStore:{},photoBindingRegistry:registry});
  const rows=await service.photoRowsFor(publication.head.reportHash);
  return [...new Set(rows.map(row=>row.delivery?.photo_sha256).filter(digest))].map(photoRefs);
 }});
}

export async function prepareDirectAuditBundle({privateRoot,bundleRoot,validation,archive,reviewState,collectorRevision,sourceBasis,mode,metadataRoot,verificationFile}){
 await privateAuditDirectory(bundleRoot);
 const publication=JSON.parse(await fs.readFile(path.join(privateRoot,'publication.private.json')));
 const objects=new Map();
 const prepared=await prepareRemotePreviewPackage({privateRoot,maxBytes:runtimeCap,validation,includeRetained:false,transport:{
  async putVerifiedObject(key,bytes){
   await privateAuditWrite(path.join(bundleRoot,key),bytes);
   objects.set(key,bytes.length);
   return {key,sha256:key.slice(0,-3),verified:true};
  }
 },runBatch:async(_limits,operation)=>operation()});
 await eachBounded([...objects],([key,size])=>archive.verify(key,size,()=>fs.readFile(path.join(bundleRoot,key))),64);
 const closure=await verifyDirectAuditDependencies({privateRoot,archive,metadataRoot});
 await createHostedReviews({stateStore:reviewState,key:'preview-gps-map-20261106:review-journal',snapshotFor:async()=>null})
  .read({id:'driver-audit-deployment',role:'viewer'});
 if(verificationFile){
  for(const [key,size] of objects)closure.verifiedObjects.set(key,size);
  await privateAuditWrite(verificationFile,JSON.stringify(Object.fromEntries(closure.verifiedObjects)));
 }
 const {descriptor,generation,reportHash}=prepared,manifestSha256=validation.manifestSha256;
 const sourceAt=publication.head.source?.observedAt;
 const visibleCutoffAt=typeof sourceAt==='string'&&Number.isFinite(Date.parse(sourceAt))?new Date(sourceAt).toISOString():null;
 const identity={manifestSha256,generation,reportHash,descriptorSha256:descriptor.sha256};
 return {version:1,mode,bundleRoot,pointer:{version:1,generation,reportHash,descriptor},collectorRevision,sourceBasis,manifestSha256,visibleCutoffAt,
  closureReceipt:{version:1,status:'verified',sourceBasis,...identity,checkedAt:new Date().toISOString(),checks:{archive:true,photos:true,reviewHistory:true}},
  restore:{version:1,...identity,archive:archiveName,verified:true}};
}

export async function readAuditHandoff(sha,archive){
 if(!digest(sha))throw Error('Pinned audit handoff hash required');
 const key=sha+'.gz';
 const chunks=[];
 let count=0;
 for await(const chunk of await archive.readObject(key,{maxBytes:8*1024*1024})){
  count+=chunk.length;
  if(count>8*1024*1024)throw Error('Audit handoff exceeds size limit');
  chunks.push(Buffer.from(chunk));
 }
 const bytes=Buffer.concat(chunks,count);
 if(sha256(bytes)!==sha)throw Error('Audit handoff hash mismatch');
 const handoff=JSON.parse(bytes);
 if(handoff.version!==1||!handoff.seed?.pointer?.descriptor||handoff.seed.mode!=='bootstrap')throw Error('Invalid audit handoff');
 return handoff;
}

export async function stageAuditHandoff({root,sha,archive,withBaseline=false}){
 await privateAuditDirectory(root);
 const handoff=await readAuditHandoff(sha,archive),bundleRoot=path.join(root,'objects');
 await privateAuditDirectory(bundleRoot);
 const descriptor=handoff.seed.pointer.descriptor;
 const descriptorBytes=await readManifestBytes(archive,descriptor,{maxBytes:8*1024*1024});
 const runtime=JSON.parse(descriptorBytes);
 if(runtime.sourceManifestSha256!==handoff.seed.manifestSha256||runtime.generation!==handoff.seed.pointer.generation||runtime.reportHash!==handoff.seed.pointer.reportHash)throw Error('Audit handoff release identity mismatch');
 const runtimeChunks=new Map();
 for(const ref of [descriptor,...Object.values(runtime.files)])for(const chunk of ref.chunks)runtimeChunks.set(chunk.sha256,chunk);
 await eachBounded([...runtimeChunks.values()],chunk=>{
  const {size,sha256}=chunk;
  return materializeAuditFile(bundleRoot,sha256+'.gz',{version:1,size,sha256,chunks:[{offset:0,size,sha256}]},archive);
 },32);
 if(withBaseline){
  if(!handoff.baseline||!handoff.journals||!handoff.builder?.manifest||!handoff.builder?.files)throw Error('Audit sync baseline or reviewed builder missing');
  const baselineRoot=path.join(root,'baseline');
  await eachBounded(Object.entries(handoff.baseline),([name,ref])=>materializeAuditFile(baselineRoot,name,ref,archive),32);
  if(sha256(await fs.readFile(path.join(baselineRoot,'files.private.json')))!==handoff.seed.manifestSha256)throw Error('Audit baseline manifest mismatch');
  const journals=await materializeAuditFile(root,'validation-journals.private.json',handoff.journals,archive);
  const renderer=path.join(baselineRoot,'build.private.json');
  const codeRoot=path.join(root,'builder');
  await eachBounded(Object.entries(handoff.builder.files),async([name,ref])=>{
   if(!codePath(name))throw Error('Invalid private audit builder path');
   await materializeAuditFile(path.join(codeRoot,path.dirname(name)),path.basename(name),ref,archive);
  });
  await materializeAuditFile(codeRoot,'runtime-manifest.json',handoff.builder.manifest,archive);
  await verifyAuditBuilder(codeRoot,handoff.builder.manifest.sha256);
  await privateAuditWrite(path.join(root,'sync.json'),JSON.stringify({version:1,root,baselineRoot,codeRoot,builderSha256:handoff.builder.manifest.sha256,
   rendererBuild:{path:renderer,sha256:sha256(await fs.readFile(renderer))},journals:{path:journals,sha256:handoff.journals.sha256}}));
 }
 if(handoff.verification){
  const index=JSON.parse(await readManifestBytes(archive,handoff.verification,{maxBytes:8*1024*1024}));
  const receiptRoot=path.join(root,'archive-receipts');
  await privateAuditDirectory(receiptRoot);
  await eachBounded(Object.entries(index),async([key,size])=>{
   if(!/^[a-f0-9]{64}\.gz$/.test(key)||!Number.isSafeInteger(size)||size<1||size>8*1024*1024)throw Error('Invalid verified archive index');
   await privateAuditWrite(path.join(receiptRoot,key+'.json'),JSON.stringify({target:archiveName,key,sha256:key.slice(0,-3),bytes:size,verified:true}));
  },64);
 }
 await privateAuditWrite(path.join(root,'seed.json'),JSON.stringify({...handoff.seed,bundleRoot}));
 return {generation:runtime.generation,manifestSha256:runtime.sourceManifestSha256,runtimeObjects:runtimeChunks.size,baselineStaged:withBaseline};
}

export async function verifyAuditBuilder(root,expected){
 await privateAuditDirectory(root);
 if(!digest(expected))throw Error('Reviewed builder hash required');
 const file=path.join(root,'runtime-manifest.json');
 const manifest=await privateAuditJson(file);
 if(sha256(await fs.readFile(file))!==expected||manifest.version!==1||!manifest.files?.['scripts/run-automatic-report.mjs'])throw Error('Audit builder manifest mismatch');
 const expectedPaths=new Set(['runtime-manifest.json']);
 for(const [name,hash] of Object.entries(manifest.files)){
  if(!codePath(name)||!digest(hash))throw Error('Invalid audit builder file binding');
  const target=path.join(root,name),stat=await fs.lstat(target);
  if(!stat.isFile()||stat.mode&0o077||stat.size>8*1024*1024||await fs.realpath(target)!==target||sha256(await fs.readFile(target))!==hash)throw Error('Audit builder file mismatch');
  expectedPaths.add(name);
 }
 async function visit(directory,relative=''){
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
   const name=path.join(relative,entry.name);
   if(entry.isDirectory())await visit(path.join(directory,entry.name),name);
   else if(!entry.isFile()||!expectedPaths.has(name))throw Error('Unexpected file in reviewed audit builder');
  }
 }
 await visit(root);
}

// The production deployer receives only the hash of this immutable private
// handoff. Its untrusted input cannot name a destination or contain credentials.
export async function publishAuditHandoff({config,privateRoot,journals,verificationFile,builderRoot,builderSha256,archive,withBaseline=false}){
 const fileManifest=await fs.readFile(path.join(privateRoot,'files.private.json'));
 if(sha256(fileManifest)!==config.manifestSha256)throw Error('Audit handoff manifest changed');
 const files=JSON.parse(fileManifest);
 const baseline=new Map();
 // The seed and full builder baseline share one pinned identity. The larger
 // baseline only needs to be materialized for the separately gated sync start.
 const transport={putVerifiedObject:(key,bytes)=>withBaseline?archive.verify(key,bytes.length,()=>bytes):
  {key,sha256:key.slice(0,-3),verified:true}};
 const stagedFiles=Object.entries(files).filter(([name,hash])=>name!=='archive-'+hash+'.private.bin');
 await eachBounded([...stagedFiles,['files.private.json',config.manifestSha256]],async([name,expected])=>{
  if(!filename(name)||!digest(expected))throw Error('Invalid baseline file name or hash');
  const bytes=await fs.readFile(path.join(privateRoot,name));
  if(sha256(bytes)!==expected)throw Error('Audit baseline file hash changed');
  baseline.set(name,await archiveBytes(transport,bytes,{path:name}));
 });
 const journalBytes=await fs.readFile(journals.path);
 if(sha256(journalBytes)!==journals.sha256)throw Error('Audit validation journal hash changed');
 const journal=await archiveBytes(transport,journalBytes,{path:'validation-journals.private.json'});
 await verifyAuditBuilder(builderRoot,builderSha256);
 const builderBytes=await fs.readFile(path.join(builderRoot,'runtime-manifest.json'));
 const builderRefs=new Map();
 await eachBounded(Object.keys(JSON.parse(builderBytes).files),async name=>{
  const bytes=await fs.readFile(path.join(builderRoot,name));
  builderRefs.set(name,await archiveBytes(transport,bytes,{path:name}));
 });
 const builder={manifest:await archiveBytes(transport,builderBytes,{path:'runtime-manifest.json'}),
  files:Object.fromEntries([...builderRefs].sort(([left],[right])=>left.localeCompare(right)))};
 const verification=await archiveBytes({putVerifiedObject:(key,bytes)=>archive.verify(key,bytes.length,()=>bytes)},
  await fs.readFile(verificationFile),{path:'verified-objects.private.json'});
 const {bundleRoot,...seed}=config;
 const ordered=Object.fromEntries([...baseline].sort(([left],[right])=>left.localeCompare(right)));
 const bytes=Buffer.from(JSON.stringify({version:1,seed,baseline:ordered,journals:journal,verification,builder}));
 if(bytes.length>8*1024*1024)throw Error('Audit handoff manifest exceeds size limit');
 const hash=sha256(bytes);
 await archive.verify(hash+'.gz',bytes.length,()=>bytes);
 return {sha256:hash,manifestSha256:config.manifestSha256,generation:config.pointer.generation,baselineArchived:withBaseline};
}
