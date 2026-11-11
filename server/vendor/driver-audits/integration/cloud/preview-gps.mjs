import {createHash} from 'node:crypto';
import {compareUploadLocation,assessLocationTiming} from '../../app/src/content/dashboard/upload-location.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=status=>{throw Object.assign(Error('GPS evidence unavailable'),{status});};
export function createPreviewGps({snapshotFor,index,readStream}){
 if(index?.version!==1||!index.records)throw Error('Invalid GPS index');
 return {async read(params,actor){
  if(!actor||!['owner','reviewer','viewer'].includes(actor.role))fail(403);
  const key=params.get('record'),hash=params.get('snapshot');
  if(params.getAll('record').length!==1||params.getAll('snapshot').length!==1||[...params.keys()].some(k=>!['record','snapshot','vehicle'].includes(k))||!key||key.length>300||!/^[a-f0-9]{64}$/.test(hash||''))fail(400);
  const snapshot=await snapshotFor(hash);if(snapshot?.snapshotHash!==hash)fail(404);
  const row=snapshot.rows.find(r=>r.key===key);if(!row)fail(404);
  const entry=index.records[key],base={version:1,recordKey:key,snapshotHash:hash,assessmentHash:row.assessmentHash,date:row.date,upload:row.delivery?.upload,windowStart:row.delivery?.window_start,deadline:row.delivery?.deadline,asOf:index.asOf,points:[],physicalDeliveryConfirmed:false};
  if(!entry)return {...base,status:'unavailable',message:'No GPS replay is saved for this delivery.'};
  const r=entry.result;if(r.binding.assessmentHash!==row.assessmentHash||r.binding.deliveryDigest!==digest(row.delivery))return {...base,status:'stale',message:'Delivery evidence changed; the earlier GPS comparison is retained in history.'};
  const context=entry.context,requested=params.get('vehicle'),vehicle=requested||r.vehicle;
  if(params.getAll('vehicle').length>1||requested&&!(context.vehicleAlternatives||[]).includes(requested))fail(400);
  const alternative=!!requested&&requested!==r.vehicle,streamKeys=alternative?(index.streamFiles?.[row.date+'|'+requested]?[row.date+'|'+requested]:[]):r.gps?.streams||[];
  const streams=await Promise.all(streamKeys.map(readStream));
  const pin=context.pin,validPin=pin&&Number.isFinite(pin.lat)&&Math.abs(pin.lat)<=90&&Number.isFinite(pin.lng)&&Math.abs(pin.lng)<=180;
  const points=streams.flatMap(s=>s.points.map(p=>({...p,vehicle:s.vehicle}))).sort((a,b)=>a.timeMs-b.timeMs||a.id.localeCompare(b.id));
  const evidence={...base,status:'ready',points,vehicle,uploadLocation:compareUploadLocation({upload:base.upload,points,destination:validPin?pin:null,policy:r.policy}),
   assignment:{state:context.assignmentState,verified:context.assignmentVerified===true,candidates:context.vehicleAlternatives||[],...(context.assignmentBasis?{sourceBasis:context.assignmentBasis}:{})},
   destination:validPin?{...pin,verified:context.destinationVerified===true,basis:context.pinRole||'recorded_reference_not_independently_validated',...(context.pinBasis?{sourceBasis:context.pinBasis}:{}),label:context.destinationVerified?'Verified delivery address':/photo|proof/i.test(context.pinRole||'')?'Photo location':'Saved location candidate'}:null,
   observation:alternative?'alternative_vehicle_context':r.observation,timingState:alternative?'alternative_vehicle_context':r.deliveryTiming?.state,stops:alternative?[]:r.sampledStops||[],laterWindowSamples:alternative?[]:r.laterWindowSamples||[],uploadComparison:alternative?null:r.uploadComparison||null,gaps:streams.flatMap(s=>s.gaps||[]),assessmentGaps:alternative?[]:r.coverage?.unobservedIntervals||[],addressStop:entry.addressStop?.assessmentHash===row.assessmentHash&&entry.addressStop?.deliverySourceSha256===row.delivery?.source_sha256?entry.addressStop:null,related:entry.related||[],policy:r.policy,sourceRefs:r.sourceRefs||[]};
  const projection=!alternative?entry.evidenceResult:null;
  if(projection&&(projection.assessmentHash!==row.assessmentHash||projection.deliveryDigest!==digest(row.delivery)||JSON.stringify(projection.uploadLocation)!==JSON.stringify(evidence.uploadLocation)))throw Error('GPS evidence projection mismatch');
  return {...evidence,...(projection?{gpsEvidence:projection,uploadLocation:projection.uploadLocation,locationTiming:projection.locationTiming}:{locationTiming:assessLocationTiming(evidence)})};
 }};
}
