import '../loadEnv.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import {runDriverAuditSyncTick} from '../services/driverAuditSync.js';
import {runDriverAuditDirectImport} from '../services/driverAuditDirectImport.js';
import {collectDriverAuditGarbage} from '../services/driverAuditGarbageCollection.js';
import {driverAuditReplicaRetentionStatus,driverAuditRetentionImplementation} from '../services/driverAuditRetention.js';
import {withDriverAuditWriter} from '../services/driverAuditWriter.js';
import {pruneDriverAuditWorkspace,requireDriverAuditBuildSpace} from '../services/driverAuditWorkspace.js';
import {pathToFileURL} from 'node:url';
import {createBudgetedAuditArchive,createBudgetedAuditState} from '../vendor/driver-audits/integration/cloud/driver-audit-archive.mjs';
import {prepareDirectAuditBundle,privateAuditDirectory,privateAuditJson,privateAuditWrite,verifyAuditBuilder} from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import {createCloudState} from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import {createHostedRpc} from '../vendor/driver-audits/integration/cloud/rpc.mjs';
import {createSupabaseArchiveTransport} from '../vendor/driver-audits/integration/hosted/supabase-archive.mjs';
import {acquireWorkerLock} from '../vendor/driver-audits/integration/hosted/worker-lock.mjs';

const interval=60_000;
const budgetRetry=5*interval;
const nullableIso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;

