import {digest} from './gps.mjs';
// Validate against complete frozen rows before exposing a projected availability overlay.
export function attachReleaseAvailability(entries,rows,bundle,generation){
 if(!bundle)return;
 if(bundle.version!==1||!bundle.records||!Array.isArray(rows))throw Error('Invalid release GPS availability');
 const byKey=new Map(rows.map(row=>[row.key,row]));
 for(const [key,value] of Object.entries(bundle.records)){
  const row=byKey.get(key);
  if(!row||value.binding?.assessmentHash!==row.assessmentHash||value.binding.deliveryDigest!==digest(row.delivery))throw Error('Stale release GPS availability binding');
  const availability=value.sourceAvailability;
  if(!['acquired_unlinked','no_data'].includes(availability?.status)||!availability.sources?.length||availability.sources.some(s=>!/^[a-f0-9]{64}$/.test(s.sourceHash||'')))throw Error('Unverified release GPS source availability');
  const existing=entries.get(key);
  if(existing&&(existing.assessmentHash!==row.assessmentHash||existing.deliverySourceSha256!==row.delivery.source_sha256))throw Error('Conflicting release GPS overlay binding');
  entries.set(key,{...(existing||{version:'matter-evidence-overlay-entry-v1',generation,recordKey:key,assessmentHash:row.assessmentHash,deliverySourceSha256:row.delivery.source_sha256}),gpsAvailability:{...value,deliveryBinding:row.delivery,bindingVerified:true}});
 }
}
