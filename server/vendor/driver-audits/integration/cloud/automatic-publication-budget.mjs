import {readerTransferMicros,MAX_READER_BODY_BYTES} from './reader-budget.mjs';

export const MAX_PUBLICATION_BATCH_BYTES=32*1024*1024;
export const MAX_PUBLICATION_BATCH_OBJECTS=64;
export const MAX_PUBLICATION_TRANSFER_BYTES=128*1024*1024;
const PER_OBJECT_OVERHEAD_BYTES=128*1024;

export function publicationBatchTransfer({bytes,objects}={}){
 if(!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_PUBLICATION_BATCH_BYTES||!Number.isSafeInteger(objects)||objects<1||objects>MAX_PUBLICATION_BATCH_OBJECTS)throw Error('Publication batch exceeds its bounded transfer allowance');
 const aggregateBytes=2*bytes+objects*PER_OBJECT_OVERHEAD_BYTES+4096;
 if(!Number.isSafeInteger(aggregateBytes)||aggregateBytes>MAX_PUBLICATION_TRANSFER_BYTES||aggregateBytes>MAX_READER_BODY_BYTES)throw Error('Publication transfer exceeds reader budget bound');
 return {bytes,objects,aggregateBytes,extraMicros:readerTransferMicros({responseBytes:aggregateBytes,requestBytes:0})};
}

// One reader-budget reservation covers the measured batch runtime and a
// conservative POST plus read-back GET transfer estimate. It charges every
// planned object even when the archive layer skips an already-retained upload.
// Failed work retains its reservation; deferred work is settled before the
// caller records the deferral, matching the existing resumable-upload contract.
export async function runAutomaticPublicationBatch({budget,bytes,objects,operation,monotonic=()=>performance.now()}={}){
 if(!budget?.reserve||!budget?.settle||typeof operation!=='function'||typeof monotonic!=='function')throw Error('Invalid publication batch budget');
 const estimate=publicationBatchTransfer({bytes,objects}),started=monotonic();
 const reservation=await budget.reserve({responseBytes:MAX_READER_BODY_BYTES});
 if(!reservation?.allowed)return {status:'budget-exhausted',period:reservation?.period};
 const result=await operation(reservation);
 const elapsedMs=Math.ceil(monotonic()-started);
 let settlement;
 try{settlement=await budget.settle(reservation,{elapsedMs,extraMicros:estimate.extraMicros});}
 catch{settlement={settled:false,reason:'unconfirmed'};}
 return {...result,budgetSettlement:settlement?.settled?'settled':'retained',readerTransfer:{responseBytes:estimate.aggregateBytes,extraMicros:estimate.extraMicros}};
}
