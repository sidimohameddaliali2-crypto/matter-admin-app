import {createHash} from 'node:crypto';
import {assertDriverAuditWriter,driverAuditWriteOptions} from './driverAuditWriter.js';
import {readManifestBytes} from '../vendor/driver-audits/integration/cloud/repository.mjs';

const maxChunkBytes=8*1024*1024;
const digestPattern=/^[a-f0-9]{64}$/;
const isDigest=value=>typeof value==='string'&&digestPattern.test(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function restorable(pointer){
  const {restore,directImport}=pointer??{};
  return pointer?.version===1&&isDigest(pointer.generation)&&isDigest(pointer.reportHash)&&
    isDigest(pointer.sourceBodySha256)&&isDigest(pointer.descriptor?.sha256)&&
    Number.isSafeInteger(pointer.sourceRevision)&&pointer.sourceRevision>0&&
    directImport?.version===1&&directImport.collectorRevision===pointer.sourceRevision&&
    isDigest(directImport.manifestSha256)&&isDigest(directImport.sourceBasis)&&restore?.version===1&&restore.verified===true&&
    restore.archive==='matter-report-archive'&&restore.manifestSha256===directImport.manifestSha256&&
    restore.generation===pointer.generation&&restore.reportHash===pointer.reportHash&&
    restore.descriptorSha256===pointer.descriptor.sha256;
}

async function pointerKeys(archive,pointer){
  const ref=pointer.descriptor;
  const body=await readManifestBytes(archive,ref,{maxBytes:maxChunkBytes});
  const descriptor=JSON.parse(body);
  if(descriptor?.version!==1||descriptor.generation!==pointer.generation||descriptor.reportHash!==pointer.reportHash||
     descriptor.sourceManifestSha256!==pointer.directImport.manifestSha256||!descriptor.files||
     typeof descriptor.files!=='object'||Array.isArray(descriptor.files)||!Object.keys(descriptor.files).length){
    throw new Error('The archived audit descriptor disagrees with its retained release.');
  }
  const keys=new Map();
  for(const manifest of [ref,...Object.values(descriptor.files)]){
    if(!Array.isArray(manifest?.chunks))throw new Error('An archived audit file reference is invalid.');
    for(const {sha256,size} of manifest.chunks){
      const key=sha256+'.gz';
      if(!isDigest(sha256)||!Number.isSafeInteger(size)||size<1||size>maxChunkBytes||
         (keys.has(key)&&keys.get(key)!==size))throw new Error('An archived audit chunk reference is invalid.');
      keys.set(key,size);
    }
  }
  return keys;
}

async function readState(control,options){
  const head=(await control.findOne({_id:'head'},options))?.head??null;
  const stage=await control.findOne({_id:'direct-stage'},options);
  const ledger=await control.findOne({_id:'capacity'},options);
  return {head,stage:stage??null,ledger:ledger??null};
}

function verifiedObject(doc,key,size){
  const bytes=Buffer.isBuffer(doc?.bytes)?doc.bytes:doc?.bytes?.value?.(true);
  if(doc?.size!==size||!bytes||bytes.length!==size||hash(bytes)!==key.slice(0,-3)){
    throw new Error('The MongoDB audit object does not match its immutable reference.');
  }
  return Buffer.from(bytes);
}

async function plan({db,archive,maxObjects=64}){
  if(!db||typeof archive?.readObject!=='function'||!Number.isInteger(maxObjects)||maxObjects<1||maxObjects>64){
    throw new Error('A bounded audit GC request with private archive access is required.');
  }
  const control=db.collection('driverAuditControl'),objects=db.collection('driverAuditObjects');
  const state=await readState(control);
  const {head,stage,ledger}=state;
  if(!head)return {state,candidates:[],protectedObjects:0,reclaimBytes:0};
  if(!restorable(head)||(head.previous&&!restorable(head.previous)))throw new Error('The active or previous audit lacks a verified archive restore.');
  if(stage&&!restorable(stage.pointer))throw new Error('The unresolved audit stage has no verified archive pointer.');
  if(!ledger||!Number.isSafeInteger(ledger.used)||ledger.used<0||
     !Number.isSafeInteger(ledger.limit)||ledger.limit<ledger.used||
     !ledger.allocations||typeof ledger.allocations!=='object'||Array.isArray(ledger.allocations)){
    throw new Error('The audit capacity ledger is invalid.');
  }
  const protectedKeys=new Set();
  for(const pointer of [head,head.previous,stage?.pointer].filter(Boolean)){
    for(const key of (await pointerKeys(archive,pointer)).keys())protectedKeys.add(key);
  }
  const unprotected=new Set(Object.keys(ledger.allocations).map(digest=>digest+'.gz').filter(key=>!protectedKeys.has(key)));
  if(!unprotected.size)return {state,candidates:[],protectedObjects:protectedKeys.size,reclaimBytes:0};
  const old=db.collection('driverAuditReleases').find({}, {projection:{head:1},sort:{'head.sourceRevision':-1}});
  const candidates=[];
  for(const {head:prior} of await old.toArray()){
    if(!restorable(prior)||prior.sourceRevision>=head.sourceRevision)continue;
    for(const [key,size] of await pointerKeys(archive,prior)){
      if(!unprotected.delete(key))continue;
      const digest=key.slice(0,-3),charge=size+1024;
      const doc=await objects.findOne({_id:key});
      if(!doc)continue;
      if(ledger.allocations[digest]!==charge)throw new Error('The audit object has no matching capacity charge.');
      const local=verifiedObject(doc,key,size);
      const restored=await readManifestBytes(archive,{
        version:1,sha256:digest,size,chunks:[{offset:0,size,sha256:digest}],
      },{maxBytes:maxChunkBytes}).catch(error=>{throw new Error('Private archive readback failed before audit GC.',{cause:error});});
      if(!local.equals(restored))throw new Error('The private archive copy differs from the MongoDB audit object.');
      candidates.push({key,size,charge});
      if(candidates.length===maxObjects)break;
    }
    if(!unprotected.size||candidates.length===maxObjects)break;
  }
  const reclaimBytes=candidates.reduce((total,object)=>total+object.charge,0);
  if(reclaimBytes>ledger.used)throw new Error('The audit GC plan exceeds the verified capacity ledger.');
  return {state,candidates,protectedObjects:protectedKeys.size,reclaimBytes};
}

export async function planDriverAuditGarbage(options){
  const {candidates,protectedObjects,reclaimBytes}=await plan(options);
  return {candidates,protectedObjects,reclaimBytes};
}

export async function collectDriverAuditGarbage({db,client,archive,writerToken,apply=false,maxObjects}){
  if(!apply)return {status:'planned',...await planDriverAuditGarbage({db,archive,maxObjects})};
  await assertDriverAuditWriter(db,writerToken);
  const {state,candidates,protectedObjects,reclaimBytes}=await plan({db,archive,maxObjects});
  if(!candidates.length)return {status:'unchanged',objectsRemoved:0,bytesReclaimed:0,protectedObjects};
  if(typeof client?.startSession!=='function')throw new Error('Audit GC requires MongoDB transactions.');
  const control=db.collection('driverAuditControl'),objects=db.collection('driverAuditObjects');
  const expected=hash(JSON.stringify(state));
  const session=client.startSession();
  try{
    await session.withTransaction(async()=>{
      const options={session};
      await assertDriverAuditWriter(db,writerToken,options);
      if(hash(JSON.stringify(await readState(control,options)))!==expected){
        throw new Error('The audit head, stage or ledger changed after archive verification.');
      }
      // A conditional write to the lock and head gives MongoDB a write conflict
      // if a concurrent operator changes either record during this transaction.
      const writer=await control.updateOne({_id:'direct-writer',token:writerToken},{$inc:{gcFence:1}},options);
      const head=await control.updateOne({_id:'head','head.sourceBodySha256':state.head.sourceBodySha256},{$inc:{gcFence:1}},options);
      if(writer.matchedCount!==1||head.matchedCount!==1)throw new Error('The audit GC writer or head changed.');
      for(const {key,size} of candidates){
        verifiedObject(await objects.findOne({_id:key},options),key,size);
        const removed=await objects.deleteOne({_id:key,size},options);
        if(removed.deletedCount!==1)throw new Error('An audit GC object changed before deletion.');
      }
      const unset=Object.fromEntries(candidates.map(({key})=>['allocations.'+key.slice(0,-3),'']));
      const updated=await control.updateOne({_id:'capacity',used:state.ledger.used},{$inc:{used:-reclaimBytes},$unset:unset},options);
      if(updated.matchedCount!==1)throw new Error('The audit GC capacity ledger changed.');
    },{readConcern:{level:'snapshot'},writeConcern:driverAuditWriteOptions.writeConcern});
  }finally{await session.endSession();}
  return {status:'collected',objectsRemoved:candidates.length,bytesReclaimed:reclaimBytes,protectedObjects};
}
