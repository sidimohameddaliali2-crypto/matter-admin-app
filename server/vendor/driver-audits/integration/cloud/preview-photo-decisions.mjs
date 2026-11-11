// Accepted readings are immutable decisions; refreshed evidence is validated on every load.
const displayFields=new Set(['visibleText','description','addressComparison','addressComparisonReason']);
const text=x=>typeof x==='string'&&x.trim().length>0;
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function applyPhotoDecisions(entries,photos,artifact){
 if(!artifact)return;
 if(artifact.version!==1||!hash(artifact.reportHash)||!Array.isArray(artifact.records))throw Error('Invalid photo decisions');
 const seen=new Set();
 for(const decision of artifact.records){
  const d=decision;
  if(seen.has(d.recordKey)||d.kind!=='accepted_photo_reading'||!d.recordKey?.startsWith(d.date+'/')||!['assessmentHash','deliverySourceSha256','imageSha256','reviewSha256','sourceSha256','comparedSourceSha256'].every(k=>hash(d[k]))||!d.decisionId||!d.acceptedBy||!Number.isFinite(Date.parse(d.acceptedAt))||!d.reason||!d.sourceRef||!['fresh_ai_image_observation','saved_source_field_comparison'].includes(d.observationBasis)||!Array.isArray(d.correction?.visibleText)||d.correction.visibleText.some(x=>!text(x))||!text(d.correction.description)||!text(d.correction.addressComparisonReason)||Object.keys(d.correction).some(k=>!displayFields.has(k))||!['visible_text_corresponds_to_source','ambiguous'].includes(d.correction.addressComparison))throw Error('Invalid photo decision binding');
  seen.add(d.recordKey);
  const entry=entries.get(d.recordKey);
  // Out-of-population decisions remain in the artifact and are never discarded.
  if(!entry)continue;
  const changed=[];
  if(entry.assessmentHash!==d.assessmentHash)changed.push('assessment');
  if(entry.deliverySourceSha256!==d.deliverySourceSha256)changed.push('delivery source');
  if(photos.get(d.recordKey)!==d.imageSha256)changed.push('image');
  if(entry.directPhoto?.reviewSha256!==d.reviewSha256)changed.push('original image review');
  if(entry.source?.comparedSourceSha256!==d.comparedSourceSha256)changed.push('compared address source');
  const state=changed.length?'conflict':'applied';
  entry.photoDecision={state,changed,decision:d};
  const original=d.originalReview?.review||entry.directPhoto?.review;
  const originalText=original?`${original.description} Visible text: ${original.visibleText.join(', ')}. ${original.addressComparisonReason}`:'Original image review unavailable.';
  entry.corrections=[...(entry.corrections||[]),{issue_id:'photo-decision:'+d.decisionId,category:'Data',issue_type:state==='applied'?'Accepted photo-reading correction':'Accepted photo correction needs revalidation',tier:0,supplemental:state==='conflict',reason:(state==='applied'?d.reason:`Saved decision retained; changed ${changed.join(', ')} prevents applying it. ${d.reason}`)+` Accepted by ${d.acceptedBy} on ${d.acceptedAt}. Observation basis: ${d.observationBasis}. Original saved observation: ${originalText} Original grades and reviews are unchanged; handover is not established.`,source:{sha256:d.sourceSha256,imageSha256:d.imageSha256},photoDecisionId:d.decisionId}];
 }
}
