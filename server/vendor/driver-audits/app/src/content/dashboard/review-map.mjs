export const evidenceTime=value=>typeof value==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
export const dubaiClock=value=>Number.isFinite(evidenceTime(value))?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value))+(new Date(value).getUTCMilliseconds()?'.'+String(new Date(value).getUTCMilliseconds()).padStart(3,'0'):''):'Not recorded';
export function visibleSelection(points,id,anchor){return points.find(p=>p.id===id)||[...points].sort((a,b)=>Math.abs(a.timeMs-anchor)-Math.abs(b.timeMs-anchor))[0]||null;}

const gpsQualityLabels={
 conflicting_coordinates:'Different positions were recorded at the same time',
 impossible_jump:'The recorded movement is too fast to rely on',
 jump_plateau:'Repeated positions follow an unreliable GPS jump',
 source_observation_barrier:'An unreliable reading interrupts this comparison',
 unplaced_source_observation:'A reading has no reliable time within this day',
 saved_point_identity_conflict:'Different versions of the same saved reading disagree',
 future_at_source_receipt:'The GPS time is later than when the source received it',
 future_fix_clock:'The GPS time is later than when the source received it',
 future_fix:'The GPS time is later than this report’s cutoff',
 missing_fix_clock:'The GPS time is missing or invalid',
 missing_or_invalid_fix_clock:'The GPS time is missing or invalid',
 invalid_coordinates:'The recorded position is invalid',
 missing_or_nonfinite_position:'The recorded position is missing or invalid',
 ambiguous_driver_mapping:'More than one driver is linked to this vehicle',
 missing_driver_mapping:'The driver assignment is missing',
 driver_mapping_unavailable:'The driver assignment could not be checked',
 missing_observation_receipt:'The original receipt time is missing',
 missing_receipt_clock:'A collection or receipt time is missing',
 inconsistent_source_receipt_clock:'The source receipt times disagree',
 inconsistent_receipt_clock:'The GPS and collection times disagree',
 inconsistent_cache_fetch_clock:'The saved GPS and retrieval times disagree',
 uncertain_source_clock:'The source time cannot be placed reliably',
 source_identity_mismatch:'The reading does not match the requested vehicle or driver',
 missing_point_identity:'The saved reading has no reference ID',
 missing_vehicle_identity:'The vehicle is not identified',
 missing_provenance:'The original source reference is missing',
 unsupported_stored_source:'The saved source could not be verified',
 export_day_clock_mismatch:'The GPS time does not match the export date',
};
export function gpsQualityText(reasons){
 const values=Array.isArray(reasons)?reasons:[];
 return [...new Set(values.map(reason=>Object.hasOwn(gpsQualityLabels,reason)?gpsQualityLabels[reason]:'This reading needs checking'))].join('; ')||'This reading needs checking';
}

