import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {isDeepStrictEqual} from 'node:util';
import {createGunzip,gzipSync,gunzipSync} from 'node:zlib';
import {driverAuditPackagePointer,driverAuditSourceHead,readDriverAuditSeedConfig} from './driverAuditDirectImport.js';
import {checkedAuditPointer} from '../vendor/driver-audits/integration/cloud/audit-replica.mjs';
import {privateAuditJson,privateAuditWrite} from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import {createCloudRepository,readManifestBytes} from '../vendor/driver-audits/integration/cloud/repository.mjs';

const digest=/^[a-f0-9]{64}$/;
const filename=/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const objectName=/^[a-f0-9]{64}\.gz$/;
const maxFile=128*1024*1024;
const receiptName='retired-workspace.private.json';
const inventoryName='retired-workspace-inventory.private.json.gz';
const abandonedReceipt='abandoned-workspace.private.json';
const abandonedInventory='abandoned-workspace-inventory.private.json.gz';
const copiesReceipt='retired-archive-copies.private.json';
const copiesInventory='retired-archive-copies-inventory.private.json.gz';
const buildFiles=new Set(['automatic-build.private.json','automatic-validation.private.json','combined-reviews.private.json',
  'gps-refresh-receipt.private.json','history-query.private.gz','receipt.private.json','verified-gps-windows.private.json']);
