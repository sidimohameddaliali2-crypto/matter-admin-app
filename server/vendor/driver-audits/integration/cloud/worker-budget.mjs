import {validateReaderUsage} from './reader-usage.mjs';
import {readerComputeMicros} from './reader-compute-cost.mjs';
// Project-local worker admission ledger. It estimates bounded compute, not the provider invoice.
import {randomInt,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const MONTH=/^\d{4}-(?:0[1-9]|1[0-2])$/,ID=/^[a-f0-9-]{36}$/i;
export const WORKER_BUDGET_DEFAULTS=Object.freeze({monthlyMicros:12_000_000,reservationMicros:40_000,maxRunMs:300_000,overheadMs:10_000,rateMicrosPerHour:428_800});
const fail=message=>{throw Error(message)};
const pendingLedgers=new WeakMap();

function queueLedgerMutation(stateStore,key,operation){
 let ledgers=pendingLedgers.get(stateStore);
 if(!ledgers){
  ledgers=new Map();
  pendingLedgers.set(stateStore,ledgers);
 }
 const result=(ledgers.get(key)??Promise.resolve()).then(operation);
 const tail=result.then(()=>{},()=>{});
 ledgers.set(key,tail);
 void tail.then(()=>{if(ledgers.get(key)===tail)ledgers.delete(key);});
 return result;
}

function revisionConflict(error){
 // The CAS RPC rejects PT409 before writing. Identity conflicts and ambiguous
 // transport errors may refer to an existing commit, so they cannot be retried.
 return error?.status===409&&(error.code??error.cause?.code)==='PT409';
}
function validatePolicy(p){if(!p||!Number.isSafeInteger(p.monthlyMicros)||p.monthlyMicros<1||p.monthlyMicros>25_000_000||!Number.isSafeInteger(p.reservationMicros)||p.reservationMicros<40_000||p.reservationMicros>p.monthlyMicros||p.maxRunMs!==300_000||p.overheadMs!==10_000||p.rateMicrosPerHour!==428_800)fail('Invalid worker budget policy');return p;}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const validReservationMicros=(value,policy)=>Number.isSafeInteger(value)&&value>=40_000&&value<=policy.reservationMicros;
function validateReservation(reservation,policy){if(!reservation||!ID.test(reservation.id||'')||!MONTH.test(reservation.period||'')||!Number.isSafeInteger(reservation.startedAtMs)||!validReservationMicros(reservation.reservationMicros,policy))fail('Invalid worker budget reservation');}
function readDocument(body,policy){
 if(body===null)return {version:1,policy,latestPeriod:null,periods:{},active:{}};
 let d;try{d=JSON.parse(body)}catch{fail('Invalid worker budget ledger')}
 if(!d||d.version!==1||!equal(d.policy,policy)||d.latestPeriod!==null&&!MONTH.test(d.latestPeriod)||!d.periods||typeof d.periods!=='object'||Array.isArray(d.periods)||!d.active||typeof d.active!=='object'||Array.isArray(d.active))fail('Invalid worker budget ledger');
 for(const [month,p] of Object.entries(d.periods))if(!MONTH.test(month)||!p||!Number.isSafeInteger(p.usedMicros)||p.usedMicros<0||p.usedMicros>policy.monthlyMicros||!Number.isSafeInteger(p.admissions)||p.admissions<0||!Number.isSafeInteger(p.settlements)||p.settlements<0||p.settlements>p.admissions||d.latestPeriod===null||month>d.latestPeriod)fail('Invalid worker budget ledger');
 const open={},reserved={};
 for(const [id,r] of Object.entries(d.active)){
  if(!ID.test(id)||!MONTH.test(r?.period||'')||!d.periods[r.period]||!validReservationMicros(r.reservationMicros,policy)||!Number.isSafeInteger(r.startedAtMs))fail('Invalid worker budget ledger');
  open[r.period]=(open[r.period]||0)+1;reserved[r.period]=(reserved[r.period]||0)+r.reservationMicros;
  if(!Number.isSafeInteger(reserved[r.period]))fail('Invalid worker budget ledger');
 }
 const months=Object.keys(d.periods).sort();if((months.at(-1)??null)!==d.latestPeriod)fail('Invalid worker budget ledger');
 for(const [month,p] of Object.entries(d.periods))if((open[month]||0)!==p.admissions-p.settlements||p.usedMicros<(reserved[month]||0))fail('Invalid worker budget ledger');
 return d;
}
function currentMonth(now){if(!Number.isSafeInteger(now)||now<0)fail('Invalid worker budget clock');const d=new Date(now);if(!Number.isFinite(d.getTime()))fail('Invalid worker budget clock');return d.toISOString().slice(0,7);}
function settledMicros(policy,elapsedMs,extraMicros){if(!Number.isSafeInteger(elapsedMs)||elapsedMs<0||elapsedMs>policy.maxRunMs)fail('Uncertain worker duration');if(!Number.isSafeInteger(extraMicros)||extraMicros<0||extraMicros>policy.reservationMicros)fail('Uncertain additional cost');const cost=Math.max(100,Math.ceil((elapsedMs+policy.overheadMs)*policy.rateMicrosPerHour/3_600_000/100)*100)+extraMicros;if(!Number.isSafeInteger(cost)||cost>policy.reservationMicros)fail('Uncertain total cost');return cost;}
export const NOVEMBER_RECOVERY_READER_BUDGET_KEY='reader-budget-recovery-20261112';
export const NOVEMBER_OVERNIGHT_READER_BUDGET_KEY='reader-budget-overnight-20261113';
export const NOVEMBER_SYNC_RESTORE_READER_BUDGET_KEY='reader-budget-sync-restore-20261113';
export const NOVEMBER_OVERNIGHT_COLLECTION_BUDGET_KEY='worker-budget-overnight-20261113';
const NOVEMBER_OVERNIGHT_COLLECTION_POLICY=Object.freeze({...WORKER_BUDGET_DEFAULTS,monthlyMicros:5_000_000});
const novemberReaderBudgetKeys=new Set(['reader-budget-release-20261112','reader-budget-sync-20261112',NOVEMBER_RECOVERY_READER_BUDGET_KEY,NOVEMBER_OVERNIGHT_READER_BUDGET_KEY,NOVEMBER_SYNC_RESTORE_READER_BUDGET_KEY]);
const readerBudgetKeys=new Set(['reader-budget','reader-budget-reserve','reader-budget-approved-20261106',...novemberReaderBudgetKeys]);

export function createWorkerBudget({stateStore,clock=Date.now,policy=WORKER_BUDGET_DEFAULTS,key='worker-budget',requestId=randomUUID,maxRetries=8}={}){
 if(!stateStore?.read||!stateStore?.compareAndSwap||typeof clock!=='function'||typeof requestId!=='function'||!Number.isInteger(maxRetries)||maxRetries<1||maxRetries>20||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(key))fail('Invalid worker budget dependencies');policy={...validatePolicy(policy)};
 function mutate(kind,id,change){
  return queueLedgerMutation(stateStore,key,async()=>{
   for(let attempt=0;attempt<maxRetries;attempt++){
    const current=await stateStore.read(key);
    if(!Number.isSafeInteger(current?.revision)||current.revision<0)fail('Invalid worker budget revision');
    const doc=readDocument(current.body,policy),output=change(doc);
    if(!output.commit)return output.result;
    const body=JSON.stringify(doc);
    const event=JSON.stringify({kind:'worker-budget-'+kind,...output.event});
    const request=JSON.stringify({eventId:id,kind,expectedRevision:current.revision,body});
    try{
     const saved=await stateStore.compareAndSwap({key,expectedRevision:current.revision,eventId:'budget-'+kind+'-'+id,body,event,request});
     if(saved.body_text!==body||saved.event_text!==event)fail('Worker budget receipt mismatch');
     return output.result;
    }catch(error){
     if(!revisionConflict(error))throw error;
     if(attempt+1===maxRetries)throw Object.assign(Error('Worker budget state remained busy',{cause:error}),{
      status:503,diagnosticCategory:'state-contention',
     });
     const maximumDelay=Math.min(200,10*2**attempt);
     await delay(randomInt(Math.ceil(maximumDelay/2),maximumDelay+1));
    }
   }
  });
 }
 return {
  async reserve({reservationMicros=policy.reservationMicros}={}){
   if(!validReservationMicros(reservationMicros,policy))fail('Invalid worker budget reservation amount');
   const id=requestId(),now=clock(),period=currentMonth(now);if(!ID.test(id))fail('Invalid worker budget request');
   const novemberRelease=novemberReaderBudgetKeys.has(key)||key===NOVEMBER_OVERNIGHT_COLLECTION_BUDGET_KEY;
   if(novemberRelease&&period!=='2026-11')return {allowed:false,period,reason:'release-expired'};
   return mutate('reserve',id,doc=>{
    if(novemberRelease){
     const currentPeriod=currentMonth(clock());
     if(currentPeriod!=='2026-11')return {commit:false,result:{allowed:false,period:currentPeriod,reason:'release-expired'}};
    }
    if(doc.latestPeriod&&period<doc.latestPeriod)fail('Worker budget clock moved backwards');doc.latestPeriod=period;
    const p=doc.periods[period]??{usedMicros:0,admissions:0,settlements:0};
    if(p.usedMicros+reservationMicros>policy.monthlyMicros)return {commit:false,result:{allowed:false,period,remainingMicros:policy.monthlyMicros-p.usedMicros}};
    if(doc.active[id])fail('Duplicate worker budget request');p.usedMicros+=reservationMicros;p.admissions++;doc.periods[period]=p;doc.active[id]={period,reservationMicros,startedAtMs:now};
    return {commit:true,event:{id,period,reservationMicros},result:{allowed:true,id,period,startedAtMs:now,reservationMicros}};
   });
  },
  async increase(reservation,{reservationMicros=policy.reservationMicros}={}){
   validateReservation(reservation,policy);
   if(!validReservationMicros(reservationMicros,policy))fail('Invalid worker budget increase');
   return mutate('increase',reservation.id+'-'+reservationMicros,doc=>{
    const r=doc.active[reservation.id],identity={id:reservation.id,period:reservation.period,startedAtMs:reservation.startedAtMs};
    if(!r)return {commit:false,result:{allowed:false,...identity,reservationMicros:reservation.reservationMicros,reason:'not-active'}};
    if(r.period!==reservation.period||r.startedAtMs!==reservation.startedAtMs||r.reservationMicros<reservation.reservationMicros)fail('Worker budget reservation mismatch');
    const now=clock();if(!Number.isSafeInteger(now)||now<r.startedAtMs)fail('Uncertain worker duration');
    const target=Math.max(r.reservationMicros,reservationMicros),result={allowed:true,...identity,reservationMicros:target};
    if(r.reservationMicros===target)return {commit:false,result};
    const p=doc.periods[r.period],previousReservationMicros=r.reservationMicros,addedMicros=target-previousReservationMicros;
    if(p.usedMicros+addedMicros>policy.monthlyMicros)return {commit:false,result:{allowed:false,...identity,reservationMicros:r.reservationMicros,remainingMicros:policy.monthlyMicros-p.usedMicros}};
    p.usedMicros+=addedMicros;r.reservationMicros=target;
    return {commit:true,event:{id:reservation.id,period:r.period,previousReservationMicros,reservationMicros:r.reservationMicros,addedMicros},result};
   });
  },
  async settle(reservation,{elapsedMs,extraMicros=0,preReservationMs=0,accountingBasis,cpuMicros,readerUsage}={}){
   validateReservation(reservation,policy);
   if(readerUsage!==undefined){if(!readerBudgetKeys.has(key))fail('Reader usage is not a collector measurement');readerUsage=validateReaderUsage(readerUsage);}
   const archiveTransferOnly=accountingBasis==='remote-archive-transfer-v1';
   if(archiveTransferOnly&&(!readerBudgetKeys.has(key)||cpuMicros!==undefined||readerUsage!==undefined))fail('Invalid remote archive accounting');
   if(accountingBasis!==undefined&&!archiveTransferOnly&&(accountingBasis!=='expired-platform-maximum'||!['reader-budget','reader-budget-reserve'].includes(key)||reservation.reservationMicros!==150_000||elapsedMs!==300_000||preReservationMs!==0||extraMicros!==105_614||clock()-reservation.startedAtMs<360_000))fail('Unverified expired reader bound');
   if(!Number.isSafeInteger(preReservationMs)||preReservationMs<0||preReservationMs>policy.maxRunMs||preReservationMs>elapsedMs)fail('Uncertain pre-reservation duration');
   let charge=settledMicros(policy,elapsedMs,extraMicros);
   // A verified archive transfer from a fixed-cost host incurs no Vercel compute.
   // Keep its measured duration in the receipt and charge the bounded transfer.
   if(archiveTransferOnly)charge=extraMicros;
   if(cpuMicros!==undefined){if(!readerBudgetKeys.has(key)||accountingBasis!==undefined)fail('Invalid reader compute accounting');charge=readerComputeMicros({elapsedMs,cpuMicros})+extraMicros;}
   return mutate('settle',reservation.id,doc=>{
    const r=doc.active[reservation.id];if(!r)return {commit:false,result:{settled:false,reason:'not-active'}};
    if(r.period!==reservation.period||r.startedAtMs!==reservation.startedAtMs||r.reservationMicros!==reservation.reservationMicros)fail('Worker budget reservation mismatch');
    if(charge>r.reservationMicros)fail('Uncertain total cost exceeds reservation');
    const now=clock();if(!Number.isSafeInteger(now)||now<r.startedAtMs||now-r.startedAtMs+preReservationMs+10<elapsedMs)fail('Uncertain worker duration');
    const p=doc.periods[r.period],refund=r.reservationMicros-charge;if(p.usedMicros<refund)fail('Invalid worker budget ledger');p.usedMicros-=refund;p.settlements++;delete doc.active[reservation.id];
    return {commit:true,event:{id:reservation.id,period:r.period,elapsedMs,preReservationMs,extraMicros,chargedMicros:charge,...(readerUsage?{readerUsage}:{}),...(accountingBasis?{accountingBasis}:cpuMicros!==undefined?{accountingBasis:'measured-cpu-memory-v1',cpuMicros}:{})},result:{settled:true,period:r.period,chargedMicros:charge,refundedMicros:refund}};
   });
  }
 };
}
// Worker completion can only release an excess reservation after a known success.
export function createCollectionBudget({approvedNovemberOvernight=false,clock=Date.now,...options}={}){
 if(typeof approvedNovemberOvernight!=='boolean')fail('Explicit November collection approval required');
 const base=createWorkerBudget({...options,clock});
 if(!approvedNovemberOvernight)return base;
 const supplement=createWorkerBudget({...options,clock,key:NOVEMBER_OVERNIGHT_COLLECTION_BUDGET_KEY,policy:NOVEMBER_OVERNIGHT_COLLECTION_POLICY});
 return {
  async reserve(){
   const began=clock();
   const reservation=await base.reserve();
   if(reservation.allowed)return {...reservation,collectionPool:'base'};
   const fallback=await supplement.reserve();
   return {...fallback,collectionPool:'novemberOvernight',
    collectionPoolDelayMs:fallback.allowed?fallback.startedAtMs-began:0};
  },
  settle(reservation,measurement){
   if(reservation?.collectionPool==='base')return base.settle(reservation,measurement);
   if(reservation?.collectionPool==='novemberOvernight'){
    const delay=reservation.collectionPoolDelayMs;
    if(!Number.isSafeInteger(delay)||delay<0)fail('Uncertain collection pool admission duration');
    return supplement.settle(reservation,{...measurement,preReservationMs:(measurement?.preReservationMs??0)+delay});
   }
   fail('Invalid collection budget pool reservation');
  },
 };
}

export async function runWithWorkerBudget(budget,operation,{monotonic=()=>performance.now()}={}){if(!budget?.reserve||!budget?.settle||typeof operation!=='function'||typeof monotonic!=='function')fail('Invalid worker budget execution');const start=monotonic(),reservation=await budget.reserve();if(!reservation.allowed)return {status:'budget-exhausted',period:reservation.period};const result=await operation(),elapsedMs=Math.ceil(monotonic()-start);let settlement;try{settlement=await budget.settle(reservation,{elapsedMs});}catch{settlement={settled:false,reason:'unconfirmed'};}return {...result,budgetSettlement:settlement.settled?'settled':'retained'};}
