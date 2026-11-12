// Transport is injected; credentials stay in the trusted server, never the browser.
// A replay returns the original committed body and event, even if a concurrent
// caller computed a different candidate. Callers must use the returned receipt.
import {Buffer} from 'node:buffer';
import {createHash,randomUUID} from 'node:crypto';
const keyOk=s=>typeof s==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(s);
const idOk=s=>typeof s==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,159}$/.test(s);
function jsonObject(s){if(typeof s!=='string'||Buffer.byteLength(s)>32*1024*1024)throw Error('Invalid state document');let x;try{x=JSON.parse(s);}catch{throw Error('Invalid state document');}if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Invalid state document');}
const conflict=e=>{if(e?.code==='40001'||e?.code==='23505'||e?.code==='55P03'||e?.status===409)throw Object.assign(Error('State revision, request or lease conflict'),{status:409,cause:e});throw e;};
function checkedReceipt(r){if(!r||!Number.isSafeInteger(r.revision)||r.revision<1||typeof r.replayed!=='boolean')throw Error('Invalid state response');jsonObject(r.event_text);jsonObject(r.body_text);if(!/^[a-f0-9]{64}$/.test(r.body_sha256||'')||createHash('sha256').update(r.body_text).digest('hex')!==r.body_sha256)throw Error('State receipt integrity failure');return r;}
export function createCloudState({rpc}){
 if(typeof rpc!=='function')throw Error('State RPC transport required');
 return {async read(key){if(!keyOk(key))throw Error('Invalid state key');const r=await rpc('matter_hosted_state_read',{p_key:key});if(!r||!Number.isSafeInteger(r.revision)||r.revision<0||r.body_text!==null&&typeof r.body_text!=='string')throw Error('Invalid state response');if(r.body_text!==null)jsonObject(r.body_text);return {revision:r.revision,body:r.body_text};},
 async readIfChanged(key,revision){
  if(!keyOk(key)||!Number.isSafeInteger(revision)||revision<0)throw Error('Invalid conditional state read');
  const result=await rpc('matter_hosted_state_read_if_changed',{p_key:key,p_revision:revision});
  if(!result||!Number.isSafeInteger(result.revision)||result.revision<revision||typeof result.unchanged!=='boolean'
   ||result.body_text!==null&&typeof result.body_text!=='string'
   ||result.unchanged&&(result.revision!==revision||result.body_text!==null)
   ||!result.unchanged&&(result.revision===revision||result.body_text===null))throw Error('Invalid conditional state response');
  if(result.body_text!==null)jsonObject(result.body_text);
  return {revision:result.revision,body:result.body_text,unchanged:result.unchanged};
 },
 async receipts(key,{after=0,limit=1}={}){if(!keyOk(key)||!Number.isSafeInteger(after)||after<0||limit!==1)throw Error('Invalid receipt request');const rows=await rpc('matter_hosted_state_receipts',{p_key:key,p_after:after,p_limit:limit});if(!Array.isArray(rows)||rows.length>limit)throw Error('Invalid receipt response');let revision=after;for(const row of rows){if(!Number.isSafeInteger(row.revision)||row.revision<=revision||!idOk(row.event_id)||!/^[a-f0-9]{64}$/.test(row.request_sha256||'')||!/^[a-f0-9]{64}$/.test(row.body_sha256||''))throw Error('Invalid receipt response');jsonObject(row.body_text);jsonObject(row.event_text);if(createHash('sha256').update(row.body_text).digest('hex')!==row.body_sha256)throw Error('Receipt integrity failure');revision=row.revision;}return rows;},
 async compareAndSwap({key,expectedRevision,eventId,body,event,request}){if(!keyOk(key)||!idOk(eventId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('Invalid state request');jsonObject(body);jsonObject(event);if(request===undefined)request=JSON.stringify({expectedRevision,event:JSON.parse(event)});jsonObject(request);let r;try{r=await rpc('matter_hosted_state_cas',{p_key:key,p_expected:expectedRevision,p_event_id:eventId,p_body_text:body,p_event_text:event,p_request_text:request});}catch(e){conflict(e);}return checkedReceipt(r);}};
}
// Collector state is reserved for fenced writes. Lease expiry is decided by PostgreSQL.
export function createCollectorLeaseState({rpc,ownerId=randomUUID(),ttlSeconds=900}={}){
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x);
 if(typeof rpc!=='function'||!uuid(ownerId)||!Number.isInteger(ttlSeconds)||ttlSeconds<30||ttlSeconds>900)throw Error('Invalid collector lease configuration');
 const state=createCloudState({rpc});
 const token=lease=>{if(!lease||lease.ownerId!==ownerId||typeof lease.token!=='string'||!/^[1-9][0-9]{0,15}$/.test(lease.token)||BigInt(lease.token)>9007199254740991n||typeof lease.expiresAt!=='string'||!Number.isFinite(Date.parse(lease.expiresAt)))throw Error('Invalid collector lease');return lease.token;};
 return {
  async acquireLease(){let value;try{value=await rpc('matter_hosted_lease_acquire',{p_owner:ownerId,p_ttl:ttlSeconds});}catch(e){conflict(e);}const lease={...value,ownerId};token(lease);return lease;},
  async assertLease(lease){const valid=await rpc('matter_hosted_lease_assert',{p_owner:ownerId,p_token:token(lease)});if(valid!==true)throw Object.assign(Error('Collector lease expired or superseded'),{status:409});},
  async releaseLease(lease){const result=await rpc('matter_hosted_lease_release',{p_owner:ownerId,p_token:token(lease)});if(typeof result!=='boolean')throw Error('Invalid lease response');return result;},
  async read(){return state.read('collector-state');},
  async compareAndSwap({lease,expectedRevision,eventId,body,event,request}){const fence=token(lease);if(!idOk(eventId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('Invalid state request');jsonObject(body);jsonObject(event);if(request===undefined)request=JSON.stringify({expectedRevision,event:JSON.parse(event)});jsonObject(request);let r;try{r=await rpc('matter_hosted_collector_cas',{p_owner:ownerId,p_token:fence,p_expected:expectedRevision,p_event_id:eventId,p_body_text:body,p_event_text:event,p_request_text:request});}catch(e){conflict(e);}return checkedReceipt(r);},
  async compareAndSwapReviewsGuarded({lease,expectedRevision,expectedReviewRevision,eventId,body,event,request}){const fence=token(lease);if(!idOk(eventId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Number.isSafeInteger(expectedReviewRevision)||expectedReviewRevision<0)throw Error('Invalid guarded state request');jsonObject(body);jsonObject(event);if(request===undefined)request=JSON.stringify({expectedRevision,event:JSON.parse(event)});jsonObject(request);let r;try{r=await rpc('matter_hosted_collector_cas_review',{p_owner:ownerId,p_token:fence,p_expected:expectedRevision,p_expected_review_revision:expectedReviewRevision,p_event_id:eventId,p_body_text:body,p_event_text:event,p_request_text:request});}catch(e){conflict(e);}return checkedReceipt(r);}
 };
}
export function createArchiveCapacity({rpc}){if(typeof rpc!=='function')throw Error('Capacity RPC required');return async({bytes})=>{if(!Number.isSafeInteger(bytes)||bytes<0||bytes>60000000000)throw Error('Invalid capacity request');const r=await rpc('matter_hosted_archive_capacity',{p_requested_bytes:bytes});if(!r||!Number.isSafeInteger(r.used_bytes)||r.used_bytes<0||r.requested_bytes!==bytes||r.limit_bytes!==60000000000||typeof r.allowed!=='boolean'||r.allowed!==(r.used_bytes+bytes<=r.limit_bytes))throw Error('Invalid archive capacity response');return r.allowed;};}
