import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {acquireWorkerLock} from '../hosted/worker-lock.mjs';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
// Scheduling receipts and lease revisions are not new evidence. Photo-only and
// GPS-only arrivals are, even when the delivery report hash has not changed.
export function automaticReleaseBasis(publication){
 const {head}=publication||{};
 if(!/^[a-f0-9]{64}$/.test(head?.reportHash||'')||! /^[a-f0-9]{64}$/.test(head?.manifest?.sha256||''))throw Error('Invalid saved feed head');
 return sha(canonical({head:{reportHash:head.reportHash,manifest:head.manifest,gps:head.gps},gps:Object.fromEntries(Object.entries(publication.gpsState||{}).map(([k,v])=>[k,v.stateManifest])),photos:publication.cloudPhotoResults||{},photoBindingRepair:publication.photoBindingRepair||null}));
}
async function read(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function write(file,value){const tmp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value),{mode:0o600});await fs.rename(tmp,file);}

// Local candidate promotion only. This never changes the hosted publication or
// a review journal. A process crash releases the OS lock; successful candidates
// and failed attempts remain separately inspectable on disk.
export function createAutomaticRelease({root,baselineRoot,loadSource,build,validate,recipeId=null,clock=()=>new Date(),lock=acquireWorkerLock,pinnedDirectSync=false}){
 if(typeof pinnedDirectSync!=='boolean')throw Error('Invalid direct audit sync mode');
 if(recipeId!==null&&!/^[a-f0-9]{64}$/.test(recipeId))throw Error('Invalid automatic build recipe');
 if(!path.isAbsolute(root||'')||!path.isAbsolute(baselineRoot||'')||[loadSource,build,validate,clock,lock].some(f=>typeof f!=='function')||root===baselineRoot||baselineRoot.startsWith(root+path.sep)||root.startsWith(baselineRoot+path.sep))throw Error('Separate automatic candidate directory required');
 const pointerFile=path.join(root,'current.private.json'),statusFile=path.join(root,'status.private.json');
 return {pointerFile,status:()=>read(statusFile,null),async tick(){
  await fs.mkdir(root,{recursive:true,mode:0o700});const lease=await lock(path.join(root,'runner.lock'));
  let attempt=null;
  try{
   const identity=publication=>recipeId?sha({source:automaticReleaseBasis(publication),recipeId}):automaticReleaseBasis(publication);
   const source=await loadSource(),basis=identity(source.publication),prior=await read(pointerFile,null);
   if(prior?.basis===basis){await write(statusFile,{status:'unchanged',basis,checkedAt:clock().toISOString(),current:prior});return {status:'unchanged',basis};}
   attempt={id:randomUUID(),basis,startedAt:clock().toISOString(),status:'building'};
   await write(statusFile,{...attempt,current:prior});const output=path.join(root,'attempts',attempt.id);await fs.mkdir(output,{recursive:true,mode:0o700});
   const candidate=await build({source,basis,output,baselineRoot:prior?.privateRoot||baselineRoot});
   const privateRoot=await fs.realpath(candidate.privateRoot),attemptRoot=await fs.realpath(output);
   if(!privateRoot.startsWith(attemptRoot+path.sep))throw Error('Candidate escaped isolated attempt');
   attempt.status='validating';await write(statusFile,{...attempt,current:prior});
   const verification=await validate({...candidate,basis});if(verification?.ok!==true)throw Error('Candidate validation failed');
   const manifest=await fs.readFile(path.join(privateRoot,'files.private.json'));
   const manifestSha256=createHash('sha256').update(manifest).digest('hex');
   if(manifestSha256!==verification.manifestSha256)throw Error('Candidate changed after validation');
   if(!pinnedDirectSync){
    const latest=await loadSource();
    if(identity(latest.publication)!==basis){await write(statusFile,{...attempt,status:'superseded',current:prior});return {status:'superseded',basis};}
   }else if(!Number.isSafeInteger(source.savedState?.revision)||source.savedState.revision<1||prior?.collectorRevision>source.savedState.revision){
    throw Error('Invalid pinned audit source revision');
   }
   const pointer={version:1,basis,sourceBasis:automaticReleaseBasis(source.publication),...(pinnedDirectSync?{collectorRevision:source.savedState.revision}:{}),baselineRoot:prior?.privateRoot||baselineRoot,privateRoot,manifestSha256,verifiedAt:clock().toISOString(),previous:prior?{basis:prior.basis,privateRoot:prior.privateRoot,manifestSha256:prior.manifestSha256}:null};
   await write(path.join(output,'accepted.private.json'),pointer);
   // Last operation that exposes this generation: one atomic local rename.
   await write(pointerFile,pointer);await write(statusFile,{status:'ready',basis,checkedAt:clock().toISOString(),current:pointer});
   return {status:'ready',...pointer};
  }catch(error){await write(statusFile,{status:'retry-pending',attempt,checkedAt:clock().toISOString(),current:await read(pointerFile,null),reason:'Build or verification failed; previous report retained'});throw error;}
  finally{await lease.release();}
 }};
}

export function runAutomaticReleaseLoop(worker,{intervalMs=60000,setTimer=setTimeout,clearTimer=clearTimeout,onResult=()=>{}}={}){
 if(!worker?.tick||!Number.isInteger(intervalMs)||intervalMs<1000)throw Error('Invalid release loop');
 let stopped=false,timer,pending;
 const notify=result=>{try{onResult(result);}catch{/* Logging must not break the retry loop. */}};
 const run=async()=>{try{notify(await worker.tick());}catch{notify({status:'retry-pending'});}finally{if(!stopped)timer=setTimer(()=>{pending=run();},intervalMs);}};
 pending=run();return {async stop(){stopped=true;clearTimer(timer);await pending;}};
}
