import {ORDER_TIMING_POLICY,verifiedEarliest} from '../../app/src/content/dashboard/order-timing-policy.mjs';
import {createHash} from 'node:crypto';

export const METHOD='private-truckoom-timing-v1';
// Screening distances are explicit sensitivity parameters, not GPS accuracy or incident tiers.
export const DEFAULT_POLICY=Object.freeze({radiusMetres:200,sharedSiteMetres:50,maxSampleGapSeconds:300,minStopSpanSeconds:60,uploadMatchSeconds:120,awayMetres:500,jumpKmh:180,jumpMinMetres:500});
export const digest=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
export const clock=x=>{if(typeof x!=='string')return null;const m=x.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/);if(!m)return null;const [,y,mo,d,h,mi,s]=m;if(+mo<1||+mo>12||+d<1||+d>new Date(Date.UTC(+y,+mo,0)).getUTCDate()||+h>23||+mi>59||+s>59)return null;const t=Date.parse(x);return Number.isFinite(t)?t:null;};
export const dayOf=t=>new Date(t+14400000).toISOString().slice(0,10);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const coordinates=p=>p&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=90&&Math.abs(p.longitude)<=180&&(p.latitude!==0||p.longitude!==0);
export function metres(a,b){const r=Math.PI/180,h=Math.sin((a.latitude-b.latitude)*r/2)**2+Math.cos(a.latitude*r)*Math.cos(b.latitude*r)*Math.sin((a.longitude-b.longitude)*r/2)**2;return 6371000*2*Math.asin(Math.sqrt(Math.min(1,h)));}
const count=(o,k)=>{o[k]=(o[k]||0)+1;};
// Truckoom's trip-state label can remain Running at a zero-speed observation.
// Prefer supplied numeric speed; conflicting numeric observations cannot support a stop.
const stopped=p=>p.speeds.length?p.speeds.every(s=>s===0):p.states.length>0&&p.states.every(s=>/^(stopped|stop|idle|stationary|parked)$/i.test(s));
function validatePolicy(p){for(const k of Object.keys(DEFAULT_POLICY))if(!Number.isFinite(p[k])||p[k]<=0)throw Error('Invalid screening policy: '+k);if(p.radiusMetres>=p.awayMetres)throw Error('Near radius must be smaller than away distance');}

const unsafeSourceFlags=new Set(['future_fix_clock','missing_fix_clock','invalid_coordinates','missing_or_nonfinite_position','ambiguous_driver_mapping','missing_driver_mapping','driver_mapping_unavailable','missing_observation_receipt']);
const scopedDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&clock(value+'T00:00:00Z')!==null?value:null;
const referenceFor=p=>({sourceSha256:p.sourceSha256,sourceId:p.sourceId??null,sourceRow:p.sourceRow,sourceKind:p.sourceKind,rawTime:p.time??null,receivedAt:p.receivedAt??null,clockAuthority:p.clockAuthority??null,...(p.provenance?{provenance:structuredClone(p.provenance)}:{}),...(p.nativeReference?{nativeReference:p.nativeReference,nativeBytesVerified:false}:{}),...(p.capture?{capture:structuredClone(p.capture)}:{}),...(p.sourceQualityReasons?.length?{sourceQualityReasons:[...p.sourceQualityReasons].sort()}: {})});

export function savedApiSourceQuality(p){
 const capture=p.capture&&typeof p.capture==='object'?p.capture:null,t=clock(p.gpsTime),received=clock(p.recordedAt);
 const sourceReceipt=capture?.sourceReceipt,sourceReceived=clock(sourceReceipt?.responseReceivedAt);
 const reasons=(Array.isArray(capture?.qualityFlags)?capture.qualityFlags:[]).filter(f=>unsafeSourceFlags.has(f));
 if(capture?.driverMappingState==='ambiguous_current_mapping')reasons.push('ambiguous_driver_mapping');
 if(['unmapped','unavailable'].includes(capture?.driverMappingState))reasons.push('missing_driver_mapping');
 if(sourceReceipt&&(sourceReceived===null||received!==null&&sourceReceived>received))reasons.push('inconsistent_source_receipt_clock');
 if(sourceReceived!==null&&t!==null&&t>sourceReceived)reasons.push('future_at_source_receipt');
 return [...new Set(reasons)].sort();
}

