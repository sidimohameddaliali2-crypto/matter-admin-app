// Conditional GPS observations, never a delivery verdict or a replacement review.
// No source I/O, model calls, timers or mutations live in this projection.
import {createHash} from 'node:crypto';
import {savedGpsFutureFix,savedGpsCaptureUnusable,savedGpsUncertainClock} from './saved-gps-contract.mjs';

export const SAVED_GPS_ASSESSMENT_VERSION='saved-gps-observation-v1-20261102';
const FIVE_MINUTES=300000,CONTEXT=600000;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const instant=value=>typeof value==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const dayAt=time=>new Date(time+14400000).toISOString().slice(0,10);
const coords=p=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180&&(p.lat!==0||p.lng!==0);
const frozen=row=>row.date>='2026-10-19'&&row.date<='2026-10-25';
function dateScope(windows,scope){
 const days=(windows||[]).map(w=>w.day).filter(Boolean).sort(),result=scope??(days.length?{from:days[0],to:days.at(-1)}:null);
 if(result===null)return null;
 const valid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00+04:00'))&&dayAt(Date.parse(value+'T00:00:00+04:00'))===value;
 if(!valid(result.from)||!valid(result.to)||result.from>result.to)throw Error('Valid bounded GPS assessment date scope required');
 return result;
}
const withinScope=(row,scope)=>!!scope&&typeof row.date==='string'&&row.date>=scope.from&&row.date<=scope.to;
const pointRef=p=>p?{id:p.id,vehicleNo:p.vehicleNo,driverId:p.driverId??null,gpsTime:p.gpsTime,recordedAt:p.recordedAt,location:p.location?{lat:p.location.lat??null,lng:p.location.lng??null}:null,...(p.capture!=null?{capture:structuredClone(p.capture)}:{})}:null;
const distance=(a,b)=>{const rad=n=>n*Math.PI/180,q=Math.sin(rad(a.lat-b.lat)/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(rad(a.lng-b.lng)/2)**2;return Math.round(6371000*2*Math.atan2(Math.sqrt(Math.min(1,q)),Math.sqrt(Math.max(0,1-q))));};
function indexWindows(windows){const index=new Map();for(const w of windows||[]){if(!w||!Array.isArray(w.points)||!w.vehicleNo||!w.day||!/^[a-f0-9]{64}$/.test(w.snapshotSha256||''))throw Error('Verified saved GPS windows required');const key=w.vehicleNo+'/'+w.day;if(index.has(key))throw Error('Only one current saved GPS window per vehicle and day is allowed');index.set(key,w);}return index;}
const reasonMessages={
 capture_quality:'Source capture metadata records unusable position, clock or assignment evidence. These observations cannot support a measurement or connect surrounding fixes.',
 delivery_driver_missing:'The delivery has no source driver ID. A roster name or vehicle reference cannot establish the recorded driver.',
 upload_missing:'No valid timezone-qualified proof upload time is available for GPS comparison.',
 saved_pin_missing:'No valid saved destination coordinates are available. No distance or location outcome is inferred.',
 source_window_missing:'Some collection-day windows around the upload are unavailable. Available observations do not establish complete route coverage.',
 no_observations:'No saved observations were collected in the bounded upload context. This is missing evidence, not proof of no movement.',
 missing_fix_time:'Some relevant records have no usable GPS-fix time. Collection time is not substituted.',
 invalid_location:'Some relevant records have missing or invalid coordinates and are excluded.',
 stale_fixes:'Some relevant fixes were more than five minutes old when collected and are excluded from upload measurements.',
 future_fixes:'Some relevant fixes occur after their collection time and require source-clock review.',
 driver_missing:'Relevant GPS records have no recorded driver ID. They are not attributed to the roster driver.',
 driver_mismatch:'Relevant GPS records identify another driver. The roster reference does not override that evidence.',
 conflicting_fix:'Different coordinates or recorded drivers share a vehicle GPS-fix time. These observations are held for review.',
 no_eligible_fix:'No unambiguous fresh matching-driver fix lies within five minutes of the upload.',
 sampling_gap:'The surrounding accepted fixes are more than five minutes apart. This is a sampling limitation, not a tracking defect or a delivery finding.',
};

export function validateAssignmentConfirmations(values){
 if(!Array.isArray(values))throw Error('Assignment confirmations must be an array');
 const ids=new Set(),keys=new Set();
 for(const c of values){
  if(!c||typeof c.id!=='string'||!c.id||ids.has(c.id)||c.basis!=='user_confirmation'||!c.confirmedBy||instant(c.confirmedAt)===null||typeof c.driverId!=='string'||!c.driverId||typeof c.vehicleNo!=='string'||!c.vehicleNo||!/^\d{4}-\d{2}-\d{2}$/.test(c.day||'')||dayAt(Date.parse(c.day+'T00:00:00+04:00'))!==c.day||!Array.isArray(c.recordKeys)||!c.recordKeys.length||!Array.isArray(c.allowedRecordedDriverIds)||!c.allowedRecordedDriverIds.length||!c.allowedRecordedDriverIds.every(v=>v===null||typeof v==='string'&&v.length>0))throw Error('Invalid dated assignment confirmation');
  ids.add(c.id);for(const key of c.recordKeys){if(typeof key!=='string'||!key||keys.has(key))throw Error('Conflicting assignment confirmation record');keys.add(key);}
 }
 return values;
}

export function assessSavedGps(row,{windows=[],roster=[],completedRecordKeys=[],windowIndex,scope,assignmentConfirmations=[]}={}){
 const completed=completedRecordKeys instanceof Set?completedRecordKeys:new Set(completedRecordKeys);
 if(frozen(row)||completed.has(row.key)||!withinScope(row,dateScope(windows,scope)))return null;
 const delivery=row.delivery||{},driverId=delivery.driver_id||null;
 const reference=driverId?roster.find(d=>d.id===driverId):roster.find(d=>String(d.vehicle)===String(delivery.vehicle));
 if(!reference)return null;
 const vehicleNo=String(reference.vehicle),uploadRaw=(Object.hasOwn(delivery,'raw_upload')?delivery.raw_upload:delivery.upload??null),u=instant(uploadRaw),uploadAt=u===null?null:new Date(u).toISOString();
 const confirmed=validateAssignmentConfirmations(assignmentConfirmations).find(c=>u!==null&&c.driverId===driverId&&c.vehicleNo===vehicleNo&&c.day===dayAt(u)&&c.recordKeys.includes(row.key));
 const supportsAssignment=p=>!!driverId&&(p.driverId===driverId||!!confirmed&&instant(p.gpsTime)!==null&&dayAt(instant(p.gpsTime))===confirmed.day&&confirmed.allowedRecordedDriverIds.includes(p.driverId??null));
 const pinRaw=(Object.hasOwn(delivery,'source_gps_location')?delivery.source_gps_location:row.gps?.destination?.pin),pin=coords(pinRaw)?{lat:pinRaw.lat,lng:pinRaw.lng}:null;
 const index=windowIndex||indexWindows(windows),neededDays=u===null?[]:[...new Set([dayAt(u-CONTEXT),dayAt(u),dayAt(u+CONTEXT)])],selected=neededDays.map(day=>index.get(vehicleNo+'/'+day)).filter(Boolean);
 const coverage={rawPoints:0,distinctFixes:0,duplicateFixes:0,eligibleFixes:0,missingGpsTime:0,invalidLocation:0,staleFixes:0,futureFixes:0,missingRecordedDriver:0,mismatchedDriver:0,conflictingFixTimes:0,availableWindowDays:selected.map(w=>w.day).sort(),missingWindowDays:neededDays.filter(day=>!index.has(vehicleNo+'/'+day))};
 const relevant=[],ids=new Map();
 for(const w of selected)for(const p of w.points){
  if(p.vehicleNo!==vehicleNo)continue;
  const g=instant(p.gpsTime),r=instant(p.recordedAt);
  // Bound the event context so later unrelated collections cannot churn an old assessment.
  const unlocatedCapture=p.capture!=null&&(g===null||savedGpsUncertainClock(p));
  if(!unlocatedCapture&&(r===null?(p.capture==null||g!==null&&Math.abs(g-u)>FIVE_MINUTES):Math.abs(r-u)>CONTEXT||!(Math.abs(r-u)<=FIVE_MINUTES||g!==null&&Math.abs(g-u)<=FIVE_MINUTES)))continue;
  if(ids.has(p.id)){if(hash(ids.get(p.id))!==hash(p))throw Error('Conflicting saved GPS source record identity');continue;}
  ids.set(p.id,p);relevant.push(p);
 }
 relevant.sort((a,b)=>String(a.gpsTime).localeCompare(String(b.gpsTime))||String(a.recordedAt).localeCompare(String(b.recordedAt))||a.id.localeCompare(b.id));
 coverage.rawPoints=relevant.length;
 const timestampGroups=new Map(),fixes=new Map();
 for(const p of relevant){const g=instant(p.gpsTime),r=instant(p.recordedAt),validLocation=coords(p.location);
  if(g===null)coverage.missingGpsTime++;
  if(!validLocation)coverage.invalidLocation++;
  if(g!==null&&r-g>FIVE_MINUTES)coverage.staleFixes++;
  if(savedGpsFutureFix(p))coverage.futureFixes++;
  if(!p.driverId)coverage.missingRecordedDriver++;else if(driverId&&p.driverId!==driverId)coverage.mismatchedDriver++;
  if(g===null||!validLocation)continue;
  const groupKey=String(g),identity=JSON.stringify([g,p.location.lat,p.location.lng]);
  if(!timestampGroups.has(groupKey))timestampGroups.set(groupKey,new Set());
  timestampGroups.get(groupKey).add(JSON.stringify([p.location.lat,p.location.lng,p.driverId??null]));
  const previous=fixes.get(identity);if(!previous||instant(previous.recordedAt)>r)fixes.set(identity,p);
 }
 const conflicts=new Set([...timestampGroups].filter(([,values])=>values.size>1).map(([key])=>key));coverage.conflictingFixTimes=conflicts.size;
 coverage.distinctFixes=fixes.size;coverage.duplicateFixes=relevant.filter(p=>instant(p.gpsTime)!==null&&coords(p.location)).length-fixes.size;
 const eligible=[...fixes.values()].filter(p=>!savedGpsCaptureUnusable(p)&&supportsAssignment(p)&&!conflicts.has(String(instant(p.gpsTime)))&&instant(p.gpsTime)<=instant(p.recordedAt)&&instant(p.recordedAt)-instant(p.gpsTime)<=FIVE_MINUTES&&Math.abs(instant(p.gpsTime)-u)<=FIVE_MINUTES).sort((a,b)=>instant(a.gpsTime)-instant(b.gpsTime)||a.id.localeCompare(b.id));
 coverage.eligibleFixes=eligible.length;
 const assignmentProblem=!driverId||relevant.some(p=>!supportsAssignment(p))||coverage.conflictingFixTimes>0;
 const captureProblem=relevant.some(savedGpsCaptureUnusable);
 const usable=assignmentProblem||captureProblem?[]:eligible;
 const before=usable.filter(p=>instant(p.gpsTime)<=u).at(-1)||null,after=usable.find(p=>instant(p.gpsTime)>=u)||null;
 const nearest=[...usable].sort((a,b)=>Math.abs(instant(a.gpsTime)-u)-Math.abs(instant(b.gpsTime)-u)||instant(a.gpsTime)-instant(b.gpsTime)||a.id.localeCompare(b.id))[0]||null;
 const measurement={nearest:pointRef(nearest),before:pointRef(before),after:pointRef(after),distanceMetres:nearest&&pin?distance(nearest.location,pin):null,sampleOffsetSeconds:nearest?(instant(nearest.gpsTime)-u)/1000:null,gapSeconds:before&&after&&instant(before.gpsTime)!==instant(after.gpsTime)?(instant(after.gpsTime)-instant(before.gpsTime))/1000:null};
 const codes=[];const add=(condition,code)=>{if(condition)codes.push(code);};
 add(captureProblem,'capture_quality');add(!driverId,'delivery_driver_missing');add(u===null,'upload_missing');add(!pin,'saved_pin_missing');add(coverage.missingWindowDays.length,'source_window_missing');add(u!==null&&!relevant.length,'no_observations');add(coverage.missingGpsTime,'missing_fix_time');add(coverage.invalidLocation,'invalid_location');add(coverage.staleFixes,'stale_fixes');add(coverage.futureFixes,'future_fixes');add(coverage.missingRecordedDriver,'driver_missing');add(coverage.mismatchedDriver,'driver_mismatch');add(coverage.conflictingFixTimes,'conflicting_fix');add(u!==null&&!nearest,'no_eligible_fix');add(measurement.gapSeconds>300,'sampling_gap');
 const assignmentConfirmation=confirmed?{id:confirmed.id,basis:confirmed.basis,confirmedBy:confirmed.confirmedBy,confirmedAt:confirmed.confirmedAt,day:confirmed.day,driverId:confirmed.driverId,vehicleNo:confirmed.vehicleNo,allowedRecordedDriverIds:confirmed.allowedRecordedDriverIds}:null;
 const assessment={...(assignmentConfirmation?{assignmentConfirmation}:{}),key:row.key,version:relevant.some(p=>p.capture!=null)?'saved-gps-observation-v2-20261110':SAVED_GPS_ASSESSMENT_VERSION,state:assignmentProblem?'needs_review':nearest&&pin?'measured_observation':'insufficient_evidence',reasons:codes.map(code=>({code,message:code==='future_fixes'&&relevant.some(p=>p.capture!=null)?'Some fixes occur after the original source response or collection time and require source-clock review.':confirmed&&['driver_missing','driver_mismatch'].includes(code)?'Source driver identity is missing or different. A dated user confirmation supports this vehicle association; the source discrepancy is retained.':confirmed&&code==='no_eligible_fix'?'No unambiguous fresh fix covered by the dated confirmation lies within five minutes of the upload.':reasonMessages[code]})),driverId,vehicleNo,uploadAt,measurement,coverage,sourceRefs:selected.map(w=>({snapshotSha256:w.snapshotSha256,day:w.day,vehicleNo,fetchedAt:w.fetchedAt??null})),limitations:['Measurements compare a saved vehicle fix with a reported upload and saved destination pin; they do not establish photo capture location.','Recorded driver IDs corroborate a source association, not independently verified who drove.','The five-minute eligibility bound is a conservative measurement gate, not an incident threshold.','No interpolation, continuous presence, customer visit, physical handover or distance-based incident tier is inferred.','Saved destination coordinates have no independently verified effective address history.'],physicalHandoverConfirmed:false};
 // Source capture hashes remain in the first retained receipt for this evidence
 // version; unrelated later points/fetch times must not trigger re-assessment.
 const {sourceRefs,...semantic}=assessment;
 return {id:hash({...semantic,pin,observations:relevant.map(pointRef)}),...assessment};
}

export function applySavedGpsAssessments(app,options={}){
 return applySavedGpsContexts(applyAssessmentVersions(app,options),options);
}
function applyAssessmentVersions(app,options={}){
 const rows=app.queries?.reporting_validated_deliveries?.rows;if(!Array.isArray(rows))throw Error('Validated delivery rows required');
 const historyId='reporting_saved_gps_assessment_history',prior=app.queries[historyId]?.rows||[],history=[...prior],seen=new Map(history.map(a=>[a.id,a])),windowIndex=indexWindows(options.windows||[]),scope=dateScope(options.windows,options.scope),completedRecordKeys=options.completedRecordKeys instanceof Set?options.completedRecordKeys:new Set(options.completedRecordKeys||[]);
 let changed=false;
 const nextRows=rows.map(row=>{const assessment=assessSavedGps(row,{...options,windowIndex,completedRecordKeys,scope});
  if(!assessment){
   if(frozen(row)||completedRecordKeys.has(row.key)||!withinScope(row,scope)||!row.savedGpsAssessment)return row;
   changed=true;const old=row.savedGpsAssessment;if(!seen.has(old.id)){history.push(old);seen.set(old.id,old);}
   const {savedGpsAssessment,...withoutStaleOverlay}=row;return withoutStaleOverlay;
  }
  if(assessment.id===row.savedGpsAssessment?.id)return row;
  changed=true;const old=row.savedGpsAssessment;if(old&&!seen.has(old.id)){history.push(old);seen.set(old.id,old);}
  if(!seen.has(assessment.id)){history.push(assessment);seen.set(assessment.id,assessment);}
  return {...row,savedGpsAssessment:seen.get(assessment.id)};
 });
 if(!changed)return app;
 const assessed=nextRows.filter(r=>r.savedGpsAssessment),counts={measured_observation:0,needs_review:0,insufficient_evidence:0};for(const row of assessed)counts[row.savedGpsAssessment.state]++;
 const digest=hash(assessed.map(r=>[r.key,r.savedGpsAssessment.id]));
 return {...app,queries:{...app.queries,reporting_validated_deliveries:{...app.queries.reporting_validated_deliveries,rows:nextRows},[historyId]:{...app.queries[historyId],name:'Saved GPS assessment versions',rows:history}},matter:{...app.matter,savedGpsAssessments:{version:SAVED_GPS_ASSESSMENT_VERSION,digest,assessed:assessed.length,counts,historyCount:history.length}}};
}

// Context is deliberately independent of assessment identity/history. It may expose
// unsuitable vehicle observations, but never promotes them to delivery evidence.
export const SAVED_GPS_CONTEXT_VERSION='saved-gps-day-context-v1-20261102';
export function savedGpsContext(row,{windows=[],roster=[],completedRecordKeys=[],windowIndex,scope}={}){
 const completed=completedRecordKeys instanceof Set?completedRecordKeys:new Set(completedRecordKeys);
 if(frozen(row)||completed.has(row.key)||!withinScope(row,dateScope(windows,scope)))return null;
 const delivery=row.delivery||{},driverId=delivery.driver_id||null;
 const reference=driverId?roster.find(d=>d.id===driverId):roster.find(d=>String(d.vehicle)===String(delivery.vehicle));
 if(!reference)return null;
 const vehicleNo=String(reference.vehicle),u=instant((Object.hasOwn(delivery,'raw_upload')?delivery.raw_upload:delivery.upload??null)),uploadDay=u===null?null:dayAt(u),start=u===null?null:Date.parse(uploadDay+'T00:00:00+04:00'),end=start===null?null:start+86400000;
 const pinRaw=(Object.hasOwn(delivery,'source_gps_location')?delivery.source_gps_location:row.gps?.destination?.pin),pin=coords(pinRaw)?{lat:pinRaw.lat,lng:pinRaw.lng}:null;
 const index=windowIndex||indexWindows(windows),neededDays=u===null?[]:[dayAt(start-1),uploadDay,dayAt(end)],selected=neededDays.map(day=>index.get(vehicleNo+'/'+day)).filter(Boolean);
 const coverage={rawPoints:0,distinctFixes:0,duplicateFixes:0,missingGpsTime:0,missingCollectionTime:0,invalidLocation:0,staleFixes:0,futureFixes:0,missingRecordedDriver:0,mismatchedDriver:0,conflictingFixTimes:0,availableWindowDays:selected.map(w=>w.day).sort(),missingWindowDays:neededDays.filter(day=>!index.has(vehicleNo+'/'+day))};
 const observations=[],ids=new Map(),groups=new Map(),fixes=new Map();
 for(const w of selected)for(const p of w.points){
  if(p.vehicleNo!==vehicleNo)continue;
  const g=instant(p.gpsTime),r=instant(p.recordedAt),clock=g??r;
  // A missing fix can be counted by collection time, but is never aligned or selected.
  if(clock===null?p.capture==null:clock<start-CONTEXT||clock>=end+CONTEXT)continue;
  if(ids.has(p.id)){if(hash(ids.get(p.id))!==hash(p))throw Error('Conflicting saved GPS source record identity');continue;}
  ids.set(p.id,p);observations.push(p);
  if(g===null)coverage.missingGpsTime++;
  if(r===null)coverage.missingCollectionTime++;
  if(!coords(p.location))coverage.invalidLocation++;
  if(g!==null&&r!==null&&r-g>FIVE_MINUTES)coverage.staleFixes++;
  if(savedGpsFutureFix(p))coverage.futureFixes++;
  if(!p.driverId)coverage.missingRecordedDriver++;else if(driverId&&p.driverId!==driverId)coverage.mismatchedDriver++;
  if(g===null)continue;
  if(!groups.has(g))groups.set(g,new Set());
  groups.get(g).add(JSON.stringify([coords(p.location)?p.location.lat:null,coords(p.location)?p.location.lng:null,p.driverId??null]));
  if(!coords(p.location))continue;
  const identity=JSON.stringify([g,p.location.lat,p.location.lng,p.driverId??null]),previous=fixes.get(identity);
  if(!previous||(r??Infinity)<(instant(previous.recordedAt)??Infinity)||r===instant(previous.recordedAt)&&p.id.localeCompare(previous.id)<0)fixes.set(identity,p);
 }
 const conflicts=new Set([...groups].filter(([,values])=>values.size>1).map(([g])=>g));
 coverage.rawPoints=observations.length;coverage.distinctFixes=fixes.size;coverage.duplicateFixes=observations.filter(p=>instant(p.gpsTime)!==null&&coords(p.location)).length-fixes.size;coverage.conflictingFixTimes=conflicts.size;
 const points=[...fixes.values()].filter(p=>!savedGpsCaptureUnusable(p)&&!conflicts.has(instant(p.gpsTime))).sort((a,b)=>instant(a.gpsTime)-instant(b.gpsTime)||a.id.localeCompare(b.id));
 let before=points.filter(p=>instant(p.gpsTime)<=u).at(-1)||null,after=points.find(p=>instant(p.gpsTime)>=u)||null,nearest=[...points].sort((a,b)=>Math.abs(instant(a.gpsTime)-u)-Math.abs(instant(b.gpsTime)-u)||instant(a.gpsTime)-instant(b.gpsTime)||a.id.localeCompare(b.id))[0]||null;
 const captureBarriers=observations.filter(savedGpsCaptureUnusable);
 if(before&&after&&captureBarriers.some(p=>{const at=instant(p.gpsTime);return at===null||savedGpsUncertainClock(p)||at>=instant(before.gpsTime)&&at<=instant(after.gpsTime)})){before=null;after=null;}
 const sample=p=>{if(!p)return null;const g=instant(p.gpsTime),r=instant(p.recordedAt),age=r===null?null:(r-g)/1000,assignmentStatus=!driverId?'delivery_driver_missing':!p.driverId?'missing':p.driverId===driverId?'matches_recorded_id':'mismatch';
  return {...pointRef(p),distanceMetres:pin?distance(p.location,pin):null,sampleOffsetSeconds:(g-u)/1000,fixAgeSeconds:age,assignmentStatus,withheldFromAssessment:true,flags:[...(assignmentStatus!=='matches_recorded_id'?[assignmentStatus]:[]),...(age===null?['missing_collection_time']:age<0?['future_fix']:age>300?['stale_fix']:[])]};};
 const codes=[];const add=(condition,code)=>{if(condition)codes.push(code);};
 add(captureBarriers.length,'capture_quality');add(u===null,'upload_missing');add(!driverId,'delivery_driver_missing');add(!pin,'saved_pin_missing');add(coverage.missingWindowDays.length,'source_window_missing');add(u!==null&&!observations.length,'no_observations');add(coverage.missingGpsTime,'missing_fix_time');add(coverage.missingCollectionTime,'missing_collection_time');add(coverage.invalidLocation,'invalid_location');add(coverage.staleFixes,'stale_fixes');add(coverage.futureFixes,'future_fixes');add(coverage.missingRecordedDriver,'driver_missing');add(coverage.mismatchedDriver,'driver_mismatch');add(conflicts.size,'conflicting_fix');
 const messages={...reasonMessages,...(observations.some(p=>p.capture!=null)?{future_fixes:'Some fixes occur after the original source response or collection time and require source-clock review.'}:{}),source_window_missing:'Some upload-day or adjacent collection-day windows are unavailable. This context does not establish complete route coverage.',no_observations:'No saved vehicle observations are available within the displayed GPS-fix search range.',missing_collection_time:'Some observations lack a valid collection timestamp; their fix age cannot be established.',stale_fixes:'Some displayed or searched fixes were more than five minutes old when collected. They remain contextual vehicle observations only.',conflicting_fix:'Conflicting coordinates or driver IDs share a vehicle fix time. No observation at that time is selected as nearest, before or after.'};
 const context={key:row.key,version:observations.some(p=>p.capture!=null)?'saved-gps-day-context-v2-20261110':SAVED_GPS_CONTEXT_VERSION,state:u===null?'upload_unavailable':nearest?'vehicle_observations':'no_unambiguous_observations',vehicleNo,driverId,uploadAt:u===null?null:new Date(u).toISOString(),uploadDay,searchRange:u===null?null:{from:new Date(start-CONTEXT).toISOString(),to:new Date(end+CONTEXT).toISOString(),endExclusive:true},nearest:sample(nearest),before:sample(before),after:sample(after),gapSeconds:before&&after&&instant(before.gpsTime)!==instant(after.gpsTime)?(instant(after.gpsTime)-instant(before.gpsTime))/1000:null,coverage,reasons:codes.map(code=>({code,message:messages[code]})),sourceRefs:selected.map(w=>({snapshotSha256:w.snapshotSha256,day:w.day,vehicleNo,fetchedAt:w.fetchedAt??null})),withheldFromAssessment:true};
 // Keep the first coverage/provenance receipt for unchanged selected evidence.
 // Routine later day samples must not republish the report solely because counts
 // increased. New reason types, source-day availability or selected fixes still
 // change identity and retain a fresh receipt.
 const {sourceRefs,coverage:receiptCoverage,...semantic}=context;
 const availability={availableWindowDays:receiptCoverage.availableWindowDays,missingWindowDays:receiptCoverage.missingWindowDays};
 return {id:hash({...semantic,pin,availability}),...context};
}
export function applySavedGpsContexts(app,options={}){
 const rows=app.queries?.reporting_validated_deliveries?.rows;if(!Array.isArray(rows))throw Error('Validated delivery rows required');
 const scope=dateScope(options.windows,options.scope),completed=options.completedRecordKeys instanceof Set?options.completedRecordKeys:new Set(options.completedRecordKeys||[]),windowIndex=indexWindows(options.windows||[]);let changed=false;
 const nextRows=rows.map(row=>{
  if(frozen(row)||completed.has(row.key)||!withinScope(row,scope))return row;
  const context=savedGpsContext(row,{...options,scope,windowIndex,completedRecordKeys:completed});
  if(context?.id===row.savedGpsContext?.id)return row;
  changed=true;if(context)return {...row,savedGpsContext:context};
  const {savedGpsContext:old,...rest}=row;return rest;
 });
 if(!changed)return app;
 const contexts=nextRows.filter(r=>r.savedGpsContext);
 return {...app,queries:{...app.queries,reporting_validated_deliveries:{...app.queries.reporting_validated_deliveries,rows:nextRows}},matter:{...app.matter,savedGpsContexts:{version:SAVED_GPS_CONTEXT_VERSION,digest:hash(contexts.map(r=>[r.key,r.savedGpsContext.id])),contextualized:contexts.length}}};
}
