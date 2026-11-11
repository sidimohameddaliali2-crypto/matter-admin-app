// Source observations only. Google geometry and request status are not inputs.
const clock=value=>{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
 const day=Date.parse(value.slice(0,10)+'T00:00:00Z'),time=Date.parse(value);
 return Number.isFinite(day)&&Number.isFinite(time)&&new Date(day).toISOString().slice(0,10)===value.slice(0,10)&&+value.slice(11,13)<24&&+value.slice(14,16)<60&&+value.slice(17,19)<60?time:null;
};
export function straightLineMetres(a,b){
 if(!a||!b)return null;
 const rad=Math.PI/180,lat=(b.lat-a.lat)*rad,lng=(b.lng-a.lng)*rad;
 const v=Math.sin(lat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(lng/2)**2;
 return 6371000*2*Math.atan2(Math.sqrt(v),Math.sqrt(Math.max(0,1-v)));
}
const coordinate=p=>Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180;
export function compareUploadLocation({upload,points=[],destination,policy={}}){
 const time=clock(upload),limit=(policy.uploadMatchSeconds??120)*1000,near=policy.radiusMetres??200,away=policy.awayMetres??500;
 const base={version:1,upload,matchSeconds:limit/1000,before:[],after:[],nearest:[],excludedNearest:[],state:'missing_upload_clock',distanceBand:'unknown'};
 if(time===null)return base;
 const pin=destination&&Number.isFinite(destination.lat)&&Math.abs(destination.lat)<=90&&Number.isFinite(destination.lng)&&Math.abs(destination.lng)<=180?destination:null;
 const seen=new Set(),all=points.filter(p=>{const t=clock(p.time),key=[p.id,p.time,p.latitude,p.longitude].join('|');if(t===null||p.timeMs!==t||!coordinate(p)||seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>a.timeMs-b.timeMs||a.id.localeCompare(b.id));
 const valid=all.filter(p=>p.usable===true),beforeTime=valid.filter(p=>p.timeMs<=time).at(-1)?.timeMs,afterTime=valid.find(p=>p.timeMs>=time)?.timeMs;
 const nearestDelta=all.length?Math.min(...all.map(p=>Math.abs(p.timeMs-time))):Infinity;
 const entry=p=>{const distanceMetres=straightLineMetres({lat:p.latitude,lng:p.longitude},pin);return {pointId:p.id,time:p.time,latitude:p.latitude,longitude:p.longitude,vehicle:p.vehicle,offsetSeconds:(p.timeMs-time)/1000,distanceMetres,distanceBand:distanceMetres===null?'unknown':distanceMetres<=near?'near':distanceMetres>away?'away':'intermediate',withinMatch:Math.abs(p.timeMs-time)<=limit,usable:p.usable===true,qualityReasons:p.qualityReasons||[],references:p.references||[]};};
 const before=valid.filter(p=>p.timeMs===beforeTime).map(entry),after=valid.filter(p=>p.timeMs===afterTime).map(entry),closest=all.filter(p=>Math.abs(p.timeMs-time)===nearestDelta),nearest=closest.map(entry),excludedNearest=closest.filter(p=>p.usable!==true).map(entry);
 const brackets=[...before,...after],timely=brackets.filter(p=>p.withinMatch),bands=new Set(timely.map(p=>p.distanceBand)),conflictingClock=[before,after].some(side=>new Set(side.map(p=>[p.latitude,p.longitude].join(','))).size>1);
 const qualityConflict=excludedNearest.some(p=>p.withinMatch),conflict=conflictingClock||(bands.has('near')&&bands.has('away'));
 const state=qualityConflict?'quality_conflict':conflict?'conflicting_positions':!valid.length?'no_usable_gps':!timely.length?'outside_time_match':before.length&&after.length?'bracketed':'one_sided';
 return {...base,state,before,after,nearest,excludedNearest,distanceBand:qualityConflict||conflict?'unknown':bands.size===1?[...bands][0]:bands.size>1?'mixed':'unknown'};
}

// Location corroboration is separate from own-slot compliance. These observations
// never clear an existing timing flag or establish a handover.
export function assessLocationTiming(evidence){
 const {uploadLocation:c,points=[],stops=[],policy={}}=evidence,upload=clock(evidence.upload),start=clock(evidence.windowStart),end=clock(evidence.deadline),byId=new Map(points.map(p=>[p.id,p]));
 const base={version:1,locationDiscrepancy:false,deliveryTimingConfirmed:false,needsTimingReview:false,earlierStops:[]};
 const finish=(state,summary,extra={})=>({...base,state,summary,...extra});
 if(/conflict|alternative/i.test(evidence.assignment?.state||'')||evidence.observation==='alternative_vehicle_context')return finish('source_conflict','Vehicle assignment needs checking');
 if(!c||['quality_conflict','conflicting_positions'].includes(c.state))return finish('not_comparable','GPS needs checking');
 const timely=[...(c.before||[]),...(c.after||[])].filter(p=>p.withinMatch&&p.usable&&Number.isFinite(p.distanceMetres));
 if(!timely.length)return finish('not_comparable','No close-time GPS comparison');
 if(timely.every(p=>p.distanceMetres<=(policy.awayMetres??500)))return finish('near_upload','Vehicle nearby');
 if(!timely.every(p=>p.distanceMetres>(policy.awayMetres??500)))return finish('not_comparable','GPS positions differ');
 const stopped=p=>p?.usable===true&&p.references?.length&&(p.speeds?.length?p.speeds.every(s=>s===0):p.states?.length&&p.states.every(s=>/^(stopped|stop|idle|stationary|parked)$/i.test(s)));
 const validStops=stops.filter(s=>{
  const ps=(s.pointIds||[]).map(id=>byId.get(id));if(ps.length<2||!ps.every(p=>stopped(p)&&coordinate(p)&&p.timeMs===clock(p.time)))return false;
  if(ps.some(p=>straightLineMetres({lat:p.latitude,lng:p.longitude},evidence.destination)===null||straightLineMetres({lat:p.latitude,lng:p.longitude},evidence.destination)>(policy.radiusMetres??200)))return false;
  return clock(s.start)===ps[0].timeMs&&clock(s.end)===ps.at(-1).timeMs&&ps.at(-1).timeMs-ps[0].timeMs>=(policy.minStopSpanSeconds??60)*1000&&ps.every((p,i)=>!i||(p.timeMs>ps[i-1].timeMs&&p.timeMs-ps[i-1].timeMs<=(policy.maxSampleGapSeconds??300)*1000));
 });
 const earlierStops=validStops.filter(s=>clock(s.end)<upload-(policy.uploadMatchSeconds??120)*1000).map(s=>({...s,windowComparison:start===null||end===null||start>end?'unknown':clock(s.end)<start?'before':clock(s.start)>end?'after':clock(s.start)>=start&&clock(s.end)<=end?'within':'boundary_overlap'}));
 if(!earlierStops.length)return finish('away_at_upload','Vehicle elsewhere at upload');
 const hasInWindow=earlierStops.some(s=>['within','boundary_overlap'].includes(s.windowComparison));
 const otherOption=validStops.some(s=>clock(s.end)>=upload-(policy.uploadMatchSeconds??120)*1000)|| (evidence.laterWindowSamples||[]).some(id=>{const p=byId.get(id);return stopped(p)&&p.timeMs>=start&&p.timeMs<=end&&p.timeMs>upload;});
 if(otherOption)return finish('multiple_visit_options','More than one nearby visit',{earlierStops});
 if(hasInWindow)return finish('earlier_stop_in_window','Nearby before upload',{earlierStops});
 if(earlierStops.every(s=>s.windowComparison==='before'))return finish('earlier_stop_before_window','Early stop; later upload',{earlierStops,needsTimingReview:true});
 return finish('earlier_stop_other','Nearby before upload',{earlierStops});
}
