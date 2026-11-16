const hasAhead=(candidate,active)=>candidate?.collectorRevision>active?.directImport?.collectorRevision;
const sameEvidence=(source,active)=>source.basis===active.directImport.sourceBasis;

export function describeDriverAuditSyncFailure(error){
 const capacity=error.code==='ENOSPC'
  ?{kind:'build-disk',availableBytes:null,requiredBytes:null}
  :error.code==='AUDIT_CAPACITY'?error.capacity??null:null;
 if(error.code==='AUDIT_CAPACITY'||error.code==='ENOSPC')return {status:'capacity-blocked',errorCode:'AUDIT_CAPACITY',capacity};
 if(error.code==='AUDIT_BUDGET')return {status:'budget-deferred',errorCode:'AUDIT_BUDGET',capacity:null};
 return {status:'failed',errorCode:'SYNC_FAILED',capacity:null};
}

export function savedAuditTransferBlock(receipt,{sourceBasis,baselineManifestSha256,policy}){
 const capacity=receipt?.capacity;
 if(receipt?.sourceBasis!==sourceBasis||receipt.baselineManifestSha256!==baselineManifestSha256||
    !Object.entries(policy).every(([key,value])=>receipt[key]===value)||
    !/^[a-f0-9]{64}$/.test(receipt.candidateManifestSha256)||
    capacity?.kind!=='import-transfer'||capacity.availableBytes!==policy.maxBytes||
    !Number.isSafeInteger(capacity.requiredBytes)||capacity.requiredBytes<=policy.maxBytes)return null;
 return {kind:capacity.kind,availableBytes:capacity.availableBytes,requiredBytes:capacity.requiredBytes};
}

export async function runDriverAuditSyncTick({readSource,readHead,getCandidate,build,apply,status,maintain,onMaintenanceError}){
 let active=await readHead(), latest;
 const update=async(state,pending,errorCode=null,capacity=null)=>status({
  status:state,pending,errorCode,capacity,latestCaptureAt:latest?.observedAt??null,visibleCutoffAt:active?.visibleCutoffAt??null,
 });
 const maintainVerified=async()=>{
  try{await maintain?.(active);}
  catch(error){onMaintenanceError?.(error);}
 };
 try{
  if(active?.directImport?.version!==1)throw Error('An active direct audit seed is required');
  latest=await readSource();
  if(latest.revision<active.directImport.collectorRevision)throw Error('Saved audit source moved backwards');
  if(sameEvidence(latest,active)){
   await update('ready',false);
   await maintainVerified();
   return;
  }
  await update('checking',true);
  const prior=await getCandidate();
  const applyCandidate=async candidate=>{
   if(!hasAhead(candidate,active)||candidate.collectorRevision>latest.revision)throw Error('Audit candidate is outside the saved source window');
   await apply(candidate);
   return candidate;
  };
  let candidate;
  if(hasAhead(prior,active)){
   try{candidate=await applyCandidate(prior);}
   catch(error){
    if(error.code!=='AUDIT_CAPACITY'||error.capacity?.kind!=='import-transfer'||
       prior.collectorRevision>=latest.revision||prior.sourceBasis===latest.basis)throw error;
    // New evidence may fit even when the pinned candidate cannot be imported.
   }
  }
  if(!candidate)candidate=await applyCandidate(await build(latest));
  active=await readHead();
  if(active?.directImport?.sourceBasis!==candidate.sourceBasis)throw Error('Active audit verification failed');
  latest=await readSource();
  const pending=!sameEvidence(latest,active);
  await update(pending?'pending':'ready',pending);
  await maintainVerified();
 }catch(error){
  const failure=describeDriverAuditSyncFailure(error);
  await update(failure.status,true,failure.errorCode,failure.capacity);
  throw error;
 }
}
