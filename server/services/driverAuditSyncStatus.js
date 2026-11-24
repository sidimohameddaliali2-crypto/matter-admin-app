import {createHash} from 'node:crypto';
import {driverAuditDeliveryIdentity,isDriverAuditDeliveryHead} from './driverAuditDeliveryHead.js';

const states=new Set(['checking','pending','ready','failed','capacity-blocked','budget-deferred']);
const capacityReasons=new Set(['build-disk','replica-storage','import-transfer']);
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;

export async function readDriverAuditSyncStatus(db,generation,clock=Date.now){
 let saved;
 try{saved=await db.collection('driverAuditControl').findOne({_id:'sync-status'},{maxTimeMS:1000});}
 catch{return {status:'failed',pending:true,latestCaptureAt:null,checkedAt:null};}
 return driverAuditSyncStatusFor(saved,generation,clock);
}

export async function readDriverAuditFileSyncStatus(file,generation,clock=Date.now){
 let saved;
 try{saved=JSON.parse(await readPrivateDriverAuditSource(file,64*1024));}
 catch(error){if(error.code==='ENOENT')return driverAuditSyncStatusFor(null,generation,clock);return {status:'failed',pending:true,latestCaptureAt:null,checkedAt:null};}
 return driverAuditSyncStatusFor(saved,generation,clock);
}

export function driverAuditSyncStatusFor(saved,generation,clock=Date.now){
 if(!saved)return {status:'snapshot',pending:false,latestCaptureAt:null,checkedAt:null};
 const checkedAt=iso(saved.checkedAt);
 const heartbeatAt=saved.dataStore==='supabase'&&['sidi','off-host'].includes(saved.executionHost)?iso(saved.heartbeatAt):null;
 const activityAt=heartbeatAt??checkedAt;
 const age=activityAt?clock()-Date.parse(activityAt):Infinity;
 const current=age>=0&&age<30*60_000;
 const status=current&&states.has(saved.status)?saved.status:'failed';
 const visibleStatus=status==='ready'&&saved.activeGeneration!==generation?'pending':status;
 const reason=saved.capacity?.kind;
 const showCapacity=visibleStatus==='capacity-blocked'&&saved.errorCode==='AUDIT_CAPACITY'&&capacityReasons.has(reason);
 return {status:visibleStatus,pending:saved.pending===true||visibleStatus==='failed'||visibleStatus==='pending',
  latestCaptureAt:iso(saved.latestCaptureAt),checkedAt,...(showCapacity?{capacityReason:reason}:{})};
}
import {readPrivateDriverAuditSource} from './driverAuditSource.js';

export const driverAuditSupabaseWorkerStatusKey='app-sidi-report-worker-status';
const headKey='app-sidi-report-head',minute=60000,day=24*60*minute;
const slotGrace=30*minute;
const digest=value=>createHash('sha256').update(value).digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const requireStatus=(condition,message='The report worker status binding differs')=>{if(!condition)throw Error(message);};
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
 &&iso(value)===(value.includes('.')?value:value.replace(/Z$/,'.000Z'));
const fields=['version','kind','executionHost','syncConfigSha256','sourceConfigSha256','scheduledAt','nextCheckAt','checkedAt',
 'outcome','status','activeGeneration','servingHeadRevision','servingHeadBodySha256','collectorRevision','visibleCutoffAt','latestCaptureAt','errorCode'];
const pendingStatus=()=>({status:'pending',pending:true,latestCaptureAt:null,checkedAt:null});

export function validateDriverAuditSupabaseWorkerSlotStatus(value,{clock=Date.now}={}){
 requireStatus(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length
  &&fields.every(key=>Object.hasOwn(value,key))&&value.version===1&&value.kind==='supabase-report-worker-slot-status'
  &&value.executionHost==='off-host'&&['syncConfigSha256','sourceConfigSha256','activeGeneration','servingHeadBodySha256'].every(key=>hash(value[key]))
  &&positive(value.servingHeadRevision)&&positive(value.collectorRevision)
  &&['scheduledAt','nextCheckAt','checkedAt'].every(key=>timestamp(value[key])&&iso(value[key])===value[key])
  &&['visibleCutoffAt','latestCaptureAt'].every(key=>value[key]===null||timestamp(value[key])));
 const slot=Date.parse(value.scheduledAt),start=Math.floor(slot/day)*day,offset=slot-start;
 const next=offset===390*minute?start+480*minute:offset===480*minute?start+day+390*minute:null;
 requireStatus(next!==null&&Date.parse(value.nextCheckAt)===next&&Date.parse(value.checkedAt)>=slot
  &&Date.parse(value.checkedAt)-slot<=day&&Date.parse(value.checkedAt)<=clock()+30000);
 const failed={failed:'SYNC_FAILED','capacity-blocked':'AUDIT_CAPACITY','budget-deferred':'AUDIT_BUDGET'};
 requireStatus(value.outcome==='failed'?Object.hasOwn(failed,value.status)&&value.errorCode===failed[value.status]
  :['published','unchanged'].includes(value.outcome)&&['ready','pending'].includes(value.status)&&value.errorCode===null);
 return Object.fromEntries(fields.map(key=>[key,value[key]]));
}