const queueTier=row=>(row.matchedFindings?.some(f=>f.supplemental)?row.tier:row.selectedTier)||4;
export function reviewQueue(rows){return [...rows].sort((a,b)=>queueTier(a)-queueTier(b)||a.date.localeCompare(b.date)||a.key.localeCompare(b.key));}
export function inspectionQueue(rows,identities,combineWeekend=false){
 const ordered=reviewQueue(rows),seen=new Set(),queue=[];
 for(const row of ordered){if(seen.has(row.key))continue;const peers=combineWeekend?weekendOrders(row,rows,identities):[row],paired=new Set(peers.map(r=>r.date)).size>1,orders=paired?peers:[row];
  for(const peer of orders)seen.add(peer.key);
  queue.push({...row,queueOrderKeys:orders.map(r=>r.key),queueDate:paired?orders[0].date:row.date});
 }
 return queue.sort((a,b)=>queueTier(a)-queueTier(b)||a.queueDate.localeCompare(b.queueDate)||a.key.localeCompare(b.key));
}
export function weekendOrders(row,rows,identities){
 const day=new Date(row.date+'T12:00:00Z').getUTCDay(),identity=identities?.[row.key];
 if(![6,0].includes(day)||typeof identity!=='string'||!identity)return [row];
 const saturday=new Date(Date.parse(row.date+'T12:00:00Z')-(day===0?86400000:0)).toISOString().slice(0,10),sunday=new Date(Date.parse(saturday+'T12:00:00Z')+86400000).toISOString().slice(0,10);
 return rows.filter(r=>identities[r.key]===identity&&[saturday,sunday].includes(r.date)).sort((a,b)=>a.date.localeCompare(b.date)||a.key.localeCompare(b.key));
}
export function routeSegments(points,maxGapSeconds=300){
 const result=[];let current=[],last=null;
 for(const p of points){const valid=p.usable===true&&Number.isFinite(p.timeMs)&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude);
  if(!valid||last&&(p.vehicle!==last.vehicle||p.timeMs<=last.timeMs||p.timeMs-last.timeMs>maxGapSeconds*1000)){if(current.length)result.push(current);current=[];}
  if(valid)current.push(p);last=valid?p:null;
 }if(current.length)result.push(current);return result;
}
export function timelineRange(evidence,mode='upload'){
 const upload=evidenceTime(evidence.upload),times=(evidence.points||[]).map(p=>p.timeMs).filter(Number.isFinite),start=evidenceTime(evidence.windowStart),end=evidenceTime(evidence.deadline);
 const anchor=Number.isFinite(upload)?upload:times[0]??(Number.isFinite(start)?start:Date.parse(evidence.date+'T00:00:00+04:00'));
 if(mode==='upload')return {start:Math.floor(anchor/300000)*300000-1800000,end:Math.floor(anchor/300000)*300000+1800000};
 const all=[...times,upload,start,end].filter(Number.isFinite);return {start:Math.min(...all,anchor),end:Math.max(...all,anchor+60000)};
}
export const timePercent=(time,range)=>100*(time-range.start)/(range.end-range.start);
export function metresBetween(a,b){if(!a||!b)return null;const rad=x=>x*Math.PI/180,dlat=rad(b.lat-a.lat),dlng=rad(b.lng-a.lng),x=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlng/2)**2;return 6371000*2*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));}
export function uploadMapPins(evidence,points){
 if(evidence.uploadLocation?.version===1){
  const comparison=evidence.uploadLocation,ids=new Set([...comparison.before,...comparison.after,...comparison.excludedNearest].map(p=>p.pointId)),groups=new Map();
  for(const p of (evidence.points||points).filter(p=>ids.has(p.id))){const key=[p.latitude,p.longitude,p.usable].join(':');const group=groups.get(key)||[];if(!group.some(x=>x.id===p.id))group.push(p);groups.set(key,group);}
  const u=evidenceTime(evidence.upload);
  return [...groups.values()].map(group=>{group.sort((a,b)=>a.timeMs-b.timeMs);const p=[...group].sort((a,b)=>Math.abs(a.timeMs-u)-Math.abs(b.timeMs-u))[0],seconds=Math.round(Math.abs(p.timeMs-u)/1000),duration=seconds>=60?Math.floor(seconds/60)+'m '+seconds%60+'s':seconds===0?'<1s':seconds+'s',distance=metresBetween({lat:p.latitude,lng:p.longitude},evidence.destination),bothSides=group.some(x=>x.timeMs<u)&&group.some(x=>x.timeMs>u);
   return {point:p,pointIds:group.map(p=>p.id),time:[...new Set(group.map(p=>dubaiClock(p.time).split('.')[0]))].join(' & '),distance:distance==null?null:Math.round(distance),offset:bothSides?'Before & after upload':p.timeMs===u?'At upload time':duration+(p.timeMs<u?' before upload':' after upload'),suspect:p.usable!==true,comparisonState:comparison.state};
  });
 }

 const upload=evidenceTime(evidence.upload);if(!Number.isFinite(upload))return [];
 const available=points.filter(p=>Number.isFinite(p.timeMs)&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude));
 const gap=Math.min(...available.map(p=>Math.abs(p.timeMs-upload)));
 const nearest=available.filter(p=>Math.abs(p.timeMs-upload)===gap),seen=new Set();
 return nearest.filter(p=>{const key=[p.timeMs,p.latitude,p.longitude].join(':');if(seen.has(key))return false;seen.add(key);return true;}).map(p=>{
  const seconds=Math.round(Math.abs(p.timeMs-upload)/1000),duration=seconds>=60?Math.floor(seconds/60)+'m '+seconds%60+'s':seconds+'s';
  const distance=metresBetween({lat:p.latitude,lng:p.longitude},evidence.destination);
  return {point:p,time:dubaiClock(p.time),distance:distance==null?null:Math.round(distance),offset:seconds===0?'At upload time':duration+(p.timeMs<upload?' before upload':' after upload'),suspect:p.usable!==true};
 });
}
// The opening map is a time comparison, not the vehicle's whole journey.
// Keep tied/conflicting fixes visible instead of selecting the convenient one.
export function mapViewPoints(evidence,mode='upload'){
 const points=(evidence.points||[]).filter(p=>Number.isFinite(p.timeMs)&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude));
 return mode==='full'?points:uploadMapPins(evidence,points).map(pin=>pin.point);
}
export function emptyMapMessage(evidence,mode='upload'){
 const available=mapViewPoints(evidence,'full');
 if(mode==='upload'&&available.length)return Number.isFinite(evidenceTime(evidence.upload))?'No upload-time comparison · GPS available in evidence':'Upload time missing · GPS available in evidence';
 return 'No GPS linked to this delivery';
}
export const gpsStateText={alternative_vehicle_context:'Alternative vehicle route; no delivery assignment asserted',assignment_conflict:'Vehicle readings available; driver assignment conflicts',no_recorded_location:'Vehicle route available; delivery location missing',no_recorded_vehicle:'No vehicle linked to this delivery',no_usable_collected_gps:'No usable readings in the saved GPS copy',affected_gps_cannot_support_timing:'GPS jumps or conflicts prevent a timing check',shared_site_unallocated:'Other deliveries share this location',ambiguous_visits:'More than one visit could match',provisional_association:'Vehicle readings available; assignment or location needs checking'};

