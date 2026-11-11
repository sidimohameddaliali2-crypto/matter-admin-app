import {reportingDate} from './reporting-model.mjs';
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const signature=value=>JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])));
const EMPTY_HISTORY = [];
const statuses=['open','investigating','resolved','needs_evidence','follow_up','explained','incorrect_data'];
export const reviewEvents=state=>state.records?.reportingReviews||EMPTY_HISTORY;
export function reviewMatches(event,issue,snapshot){
 const d=event.data;
 return d.issueId===issue.id&&(snapshot.deliveryReview&&d.reviewScope==='delivery-review-v1'||d.snapshotHash===snapshot.snapshotHash||snapshot.raw&&d.reviewScope==='raw-day-v1'&&d.evidenceVersion===issue.evidence?.source_sha256&&d.ruleVersion===issue.evidence?.rule_version);
}
export function validReportingHistory(state){
 if(!state||['records','overrides','removed','preferences'].some(k=>!state[k]||typeof state[k]!=='object'||Array.isArray(state[k])))return false;
 const events=state.records.reportingReviews||[];
 return Array.isArray(events)&&new Set(events.map(e=>e?.id)).size===events.length&&events.every(e=>e&&uuid.test(e.id||'')&&e.data&&typeof e.data.issueId==='string'&&/^[a-f0-9]{64}$/.test(e.data.snapshotHash||'')&&Number.isSafeInteger(e.data.revision)&&e.data.revision>0&&typeof e.data.response==='string'&&typeof e.data.authorName==='string'&&statuses.includes(e.data.status));
}
export function appendReportingReview(storage,key,snapshot,request,now=()=>new Date().toISOString()){
 const input=request||{},allowed=['eventId','issueId','snapshotHash','expectedRevision','status','response','responsiblePerson','followUpDate','authorName','findingId'];
 if(Object.keys(input).some(k=>!allowed.includes(k))||!uuid.test(input.eventId||'')||input.snapshotHash!==snapshot.snapshotHash||!snapshot.issues.some(i=>i.id===input.issueId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!statuses.includes(input.status)||typeof input.response!=='string'||!input.response.trim()||input.response.length>4000||typeof input.responsiblePerson!=='string'||input.responsiblePerson.length>200||typeof input.authorName!=='string'||!input.authorName.trim()||input.authorName.length>200||input.followUpDate!==''&&!reportingDate(input.followUpDate))throw Error('Use a valid case, response, reviewer and follow-up date.');
 let state;try{state=JSON.parse(storage.getItem(key)||'{"records":{},"overrides":{},"removed":{},"preferences":{}}');}catch{throw Error('Local history is unreadable. It has not been replaced.');}
 if(!validReportingHistory(state))throw Error('Local history is invalid. It has not been replaced.');
 const events=reviewEvents(state),fingerprint=signature(input),prior=events.find(e=>e.id===input.eventId);
 if(prior){if(prior.data.requestSignature!==fingerprint)throw Error('This retry ID belongs to a different response.');return {state,revision:prior.data.revision,replayed:true};}
 const issue=snapshot.issues.find(i=>i.id===input.issueId);
 const row=snapshot.rows?.find(r=>r.key===issue.deliveryId);
 if(input.findingId!==undefined&&(!snapshot.deliveryReview||typeof input.findingId!=='string'||![...(row?.findings||[]),...(row?.photoFindings||[])].some(f=>f.issue_id===input.findingId)))throw Error('Choose a finding from this delivery evidence.');
 const history=events.filter(e=>reviewMatches(e,issue,snapshot));
 if(history.length!==input.expectedRevision)throw Error('This case has a newer response. Load the latest history before saving your draft.');
 const event={id:input.eventId,created_at:now(),data:{...input,reviewScope:snapshot.deliveryReview?'delivery-review-v1':snapshot.raw?'raw-day-v1':'snapshot',evidenceVersion:issue.evidence?.source_sha256||null,ruleVersion:issue.evidence?.rule_version||null,revision:history.length+1,requestSignature:fingerprint,previousStatus:history.at(-1)?.data.status||'unreviewed',authorVerification:'self-reported-local',upstreamWrites:false}};
 const next={...state,records:{...state.records,reportingReviews:[...events,event]}};
 storage.setItem(key,JSON.stringify(next));return {state:next,revision:event.data.revision,replayed:false};
}
