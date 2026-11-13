import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createDriverAuditReplica} from './driverAuditReplica.js';
import {assertDriverAuditWriter,driverAuditWriteOptions,withDriverAuditWriter} from './driverAuditWriter.js';
import {checkedAuditPointer,importAuditReplica} from '../vendor/driver-audits/integration/cloud/audit-replica.mjs';
import {loadRemotePreviewPackage} from '../vendor/driver-audits/integration/cloud/remote-preview-package.mjs';
import {readManifestBytes} from '../vendor/driver-audits/integration/cloud/repository.mjs';

const maxChunkBytes=8*1024*1024;
const maxTransferBytes=128*1024*1024;
const maxCapacityBytes=256*1024*1024;
const digestPattern=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const isHash=value=>typeof value==='string'&&digestPattern.test(value);
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const isAbsolute=value=>typeof value==='string'&&!value.includes('\0')&&path.isAbsolute(value);
const isOwnerOnly=stat=>(stat.mode&0o077)===0&&(typeof process.getuid!=='function'||stat.uid===process.getuid());
const isTimestamp=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value))return false;
  const parsed=new Date(value);
  const normalized=value.includes('.')?value:value.replace(/Z$/,'.000Z');
  return Number.isFinite(parsed.getTime())&&parsed.toISOString()===normalized;
};

export class DriverAuditDirectImportError extends Error {}

async function privateFile(file,maxBytes){
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||!isOwnerOnly(stat)||stat.size<1||stat.size>maxBytes){
      throw new DriverAuditDirectImportError('An owner-only, bounded regular file is required.');
    }
    const buffer=Buffer.alloc(stat.size);
    let offset=0;
    while(offset<buffer.length){
      const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);
      if(!bytesRead)throw new DriverAuditDirectImportError('A private audit file changed while being read.');
      offset+=bytesRead;
    }
    if((await handle.stat()).size!==buffer.length)throw new DriverAuditDirectImportError('A private audit file changed while being read.');
    return buffer;
  }finally{await handle.close();}
}

function validatedConfig(config){
  if(!isObject(config)||config.version!==1||!['bootstrap','sync'].includes(config.mode)||
     !isAbsolute(config.bundleRoot)||!Number.isSafeInteger(config.collectorRevision)||config.collectorRevision<1||
     !isHash(config.sourceBasis)||!isHash(config.manifestSha256)||
     (config.visibleCutoffAt!==null&&!isTimestamp(config.visibleCutoffAt))){
    throw new DriverAuditDirectImportError('Invalid direct audit import configuration.');
  }
  const {pointer,closureReceipt,restore}=config;
  const descriptor=pointer?.descriptor;
  if(pointer?.version!==1||!isHash(pointer.generation)||!isHash(pointer.reportHash)||
     descriptor?.version!==1||descriptor.domain!=='previewPackage'||descriptor.path!=='descriptor.json'||
     descriptor.kind!=='immutable-evidence'||!isHash(descriptor.sha256)||
     !Number.isSafeInteger(descriptor.size)||descriptor.size<1||descriptor.size>maxChunkBytes||
     !Array.isArray(descriptor.chunks)||!descriptor.chunks.length||
     descriptor.chunks.some(chunk=>!validChunk(chunk)||!Number.isSafeInteger(chunk.offset)||chunk.offset<0)){
    throw new DriverAuditDirectImportError('Invalid direct audit package pointer.');
  }
  const matchesBinding=receipt=>receipt?.version===1&&receipt.sourceBasis===config.sourceBasis&&
    receipt.manifestSha256===config.manifestSha256&&receipt.generation===pointer.generation&&
    receipt.reportHash===pointer.reportHash&&receipt.descriptorSha256===descriptor.sha256;
  if(!matchesBinding(closureReceipt)||closureReceipt.status!=='verified'||!isTimestamp(closureReceipt.checkedAt)||
     closureReceipt.checks?.archive!==true||closureReceipt.checks?.photos!==true||closureReceipt.checks?.reviewHistory!==true){
    throw new DriverAuditDirectImportError('A verified external audit closure receipt is required for this exact package.');
  }
  if(restore?.version!==1||restore.archive!=='matter-report-archive'||restore.verified!==true||
     restore.manifestSha256!==config.manifestSha256||restore.generation!==pointer.generation||
     restore.reportHash!==pointer.reportHash||restore.descriptorSha256!==descriptor.sha256){
    throw new DriverAuditDirectImportError('A verified private archive restore receipt is required for this exact package.');
  }
  return config;
}