// This current document is shared between machines. It contains one terminal
// slot outcome, never idle heartbeats or raw delivery/review/photo payloads.
// Existing CAS receipts provide exact lost-ack recovery; no new schema is used.
export function createDriverAuditSupabaseWorkerStatusStore({state,clock=Date.now}={}){
 requireStatus(typeof state?.read==='function'&&typeof clock==='function');
 async function row(key,maximum){
  const result=await state.read(key);
  requireStatus(Number.isSafeInteger(result?.revision)&&result.revision>=0
   &&(result.revision===0&&result.body===null||result.revision>0&&typeof result.body==='string'&&Buffer.byteLength(result.body)<=maximum));
  return result;
 }
 async function currentHead(){
  const result=await row(headKey,256*1024);requireStatus(result.body!==null);
  const value=JSON.parse(result.body);
  requireStatus(value?.version===1&&hash(value.generation)&&value.servingPackage?.version===1
   &&value.servingPackage.dataStore==='supabase'&&positive(value.servingPackage.collectorRevision)
   &&(value.visibleCutoffAt===null||timestamp(value.visibleCutoffAt)));
  requireStatus(!Object.hasOwn(value,'deliveryView')||value.lightView&&isDriverAuditDeliveryHead(value.deliveryView)
   &&value.deliveryView.collectorRevision>=value.servingPackage.collectorRevision);
  return {...driverAuditDeliveryIdentity(value),revision:result.revision,bodySha256:digest(result.body)};
 }
 const matches=(value,head)=>value.activeGeneration===head.generation&&value.servingHeadRevision===head.revision
  &&value.servingHeadBodySha256===head.bodySha256&&value.collectorRevision===head.collectorRevision
  &&value.visibleCutoffAt===head.visibleCutoffAt;
 return Object.freeze({
  async read(generation,clockOverride=clock){
   try{
    requireStatus(hash(generation)&&typeof clockOverride==='function');
    const saved=await row(driverAuditSupabaseWorkerStatusKey,4096);if(saved.body===null)return pendingStatus();
    const value=validateDriverAuditSupabaseWorkerSlotStatus(JSON.parse(saved.body),{clock:clockOverride}),head=await currentHead();
    if(value.activeGeneration!==generation||!matches(value,head))return pendingStatus();
    const overdue=clockOverride()>Date.parse(value.nextCheckAt)+slotGrace;
    const status=overdue?'pending':value.status;
    return {status,pending:status!=='ready',latestCaptureAt:iso(value.latestCaptureAt),checkedAt:iso(value.checkedAt)};
   }catch{return pendingStatus();}
  },
  async write(input){
   requireStatus(typeof state.compareAndSwap==='function');
   const value=validateDriverAuditSupabaseWorkerSlotStatus(input,{clock}),body=JSON.stringify(value);
   requireStatus(Buffer.byteLength(body)<=4096);
   const head=await currentHead();
   if(!matches(value,head)){
    if(head.revision>value.servingHeadRevision&&head.collectorRevision>=value.collectorRevision)
     return {verified:false,superseded:true};
    throw Error('The terminal worker outcome does not match the actual serving head');
   }
   const before=await row(driverAuditSupabaseWorkerStatusKey,4096);
   if(before.body===body)return {verified:true,replayed:true,revision:before.revision};
   if(before.body!==null){
    const previous=validateDriverAuditSupabaseWorkerSlotStatus(JSON.parse(before.body),{clock});
    requireStatus(Date.parse(previous.scheduledAt)<Date.parse(value.scheduledAt),'A terminal slot already has a different or newer outcome');
   }
   const eventId='worker-slot-'+digest(JSON.stringify([value.syncConfigSha256,value.sourceConfigSha256,value.scheduledAt]));
   const event=JSON.stringify({kind:'supabase-report-worker-slot',scheduledAt:value.scheduledAt,outcome:value.outcome,bodySha256:digest(body)});
   const request=JSON.stringify({kind:'supabase-report-worker-slot',expectedRevision:before.revision,bodySha256:digest(body)});
   let failure;
   try{
    const receipt=await state.compareAndSwap({key:driverAuditSupabaseWorkerStatusKey,expectedRevision:before.revision,eventId,body,event,request});
    requireStatus(receipt?.body_text===body&&receipt.event_text===event&&receipt.body_sha256===digest(body));
   }catch(error){failure=error;}
   const after=await row(driverAuditSupabaseWorkerStatusKey,4096);
   if(after.body===body&&after.revision===before.revision+1)return {verified:true,replayed:!!failure,revision:after.revision};
   throw failure??Error('The worker status readback did not confirm its exact slot');
  },
 });
}