async function main(){
 const [flag,file,mode]=process.argv.slice(2);
 if(flag!=='--config'||!path.isAbsolute(file||'')||mode!==undefined&&mode!=='--check'||process.argv.length>5)throw Error('Invalid audit sync arguments');
 const config=await privateAuditJson(file);
 const {root,baselineRoot,codeRoot,builderSha256,rendererBuild,journals}=config;
 if(config.version!==1||path.dirname(file)!==root||baselineRoot!==path.join(root,'baseline')||
    codeRoot!==path.join(root,'builder')||
    rendererBuild?.path!==path.join(baselineRoot,'build.private.json')||journals?.path!==path.join(root,'validation-journals.private.json'))throw Error('Invalid staged audit sync config');
 await privateAuditDirectory(root);
 await privateAuditDirectory(baselineRoot);
 await verifyAuditBuilder(codeRoot,builderSha256);
 const load=name=>import(pathToFileURL(path.join(codeRoot,name)).href);
 const [{automaticReleaseBasis,createAutomaticRelease},{createAutomaticReleaseSource},{buildAutomaticRelease},{validateAutomaticCandidate}]=await Promise.all([
  load('integration/cloud/automatic-release.mjs'),
  load('integration/cloud/automatic-release-source.mjs'),
  load('integration/cloud/automatic-release-build.mjs'),
  load('scripts/run-automatic-report.mjs'),
 ]);
 const {MONGODB_URI:uri,DRIVER_AUDIT_SUPABASE_SECRET:secret}=process.env;
 const capacityBytes=Number(process.env.DRIVER_AUDIT_CAPACITY_BYTES);
 if(process.env.DRIVER_AUDIT_ENABLED!=='1'||process.env.DRIVER_AUDIT_IMPORT_ENABLED!=='0'||!uri||!secret||
    !Number.isSafeInteger(capacityBytes)||capacityBytes<1||capacityBytes>256*1024*1024)throw Error('Audit sync is not enabled with explicit bounds');
 const connection=mongoose.createConnection(uri,{autoCreate:false,autoIndex:false,maxPoolSize:2,serverSelectionTimeoutMS:5000});
 let lock;
 try{
  await connection.asPromise();
  const db=connection.db,control=db.collection('driverAuditControl');
  const readHead=async()=>(await control.findOne({_id:'head'}))?.head;
  const seed=await readHead();
  if(seed?.directImport?.version!==1)throw Error('Verified direct audit seed required');
  const rpc=createHostedRpc({secret}),state=createCloudState({rpc}),remote=createSupabaseArchiveTransport({secret});
  await remote.assertPrivate();
  const retentionRequested=process.env.DRIVER_AUDIT_REPLICA_GC_ENABLED==='1';
  const [retentionReceipt,implementationSha256]=retentionRequested?await Promise.all([
   privateAuditJson(path.join(root,'deployment-sync.json')).catch(()=>null),
   driverAuditRetentionImplementation().catch(()=>null),
  ]):[null,null];
  const replicaGcStatus=driverAuditReplicaRetentionStatus(retentionRequested,retentionReceipt,implementationSha256);
  const collectReplicas=replicaGcStatus==='qualified';
  if(retentionRequested&&!collectReplicas)console.warn('Driver audit replica retention withheld: '+replicaGcStatus+'. Audit sync remains enabled.');
  if(mode==='--check'){
   console.log(JSON.stringify({status:'checked',activeGeneration:seed.generation,replicaGcStatus}));
   return;
  }
  lock=await acquireWorkerLock(path.join(path.dirname(root),'sync-worker.lock'));
  const archive=createBudgetedAuditArchive({rpc,state,remote,receiptRoot:path.join(root,'archive-receipts'),requestBytes:4096+2*Buffer.byteLength(secret),approvedNovemberRelease:true,approvedNovemberSync:true});
  const boundedState=(responseLimit,select=cloud=>cloud)=>createBudgetedAuditState({state:select(createCloudState({rpc:createHostedRpc({secret,maxResponseBytes:responseLimit})})),
   budgetState:state,responseLimit,requestBytes:4096+2*Buffer.byteLength(secret),approvedNovemberRelease:true,approvedNovemberSync:true});
  const sourceState=boundedState(2*1024*1024),reviewState=boundedState(8*1024*1024);
  const sourceReceipts=boundedState(2*1024*1024,cloud=>({async read(revision){
   const [receipt]=await cloud.receipts('collector-state',{after:revision-1});
   if(receipt?.revision!==revision)throw Error('The pinned collector receipt is unavailable');
   return {revision,body:JSON.stringify(receipt)};
  }}));
  const bootstrap=await privateAuditJson(path.join(root,'seed.json')).catch(()=>null);
  const work=path.join(root,'work');
  const loadSource=createAutomaticReleaseSource({secret,stateStore:sourceState,cacheRoot:path.join(work,'archive-cache'),localRoots:[baselineRoot],archiveTransport:{readObject:archive.readBounded}});
  let pinned;
  const builder=createAutomaticRelease({
   root:work,baselineRoot,pinnedDirectSync:true,loadSource:async()=>pinned,
   async build(options){
    const disk=await fs.statfs(work);
    requireDriverAuditBuildSpace(disk.bavail*disk.bsize);
    return buildAutomaticRelease({...options,rendererBuild,archiveBackedBaseline:true});
   },
   validate:candidate=>validateAutomaticCandidate(candidate,{journals}),
  });
  const current=async()=>privateAuditJson(builder.pointerFile).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const configFor=candidate=>path.join(path.dirname(candidate.privateRoot),'direct-seed.private.json');
  const importConfig=async config=>{
   const apply=()=>runDriverAuditDirectImport({config,db,capacityBytes,apply:true});
   try{await apply();}
   catch(error){
    if(error.code!=='AUDIT_CAPACITY'||!collectReplicas)throw error;
    const reclaimed=await withDriverAuditWriter(db,writerToken=>collectDriverAuditGarbage({
     db,client:connection.getClient(),archive:{readObject:archive.readBounded},writerToken,apply:true,
    }));
    if(!reclaimed.objectsRemoved)throw error;
    await apply();
   }
  };
  async function recoverStage(){
   const stage=await control.findOne({_id:'direct-stage'});
   if(!stage)return;
   const candidate=await current();
   const file=candidate?.manifestSha256===stage.pointer?.directImport?.manifestSha256?configFor(candidate):path.join(root,'seed.json');
   const saved=await privateAuditJson(file);
   if(saved.manifestSha256!==stage.pointer?.directImport?.manifestSha256||
      saved.collectorRevision!==stage.pointer?.sourceRevision||
      saved.pointer?.descriptor?.sha256!==stage.pointer?.descriptor?.sha256)throw Error('Unresolved audit stage requires its pinned package');
   await importConfig(saved);
  }
  const heartbeat=path.join(root,'sync-status.private.json');
  const scheduled=await privateAuditJson(heartbeat).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  let next=Date.parse(scheduled?.nextCheckAt??'');
  if(!Number.isFinite(next)||next>Date.now()+budgetRetry)next=Date.now();
  let stopped=false,wake;
  const stop=()=>{stopped=true;wake?.();};
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
  async function status(value){
   const active=await readHead();
   const report={version:1,...value,replicaGcStatus,activeGeneration:active?.generation??null,checkedAt:new Date().toISOString(),nextCheckAt:new Date(next).toISOString()};
   await control.updateOne({_id:'sync-status'},{$set:report},{upsert:true});
   await privateAuditWrite(heartbeat,JSON.stringify(report));
  }
  await status({status:'pending',pending:true,errorCode:null,latestCaptureAt:scheduled?.latestCaptureAt??null,visibleCutoffAt:seed.visibleCutoffAt??null});
  while(!stopped){
   if(next>Date.now())await new Promise(resolve=>{
    const timer=setTimeout(resolve,next-Date.now());
    wake=()=>{clearTimeout(timer);resolve();};
   });
   if(stopped)break;
   next=Date.now()+interval;
   try{
    await recoverStage();
    await runDriverAuditSyncTick({
     async readSource(){
      pinned=await loadSource();
      return {revision:pinned.savedState.revision,basis:automaticReleaseBasis(pinned.publication),observedAt:nullableIso(pinned.publication.head.source?.observedAt)};
     },
     readHead,getCandidate:current,build:async()=>{
      const head=await readHead(),stage=await control.findOne({_id:'direct-stage'});
      const protectedManifests=[head,head?.previous,stage?.pointer]
       .map(pointer=>pointer?.directImport?.manifestSha256).filter(Boolean);
      const retirement={transport:pinned.transport,sourceBasis:automaticReleaseBasis,
       async readSourceReceipt(revision){
        const receipt=await sourceReceipts.read(revision);
        return {revision:receipt.revision,body:JSON.parse(receipt.body).body_text};
       },recipe:{builderSha256,rendererSha256:rendererBuild.sha256,journalsSha256:journals.sha256,baselineManifestSha256:bootstrap?.manifestSha256}};
      const workspace=await pruneDriverAuditWorkspace({root:work,receiptRoot:path.join(root,'archive-receipts'),protectedManifests,retirement});
      if(workspace.retirementDeferred)console.warn(JSON.stringify({event:'audit-workspace-retirement-deferred',attempts:workspace.retirementDeferred}));
      return builder.tick();
     },
     async apply(candidate){
      const config=await prepareDirectAuditBundle({
       privateRoot:candidate.privateRoot,bundleRoot:path.join(path.dirname(candidate.privateRoot),'audit-objects'),
       validation:{ok:true,manifestSha256:candidate.manifestSha256},archive,reviewState,
       collectorRevision:candidate.collectorRevision,sourceBasis:candidate.sourceBasis,mode:'sync',
       metadataRoot:path.join(work,'metadata'),
      });
      await privateAuditWrite(configFor(candidate),JSON.stringify(config));
      await importConfig(config);
     },
     status,
    });
   }catch(error){
    if(error.code==='AUDIT_BUDGET')next=Date.now()+budgetRetry;
    const state=error.code==='AUDIT_CAPACITY'?'capacity-blocked':error.code==='AUDIT_BUDGET'?'budget-deferred':'failed';
    const active=await readHead().catch(()=>null);
    const previous=await privateAuditJson(heartbeat).catch(()=>null);
    await status({status:state,pending:true,errorCode:state==='failed'?'SYNC_FAILED':error.code,
     visibleCutoffAt:active?.visibleCutoffAt??null,latestCaptureAt:previous?.latestCaptureAt??null}).catch(()=>{});
    console.error('Driver audit sync paused this refresh. See private sync status.');
   }
  }
 }finally{
  try{await lock?.release();}finally{await connection.close();}
 }
}

main().catch(()=>{
 console.error('Driver audit sync could not start. Verify the staged config and app connection.');
 process.exitCode=1;
});