function validChunk(chunk){
  return isHash(chunk?.sha256)&&Number.isSafeInteger(chunk.size)&&chunk.size>=1&&chunk.size<=maxChunkBytes;
}

export async function readDriverAuditSeedConfig(configPath){
  if(!isAbsolute(configPath))throw new DriverAuditDirectImportError('An absolute audit seed configuration path is required.');
  let config;
  try{config=JSON.parse(await privateFile(configPath,1024*1024));}
  catch{throw new DriverAuditDirectImportError('Use a valid owner-only JSON audit seed configuration.');}
  return validatedConfig(config);
}

async function localPackage(config){
  const {bundleRoot,pointer,manifestSha256}=config;
  const stat=await fs.lstat(bundleRoot).catch(()=>null);
  if(!stat?.isDirectory()||!isOwnerOnly(stat)){
    throw new DriverAuditDirectImportError('An owner-only audit bundle directory is required.');
  }
  const root=await fs.realpath(bundleRoot);
  const sourceTransport={
    async readObject(key,{maxBytes}){
      if(!/^[a-f0-9]{64}\.gz$/.test(key)||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>maxChunkBytes){
        throw new DriverAuditDirectImportError('Invalid audit package object request.');
      }
      return [await privateFile(path.join(root,key),maxBytes)];
    },
  };
  const descriptor=await readManifestBytes(sourceTransport,pointer.descriptor,{maxBytes:maxChunkBytes})
    .then(bytes=>JSON.parse(bytes))
    .catch(error=>{throw new DriverAuditDirectImportError('Audit package descriptor verification failed.',{cause:error});});
  if(descriptor?.sourceManifestSha256!==manifestSha256){
    throw new DriverAuditDirectImportError('Audit package descriptor does not match the pinned manifest.');
  }
  if(!isObject(descriptor.files))throw new DriverAuditDirectImportError('Invalid audit package descriptor files.');
  const publication=await readManifestBytes(sourceTransport,descriptor.files['publication.private.json'],{maxBytes:64*1024*1024})
    .then(bytes=>JSON.parse(bytes))
    .catch(error=>{throw new DriverAuditDirectImportError('Audit package source metadata verification failed.',{cause:error});});
  const observedAt=publication?.head?.source?.observedAt??null;
  const cutoffMatches=observedAt===null?config.visibleCutoffAt===null:
    isTimestamp(observedAt)&&config.visibleCutoffAt!==null&&Date.parse(observedAt)===Date.parse(config.visibleCutoffAt);
  if(!cutoffMatches)throw new DriverAuditDirectImportError('The audit cutoff does not match the verified package source.');
  const chunks=new Map();
  for(const ref of [pointer.descriptor,...Object.values(descriptor.files)]){
    if(!Array.isArray(ref?.chunks))throw new DriverAuditDirectImportError('Invalid audit package file reference.');
    for(const chunk of ref.chunks){
      if(!validChunk(chunk)||(chunks.has(chunk.sha256)&&chunks.get(chunk.sha256)!==chunk.size)){
        throw new DriverAuditDirectImportError('Invalid audit package chunk reference.');
      }
      chunks.set(chunk.sha256,chunk.size);
    }
  }
  return {sourceTransport,chunks};
}

export function driverAuditPackagePointer(config){
  const {collectorRevision,sourceBasis,manifestSha256,visibleCutoffAt,pointer,restore}=config;
  const {version,domain,path,kind,size,sha256,chunks}=pointer.descriptor;
  return {
    revision:collectorRevision,
    body:JSON.stringify({
      version:1,generation:pointer.generation,reportHash:pointer.reportHash,
      descriptor:{version,domain,path,kind,size,sha256,chunks:chunks.map(({offset,size,sha256})=>({offset,size,sha256}))},
      directImport:{version:1,collectorRevision,sourceBasis,manifestSha256},
      visibleCutoffAt:visibleCutoffAt===null?null:new Date(visibleCutoffAt).toISOString(),
      restore:{
        version:1,archive:restore.archive,verified:true,manifestSha256,generation:restore.generation,
        reportHash:restore.reportHash,descriptorSha256:restore.descriptorSha256,
      },
    }),
  };
}