// One customer's route is anchored to that customer's upload, never a guessed handover.
export function caseRoutePoints(evidence,mode='upload'){
 const points=mapViewPoints(evidence,'full');
 if(mode==='full')return points;
 const anchors=mapViewPoints(evidence,'upload'),upload=evidenceTime(evidence.upload);
 // Local approach/departure context; retain every tied upload fix even if it conflicts.
 // The complete observations remain available in the timeline and Full day view.
 return points.filter(p=>anchors.includes(p)||(Math.abs(p.timeMs-upload)<=15*60000&&anchors.some(a=>metresBetween({lat:p.latitude,lng:p.longitude},{lat:a.latitude,lng:a.longitude})<=2000)));
}
export function uploadTimingText(evidence,reason=''){
 const upload=evidenceTime(evidence.upload),start=evidenceTime(evidence.windowStart),end=evidenceTime(evidence.deadline);
 const early=/early upload/i.test(reason),late=/late upload/i.test(reason),delta=early?start-upload:late?upload-end:NaN;
 if(!Number.isFinite(delta)||delta<=0)return '';
 const mins=Math.floor(delta/60000),hours=Math.floor(mins/60),duration=hours?hours+'h '+mins%60+'m':mins?mins+' min':Math.round(delta/1000)+' sec';
 return 'Photo uploaded '+duration+(early?' before the window':' after the deadline');
}

export function roadDisplayMessage(roads){
 if(!roads||roads.status==='ready')return '';
 if(roads.reason==='provider_daily_limit')return 'Google road overlay: daily limit reached';
 if(roads.status==='quota'||roads.reason==='provider_limit'||roads.reason==='monthly_limit')return 'Road overlay limit reached';
 if(roads.paths?.length)return 'Road drawing is partial; GPS observations are unchanged.';
 if(roads.status==='sparse')return 'Too few GPS points to draw roads';
 return 'Road overlay unavailable';
}

// Display dates use the evidence clock, not the selected date-range filter.
export function dubaiDate(value){
 const t=evidenceTime(value);if(!Number.isFinite(t))return 'Date unavailable';
 return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',day:'numeric',month:'short'}).format(new Date(t));
}
export function dubaiDateTime(value,seconds=true){
 const t=evidenceTime(value);if(!Number.isFinite(t))return 'Time unavailable';
 return dubaiDate(value)+' · '+dubaiClock(value).slice(0,seconds?8:5);
}
export function datedWindow(start,end){
 const a=dubaiClock(start).slice(0,5),b=dubaiClock(end).slice(0,5);
 return dubaiDate(start)===dubaiDate(end)?a+'–'+b:dubaiDate(start)+' '+a+'–'+dubaiDate(end)+' '+b;
}
