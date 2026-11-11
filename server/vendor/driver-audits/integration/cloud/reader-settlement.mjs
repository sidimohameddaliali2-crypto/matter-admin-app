const transient=new Set(['state-timeout','state-transport','state-rate-limit','state-server-error','state-contention']);
const retryable=error=>{for(let e=error,n=0;e&&n<5;e=e.cause,n++)if(transient.has(e.diagnosticCategory))return true;return false;};
// The reservation ID makes settlement idempotent. Re-measure on retry so time
// spent on a failed accounting call is still included, never silently refunded.
export async function settleReaderWithRetry(budget,reservation,measure){
 for(let attempt=0;attempt<2;attempt++){
  try{return await budget.settle(reservation,measure());}
  catch(error){if(attempt||!retryable(error))throw error;}
 }
}
