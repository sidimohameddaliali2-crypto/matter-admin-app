import {applyPhotoBindingRepair} from './photo-binding-repair.mjs';

export function createPreviewPhotoBindingRegistry(view,rows,entries){
 const registry={version:1,generation:view.generation,reportHash:view.reportHash,entries};
 // Validate provenance even for entries later withheld by the grade guard.
 const repaired=applyPhotoBindingRepair(rows,registry),byKey=new Map(view.gpsRows.map(r=>[r.key,r]));
 const eligible=new Set(rows.filter((row,i)=>{
  const bound=byKey.get(row.key);
  return repaired[i]!==row&&row.photo?.grade==null&&row.photo?.reviewStatus==='unreviewed'&&!row.photo?.staleReview
   &&row.delivery?.photo_review_needs_refresh!==true&&row.delivery?.photo_review_valid!==true
   &&bound?.assessmentHash===row.assessmentHash&&JSON.stringify(bound.delivery)===JSON.stringify(row.delivery);
 }).map(r=>r.key));
 return {...registry,entries:entries.filter(e=>eligible.has(e.recordKey))};
}

// Display an exact recovered image without rewriting the saved assessment,
// source delivery, GPS binding, grade or review history.
export function previewPhotoBindings(view,registry=null){
 const photos=new Map(view.photos);
 if(photos.size!==view.photos.length)throw Error('Ambiguous preview photos');
 if(registry===null)return photos;
 if(registry.generation!==view.generation||registry.reportHash!==view.reportHash)throw Error('Preview photo generation mismatch');
 const repaired=applyPhotoBindingRepair(view.gpsRows,registry);
 for(let i=0;i<repaired.length;i++){
  const row=repaired[i];if(row===view.gpsRows[i])continue;
  if(!photos.has(row.key))throw Error('Photo outside preview');
  const prior=photos.get(row.key),next=row.delivery.photo_sha256;
  if(prior&&prior!==next)throw Error('Recovered photo conflicts with retained image');
  photos.set(row.key,next);
 }
 return photos;
}
