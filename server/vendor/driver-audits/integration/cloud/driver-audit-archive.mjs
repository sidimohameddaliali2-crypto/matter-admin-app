import {createArchiveReservation} from './archive-reservation.mjs';
import {createArchiveCapacity} from './cloud-state.mjs';
import {createReaderBudgetPool} from './reader-budget-pool.mjs';
import {readerTransferMicros} from './reader-budget.mjs';
import {runWithWorkerBudget} from './worker-budget.mjs';
import {runAutomaticPublicationBatch,MAX_PUBLICATION_BATCH_BYTES} from './automatic-publication-budget.mjs';
import {createVerifiedAuditArchive,sha256} from './driver-audit-handoff.mjs';

// Combine concurrent immutable reads and possible missing-object uploads into
// the same existing bounded storage and reader accounting used by publication.
export function createBudgetedAuditArchive({rpc,state,remote,receiptRoot}){
 const budget=createReaderBudgetPool({stateStore:state});
 const storage=createArchiveReservation({rpc,transport:remote,ensureCapacity:createArchiveCapacity({rpc})});
 const queued=[];
 let running=false;
 async function drain(){
  try{
   while(queued.length){
    const batch=[];
    let bytes=0;
    while(queued.length&&batch.length<64&&bytes+queued[0].size<=MAX_PUBLICATION_BATCH_BYTES){
     const task=queued.shift();
     bytes+=task.size;
     batch.push(task);
    }
    let settled;
    try{
     const run=async upload=>{
      settled=[];
      for(let offset=0;offset<batch.length;offset+=8){
       const outcomes=await Promise.allSettled(batch.slice(offset,offset+8).map(task=>task.operation(upload)));
       settled.push(...outcomes);
       const failure=outcomes.find(result=>result.status==='rejected'&&result.reason?.code!=='storage_not_found');
       if(failure)throw failure.reason;
      }
      return {status:'complete'};
     };
     const result=await runAutomaticPublicationBatch({budget,bytes,objects:batch.length,operation:async()=>{
      if(!batch.some(task=>task.writable))return run(undefined);
      return storage.run(async()=>{
       await storage.ensureCapacity({bytes,phase:'worker-preflight'});
       return run((key,body)=>storage.transport.putVerifiedObject(key,body));
      });
     }});
     if(result.status==='budget-exhausted')throw Object.assign(Error('Audit reader allowance exhausted'),{code:'AUDIT_BUDGET'});
     if(result.budgetSettlement!=='settled')throw Object.assign(Error('Audit accounting settlement uncertain'),{code:'AUDIT_BUDGET'});
     batch.forEach((task,i)=>settled[i].status==='fulfilled'?task.resolve(settled[i].value):task.reject(settled[i].reason));
    }catch(error){for(const task of batch)task.reject(error);}
   }
  }finally{running=false;}
 }
 function runObject(size,writable,operation){
  if(!Number.isSafeInteger(size)||size<1||size>16*1024*1024)throw Error('Audit archive operation exceeds bound');
  return new Promise((resolve,reject)=>{
   queued.push({size,writable,operation,resolve,reject});
   if(!running){running=true;setImmediate(()=>void drain());}
  });
 }
 const verified=createVerifiedAuditArchive({remote,receiptRoot,runObject});
 return {
  ...verified,
  async readBounded(key,{maxBytes}){
   return runObject(maxBytes,false,async()=>{
    const chunks=[];
    let size=0;
    for await(const chunk of await remote.readObject(key,{maxBytes})){
     size+=chunk.length;
     if(size>maxBytes)throw Error('Audit archive response exceeds bound');
     chunks.push(Buffer.from(chunk));
    }
    const body=Buffer.concat(chunks,size);
    if(sha256(body)+'.gz'!==key)throw Error('Audit archive read hash mismatch');
    return [body];
   });
  }
 };
}

export function createBudgetedAuditState({state,budgetState,responseLimit,requestBytes=4096}){
 const budget=createReaderBudgetPool({stateStore:budgetState});
 return {async read(key){
  let transfer=0;
  const result=await runWithWorkerBudget({
   reserve:()=>budget.reserve({responseBytes:responseLimit}),
   settle:(reservation,measurement)=>budget.settle(reservation,{...measurement,extraMicros:transfer}),
  },async()=>{
   const value=await state.read(key);
   const responseBytes=Buffer.byteLength(JSON.stringify(value));
   if(responseBytes>responseLimit)throw Error('Audit state exceeds its reader bound');
   transfer=readerTransferMicros({responseBytes,requestBytes});
   return {status:'read',value};
  });
  if(result.status!=='read'||result.budgetSettlement!=='settled')throw Object.assign(Error('Audit state allowance unavailable'),{code:'AUDIT_BUDGET'});
  return result.value;
 }};
}
