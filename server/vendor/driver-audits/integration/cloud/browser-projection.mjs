import {createHash} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
const compress=promisify(gzip);
const select=(value,keys)=>value&&typeof value==='object'?Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]])):value;
// This is a disposable reader view, never a publication or collector input.
// Full immutable case/query/history resources remain the authoritative evidence.
export function projectBrowserReport(source){
 const matter={...source.matter},queries={...source.queries};
 delete matter.pinnedCurrentObservations;
 delete matter.zoneRecoveryObservations;
 const id=matter.validatedReporting?.queryId,query=queries[id],cases=matter.lazyDeliveryDetails?.cases;
 if(Array.isArray(query?.rows)&&query.rows.every(r=>{const ref=cases?.[r.key];return ref?.count===1&&/^[a-f0-9]{64}$/.test(ref.sha256||'')&&ref.url==='report-data/detail-'+ref.sha256+'.json';})){
  queries[id]={...query,rows:query.rows.map(row=>{
   const {savedGpsContext,...out}=row;
   if(row.savedGpsAssessment){const a=row.savedGpsAssessment;out.savedGpsAssessment=select(a,['state','sourceScope','vehicleNo','reasons','assignmentConfirmation','measurement']);if(Array.isArray(a.reasons))out.savedGpsAssessment.reasons=a.reasons.map(r=>typeof r==='string'?r:select(r,['code','message']));if(a.measurement)out.savedGpsAssessment.measurement=select(a.measurement,['nearest','distanceMetres','sampleOffsetSeconds']);}
   if(row.reportingEvidence){const e=row.reportingEvidence;out.reportingEvidence=select(e,['evidenceKey']);for(const [key,fields] of Object.entries({clocks:['upload','receipt','capture'],recording:['state'],coverage:['deviceCoordinates'],sourceTrackerVisit:['status'],photo:['status']}))if(Object.hasOwn(e,key))out.reportingEvidence[key]=select(e[key],fields);if(e.supportedGpsAssessment)out.reportingEvidence.supportedGpsAssessment={sourceSelectedBounds:select(e.supportedGpsAssessment.sourceSelectedBounds,['classification'])};}
   return out;
  })};
 }
 return {...source,matter,queries};
}
export async function encodeBrowserReport(source){
 const plain=Buffer.from(JSON.stringify(projectBrowserReport(source))),digest=createHash('sha256').update(plain).digest('hex');
 return {manifest:{url:'report-data/snapshot-'+digest+'.json',sha256:digest},body:await compress(plain,{level:6}),gzip:true,decodedBytes:plain.length};
}
