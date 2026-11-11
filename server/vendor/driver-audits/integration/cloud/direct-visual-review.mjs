// Direct Codex image observations are AI interpretations, not provider receipts,
// human reviews or delivery grades. Authentication of archived inputs is the
// caller's responsibility; this module validates their shape and exact bindings.
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const time=x=>typeof x==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x));
const text=(x,n)=>typeof x==='string'&&x.trim().length>0&&x.length<=n;
const bindingFields=['recordKey','generation','imageSha256','sourceSha256','comparedSourceSha256','sourceSnapshotHash','urlSha256','proofTimestamp','assessmentHash'];
const keys=new Set(['version','method','reviewerModel','reviewerAgent','queueIndex',...bindingFields,'reviewedAt','imageOpened','readability','packageLikeObject','visibleText','description','uncertainty','visualIssues','addressComparison','addressComparisonReason','photoCaptureTime','physicalDeliveryTime','handoverEstablished','originalGradeChanged']);
const issues=new Set(['dark','blurred','overexposed','obstructed','partial_scene','no_package_like_object_visible','label_unreadable','none_observed']);
export function validateDirectVisualReview(r){
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!keys.has(k))||Object.keys(r).length!==keys.size||r.version!==1||r.method!=='codex-direct-visual-review-v1-20261103'||r.reviewerModel!=='gpt-6.1-terra'||!/^\/root\/direct_visual_[1-3]$/.test(r.reviewerAgent)||!Number.isSafeInteger(r.queueIndex)||r.queueIndex<0||!text(r.recordKey,256)||!/^\d{4}-\d{2}-\d{2}\/.+/.test(r.recordKey)||bindingFields.filter(k=>!['recordKey','proofTimestamp'].includes(k)).some(k=>!hex(r[k]))||r.proofTimestamp!==null&&!time(r.proofTimestamp)||!time(r.reviewedAt)||r.imageOpened!==true||!['usable','limited','unusable'].includes(r.readability)||!['visible','not_visible','uncertain'].includes(r.packageLikeObject)||!Array.isArray(r.visibleText)||r.visibleText.length>100||r.visibleText.some(x=>!text(x,1000))||!text(r.description,400)||!text(r.uncertainty,400)||!text(r.addressComparisonReason,300)||!Array.isArray(r.visualIssues)||!r.visualIssues.length||r.visualIssues.some(x=>!issues.has(x))||new Set(r.visualIssues).size!==r.visualIssues.length||r.visualIssues.includes('none_observed')&&r.visualIssues.length!==1||!['visible_text_corresponds_to_source','visible_text_differs_from_source','not_comparable','ambiguous'].includes(r.addressComparison)||r.photoCaptureTime!=='unknown'||r.physicalDeliveryTime!=='unknown'||r.handoverEstablished!==false||r.originalGradeChanged!==false)throw Error('Invalid direct visual review');
 return r;
}
export function directVisualReviewForRow(review,row,source){
 validateDirectVisualReview(review);
 const d=row?.delivery||{},clock=Object.hasOwn(d,'raw_upload')?d.raw_upload:d.upload??null;
 const matches=review.recordKey===row?.key&&review.assessmentHash===row?.assessmentHash&&review.sourceSha256===d.source_sha256&&review.imageSha256===d.photo_sha256&&typeof d.photo_url==='string'&&sha(d.photo_url)===review.urlSha256&&review.proofTimestamp===clock&&source?.status==='compared_local_source'&&hex(source.sourceSnapshotSha256)&&source.sourceSnapshotSha256===review.sourceSnapshotHash&&hex(source.comparedSourceSha256)&&source.comparedSourceSha256===review.comparedSourceSha256;
 const imageEvidenceMatches=review.recordKey===row?.key&&review.imageSha256===d.photo_sha256&&typeof d.photo_url==='string'&&sha(d.photo_url)===review.urlSha256&&review.proofTimestamp===clock;
 return {status:matches?'reviewed':'stale',review,imageEvidenceMatches,independentlyConfirmed:false};
}
export function makeDirectVisualArtifact({queueBytes,queueSha256,reviewLines}){
 if(!Buffer.isBuffer(queueBytes)||!hex(queueSha256)||sha(queueBytes)!==queueSha256||!Array.isArray(reviewLines)||reviewLines.length>100000)throw Error('Invalid direct review inputs');
 const queue=JSON.parse(queueBytes);if(queue.version!==1||!Array.isArray(queue.entries))throw Error('Invalid direct review queue');
 const seen=new Set(),records=new Set(),entries=[];
 for(const line of reviewLines){
  if(typeof line!=='string'||line.length>20000)throw Error('Invalid direct review receipt');
  const r=validateDirectVisualReview(JSON.parse(line)),q=queue.entries[r.queueIndex];
  if(!q||seen.has(r.queueIndex)||records.has(r.recordKey)||bindingFields.some(k=>q[k]!==r[k]))throw Error('Direct review queue binding mismatch');
  seen.add(r.queueIndex);records.add(r.recordKey);entries.push({recordKey:r.recordKey,queueIndex:r.queueIndex,reviewSha256:sha(line),reviewJson:line});
 }
 entries.sort((a,b)=>a.queueIndex-b.queueIndex);
 return {version:'matter-direct-visual-artifact-v1',method:'codex-direct-visual-review-v1-20261103',queueSha256,independentlyConfirmed:false,entries};
}
export async function loadDirectVisualReviews(repository){
 const p=repository?.publication?.directVisualReviews;if(!p)return null;
 if(p.version!==1||!hex(p.sha256)||p.path!=='direct-visual-reviews/'+p.sha256+'.json'||typeof repository.readFile!=='function')throw Error('Invalid direct visual artifact pointer');
 const bytes=await repository.readFile('state',p.path,{maxBytes:16*1024*1024});
 if(!Buffer.isBuffer(bytes)||sha(bytes)!==p.sha256)throw Error('Direct visual artifact integrity failure');
 const artifact=JSON.parse(bytes);
 if(artifact.version!=='matter-direct-visual-artifact-v1'||artifact.method!=='codex-direct-visual-review-v1-20261103'||!hex(artifact.queueSha256)||artifact.independentlyConfirmed!==false||!Array.isArray(artifact.entries)||artifact.entries.length>100000)throw Error('Invalid direct visual artifact');
 const reviews=new Map(),indices=new Set();
 for(const e of artifact.entries){
  if(typeof e?.reviewJson!=='string'||e.reviewJson.length>20000||!hex(e.reviewSha256)||sha(e.reviewJson)!==e.reviewSha256)throw Error('Direct visual receipt integrity failure');
  const review=validateDirectVisualReview(JSON.parse(e.reviewJson));
  if(e.recordKey!==review.recordKey||e.queueIndex!==review.queueIndex||reviews.has(e.recordKey)||indices.has(e.queueIndex))throw Error('Duplicate or mismatched direct visual receipt');
  reviews.set(e.recordKey,{review,reviewSha256:e.reviewSha256});indices.add(e.queueIndex);
 }
 return {artifactSha256:p.sha256,queueSha256:artifact.queueSha256,reviews};
}
