import {householdResolutions} from './household-arrangements.mjs';
import {createHash} from 'node:crypto';
import {gpsEvidenceSummary} from '../private-gps/evidence-result.mjs';
import {ORDER_TIMING_POLICY,reassessOrderTiming,applyOrderTiming} from '../../app/src/content/dashboard/order-timing-policy.mjs';
export function connectPreviewOrderTiming(service,view,index,{households,decisions,frozen=false}={}){
 if(decisions&&(decisions.version!==1||!(/^[a-f0-9]{64}$/.test(decisions.reportHash||''))||!Array.isArray(decisions.records)||new Set(decisions.records.map(d=>d.recordKey)).size!==decisions.records.length))throw Error('Case decision binding mismatch');
 // The report hash records origin, not the scope of an owner decision.
 // reassessOrderTiming independently requires the exact dated order and both
 // assessment/source hashes; unrelated refreshed rows cannot revoke acceptance.
 const accepted=new Map((decisions?.records||[]).map(d=>[d.recordKey,d]));
 const byKey=new Map(view.gpsRows.map(r=>[r.key,r]));
 // A verified index file can still contain an earlier order's projection.
 // Attach context only when every identity matches the full current source row.
 function gpsSummary(row){
  const source=row&&byKey.get(row.key),value=row&&index.records[row.key]?.evidenceResult;
  if(!source?.delivery||!row.delivery||!value||value.recordKey!==row.key||value.assessmentHash!==source.assessmentHash||value.assessmentHash!==row.assessmentHash||value.deliverySourceSha256!==source.delivery.source_sha256||value.deliverySourceSha256!==row.delivery.source_sha256||value.deliveryDigest!==createHash('sha256').update(JSON.stringify(source.delivery)).digest('hex'))return null;
  // Report rows may omit fields; each supplied field must match the full source.
  if(Object.entries(row.delivery).some(([key,field])=>JSON.stringify(field)!==JSON.stringify(source.delivery[key])))return null;
  return gpsEvidenceSummary(value);
 }
 let cachedArrangements=null,cachedAssessments=null,cachedOverlay=null,cachedOriginal=null;
 async function assess(){
 let arrangements=[];try{arrangements=households?(await households.read()).arrangements:[];}catch{ /* storage failure never clears a warning */ }
 const revision=JSON.stringify(arrangements);if(frozen&&cachedAssessments&&revision===cachedArrangements)return cachedAssessments;
 const resolved=householdResolutions([...byKey.values()],index,arrangements);
 const result=new Map([...byKey.values()].filter(r=>r.date>='2026-10-19').map(r=>[r.key,reassessOrderTiming(r,{earliestDelivery:r.delivery.earliest_delivery_evidence,gps:index.records[r.key]?.result,addressStop:index.records[r.key]?.addressStop,household:resolved.get(r.key),acceptedDecision:accepted.get(r.key)})]));
 cachedArrangements=revision;cachedAssessments=result;cachedOverlay=null;return result;
 }
 return {...service,async householdStopFor(key){
  const assessments=await assess(),matched=[...assessments.values()].find(a=>a.householdResolution&&(a.recordKey===key||a.householdResolution.partnerRecordKey===key));
  if(!matched)return null;
  const h=matched.householdResolution,keys=[h.recordKey,h.partnerRecordKey].sort();
  return {stopId:h.stopId,authority:'owner_accepted',arrangementId:h.arrangementId,arrangementHash:h.arrangementHash,sourceRef:h.sourceRef,sourceSha256:h.sourceSha256,members:keys.map(k=>{const r=byKey.get(k);return {recordKey:k,assessmentHash:r.assessmentHash,deliverySourceSha256:r.delivery.source_sha256,customer:r.delivery.customer,date:r.date,upload:r.delivery.upload,windowStart:r.delivery.window_start,deadline:r.delivery.deadline,addressRelation:'same_apartment'};})};
 },async evidenceOverlay(params){const overlay=await service.evidenceOverlay(params);if(overlay.status!=='ready'||overlay.generation!==view.generation)return overlay;
  const assessments=await assess();if(frozen&&cachedOverlay&&cachedOriginal===overlay)return cachedOverlay;const entries=new Map(overlay.entries.map(e=>[e.recordKey,{...e}]));for(const [key,timingReassessment]of assessments){const row=byKey.get(key);let entry=entries.get(key);if(entry&&(entry.assessmentHash!==row.assessmentHash||entry.deliverySourceSha256!==row.delivery.source_sha256))throw Error('Timing reassessment binding mismatch');if(!entry){entry={version:'matter-evidence-overlay-entry-v1',generation:view.generation,recordKey:key,assessmentHash:row.assessmentHash,deliverySourceSha256:row.delivery.source_sha256};entries.set(key,entry);}entry.timingReassessment=timingReassessment;}
  for(const [key,entry]of entries){const value=gpsSummary(byKey.get(key));delete entry.gpsEvidence;if(value)entry.gpsEvidence=value;}
  cachedOriginal=overlay;cachedOverlay={...overlay,orderTimingPolicy:ORDER_TIMING_POLICY,entries:[...entries.values()]};return cachedOverlay;},async snapshotFor(hash){const snapshot=await service.snapshotFor(hash);if(hash!==view.reportHash)return snapshot;const assessments=await assess();return {...snapshot,rows:snapshot.rows.map(row=>{const value=gpsSummary(row),{gpsEvidence:priorGpsEvidence,...current}=row;return {...applyOrderTiming(current,assessments.get(row.key)),...(value?{gpsEvidence:value}:{})};})};}};
}
