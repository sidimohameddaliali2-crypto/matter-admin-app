import {digest} from './gps.mjs';
import {compareUploadLocation,assessLocationTiming} from '../../app/src/content/dashboard/upload-location.mjs';
export function gpsEvidenceSummary(value){const {version,versionId,recordKey,assessmentHash,deliverySourceSha256,rawOrderVehicle,associatedVehicle,vehicleLabel,sourceState,summary}=value;return {version,versionId,recordKey,assessmentHash,deliverySourceSha256,rawOrderVehicle,associatedVehicle,vehicleLabel,sourceState,summary};}
export function gpsEvidenceResult({row,entry,streams,asOf,sourceInfo,availableStreams=[]}){
 const context=entry.context||{},vehicle=entry.result.vehicle??null,points=streams.flatMap(s=>s.points.map(p=>({...p,vehicle:s.vehicle}))).sort((a,b)=>a.timeMs-b.timeMs||a.id.localeCompare(b.id));
 const assignmentConflict=context.identityConflict===true||entry.result.deliveryTiming?.state==='assignment_conflict'||/conflict|alternative/i.test(context.assignmentState||'');
 const comparison=compareUploadLocation({upload:row.delivery.upload,points,destination:context.pin,policy:entry.result.policy});
 const sourceAvailability=row.gps?.sourceAvailability||null;
 const state=points.length?(points.some(p=>p.usable)?'available':'no_usable_points'):availableStreams.length?'unlinked_identity':sourceInfo?.rawRows&&sourceInfo.usableClockRows===0?'no_usable_clock':sourceInfo?.rawRows?'no_same_day_fix':!sourceInfo&&sourceAvailability?.acquiredSources?'no_usable_clock':'no_source';
 const base={version:'gps-evidence-result-v1',recordKey:row.key,assessmentHash:row.assessmentHash,deliverySourceSha256:row.delivery.source_sha256,deliveryDigest:digest(row.delivery),asOf,rawOrderVehicle:row.delivery.vehicle??null,associatedVehicle:vehicle,vehicleLabel:vehicle?(row.delivery.vehicle&&String(row.delivery.vehicle)===String(vehicle)?String(vehicle):String(vehicle)+' · associated'):'Not linked',sourceState:state,sourceInfo:sourceInfo??null,availableStreamKeys:availableStreams.map(s=>s.key),sourceAvailability,assignment:{state:context.assignmentState,verified:context.assignmentVerified===true,candidates:context.vehicleAlternatives||[],sourceRefs:context.sourceRefs||[],sourceBasis:context.assignmentBasis??null},conflictCauses:[...(context.identityConflict?['dated_assignment_conflict']:[]),...new Set(points.flatMap(p=>p.qualityReasons||[]))],uploadLocation:comparison,sourceRefs:entry.result.sourceRefs||[]};
 const timing=assessLocationTiming({upload:row.delivery.upload,windowStart:row.delivery.window_start,deadline:row.delivery.deadline,uploadLocation:comparison,points,stops:entry.result.sampledStops||[],laterWindowSamples:entry.result.laterWindowSamples||[],destination:context.pin,policy:entry.result.policy,assignment:base.assignment});
 // An unresolved delivery-to-vehicle link does not establish that the fleet
 // has no saved GPS. Keep the source state scoped to this delivery and make
 // the missing association explicit without assigning another account's fixes.
 const missingSourceSummary=!vehicle?'No vehicle linked to this delivery':'No saved GPS source';
 const summary=comparison.state==='outside_time_match'?'GPS available · outside 2 min':state==='unlinked_identity'?'GPS available · assignment unlinked':state==='no_usable_clock'?'Source available · fix clock missing':state==='no_same_day_fix'?'Source available · no fix for this day':state==='no_source'?missingSourceSummary:state==='no_usable_points'?'GPS needs checking':timing.summary;
 // Route coordinates do not resolve a disputed driver/vehicle identity. Keep
 // that warning visible in both compact cards and the existing map labels.
 const value={...base,vehicleLabel:assignmentConflict?(vehicle?String(vehicle):'Not linked')+' · assignment needs checking':base.vehicleLabel,locationTiming:timing,summary:assignmentConflict?'Vehicle assignment needs checking':summary};return {...value,versionId:digest(value)};
}
