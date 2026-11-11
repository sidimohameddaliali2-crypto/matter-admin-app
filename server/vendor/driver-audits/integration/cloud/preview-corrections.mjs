import {attachReleaseAvailability} from '../private-gps/release-availability.mjs';
import {applyPhotoDecisions} from './preview-photo-decisions.mjs';
import {applyPreviewCorrections} from '../../app/src/content/dashboard/preview-corrections.mjs';
const labels={photo_image_reused:'Same photo linked to multiple orders',reported_early_delivery:'Reported early delivery',reported_late_delivery:'Reported late delivery',reported_wrong_delivery:'Reported wrong delivery',reported_missed_delivery:'Reported missed delivery',printed_label_date_differs_from_service_date:'Photo label date differs',photo_label_customer_differs_from_record:'Photo label names another customer',photo_label_unit_differs_from_source:'Photo label unit differs',photo_label_building_text_differs_from_source:'Photo label building differs'};
export function connectPreviewCorrections(service,view,bundle){
 if(bundle.version!==1||!/^[a-f0-9]{64}$/.test(bundle.reportHash||'')||!/^[a-f0-9]{64}$/.test(bundle.generation||''))throw Error('Correction report binding mismatch');
 const entries=new Map(view.overlay.entries.map(e=>[e.recordKey,{...e}])),photos=new Map(view.photos),seen=new Set();
 for(const record of bundle.records){
  const entry=entries.get(record.recordKey);if(!entry||seen.has(record.recordKey))throw Error('Missing or duplicate correction record');seen.add(record.recordKey);
  const findings=[];
  for(const event of [...record.reportedIncidents,...record.photoSupplements]){
   const binding=event.sourceBinding||event;
   if(event.recordKey!==entry.recordKey||![binding.assessmentHash,binding.sourceSha256,event.eventId].every(x=>/^[a-f0-9]{64}$/.test(x||'')))throw Error('Invalid correction binding');
   const complaint=event.kind==='reported_incident';
   if(complaint&&(event.match?.state!=='provisional_unique_name_date'||event.match.keys.length!==1||event.match.keys[0]!==entry.recordKey))throw Error('Unresolved complaint identity');
   if(!complaint&&(event.kind!=='photo_detail_supplement'||!/^[a-f0-9]{64}$/.test(event.imageSha256||'')))throw Error('Invalid correction photo');
   const changed=binding.assessmentHash!==entry.assessmentHash||binding.sourceSha256!==entry.deliverySourceSha256||!complaint&&event.imageSha256!==photos.get(entry.recordKey);
   if(changed){findings.push({issue_id:'preview-correction:'+event.eventId+':revalidate',category:complaint?'Customer reports':'Photo details',issue_type:'Saved finding needs evidence revalidation',tier:0,supplemental:true,reason:'This finding belongs to earlier evidence. Check the changed source before applying it; the original report or observation is retained.',eventId:event.eventId,priorEvidence:event,source:complaint?event.source:{sha256:event.observationRef?.sha256,imageSha256:event.imageSha256},evidenceConflict:true});continue;}
   for(const [index,finding]of (complaint?[event]:event.findings).entries()){
    if(!labels[finding.category])throw Error('Unknown correction category');
    if(finding.category==='photo_image_reused'&&(!Array.isArray(event.relatedRecordKeys)||event.relatedRecordKeys.length<2||new Set(event.relatedRecordKeys).size!==event.relatedRecordKeys.length||!event.relatedRecordKeys.includes(entry.recordKey)||event.relatedRecordKeys.some(key=>photos.get(key)!==event.imageSha256)))throw Error('Unverified shared image group');
    findings.push({issue_id:'preview-correction:'+event.eventId+':'+index,category:complaint?'Customer reports':'Photo details',issue_type:labels[finding.category],tier:0,supplemental:true,
     reason:complaint?'Operations reported: '+event.issue+'. Matched by customer name and date; delivery outcome has not been independently confirmed.':'Visible on photo: '+finding.observed+'. Saved record: '+finding.recorded+'. '+finding.basis+'.',
     source:complaint?{sha256:event.source.sha256,sheet:event.source.sheet,range:event.source.range,url:'https://docs.google.com/spreadsheets/d/'+event.source.spreadsheetId+'/edit#range='+encodeURIComponent("'"+event.source.sheet+"'!"+event.source.range)}:{sha256:event.observationRef.sha256,imageSha256:event.imageSha256},eventId:event.eventId,...(finding.category==='photo_image_reused'?{relatedRecordKeys:event.relatedRecordKeys,groupId:'shared-image:'+event.imageSha256}:{})});
   }
  }
  if(new Set(findings.map(f=>f.issue_id)).size!==findings.length)throw Error('Duplicate correction finding');
  entry.corrections=findings;
 }
 applyPhotoDecisions(entries,photos,bundle.photoDecisions);
 attachReleaseAvailability(entries,view.gpsRows,bundle.gpsAvailability,view.generation);
 const overlay={...view.overlay,entries:[...entries.values()]};
 return {...service,async evidenceOverlay(params){const original=await service.evidenceOverlay(params);return original.status==='ready'&&original.generation===view.generation?overlay:original;},async snapshotFor(hash){const snapshot=await service.snapshotFor(hash);if(hash!==view.reportHash)return snapshot;return {...snapshot,rows:snapshot.rows.map(row=>applyPreviewCorrections(row,entries.get(row.key)))};}};
}