const savedFiles=['collector-state.private.json','current-browser.private.json','current-reviews.private.json'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const missing=error=>{if(error.code==='ENOENT')return null;throw error;};
const assert=(valid,message)=>{if(!valid)throw Error(message);};

async function readPrivate(file,operation){
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(missing);
  if(!handle)return null;
  try{
    const stat=await handle.stat();
    assert(stat.isFile()&&stat.uid===process.getuid()&&!(stat.mode&0o077),'Unowned audit workspace file');
    return await operation(handle,stat);
  }finally{await handle.close();}
}

async function bytes(file,limit){
  return readPrivate(file,async(handle,stat)=>{
    assert(stat.size<=limit,'Audit workspace proof exceeds its read bound');
    return handle.readFile();
  });
}

async function syncPath(file){
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{await handle.sync();}finally{await handle.close();}
}

async function fingerprint(stream){
  const hash=createHash('sha256');let size=0;
  for await(const part of stream){size+=part.length;assert(size<=512*1024*1024,'Audit workspace fingerprint exceeds its bound');hash.update(part);}
  return {sha256:hash.digest('hex'),bytes:size};
}

async function localFingerprint(file,compressed=false){
  return readPrivate(file,async handle=>{
    const raw=handle.createReadStream({autoClose:false});
    return fingerprint(compressed?raw.pipe(createGunzip()):raw);
  });
}

function eligible(relative){
  const original=relative.endsWith('.retained.gz')?relative.slice(0,-12):relative;
  const [part,file,...rest]=original.split('/');
  if(rest.length||!filename.test(part)||file&&!filename.test(file))return false;
  return buildFiles.has(original)||part==='server-data'&&!!file||part==='saved-current'&&savedFiles.includes(file)
    ||part==='audit-objects'&&objectName.test(file);
}

async function safeDirectory(directory){
  const stat=await fs.lstat(directory).catch(missing);
  return stat?.isDirectory()&&stat.uid===process.getuid()&&await fs.realpath(directory)===directory;
}

async function saveInventory(directory,receipt,inventoryName,summary,files){
  const encoded=Buffer.from(JSON.stringify(files));
  assert(files.length<=10_000&&encoded.length<=16*1024*1024,'Audit workspace retirement inventory exceeds its bound');
  const inventory=gzipSync(encoded),inventoryFile=path.join(directory,inventoryName);
  await privateAuditWrite(inventoryFile,inventory);
  await syncPath(inventoryFile);
  const proof={...summary,inventoryFile:inventoryName,inventorySha256:sha(encoded),inventoryCompressedSha256:sha(inventory)};
  await privateAuditWrite(receipt,JSON.stringify(proof));
  await syncPath(receipt);
  await syncPath(directory);
  return proof;
}

async function readInventory(directory,proof,inventoryName){
  assert(proof.status==='prepared'&&proof.inventoryFile===inventoryName,'Invalid audit workspace retirement receipt');
  const inventory=await bytes(path.join(directory,inventoryName),16*1024*1024);
  assert(inventory&&sha(inventory)===proof.inventoryCompressedSha256,'Invalid compressed audit workspace inventory');
  const decoded=gunzipSync(inventory,{maxOutputLength:16*1024*1024}),files=JSON.parse(decoded);
  assert(Array.isArray(files)&&files.length<=10_000&&sha(decoded)===proof.inventorySha256,
    'Invalid audit workspace retirement inventory');
  return files;
}

async function finishInventory(directory,receipt,proof,files,revalidate){
  const affected=new Set();
  for(const item of files){
    assert(typeof item.path==='string'&&eligible(item.path)&&digest.test(item.sha256)&&Number.isSafeInteger(item.bytes)&&item.bytes>=0,
      'Invalid audit workspace retirement item');
    const target=path.join(directory,item.path);
    const parent=path.dirname(target);
    assert(await safeDirectory(parent),'Audit workspace directory changed during retirement');
    affected.add(parent);
    const actual=await localFingerprint(target);
    if(!actual)continue;
    assert(actual.sha256===item.sha256&&actual.bytes===item.bytes,'Audit workspace file changed during retirement');
    await revalidate?.(item);
    await fs.unlink(target);
  }
  for(const parent of affected)await syncPath(parent);
  await privateAuditWrite(receipt,JSON.stringify({...proof,status:'retired',retiredAt:new Date().toISOString(),
    removedFiles:files.length,removedBytes:files.reduce((total,item)=>total+item.bytes,0)}));
  await syncPath(receipt);
  await syncPath(directory);
}

async function archivedPackage({directory,seed,receiptRoot,transport}){
  const bundle=path.join(directory,'audit-objects');
  assert(seed.bundleRoot===bundle,'Audit restore bundle changed');
  const pointer=seed.pointer;
  const descriptor=JSON.parse(await readManifestBytes({async readObject(key,options){
    const local=await safeDirectory(bundle)&&await bytes(path.join(bundle,key),options.maxBytes);
    return local?[local]:transport.readObject(key,options);
  }},pointer.descriptor,{maxBytes:8*1024*1024}));
  assert(descriptor.version===1&&descriptor.generation===pointer.generation&&descriptor.reportHash===pointer.reportHash
    &&descriptor.sourceManifestSha256===seed.manifestSha256&&descriptor.files&&!Array.isArray(descriptor.files)&&Object.keys(descriptor.files).length,
  'Archived audit descriptor changed');
  const objects=new Map();
  for(const ref of [pointer.descriptor,...Object.values(descriptor.files)]){
    assert(ref?.version===1&&digest.test(ref.sha256)&&Array.isArray(ref.chunks),'Invalid archived workspace reference');
    let offset=0;
    for(const chunk of ref.chunks){
      assert(digest.test(chunk.sha256)&&chunk.offset===offset&&Number.isSafeInteger(chunk.size)&&chunk.size>0&&chunk.size<=8*1024*1024,
        'Invalid archived workspace chunk');
      const key=chunk.sha256+'.gz';offset+=chunk.size;
      assert(!objects.has(key)||objects.get(key)===chunk.size,'Conflicting archived workspace chunk');
      objects.set(key,chunk.size);
    }
    assert(offset===ref.size,'Archived workspace length changed');
  }
  for(const [key,size]of objects){
    const receipt=await privateAuditJson(path.join(receiptRoot,key+'.json'));
    assert(receipt.target==='matter-report-archive'&&receipt.key===key&&receipt.sha256+'.gz'===key&&receipt.bytes===size&&receipt.verified===true,
      'Missing exact archived audit restore receipt');
  }
  return objects;
}

async function savedSource({directory,seed,transport,readSourceReceipt,sourceBasis,original}){
  const statePath='saved-current/collector-state.private.json';
  const stateFile=await bytes(path.join(directory,statePath),2*1024*1024);
  const source=await readSourceReceipt(seed.collectorRevision);
  assert(source?.revision===seed.collectorRevision&&typeof source.body==='string','Saved audit source revision changed');
  const pinned=JSON.parse(source.body),head=pinned.head;
  assert(sourceBasis(pinned)===seed.sourceBasis&&digest.test(head?.manifest?.sha256)&&head.manifest.url==='report-data/snapshot-'+head.manifest.sha256+'.json'
    &&digest.test(head.reportHash),'Invalid saved audit source head');
  const stateHash=await original(statePath);
  if(stateFile){
    const local=JSON.parse(stateFile);
    assert(local.revision===source.revision&&local.body===source.body,'Saved audit source receipt does not match local inputs');
  }else{
    assert(stateHash?.sha256===sha(Buffer.from(JSON.stringify(source))),'Retained audit source receipt changed');
  }
  const repo=await createCloudRepository({stateStore:{read:async()=>source},transport,key:'collector-state'}).pin();
  const paths=['assets/'+head.manifest.url.slice('report-data/'.length)+'.gz','review-snapshots/'+head.reportHash+'.json.gz'];
  const sourceHashes=[];
  for(const [index,archivePath]of paths.entries()){
    const packed=await repo.readFile('state',archivePath,{maxBytes:maxFile}).catch(error=>{
      if(error.code!=='ENOENT')throw error;
      return repo.readFile('archive',archivePath,{maxBytes:maxFile});
    });
    const restored=await fingerprint(Readable.from([packed]).pipe(createGunzip()));
    const local=await original('saved-current/'+savedFiles[index+1]);
    assert(local?.sha256===restored.sha256&&local.bytes===restored.bytes&&(index!==0||restored.sha256===head.manifest.sha256),
      'Archived audit input differs from its saved copy');
    sourceHashes.push(restored.sha256);
  }
  const gps=[];
  for(const value of Object.values(pinned.gpsState??{})){
    if(!value?.stateManifest)continue;
    await readManifestBytes(transport,value.stateManifest,{maxBytes:32*1024*1024});
    gps.push(value.stateManifest.sha256);
  }
  return {revision:source.revision,stateSha256:sha(source.body),browserSha256:sourceHashes[0],reviewsSha256:sourceHashes[1],gpsStateSha256:gps};
}

async function prepare({directory,seed,accepted,receiptRoot,retirement}){
  const {transport,readSourceReceipt,sourceBasis,recipe}=retirement;
  assert(typeof transport?.readObject==='function'&&typeof readSourceReceipt==='function'&&typeof sourceBasis==='function'
    &&['builderSha256','rendererSha256','journalsSha256','baselineManifestSha256'].every(key=>digest.test(recipe?.[key])),
  'Exact audit rebuild recipe required');
  const dataRoot=path.join(directory,'server-data');
  assert(await safeDirectory(dataRoot)&&await safeDirectory(path.join(directory,'saved-current')),'Missing audit workspace inputs');
  const manifest=await bytes(path.join(dataRoot,'files.private.json'),16*1024*1024);
  assert(manifest&&sha(manifest)===seed.manifestSha256,'Audit workspace manifest changed');
  const candidate=JSON.parse(manifest);
  assert(candidate&&typeof candidate==='object'&&!Array.isArray(candidate),'Invalid audit workspace manifest');
  const compacted=await privateAuditJson(path.join(directory,'compacted-files.private.json')).catch(missing);
  const prior=new Map((compacted?.files??[]).map(item=>[item.path,item]));
  const files=[];
  async function plan(relative,expected){
    if(!eligible(relative))return null;
    const file=path.join(directory,relative),previous=prior.get(relative);
    let decoded=await localFingerprint(file),target=relative;
    if(!decoded&&previous?.retainedPath===relative+'.retained.gz'){
      target=previous.retainedPath;
      decoded=await localFingerprint(path.join(directory,target),true);
      assert(decoded&&decoded.sha256===previous.sha256&&decoded.bytes===previous.bytes,'Compacted audit input changed');
    }
    if(!decoded)return null;
    assert(!expected||decoded.sha256===expected,'Audit workspace file changed after validation');
    const stored=target===relative?decoded:await localFingerprint(path.join(directory,target));
    files.push({path:target,...stored});
    return decoded;
  }
  const objects=await archivedPackage({directory,seed,receiptRoot,transport});
  const source=await savedSource({directory,seed,transport,readSourceReceipt,sourceBasis,original:plan});
  for(const [name,hash]of Object.entries(candidate)){
    if(filename.test(name)&&digest.test(hash))await plan('server-data/'+name,hash);
  }
  await plan('server-data/files.private.json',seed.manifestSha256);
  if(await safeDirectory(path.join(directory,'audit-objects'))){
    for(const key of objects.keys())await plan('audit-objects/'+key,key.slice(0,-3));
  }
  for(const name of buildFiles)await plan(name);
  assert(files.length<=10_000,'Audit workspace retirement inventory exceeds its bound');
  return {version:1,status:'prepared',manifestSha256:seed.manifestSha256,sourceBasis:seed.sourceBasis,source,recipe,
    lineage:{baselineRoot:accepted.baselineRoot??null,previousManifestSha256:accepted.previous?.manifestSha256??null},
    archive:{descriptorSha256:seed.pointer.descriptor.sha256,objects:objects.size,inventorySha256:sha(JSON.stringify([...objects]))},
    files,inventorySha256:sha(JSON.stringify(files)),verifiedAt:new Date().toISOString()};
}

// Once the published report and original source are independently restorable,
// the prior attempt's generated build files are disposable. Retain its pointers,
// preservation receipt and a compact proof of exactly what was retired.
export async function retireDriverAuditAttempt({directory,seed,accepted,receiptRoot,retirement}){
  if(!await safeDirectory(directory))return false;
  const file=path.join(directory,receiptName);
  let proof=await privateAuditJson(file).catch(missing);
  if(!proof){
    if(!retirement||!receiptRoot||seed.mode!=='sync')return false;
    let prepared;
    try{prepared=await prepare({directory,seed,accepted,receiptRoot,retirement});}
    catch{return 'proof-unavailable';}
    const {files,...summary}=prepared;
    proof=await saveInventory(directory,file,inventoryName,summary,files);
  }
  assert(proof.version===1&&proof.manifestSha256===seed.manifestSha256&&proof.sourceBasis===seed.sourceBasis,
    'Audit workspace retirement proof changed');
  if(proof.status==='retired')return 'already-retired';
  await finishInventory(directory,file,proof,await readInventory(directory,proof,inventoryName));
  return 'retired';
}

async function readLocalManifest(root){
  if(!await safeDirectory(root))return null;
  const manifest=await bytes(path.join(root,'files.private.json'),16*1024*1024);
  if(!manifest)return null;
  const files=JSON.parse(manifest);
  assert(files&&typeof files==='object'&&!Array.isArray(files),'Invalid audit workspace manifest');
  return {root,sha256:sha(manifest),files};
}

async function exactArchiveReceipt(receiptRoot,key,actual){
  if(!receiptRoot||!await safeDirectory(receiptRoot)||key!==actual.sha256+'.gz')return false;
  const receipt=await privateAuditJson(path.join(receiptRoot,key+'.json')).catch(missing);
  return receipt?.target==='matter-report-archive'&&receipt.key===key&&receipt.verified===true
    &&receipt.sha256===actual.sha256&&receipt.bytes===actual.bytes;
}

const archiveKey=relative=>relative.match(/^(?:server-data\/archive-([a-f0-9]{64})\.private\.bin|audit-objects\/([a-f0-9]{64})\.gz)$/)?.slice(1).find(Boolean);
const proofForRecipe=recipe=>['builderSha256','rendererSha256','journalsSha256','baselineManifestSha256'].every(key=>digest.test(recipe?.[key]));

export async function acceptedWorkspace(root,candidate,head){
  if(!candidate||head?.version!==1||!digest.test(candidate.basis)
    ||typeof candidate.privateRoot!=='string')return null;
  const directory=path.dirname(candidate.privateRoot);
  if(path.dirname(directory)!==path.join(root,'attempts')
    ||!(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/).test(path.basename(directory))
    ||candidate.privateRoot!==path.join(directory,'server-data')||!await safeDirectory(directory))return null;
  const accepted=await privateAuditJson(path.join(directory,'accepted.private.json'));
  const seed=await readDriverAuditSeedConfig(path.join(directory,'direct-seed.private.json'));
  if(accepted?.version!==1||accepted.privateRoot!==candidate.privateRoot||accepted.basis!==candidate.basis
    ||accepted.manifestSha256!==candidate.manifestSha256||accepted.manifestSha256!==seed.manifestSha256
    ||accepted.sourceBasis!==seed.sourceBasis||accepted.collectorRevision!==seed.collectorRevision
    ||seed.mode!=='sync'||seed.bundleRoot!==path.join(directory,'audit-objects')
    ||!isDeepStrictEqual(driverAuditSourceHead(head),checkedAuditPointer(driverAuditPackagePointer(seed))))return null;
  const manifest=await readLocalManifest(accepted.privateRoot);
  if(manifest?.sha256!==seed.manifestSha256)return null;
  return {directory,accepted,seed,manifest};
}

// The sync writer holds both the local worker and MongoDB direct-writer locks.
// The previous local package can shed verified archive copies. Its source,
// derived reports, manifest and lineage remain available for later retirement.
export async function prunePreviousDriverAuditCopies({root,receiptRoot,head,stage,retentionStatus}){
  if(retentionStatus!=='qualified'||stage!==null||!path.isAbsolute(root??'')||!path.isAbsolute(receiptRoot??'')
    ||!await safeDirectory(root)||!await safeDirectory(receiptRoot))return null;
  let plan;
  try{
    const pointer=await privateAuditJson(path.join(root,'current.private.json')).catch(missing);
    if(pointer?.version!==1||!pointer.previous||pointer.privateRoot===pointer.previous.privateRoot
      ||pointer.manifestSha256===pointer.previous.manifestSha256||pointer.baselineRoot!==pointer.previous.privateRoot)return null;
    const active=await acceptedWorkspace(root,pointer,head);
    const previous=await acceptedWorkspace(root,pointer.previous,head?.previous);
    if(!active||!previous||!isDeepStrictEqual(pointer,active.accepted)
      ||active.seed.collectorRevision<=previous.seed.collectorRevision)return null;
    const {directory,seed,manifest}=previous;
    const receipt=path.join(directory,copiesReceipt);
    let proof=await privateAuditJson(receipt).catch(missing);
    if(proof?.status==='retired')return null;
    const binding={kind:'accepted-archive-copies',version:1,manifestSha256:manifest.sha256,
      activeSourceBodySha256:head.sourceBodySha256,sourceBodySha256:head.previous.sourceBodySha256};
    assert(!proof||Object.entries(binding).every(([key,value])=>proof[key]===value),'Audit archive copy retirement binding changed');
    const objects=await archivedPackage({directory,seed,receiptRoot,transport:{readObject(){
      throw Error('Missing local audit archive descriptor');
    }}});
    // Keep descriptor chunks so regular retirement can read the package
    // inventory locally after these copies have been removed.
    for(const chunk of seed.pointer.descriptor.chunks)objects.delete(chunk.sha256+'.gz');
    const isBound=(relative,hash)=>relative.startsWith('server-data/')
      ?manifest.files[path.basename(relative)]===hash
      :objects.has(hash+'.gz');
    let files;
    if(proof){
      files=await readInventory(directory,proof,copiesInventory);
    }else{
      files=[];
      const names=[...Array.from(objects.keys(),key=>'audit-objects/'+key),
        ...Object.keys(manifest.files).filter(name=>archiveKey('server-data/'+name)).map(name=>'server-data/'+name)];
      for(const relative of names){
        const hash=archiveKey(relative),file=path.join(directory,relative);
        if(!hash||!isBound(relative,hash))continue;
        const stat=await fs.lstat(file).catch(missing);
        if(!stat?.isFile()||!stat.blocks||stat.nlink!==1
          ||!await exactArchiveReceipt(receiptRoot,hash+'.gz',{sha256:hash,bytes:stat.size}))continue;
        const actual=await localFingerprint(file);
        if(actual?.sha256!==hash||actual.bytes!==stat.size)continue;
        files.push({path:relative,...actual,allocatedBytes:stat.blocks*512});
        if(files.length===10_000)break;
      }
      if(!files.length)return null;
    }
    plan={directory,receipt,proof,binding,files,isBound};
  }catch{return 'proof-unavailable';}
  const {directory,receipt,binding,files,isBound}=plan;
  const proof=plan.proof??await saveInventory(directory,receipt,copiesInventory,{...binding,status:'prepared'},files);
  await finishInventory(directory,receipt,proof,files,async item=>{
    const hash=archiveKey(item.path);
    assert(hash===item.sha256&&isBound(item.path,hash)
      &&await exactArchiveReceipt(receiptRoot,hash+'.gz',item),'Audit archive copy restore receipt changed');
  });
  return {files:files.length,bytes:files.reduce((sum,item)=>sum+item.bytes,0),
    allocatedBytes:files.reduce((sum,item)=>sum+item.allocatedBytes,0)};
}

async function abandonedSource(directory,retirement){
  const {transport,readSourceReceipt,sourceBasis,recipe}=retirement??{};
  if(!transport||!readSourceReceipt||!sourceBasis||!proofForRecipe(recipe)||!await safeDirectory(path.join(directory,'saved-current')))return null;
  const state=await bytes(path.join(directory,'saved-current/collector-state.private.json'),2*1024*1024);
  if(!state)return null;
  const local=JSON.parse(state);
  if(!Number.isSafeInteger(local.revision)||local.revision<1||typeof local.body!=='string')return null;
  const pinned=JSON.parse(local.body),seed={collectorRevision:local.revision,sourceBasis:sourceBasis(pinned)};
  const copies=new Map();
  const source=await savedSource({directory,seed,transport,readSourceReceipt,sourceBasis,async original(relative){
    const actual=await localFingerprint(path.join(directory,relative));
    if(actual)copies.set(relative,actual);
    return actual;
  }});
  return {source,sourceBasis:seed.sourceBasis,head:pinned.head,copies,recipe};
}

async function planAbandoned({directory,manifest,retained,receiptRoot,retirement}){
  const entries=await fs.readdir(directory,{withFileTypes:true});
  const names=new Set(entries.filter(entry=>entry.isFile()&&buildFiles.has(entry.name)&&entry.name!=='receipt.private.json').map(entry=>entry.name));
  for(const kind of ['server-data','audit-objects']){
    const subdir=path.join(directory,kind);
    if(!await safeDirectory(subdir))continue;
    for(const entry of await fs.readdir(subdir,{withFileTypes:true})){
      if(entry.isFile()&&filename.test(entry.name)&&entry.name!=='files.private.json')names.add(kind+'/'+entry.name);
    }
  }
  assert(names.size<=10_000,'Abandoned audit workspace exceeds its inventory bound');
  // Archive receipts establish exact original inputs even if the interrupted build never wrote a manifest.
  const source=await abandonedSource(directory,retirement);
  if(!source)return null;
  const originalReceipt=await bytes(path.join(directory,'receipt.private.json'),2*1024*1024);
  const saved=originalReceipt?JSON.parse(originalReceipt):null;
  const baseline=saved&&retained.find(item=>item.root===saved.baseline?.path&&item.sha256===saved.baseline.manifestSha256);
  const derived=baseline&&manifest&&saved.version===1&&saved.root===manifest.root&&saved.manifestSha256===manifest.sha256
    &&saved.canonical?.reviewsPath===path.join(directory,'saved-current/current-reviews.private.json')
    &&saved.canonical.reviewsSha256===source.source.reviewsSha256&&saved.canonical.browserSha256===source.source.browserSha256
    &&JSON.stringify(saved.canonical.head)===JSON.stringify(source.head);
  const files=[];
  async function plan(relative,actual,provenance){
    const stat=await fs.lstat(path.join(directory,relative));
    assert(stat.isFile()&&stat.size===actual.bytes,'Abandoned audit workspace file changed');
    files.push({path:relative,...actual,allocatedBytes:stat.nlink===1?stat.blocks*512:0,provenance});
  }
  for(const [relative,actual]of source.copies)await plan(relative,actual,{kind:'archived-source'});
  for(const relative of names){
    if(!eligible(relative))continue;
    const [kind,name]=relative.split('/'),key=archiveKey(relative);
    const references=kind==='server-data'?retained.filter(item=>digest.test(item.files[name])):[];
    const expected=kind==='server-data'?manifest?.files[name]:null;
    if(!key&&!references.length&&!(derived&&(digest.test(expected)||buildFiles.has(relative))))continue;
    const actual=await localFingerprint(path.join(directory,relative));
    if(!actual)continue;
    if(key&&await exactArchiveReceipt(receiptRoot,key+'.gz',actual)){
      await plan(relative,actual,{kind:'archive',key:key+'.gz'});
      continue;
    }
    let matched=false;
    for(const ref of references){
      if(ref.files[name]!==actual.sha256)continue;
      const duplicate=await localFingerprint(path.join(ref.root,name));
      if(duplicate?.sha256!==actual.sha256||duplicate.bytes!==actual.bytes)continue;
      await plan(relative,actual,{kind:'retained',root:ref.root,manifestSha256:ref.sha256});
      matched=true;break;
    }
    if(!matched&&derived&&(expected===actual.sha256||buildFiles.has(relative)))await plan(relative,actual,{kind:'derived'});
  }
  return {files,version:1,status:'prepared',kind:'abandoned',scope:derived?'source-and-rebuild':'copies-only',manifestSha256:manifest?.sha256??null,
    source:source.source,sourceBasis:source.sourceBasis,recipe:source.recipe,
    baseline:derived?{root:baseline.root,manifestSha256:baseline.sha256,receiptSha256:sha(originalReceipt)}:null,
    verifiedAt:new Date().toISOString()};
}

export async function retireAbandonedDriverAuditAttempt({directory,protectedManifests,retainedRoots,receiptRoot,retirement,apply}){
  if(!await safeDirectory(directory))return null;
  let manifest;
  try{manifest=await readLocalManifest(path.join(directory,'server-data'));}
  catch{return 'proof-unavailable';}
  if(manifest&&protectedManifests.has(manifest.sha256)||!manifest&&protectedManifests.size>0&&await fs.lstat(path.join(directory,'server-data/files.private.json')).catch(missing))return null;
  const receipt=path.join(directory,abandonedReceipt);
  let proof=await privateAuditJson(receipt).catch(missing),files;
  if(proof?.status==='retired')return null;
  if(!proof&&!manifest&&!await safeDirectory(path.join(directory,'saved-current')))return null;
  const retained=[];
  for(const candidate of retainedRoots){
    const copy=await readLocalManifest(candidate.root).catch(()=>null);
    if(copy?.sha256===candidate.manifestSha256)retained.push(copy);
  }
  if(proof){
    assert(proof.version===1&&proof.kind==='abandoned'&&proof.manifestSha256===(manifest?.sha256??null),'Abandoned audit workspace changed');
    files=await readInventory(directory,proof,abandonedInventory);
  }else{
    let prepared;
    try{prepared=await planAbandoned({directory,manifest,retained,receiptRoot,retirement});}
    catch{return 'proof-unavailable';}
    if(!prepared)return 'proof-unavailable';
    const {files:inventory,...summary}=prepared;
    if(!inventory.length)return null;
    files=inventory;
    if(apply)proof=await saveInventory(directory,receipt,abandonedInventory,summary,files);
  }
  if(apply)await finishInventory(directory,receipt,proof,files,async item=>{
    const witness=item.provenance;
    if(witness?.kind==='archive')assert(await exactArchiveReceipt(receiptRoot,witness.key,item),'Abandoned audit archive receipt changed');
    else if(witness?.kind==='retained'){
      const name=item.path.split('/')[1];
      const copy=retained.find(ref=>ref.root===witness.root&&ref.sha256===witness.manifestSha256&&ref.files[name]===item.sha256);
      const actual=copy&&await localFingerprint(path.join(copy.root,name));
      assert(actual?.sha256===item.sha256&&actual.bytes===item.bytes,'Abandoned audit retained copy changed');
    }else if(witness?.kind==='archived-source')assert(proof.source&&item.path.startsWith('saved-current/'),'Abandoned audit source proof changed');
    else if(witness?.kind==='derived'){
      const base=retained.find(ref=>ref.root===proof.baseline?.root&&ref.sha256===proof.baseline.manifestSha256);
      assert(proof.source&&base,'Abandoned audit rebuild proof changed');
    }else throw Error('Unknown abandoned audit restore provenance');
  });
  return {files:files.length,bytes:files.reduce((total,item)=>total+item.bytes,0),allocatedBytes:files.reduce((total,item)=>total+item.allocatedBytes,0)};
}
