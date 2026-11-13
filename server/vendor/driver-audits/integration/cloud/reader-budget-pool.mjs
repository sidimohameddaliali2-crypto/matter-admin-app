import {createWorkerBudget,WORKER_BUDGET_DEFAULTS,NOVEMBER_RECOVERY_READER_BUDGET_KEY,NOVEMBER_OVERNIGHT_READER_BUDGET_KEY} from './worker-budget.mjs';
import {READER_BUDGET_POLICY,MAX_READER_BODY_BYTES} from './reader-budget.mjs';

// Preserve the original ledgers and use only the remaining approved hosting dollar.
export const APPROVED_HOSTING_BUDGET_MICROS=25_000_000;
export const READER_RESERVE_BUDGET_POLICY=Object.freeze({...READER_BUDGET_POLICY,monthlyMicros:1_000_000});
// Explicitly approved 6 November 2026; separate history, preview opt-in only.
export const READER_APPROVED_ADDITION_POLICY=Object.freeze({...READER_BUDGET_POLICY,monthlyMicros:5_000_000});
export const EXPANDED_HOSTING_BUDGET_MICROS=30_000_000;
// One-time release allowance approved for November 2026 only.
export const READER_NOVEMBER_RELEASE_POLICY=Object.freeze({...READER_BUDGET_POLICY,monthlyMicros:1_000_000});
export const READER_NOVEMBER_SYNC_POLICY=Object.freeze({...READER_BUDGET_POLICY,monthlyMicros:5_000_000});
// An explicit November recovery opt-in uses a fresh ledger and leaves existing holds intact.
export const READER_NOVEMBER_RECOVERY_POLICY=Object.freeze({...READER_BUDGET_POLICY,monthlyMicros:3_000_000});
const READER_NOVEMBER_OVERNIGHT_POLICY=Object.freeze({...READER_BUDGET_POLICY,monthlyMicros:5_000_000});
const SMALL_RESPONSE_BYTES=2*1024*1024;
const capacities=new Map([[40_000,SMALL_RESPONSE_BYTES],[45_000,8*1024*1024],[47_000,9*1024*1024],[55_000,16*1024*1024],[150_000,MAX_READER_BODY_BYTES]]);