function checkTarget(prior,incoming,mode,databaseChecked){
  if(!databaseChecked)return;
  if(!prior){
    if(mode!=='bootstrap')throw new DriverAuditDirectImportError('A direct audit bootstrap must be active before syncing.');
    return;
  }
  if(prior.directImport?.version!==1||prior.directImport.collectorRevision!==prior.sourceRevision||
     !Number.isSafeInteger(prior.sourceRevision)||prior.sourceRevision<1||!isHash(prior.sourceBodySha256)){
    throw new DriverAuditDirectImportError('The existing audit head was not created by a direct import.');
  }
  if(incoming.sourceRevision===prior.sourceRevision){
    if(incoming.sourceBodySha256!==prior.sourceBodySha256)throw new DriverAuditDirectImportError('Direct audit source revision conflict.');
    return;
  }
  if(incoming.sourceRevision<prior.sourceRevision)throw new DriverAuditDirectImportError('Direct audit source revision moved backwards.');
  if(mode==='bootstrap')throw new DriverAuditDirectImportError('The existing audit head requires direct sync mode.');
}

function plannedCapacity(chunks,ledger,capacityBytes){
  const used=ledger?.used??0,allocations=ledger?.allocations??{};
  if(ledger&&(ledger.limit!==capacityBytes||!Number.isSafeInteger(used)||used<0||used>capacityBytes||!isObject(allocations))){
    throw new DriverAuditDirectImportError('The existing audit capacity ledger does not match the configured allowance.');
  }
  let transferBytes=0,additionalChargeBytes=0;
  for(const [sha256,size] of chunks){
    transferBytes+=size;
    const charge=size+1024;
    if(!Object.hasOwn(allocations,sha256))additionalChargeBytes+=charge;
    else if(allocations[sha256]!==charge)throw new DriverAuditDirectImportError('An existing audit allocation disagrees with the verified package.');
  }
  const freeReplicaBytes=capacityBytes-used;
  const capacity=transferBytes>maxTransferBytes
    ?{kind:'import-transfer',availableBytes:maxTransferBytes,requiredBytes:transferBytes}
    :additionalChargeBytes>freeReplicaBytes
      ?{kind:'replica-storage',availableBytes:freeReplicaBytes,requiredBytes:additionalChargeBytes}
      :null;
  if(capacity){
    throw Object.assign(new DriverAuditDirectImportError('The audit package exceeds its transfer or storage capacity.'),{
      code:'AUDIT_CAPACITY',capacity,
    });
  }
  return {transferBytes,additionalChargeBytes};
}

export function driverAuditSourceHead(prior){
  if(!prior)return null;
  const {version,generation,reportHash,descriptor,sourceRevision,sourceBodySha256,directImport,visibleCutoffAt,restore}=prior;
  return {version,generation,reportHash,descriptor,sourceRevision,sourceBodySha256,directImport,visibleCutoffAt,restore};
}

function dryRunStore(){
  const staged=new Map();
  let head=null;
  return {
    head:async()=>head,
    putObject:async(key,bytes)=>{staged.set(key,bytes);},
    readObject:async(key,{maxBytes})=>{
      const bytes=staged.get(key);
      if(!bytes||bytes.length>maxBytes)throw new DriverAuditDirectImportError('Audit package readback failed.');
      return [bytes];
    },
    activate:async({head:next})=>{head=next;},
  };
}

function pinnedReplica(replica,prior,{startStage,checkWriter}){
  let activated=false;
  return {
    head:async()=>activated?replica.head():prior,
    async putObject(key,bytes){
      await startStage();
      return replica.putObject(key,bytes);
    },
    readObject:(key,options)=>replica.readObject(key,options),
    async activate({expected,head}){
      await checkWriter();
      await replica.activate({expected,head:{...head,previous:driverAuditSourceHead(expected)}});
      activated=true;
    },
  };
}