// A saved database row ID is one immutable observation, even when fetched by
// several scopes. A changed clock, vehicle or position is a source conflict.
export function conflictingSavedPointIds(streams){
 const identities=new Map();
 for(const stream of streams)for(const p of stream.points)for(const ref of p.references){
  if(ref.sourceKind!=='saved_api'||!ref.sourceId)continue;
  if(!identities.has(ref.sourceId))identities.set(ref.sourceId,new Set());
  identities.get(ref.sourceId).add(JSON.stringify([stream.vehicle,p.timeMs,p.latitude,p.longitude]));
 }
 return new Set([...identities].filter(([,values])=>values.size>1).map(([id])=>id));
}

export function ingest({exportPoints=[],storedPoints=[],windows=[],asOf,policy=DEFAULT_POLICY}){
 validatePolicy(policy);const cutoff=clock(asOf);if(cutoff===null)throw Error('Explicit evaluation clock required');
 const groups=new Map(),rejections=[],qualityObservations=[],qualityObservationIds=new Set(),accounting={rawOccurrences:0,acceptedOccurrences:0,duplicateOccurrences:0,delayedReceipts:0,rejected:{}};
 function retainBarrier(p,reason,t){
  const scopeDay=t===null?scopedDay(p.scopeDay):dayOf(t);
  if(!hex(p.sourceSha256)||p.sourceRow===undefined||!(p.vehicle||p.scopeVehicle)||!scopeDay||p.observedByCutoff===false)return;
  const marker={vehicle:String(p.vehicle||p.scopeVehicle),scopeDay,timeMs:t,reason,reference:referenceFor(p)},id=digest(marker);
  if(!qualityObservationIds.has(id)){qualityObservationIds.add(id);qualityObservations.push(marker);}
 }
 function add(p,reason){
  accounting.rawOccurrences++;const t=clock(p.time);
  reason ||= !hex(p.sourceSha256)||p.sourceRow===undefined?'missing_provenance':!p.vehicle?'missing_vehicle_identity':t===null?'missing_or_invalid_fix_clock':!coordinates(p)?'invalid_coordinates':t>cutoff?'future_fix':null;
  if(reason){
   count(accounting.rejected,reason);rejections.push({sourceSha256:p.sourceSha256,sourceRow:p.sourceRow,reason});
   // Rejected observations cannot disappear between valid samples. Untimed
   // evidence is scoped to its requested/receipt day, never given a GPS clock.
   const uncertainClock=['future_fix','inconsistent_receipt_clock','inconsistent_cache_fetch_clock'].includes(reason);
   retainBarrier(p,reason,uncertainClock?null:t);
   return;
  }
  const received=clock(p.receivedAt);if(received!==null&&received-t>300000)accounting.delayedReceipts++;
  accounting.acceptedOccurrences++;const key=dayOf(t)+'|'+String(p.vehicle);let g=groups.get(key);if(!g){g={key,day:dayOf(t),vehicle:String(p.vehicle),fixes:new Map()};groups.set(key,g);}
  const fk=JSON.stringify([t,p.latitude,p.longitude]);let f=g.fixes.get(fk);if(!f){f={id:digest([key,fk]),timeMs:t,time:new Date(t).toISOString(),latitude:p.latitude,longitude:p.longitude,receivedAt:p.receivedAt??null,speeds:[],states:[],driverIds:[],references:[],usable:true,qualityReasons:[]};g.fixes.set(fk,f);}else accounting.duplicateOccurrences++;
  for(const speed of [p.speedKmh,...(p.additionalSpeeds||[])])if(Number.isFinite(speed)&&!f.speeds.includes(speed))f.speeds.push(speed);
  for(const state of [p.state,...(p.additionalStates||[])])if(state&&!f.states.includes(state))f.states.push(state);
  if(p.driverId&&!f.driverIds.includes(p.driverId))f.driverIds.push(p.driverId);
  const ref=referenceFor(p);if(!f.references.some(r=>JSON.stringify(r)===JSON.stringify(ref)))f.references.push(ref);
  if(p.sourceQualityReasons?.some(r=>['future_at_source_receipt','future_fix_clock','inconsistent_source_receipt_clock'].includes(r)))retainBarrier(p,'uncertain_source_clock',null);
 }
 for(const p of exportPoints)add({...p,sourceKind:'truckoom_export',receivedAt:null,scopeDay:p.date},p.date&&clock(p.time)!==null&&p.date!==dayOf(clock(p.time))?'export_day_clock_mismatch':null);
 for(const p of storedPoints){
  const fetched=clock(p.provenance?.fetchedAt),t=clock(p.time),received=clock(p.receivedAt),ourFetch=clock(p.provenance?.ourFetchAt);
  const sourceQualityReasons=p.capture?[...new Set([...(p.sourceQualityReasons||[]),...savedApiSourceQuality({gpsTime:p.time,recordedAt:p.receivedAt,capture:p.capture}),...(received!==null&&t!==null&&t>received?['future_at_source_receipt']:[])])]:p.sourceQualityReasons;
  const inconsistent=fetched===null||fetched>cutoff||!p.capture&&t!==null&&t>fetched||p.capture&&(ourFetch===null||ourFetch>cutoff||received!==null&&received>ourFetch);
  add({...p,sourceQualityReasons,observedByCutoff:fetched!==null&&fetched<=cutoff&&(!p.capture||ourFetch!==null&&ourFetch<=cutoff)},p.sourceKind!=='stored_track_cache'?'unsupported_stored_source':inconsistent?'inconsistent_cache_fetch_clock':null);
 }
 for(const w of windows)for(const [index,p] of (w.points||[]).entries()){
  const received=clock(p.recordedAt),fetched=clock(w.fetchedAt),t=clock(p.gpsTime),capture=p.capture&&typeof p.capture==='object'?p.capture:null;
  const sourceQualityReasons=savedApiSourceQuality(p);
  const reason=(w.scopeKind==='vehicle'&&String(p.vehicleNo)!==String(w.vehicleNo))||(w.scopeKind==='driver'&&p.driverId!==w.driverId)?'source_identity_mismatch':!p.id?'missing_point_identity':t===null?'missing_or_invalid_fix_clock':received===null||fetched===null?'missing_receipt_clock':received<t||received>fetched||fetched>cutoff?'inconsistent_receipt_clock':null;
  add({vehicle:p.vehicleNo,time:p.gpsTime,receivedAt:p.recordedAt,latitude:p.location?.lat,longitude:p.location?.lng,speedKmh:capture?.speedKph??p.speedKmh,additionalSpeeds:[p.speedKmh],state:capture?.trackerStatus??p.status,additionalStates:[p.status],driverId:p.driverId,sourceKind:'saved_api',sourceSha256:w.snapshotSha256,sourceRow:index,sourceId:p.id,clockAuthority:'saved_api_gpsTime',capture,sourceQualityReasons,scopeVehicle:w.scopeKind==='vehicle'?w.vehicleNo:null,scopeDay:scopedDay(w.day)||(received!==null?dayOf(received):clock(w.range?.from)!==null?dayOf(clock(w.range.from)):null),observedByCutoff:fetched!==null&&fetched<=cutoff},reason);
 }
 qualityObservations.sort((a,b)=>digest(a).localeCompare(digest(b)));
 const rawStreams=[...groups.values()].map(g=>({...g,points:[...g.fixes.values()]})),conflicts=conflictingSavedPointIds(rawStreams);
 const streams=rawStreams.sort((a,b)=>a.key.localeCompare(b.key)).map(g=>finalizeGpsStream({...g,conflictingSavedIds:conflicts,qualityObservations:qualityObservations.filter(q=>q.vehicle===g.vehicle&&q.scopeDay===g.day)},g.points,policy));
 accounting.distinctFixes=streams.reduce((n,s)=>n+s.points.length,0);if(accounting.acceptedOccurrences!==accounting.distinctFixes+accounting.duplicateOccurrences)throw Error('GPS accounting mismatch');
 return {method:METHOD,policy,accounting,rejections,streams,qualityObservations};
}