export function createReaderBudgetPool({stateStore,clock=Date.now,requestId,maxRetries,approvedAdditionalBrowsing=false,approvedNovemberRelease=false,approvedNovemberSync=false,approvedNovemberRecovery=false,approvedNovemberOvernight=false}={}){
 if(WORKER_BUDGET_DEFAULTS.monthlyMicros+READER_BUDGET_POLICY.monthlyMicros+READER_RESERVE_BUDGET_POLICY.monthlyMicros>APPROVED_HOSTING_BUDGET_MICROS)throw Error('Reader pool exceeds approved hosting budget');
 if(typeof approvedAdditionalBrowsing!=='boolean')throw Error('Explicit browsing approval required');
 if(typeof approvedNovemberRelease!=='boolean')throw Error('Explicit November release approval required');
 if(typeof approvedNovemberSync!=='boolean')throw Error('Explicit November sync approval required');
 if(typeof approvedNovemberRecovery!=='boolean')throw Error('Explicit November recovery approval required');
 if(typeof approvedNovemberOvernight!=='boolean')throw Error('Explicit November reporting approval required');
 if(approvedAdditionalBrowsing&&(approvedNovemberRelease||approvedNovemberSync||approvedNovemberRecovery||approvedNovemberOvernight))throw Error('November release cannot combine browsing supplements');
 if(APPROVED_HOSTING_BUDGET_MICROS+READER_APPROVED_ADDITION_POLICY.monthlyMicros>EXPANDED_HOSTING_BUDGET_MICROS)throw Error('Expanded reader pool exceeds approved hosting budget');
 const options={stateStore,clock,requestId,maxRetries};
 const budgets={
  primary:createWorkerBudget({...options,key:'reader-budget',policy:READER_BUDGET_POLICY}),
  reserve:createWorkerBudget({...options,key:'reader-budget-reserve',policy:READER_RESERVE_BUDGET_POLICY})
 };
 if(approvedAdditionalBrowsing)budgets.approved20261106=createWorkerBudget({...options,key:'reader-budget-approved-20261106',policy:READER_APPROVED_ADDITION_POLICY});
 if(approvedNovemberRelease)budgets.novemberRelease=createWorkerBudget({...options,key:'reader-budget-release-20261112',policy:READER_NOVEMBER_RELEASE_POLICY});
 if(approvedNovemberSync)budgets.novemberSync=createWorkerBudget({...options,key:'reader-budget-sync-20261112',policy:READER_NOVEMBER_SYNC_POLICY});
 if(approvedNovemberRecovery)budgets.novemberRecovery=createWorkerBudget({...options,key:NOVEMBER_RECOVERY_READER_BUDGET_KEY,policy:READER_NOVEMBER_RECOVERY_POLICY});
 if(approvedNovemberOvernight)budgets.novemberOvernight=createWorkerBudget({...options,key:NOVEMBER_OVERNIGHT_READER_BUDGET_KEY,policy:READER_NOVEMBER_OVERNIGHT_POLICY});
 const check=reservation=>{
  if(!reservation?.allowed||!Object.hasOwn(budgets,reservation.readerPool))throw Error('Invalid reader budget pool reservation');
  if(!capacities.has(reservation.reservationMicros)||reservation.maxResponseBytes!==capacities.get(reservation.reservationMicros))throw Error('Invalid reader response capacity');
 };
 return {
  async reserve({responseBytes=SMALL_RESPONSE_BYTES}={}){
   if(!Number.isSafeInteger(responseBytes)||responseBytes<0||responseBytes>MAX_READER_BODY_BYTES)throw Error('Invalid reader response size');
   const [initialMicros,initialBytes]=[...capacities].find(([,max])=>responseBytes<=max);
   const began=clock();
   let result;
   const pools=approvedAdditionalBrowsing?['approved20261106','primary','reserve']:['primary','reserve'];
   if(new Date(began).toISOString().slice(0,7)==='2026-11'){
    if(approvedNovemberSync)pools.unshift('novemberSync');
    if(approvedNovemberRelease)pools.unshift('novemberRelease');
    if(approvedNovemberRecovery)pools.unshift('novemberRecovery');
    if(approvedNovemberOvernight)pools.unshift('novemberOvernight');
   }
   for(const readerPool of pools){
    // Accounting failures propagate; only confirmed exhaustion permits fallback.
    const reservation=await budgets[readerPool].reserve({reservationMicros:initialMicros});
    result={...reservation,readerPool,readerPoolDelayMs:reservation.allowed?reservation.startedAtMs-began:0,maxResponseBytes:initialBytes};
    if(reservation.allowed)return result;
   }
   return result;
  },
  async ensureCapacity(reservation,{responseBytes}={}){
   check(reservation);
   if(!Number.isSafeInteger(responseBytes)||responseBytes<0||responseBytes>MAX_READER_BODY_BYTES)throw Error('Invalid reader response size');
   if(responseBytes<=reservation.maxResponseBytes)return reservation;
   const [reservationMicros]=[...capacities].find(([,max])=>responseBytes<=max);
   const increased=await budgets[reservation.readerPool].increase(reservation,{reservationMicros});
   return {...reservation,...increased,readerPool:reservation.readerPool,readerPoolDelayMs:reservation.readerPoolDelayMs,maxResponseBytes:increased.allowed?capacities.get(increased.reservationMicros):reservation.maxResponseBytes};
  },
  async settle(reservation,measurement){
   check(reservation);
   const delay=reservation.readerPoolDelayMs;
   if(!Number.isSafeInteger(delay)||delay<0||delay>READER_BUDGET_POLICY.maxRunMs)throw Error('Uncertain reader pool admission duration');
   // The HTTP measurement already includes authentication; only add time spent
   // checking the exhausted primary before the reserve ledger started its clock.
   return budgets[reservation.readerPool].settle(reservation,{...measurement,preReservationMs:(measurement?.preReservationMs??0)+delay});
  }
 };
}
