import {applyOrderTiming} from './order-timing-policy.mjs';
// Supplementary evidence stays separate from retained assessments and grades.
function correctionsOnly(row, entry) {
 const corrections=entry?.corrections;
 if(!Array.isArray(corrections)||!corrections.length||entry.recordKey!==row.key||entry.assessmentHash!==row.assessmentHash)return row;
 if(row.delivery?.source_sha256&&row.delivery.source_sha256!==entry.deliverySourceSha256)return row;
 const retainedFindings=row.retainedFindings||row.findings||[];
 return {...row,retainedFindings,corrections,findings:[...corrections,...retainedFindings]};
}

export function applyGpsAvailability(row,entry){
 const value=entry?.gpsAvailability;
 if(!value||value.bindingVerified!==true||entry.recordKey!==row.key||entry.assessmentHash!==row.assessmentHash||value.binding?.assessmentHash!==row.assessmentHash||!value.deliveryBinding)return row;
 if(row.delivery?.source_sha256&&row.delivery.source_sha256!==entry.deliverySourceSha256)return row;
 // Browser summaries omit fields; every supplied field must still match the server-verified full source.
 if(Object.entries(row.delivery||{}).some(([key,field])=>JSON.stringify(field)!==JSON.stringify(value.deliveryBinding[key])))return row;
 return {...row,gps:{...row.gps,originalSourceAvailability:value.originalSourceAvailability,sourceAvailability:value.sourceAvailability}};
}
export function applyPreviewCorrections(row,entry){let next=applyGpsAvailability(correctionsOnly(row,entry),entry);const v=entry?.gpsEvidence;if(v&&v.recordKey===row.key&&v.assessmentHash===row.assessmentHash&&v.deliverySourceSha256===row.delivery?.source_sha256)next={...next,gpsEvidence:v};return entry?.timingReassessment?applyOrderTiming(next,entry.timingReassessment):next;}
