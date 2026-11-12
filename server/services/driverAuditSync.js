const hasAhead=(candidate,active)=>candidate?.collectorRevision>active?.directImport?.collectorRevision;
const sameEvidence=(source,active)=>source.basis===active.directImport.sourceBasis;

export async function runDriverAuditSyncTick({readSource,readHead,getCandidate,build,apply,status}){
 let active=await readHead(), latest;
 const update=async(state,pending,errorCode=null)=>status({
  status:state,pending,errorCode,latestCaptureAt:latest?.observedAt??null,visibleCutoffAt:active?.visibleCutoffAt??null,
 });
 try{
  if(active?.directImport?.version!==1)throw Error('An active direct audit seed is required');
  latest=await readSource();
  if(latest.revision<active.directImport.collectorRevision)throw Error('Saved audit source moved backwards');
  if(sameEvidence(latest,active)){
   await update('ready',false);
   return;
  }
  await update('checking',true);
  const prior=await getCandidate();
  const candidate=hasAhead(prior,active)?prior:await build(latest);
  if(!hasAhead(candidate,active)||candidate.collectorRevision>latest.revision)throw Error('Audit candidate is outside the saved source window');
  await apply(candidate);
  active=await readHead();
  if(active?.directImport?.sourceBasis!==candidate.sourceBasis)throw Error('Active audit verification failed');
  latest=await readSource();
  const pending=!sameEvidence(latest,active);
  await update(pending?'pending':'ready',pending);
 }catch(error){
  const state=error.code==='AUDIT_CAPACITY'?'capacity-blocked':error.code==='AUDIT_BUDGET'?'budget-deferred':'failed';
  await update(state,true,state==='failed'?'SYNC_FAILED':error.code);
  throw error;
 }
}