export function grade({record,streams,context={},peers=[],policy=DEFAULT_POLICY}){
 validatePolicy(policy);const earliest=verifiedEarliest(record,context.earliestDelivery);const d=record.delivery||{},vehicle=context.vehicle||d.vehicle,pin={latitude:context.pin?.lat,longitude:context.pin?.lng},upload=clock(d.upload),start=earliest?.start??clock(d.window_start),end=clock(d.deadline);
 const out={method:METHOD,policyVersion:ORDER_TIMING_POLICY,deliverySourceSha256:d.source_sha256,windowStart:start===null?null:new Date(start).toISOString(),windowEnd:end===null?null:new Date(end).toISOString(),earliestDeliverySourceSha256:earliest?.sourceSha256??null,earliestDeliveryStartsAt:earliest?.startsAt??null,sharedAreaIsIssue:false,recordKey:record.key,date:record.date,binding:{deliveryDigest:digest(d),photoDigest:digest(record.photo||{}),historyDigest:digest(record.changes||[]),assessmentHash:record.assessmentHash??null,contextDigest:digest(context)},policy,vehicle:vehicle??null,sourceRefs:context.sourceRefs||[],observation:'not_evaluated',sampledStops:[],uploadComparison:null,sharedSite:[],deliveryTiming:{state:'unknown'},originalTier:record.tier??null,physicalDeliveryConfirmed:false,fraudConfirmed:false};
 function finish(state){out.deliveryTiming.state=state;return out;}
 if(!vehicle)return finish('no_recorded_vehicle');
 const ss=streams.filter(s=>s.day===record.date&&s.vehicle===String(vehicle));out.gps={streams:ss.map(s=>s.key),distinctFixes:ss.reduce((n,s)=>n+s.points.length,0),usableFixes:ss.reduce((n,s)=>n+s.usableFixes,0)};
 if(!out.gps.distinctFixes)return finish('no_usable_collected_gps');
 if(!coordinates(pin))return finish('no_recorded_location');
 // This is proximity to the source point, which can be an unverified phone location.
 out.locationBasis=context.destinationVerified?'verified_dated_destination':'source_recorded_point_unverified_destination';
 out.sharedSite=peers.filter(p=>p.key!==record.key&&p.date===record.date&&coordinates({latitude:p.context?.pin?.lat,longitude:p.context?.pin?.lng})&&metres(pin,{latitude:p.context.pin.lat,longitude:p.context.pin.lng})<=policy.sharedSiteMetres).map(p=>p.key).sort();
 const points=ss.flatMap(s=>s.points).sort((a,b)=>a.timeMs-b.timeMs);let cluster=[];
 function finishCluster(){if(cluster.length>=2&&(cluster.at(-1).timeMs-cluster[0].timeMs)>=policy.minStopSpanSeconds*1000){const a=cluster[0],b=cluster.at(-1);out.sampledStops.push({start:a.time,end:b.time,pointIds:cluster.map(p=>p.id),minimumMetres:Math.min(...cluster.map(p=>metres(p,pin))),observedSpanSeconds:(b.timeMs-a.timeMs)/1000,continuousPresenceConfirmed:false,windowComparison:start===null||end===null||start>end?'unknown':b.timeMs<start?'before':a.timeMs>end?'after':a.timeMs>=start&&b.timeMs<=end?'within':'boundary_overlap'});}cluster=[];}
 for(const p of points){if(!p.usable||!stopped(p)||metres(p,pin)>policy.radiusMetres){finishCluster();continue;}if(cluster.length&&p.timeMs-cluster.at(-1).timeMs>policy.maxSampleGapSeconds*1000)finishCluster();cluster.push(p);}finishCluster();
 const nearUpload=upload===null?[]:points.filter(p=>Math.abs(p.timeMs-upload)<=policy.uploadMatchSeconds*1000).sort((a,b)=>Math.abs(a.timeMs-upload)-Math.abs(b.timeMs-upload)||a.timeMs-b.timeMs);
 const nearest=nearUpload[0],sameDistance=nearest?nearUpload.filter(p=>Math.abs(p.timeMs-upload)===Math.abs(nearest.timeMs-upload)):[],locationBand=p=>metres(p,pin)<=policy.radiusMetres?'near':metres(p,pin)>policy.awayMetres?'away':'intermediate',locationAmbiguous=new Set(sameDistance.map(locationBand)).size>1;
 if(nearest)out.uploadComparison={pointId:nearest.id,pointTime:nearest.time,offsetSeconds:(nearest.timeMs-upload)/1000,distanceMetres:metres(nearest,pin),usable:nearest.usable&&sameDistance.every(p=>p.usable),locationAmbiguous,alternatives:sameDistance.map(p=>({pointId:p.id,time:p.time,distanceMetres:metres(p,pin)})),references:nearest.references,exactTime:nearest.timeMs===upload,qualityReasons:[...new Set(sameDistance.flatMap(p=>p.qualityReasons))]};
 const early=out.sampledStops.filter(s=>s.windowComparison==='before'),later=out.sampledStops.filter(s=>s.windowComparison!=='before'),inWindow=out.sampledStops.filter(s=>['within','boundary_overlap'].includes(s.windowComparison));
 const alignment=out.sampledStops.filter(s=>upload!==null&&Date.parse(s.start)-policy.uploadMatchSeconds*1000<=upload&&Date.parse(s.end)+policy.uploadMatchSeconds*1000>=upload);
 out.laterWindowSamples=points.filter(p=>p.usable&&start!==null&&end!==null&&p.timeMs>=start&&p.timeMs<=end&&metres(p,pin)<=policy.radiusMetres&&stopped(p)).map(p=>p.id);
 const hasLater=early.length&&(later.length||out.laterWindowSamples.length),qualityBad=out.uploadComparison&&!out.uploadComparison.usable,away=out.uploadComparison?.usable&&!locationAmbiguous&&out.uploadComparison.distanceMetres>policy.awayMetres;
 out.observation=qualityBad?'upload_gps_quality_affected':locationAmbiguous?'upload_location_ambiguous':hasLater?'multiple_visit_options':early.length&&away?'earlier_stop_upload_elsewhere':alignment.length&&out.uploadComparison?.distanceMetres<=policy.radiusMetres?'upload_near_sampled_stop':away?'upload_location_differs_from_recorded_point':out.sampledStops.length?'sampled_stop_context':'no_supported_sampled_stop';
 out.observedWindowStates=[...new Set(out.sampledStops.map(s=>s.windowComparison))];
 out.coverage={unobservedIntervals:ss.flatMap(s=>s.gaps).filter(g=>start!==null&&end!==null&&Date.parse(g.start)<end&&Date.parse(g.end)>start),absenceEstablished:false};
 const usedPointIds=new Set([...out.sampledStops.flatMap(s=>s.pointIds),...sameDistance.map(p=>p.id)]),usedDriverIds=[...new Set(points.filter(p=>usedPointIds.has(p.id)).flatMap(p=>p.driverIds))];out.recordedDriverIds=usedDriverIds;
 if(context.identityConflict||usedDriverIds.length>1||context.driverId&&usedDriverIds.some(id=>id!==context.driverId))return finish('assignment_conflict');
 if(qualityBad)return finish('affected_gps_cannot_support_timing');
 if(locationAmbiguous)return finish('ambiguous_upload_location');
 if(context.assignmentVerified&&context.destinationVerified&&context.windowVerified&&context.photoCorroborated&&alignment.length===1&&alignment[0].windowComparison==='within')return finish('gps_supported_in_window_visit');
 if(context.assignmentVerified&&context.destinationVerified&&context.windowVerified&&context.photoCorroborated&&alignment.length===1&&alignment[0].windowComparison==='before')return finish('gps_supported_early_visit');
 if(hasLater)return finish('ambiguous_visits');
 if(out.sharedSite.length&&out.observation==='earlier_stop_upload_elsewhere')return finish('shared_site_unallocated');
 if(!context.assignmentVerified||!context.destinationVerified)return finish('provisional_association');
 if(start===null||end===null||start>end||!context.windowVerified)return finish('window_not_verified');
 if(!context.photoCorroborated)return finish('gps_observation_without_customer_specific_corroboration');
 if(out.observation==='earlier_stop_upload_elsewhere')return finish('probable_early');
 if(alignment.length===1&&inWindow.includes(alignment[0]))return finish(alignment[0].windowComparison==='boundary_overlap'?'visit_crosses_window_boundary':'gps_supported_in_window_visit');
 if(alignment.length===1&&alignment[0].windowComparison==='before')return finish('gps_supported_early_visit');
 if(alignment.length===1&&alignment[0].windowComparison==='after')return finish('gps_supported_late_visit');
 return finish(out.sampledStops.length>1?'ambiguous_visits':'no_customer_specific_timing');
}

