import {appendReportingReview,validReportingHistory} from '../../app/src/content/dashboard/reporting-review.mjs';
const allowed=['eventId','issueId','snapshotHash','expectedRevision','status','response','responsiblePerson','followUpDate','findingId'];
const roles=new Set(['owner','reviewer']);
const readers=new Set([...roles,'viewer']);
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const empty=()=>({records:{reportingReviews:[]},overrides:{},removed:{},preferences:{}});
export function createHostedReviews({stateStore,snapshotFor,clock=()=>new Date().toISOString(),key='review-journal'}){
 if(!stateStore||typeof snapshotFor!=='function')throw Error('Review storage and snapshot resolver required');
 return {async read(actor){if(!actor||typeof actor.id!=='string'||!actor.id||!readers.has(actor.role))fail(403,'Reports permission required');const value=await stateStore.read(key),state=value.body===null?empty():JSON.parse(value.body);if(!validReportingHistory(state))throw Error('Invalid retained review history');return state;},
 async save(input,actor){
  if(!actor||typeof actor.id!=='string'||!actor.id||typeof actor.email!=='string'||!actor.email.trim()||!roles.has(actor.role))fail(403,'Reviewer permission required');
  if(!input||Object.keys(input).some(k=>!allowed.includes(k))||!/^[a-f0-9]{64}$/.test(input.snapshotHash||''))fail(400,'Invalid review request');
  let snap;try{snap=await snapshotFor(input.snapshotHash);}catch(error){if(error.code==='ENOENT'||error.status===404)fail(400,'Unknown report snapshot');throw error;}if(!snap||snap.snapshotHash!==input.snapshotHash||!Array.isArray(snap.issues))fail(400,'Unknown report snapshot');
  const value=await stateStore.read(key);let state;try{state=value.body===null?empty():JSON.parse(value.body);}catch{throw Error('Invalid retained review history');}if(!validReportingHistory(state))throw Error('Invalid retained review history');
  const prior=state.records.reportingReviews?.find(e=>e.id===input.eventId);if(prior&&(prior.data.authorVerification!=='verified-hosted'||prior.data.actorId!==actor.id||prior.data.actorRole!==actor.role))fail(409,'Review request identity conflict');
  let updated=state,result;const storage={getItem:()=>JSON.stringify(state),setItem:(_key,raw)=>{updated=JSON.parse(raw)}};
  try{result=appendReportingReview(storage,key,snap,{...input,authorName:actor.email},clock);}catch(e){if(/retry ID|newer response/.test(e.message))fail(409,'Review revision or request identity conflict');fail(400,'Invalid review request');}
  if(result.replayed)return {revision:result.revision,replayed:true};
  const event=updated.records.reportingReviews.at(-1);event.data.authorVerification='verified-hosted';event.data.actorId=actor.id;event.data.actorRole=actor.role;
  const request=JSON.stringify({input:Object.fromEntries(allowed.filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]])),actorId:actor.id,actorEmail:actor.email,actorRole:actor.role});
  const commit=await stateStore.compareAndSwap({key,expectedRevision:value.revision,eventId:input.eventId,body:JSON.stringify(updated),event:JSON.stringify(event),request});
  let committed;try{committed=JSON.parse(commit.event_text);}catch{throw Error('Invalid committed review receipt');}
  if(committed?.id!==event.id||committed.data?.requestSignature!==event.data.requestSignature||committed.data?.authorVerification!=='verified-hosted'||committed.data?.actorId!==actor.id||committed.data?.actorRole!==actor.role||committed.data?.revision!==result.revision)throw Error('Committed review receipt mismatch');
  return {revision:committed.data.revision,replayed:commit.replayed};
 }};
}
