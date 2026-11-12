import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createGunzip,gzipSync,gunzipSync} from 'node:zlib';
import {privateAuditJson,privateAuditWrite} from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import {createCloudRepository,readManifestBytes} from '../vendor/driver-audits/integration/cloud/repository.mjs';

const digest=/^[a-f0-9]{64}$/;
const filename=/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const objectName=/^[a-f0-9]{64}\.gz$/;
const maxFile=128*1024*1024;
const receiptName='retired-workspace.private.json';
const inventoryName='retired-workspace-inventory.private.json.gz';
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
    const inventory=gzipSync(Buffer.from(JSON.stringify(files)));
    const inventoryFile=path.join(directory,inventoryName);
    await privateAuditWrite(inventoryFile,inventory);
    await syncPath(inventoryFile);
    proof={...summary,inventoryFile:inventoryName,inventoryCompressedSha256:sha(inventory)};
    await privateAuditWrite(file,JSON.stringify(proof));
    await syncPath(file);
    await syncPath(directory);
  }
  assert(proof.version===1&&proof.manifestSha256===seed.manifestSha256&&proof.sourceBasis===seed.sourceBasis,
    'Audit workspace retirement proof changed');
  if(proof.status==='retired')return 'already-retired';
  assert(proof.status==='prepared'&&proof.inventoryFile===inventoryName,'Invalid audit workspace retirement receipt');
  const inventory=await bytes(path.join(directory,inventoryName),16*1024*1024);
  assert(inventory&&sha(inventory)===proof.inventoryCompressedSha256,'Invalid compressed audit workspace inventory');
  const decoded=gunzipSync(inventory,{maxOutputLength:16*1024*1024}),files=JSON.parse(decoded);
  assert(Array.isArray(files)&&files.length<=10_000&&sha(decoded)===proof.inventorySha256,
    'Invalid audit workspace retirement inventory');
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
    await fs.unlink(target);
  }
  for(const parent of affected)await syncPath(parent);
  await privateAuditWrite(file,JSON.stringify({...proof,status:'retired',retiredAt:new Date().toISOString(),
    removedFiles:files.length,removedBytes:files.reduce((total,item)=>total+item.bytes,0)}));
  await syncPath(file);
  await syncPath(directory);
  return 'retired';
}