// Recompute geometry quality after a retained/new union using the ingestion policy.
export function finalizeGpsStream({key,day,vehicle,qualityObservations=[],conflictingSavedIds},input,policy=DEFAULT_POLICY){
 validatePolicy(policy);
  const conflicts=conflictingSavedIds||conflictingSavedPointIds([{vehicle,points:input}]);
  const geometric=new Set(['conflicting_coordinates','impossible_jump','jump_plateau','source_observation_barrier','unplaced_source_observation']);
  const points=input.map(p=>{
   const reasons=[...new Set([...(p.sourceQualityReasons||[]),...(p.qualityReasons||[]).filter(r=>!geometric.has(r)),...p.references.flatMap(r=>r.sourceQualityReasons||[])])].sort();
   if(p.references.some(r=>r.sourceKind==='saved_api'&&conflicts.has(r.sourceId))&&!reasons.includes('saved_point_identity_conflict'))reasons.push('saved_point_identity_conflict');
   return {...p,speeds:[...p.speeds].sort(),states:[...p.states].sort(),driverIds:[...p.driverIds].sort(),references:[...p.references],...(reasons.length?{sourceQualityReasons:reasons}:{}),usable:!reasons.length,qualityReasons:[...reasons]};
  }).sort((a,b)=>a.timeMs-b.timeMs||a.id.localeCompare(b.id)),byClock=new Map(),gaps=[],jumps=[];
  const taint=(p,r)=>{p.usable=false;if(!p.qualityReasons.includes(r))p.qualityReasons.push(r);};
  for(const p of points){const ps=byClock.get(p.timeMs)||[];ps.push(p);byClock.set(p.timeMs,ps);p.references.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));p.motionConflict=p.speeds.includes(0)&&p.speeds.some(s=>s>0);}
  for(const ps of byClock.values())if(ps.length>1)for(const p of ps)taint(p,'conflicting_coordinates');
  const barriers=[...new Map(qualityObservations.filter(q=>q.vehicle===vehicle&&q.scopeDay===day).map(q=>[digest(q),q])).values()].sort((a,b)=>digest(a).localeCompare(digest(b)));
  let previous=null,taintedDestination=null;
  for(const p of points){if(p.qualityReasons.length){previous=null;continue;}
   if(previous&&barriers.some(q=>q.timeMs!==null&&q.timeMs>=previous.timeMs&&q.timeMs<=p.timeMs))previous=null;
   if(taintedDestination&&p.latitude===taintedDestination.latitude&&p.longitude===taintedDestination.longitude)taint(p,'jump_plateau');else taintedDestination=null;
   if(previous){const seconds=(p.timeMs-previous.timeMs)/1000,dist=metres(previous,p);if(seconds>policy.maxSampleGapSeconds)gaps.push({start:previous.time,end:p.time,seconds,reason:'unobserved_interval_not_proven_break'});
    if(seconds>0&&dist>policy.jumpMinMetres&&dist/seconds*3.6>policy.jumpKmh){taint(previous,'impossible_jump');taint(p,'impossible_jump');taintedDestination=p;jumps.push({from:previous.id,to:p.id,metres:dist,seconds});}}
   previous=p;
  }
  for(const marker of barriers){
   if(marker.timeMs===null){for(const p of points)taint(p,'unplaced_source_observation');continue;}
   const before=points.filter(p=>p.timeMs<=marker.timeMs).at(-1)?.timeMs;
   const after=points.find(p=>p.timeMs>=marker.timeMs)?.timeMs;
   // Map/report consumers work with valid coordinates only. Mark both adjacent
   // endpoints so skipping an invalid position cannot create a clean bracket.
   for(const p of points)if(p.timeMs===before||p.timeMs===after)taint(p,'source_observation_barrier');
  }
  return {key:key,day:day,vehicle:vehicle,points,gaps,jumps,distinctFixes:points.length,usableFixes:points.filter(p=>p.usable).length,...(barriers.length?{qualityObservations:barriers}:{})};
}