export async function runDriverAuditDirectImport({config,db,capacityBytes,apply=false,cloudImportEnabled=false}){
  validatedConfig(config);
  if(!Number.isSafeInteger(capacityBytes)||capacityBytes<1||capacityBytes>maxCapacityBytes){
    throw new DriverAuditDirectImportError('An explicit audit storage capacity is required.');
  }
  if(cloudImportEnabled)throw new DriverAuditDirectImportError('Disable automatic imports before using direct audit import.');
  if(apply&&!db)throw new DriverAuditDirectImportError('The existing app database is required to apply an audit import.');
  const pointer=driverAuditPackagePointer(config),incoming=checkedAuditPointer(pointer);
  const packageData=await localPackage(config);
  const run=token=>importIntoTarget({config,db,capacityBytes,apply,token,pointer,incoming,...packageData});
  return apply?withDriverAuditWriter(db,run):run(null);
}

async function importIntoTarget({config,db,capacityBytes,apply,token,pointer,incoming,sourceTransport,chunks}){
  const replica=db?createDriverAuditReplica(db,{capacityBytes}):null;
  const control=db?.collection('driverAuditControl');
  const prior=replica?await replica.head():null;
  checkTarget(prior,incoming,config.mode,Boolean(db));
  const ledger=await control?.findOne({_id:'capacity'});
  if(prior&&!ledger)throw new DriverAuditDirectImportError('The existing audit head has no capacity ledger.');
  const plan=plannedCapacity(chunks,ledger,capacityBytes);
  const stage=await control?.findOne({_id:'direct-stage'});
  const stageIdentity={'pointer.sourceBodySha256':incoming.sourceBodySha256,'pointer.sourceRevision':incoming.sourceRevision};
  if(stage&&(stage.pointer?.sourceBodySha256!==incoming.sourceBodySha256||stage.pointer?.sourceRevision!==incoming.sourceRevision||
     stage.pointer?.descriptor?.sha256!==incoming.descriptor.sha256||stage.pointer?.generation!==incoming.generation||
     stage.pointer?.reportHash!==incoming.reportHash)){
    throw new DriverAuditDirectImportError('An unresolved direct audit stage exists for a different package.');
  }
  let staged=Boolean(stage);
  const checkWriter=()=>assertDriverAuditWriter(db,token);
  const startStage=async()=>{
    if(staged)return;
    await checkWriter();
    await control.insertOne({_id:'direct-stage',pointer:incoming},driverAuditWriteOptions);
    staged=true;
  };
  const store=apply?pinnedReplica(replica,prior,{startStage,checkWriter}):dryRunStore();
  let result;
  try{
    result=await importAuditReplica({loadSource:async()=>pointer,sourceTransport,store,maxBytes:maxTransferBytes});
    if(!['imported','unchanged'].includes(result.status)||result.head?.sourceBodySha256!==incoming.sourceBodySha256){
      throw new DriverAuditDirectImportError('The direct audit head did not match the selected package.');
    }
    if(apply&&result.status==='unchanged'){
      const loaded=await loadRemotePreviewPackage({descriptor:incoming.descriptor,transport:replica});
      for(const ref of Object.values(loaded.descriptor.files)){
        await readManifestBytes(replica,ref,{maxBytes:maxTransferBytes});
      }
      if((await replica.head())?.sourceBodySha256!==incoming.sourceBodySha256){
        throw new DriverAuditDirectImportError('The active audit changed during readback.');
      }
    }
    if(apply&&staged){
      await checkWriter();
      const removed=await control.deleteOne({_id:'direct-stage',...stageIdentity},driverAuditWriteOptions);
      if(removed.deletedCount!==1)throw new DriverAuditDirectImportError('The staged audit could not be confirmed cleared.');
    }
  }catch(error){
    if(error?.code==='AUDIT_WRITER_BUSY')throw error;
    throw new DriverAuditDirectImportError('Audit package verification or database readback failed.',{cause:error});
  }
  const {mode,manifestSha256,sourceBasis,collectorRevision}=config;
  return {
    status:apply?result.status:'ready',mode,generation:incoming.generation,reportHash:incoming.reportHash,
    manifestSha256,sourceBasis,collectorRevision,visibleCutoffAt:incoming.visibleCutoffAt,objects:chunks.size,
    ...plan,capacityBytes,databaseChecked:Boolean(db),
  };
}
