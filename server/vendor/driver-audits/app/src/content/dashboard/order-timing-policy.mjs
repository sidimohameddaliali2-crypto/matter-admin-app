// A shared stop never substitutes another order's slot. Unknown evidence retains
// a review warning; a withdrawal needs positive, version-bound contrary evidence.
export const ORDER_TIMING_POLICY='individual-order-window-v3-20261109';
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const time=x=>typeof x==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x))?Date.parse(x):null;
export const isEarlyFinding=f=>f.category==='Timing'&&f.issue_type==='Early upload';
export const isTimingFinding=f=>f.category==='Timing'&&['Early upload','Late upload'].includes(f.issue_type);
export function verifiedEarliest(record,receipt){
 if(!receipt||receipt.kind!=='explicit_earliest_delivery'||receipt.recordKey!==record.key||receipt.date!==record.date||!hash(record.assessmentHash)||receipt.assessmentHash!==record.assessmentHash||!hash(record.delivery?.source_sha256)||receipt.deliverySourceSha256!==record.delivery.source_sha256||!hash(receipt.sourceSha256)||typeof receipt.sourceRef!=='string'||!receipt.sourceRef.trim()||receipt.customerRestriction!==true)return null;
 const start=time(receipt.startsAt),end=time(record.delivery.deadline);
 if(start===null||end===null||start>end||new Date(start+14400000).toISOString().slice(0,10)!==record.date)return null;
 return {start,sourceSha256:receipt.sourceSha256,sourceRef:receipt.sourceRef,startsAt:receipt.startsAt};
}
export function reassessOrderTiming(record,{earliestDelivery,gps,addressStop,household,acceptedDecision}={}){
 const d=record.delivery||{},earliest=verifiedEarliest(record,earliestDelivery),originalEarly=(record.retainedFindings||record.findings||[]).some(isEarlyFinding)||d.timing_label==='Early upload';
 const originalLate=(record.retainedFindings||record.findings||[]).some(f=>isTimingFinding(f)&&f.issue_type==='Late upload')||d.timing_label==='Late upload';
 const start=earliest?.start??time(d.window_start),end=time(d.deadline),upload=time(d.upload),validWindow=start!==null&&end!==null&&start<=end;
 const base={policy:ORDER_TIMING_POLICY,recordKey:record.key,assessmentHash:record.assessmentHash,deliverySourceSha256:d.source_sha256,originalEarly,originalLate,earliestVerified:!!earliest,windowStart:validWindow?new Date(start).toISOString():null,windowEnd:validWindow?new Date(end).toISOString():null,windowBasis:earliest?'explicit_order_agreement':'saved_reporting_slot',sharedAreaIsIssue:false,physicalDeliveryConfirmed:false,addressStop:addressStop?{state:addressStop.state,stopId:addressStop.stopId,stopKind:addressStop.stopKind,stopMembers:addressStop.stopMembers,stopBasis:addressStop.stopBasis}:null};
 const finish=(state,reason,withdrawn=false)=>({...base,state,reason,withdrawn});
 const householdBound=household?.policy==='accepted-household-receipt-v1'&&household.recordKey===record.key&&household.assessmentHash===record.assessmentHash&&household.deliverySourceSha256===d.source_sha256&&hash(household.arrangementHash)&&hash(household.sourceSha256);
 const timingIssue=originalEarly?'Early upload':originalLate?'Late upload':null;
 if(householdBound&&!earliest&&validWindow&&upload!==null&&((timingIssue==='Early upload'&&upload<start)||(timingIssue==='Late upload'&&upload>end))&&(household.timingIssues||['Early upload']).includes(timingIssue))return {...finish('household_explained','Shared household delivery — partner receipt arrangement applies.',true),explainedIssueTypes:[timingIssue],householdResolution:household};
 if(!originalEarly)return finish(originalLate?'late_upload_review':'no_early_flag',originalLate?'Photo uploaded after this order’s own slot.':'No retained early-upload flag to reassess.');
 const a=acceptedDecision;
 const accepted=a?.kind==='accepted_delivery_timing'&&a.outcome==='clean'&&a.issueType==='Early upload'&&a.recordKey===record.key&&a.date===record.date&&hash(record.assessmentHash)&&a.assessmentHash===record.assessmentHash&&hash(d.source_sha256)&&a.deliverySourceSha256===d.source_sha256&&hash(a.sourceSha256)&&typeof a.sourceRef==='string'&&a.sourceRef.trim()&&typeof a.acceptedBy==='string'&&a.acceptedBy.trim()&&typeof a.decisionId==='string'&&a.decisionId.trim()&&time(a.acceptedAt)!==null&&typeof a.reason==='string'&&a.reason.trim();
 if(accepted)return {...finish('owner_explained',a.reason,true),acceptedDecision:a};
 if(a?.kind==='accepted_delivery_timing'&&a.recordKey===record.key&&a.date===record.date&&(a.assessmentHash!==record.assessmentHash||a.deliverySourceSha256!==d.source_sha256))return {...finish('timing_unresolved','Earlier owner correction retained in history; this delivery’s evidence has changed and needs review.'),acceptedDecision:a,acceptedDecisionStatus:'evidence_conflict'};
 if(!validWindow||upload===null)return finish('timing_unresolved','Original warning retained: this order’s time or slot needs checking.');

 if(upload>=start&&earliest)return finish('original_boundary_not_supported','The upload is not before this order’s corrected earliest time.',true);
 const bound=gps?.recordKey===record.key&&gps.binding?.assessmentHash===record.assessmentHash&&gps.policyVersion===ORDER_TIMING_POLICY&&time(gps.windowStart)===start&&time(gps.windowEnd)===end&&gps.deliverySourceSha256===d.source_sha256;
 if(bound&&gps.deliveryTiming?.state==='gps_supported_in_window_visit')return finish('in_window','Customer-specific evidence supports a visit within this order’s own slot.',true);
 if(bound&&gps.deliveryTiming?.state==='gps_supported_early_visit')return finish('early_supported','Photo and qualified GPS support an early visit against this order’s own slot.');
 if(upload<start)return finish('early_upload_review','Photo uploaded before this order’s own slot. Shared-address uploads are normal; this order’s delivery timing still needs review.');
 return finish('timing_unresolved','Original warning retained: saved timing conflicts with its original assessment.');
}
export function applyOrderTiming(row,assessment){
 const originals=row.retainedFindings||row.findings||[],early=originals.filter(isTimingFinding);
 if(!early.length||row.date<'2026-10-19')return row;
 const valid=assessment?.policy===ORDER_TIMING_POLICY&&assessment.recordKey===row.key&&assessment.assessmentHash===row.assessmentHash&&(!row.delivery?.source_sha256||assessment.deliverySourceSha256===row.delivery.source_sha256);
 const checked=valid?assessment:{policy:ORDER_TIMING_POLICY,state:'validation_pending',reason:'Original early warning retained while validation loads.',originalEarly:true,earliestVerified:false,withdrawn:false};
 const retainedTier=row.retainedTier??row.tier;
 const findings=(row.findings||[]).map(f=>f.orderTimingPolicy?(originals.find(o=>o.issue_id===f.originalIssueId)||f):f).map(f=>!isTimingFinding(f)||(checked.explainedIssueTypes&&!checked.explainedIssueTypes.includes(f.issue_type))||(f.issue_type==='Late upload'&&!checked.explainedIssueTypes?.includes('Late upload'))?f:{...f,issue_id:f.issue_id+':'+ORDER_TIMING_POLICY,category:checked.withdrawn?'Data':f.category,issue_type:checked.state==='owner_explained'?'Explained — owner-accepted delivery':checked.state==='household_explained'?'Explained — shared household delivery':checked.state==='early_supported'?'GPS-supported early visit':checked.state==='in_window'?'Within own delivery window':checked.withdrawn?'Original early flag withdrawn':f.issue_type,tier:checked.withdrawn?0:f.tier,reason:checked.reason,orderTimingPolicy:ORDER_TIMING_POLICY,originalIssueId:f.issue_id});
 const tiers=findings.filter(f=>f.tier>0&&f.category!=='Proof'&&f.assessment_domain!=='photo').map(f=>f.tier);
 return {...row,retainedFindings:originals,retainedTier,tier:tiers.length?Math.min(...tiers):0,findings,timingReassessment:checked};
}
