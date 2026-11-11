// Historical route findings are additive evidence, never replacements for grades.
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const text=(x,max=20000)=>typeof x==='string'&&x.length<=max;
const day=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\d$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
const clock=x=>typeof x==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x));
const strings=x=>Array.isArray(x)&&x.length<=100&&x.every(v=>text(v));
const numberOrNull=x=>x===null||typeof x==='number'&&Number.isFinite(x)&&x>=0;
function assert(ok){if(!ok)throw Error('Invalid historical route evidence');}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const nullableClock=x=>x===null||clock(x);
const ordered=(start,end)=>!start||!end||Date.parse(start)<=Date.parse(end);
function validateContext(c){
 for(const k of ['windowOpens','windowCloses'])if(c[k]!==undefined)assert(nullableClock(c[k]));
 assert(ordered(c.windowOpens,c.windowCloses));
 for(const k of ['gpsDescription','sourceAddressAssessment','destinationAssessment','coordinateProvenance'])if(c[k]!==undefined)assert(c[k]===null||text(c[k]));
 if(c.sourceCategory!==undefined)assert(text(c.sourceCategory)||object(c.sourceCategory)&&Object.keys(c.sourceCategory).length<=100&&Object.entries(c.sourceCategory).every(([k,v])=>text(k,200)&&text(v)));
 if(c.contextualIntervals!==undefined){assert(Array.isArray(c.contextualIntervals)&&c.contextualIntervals.length<=10000);for(const interval of c.contextualIntervals)assert(object(interval)&&nullableClock(interval.start)&&nullableClock(interval.end)&&ordered(interval.start,interval.end)&&['sourceStart','sourceEnd','type','note'].every(k=>text(interval[k]))&&numberOrNull(interval.minimumDistanceMetres)&&(interval.returnStatus===null||text(interval.returnStatus)));}
 if(c.gpsWindowGaps!==undefined){assert(Array.isArray(c.gpsWindowGaps)&&c.gpsWindowGaps.length<=10000);for(const gap of c.gpsWindowGaps)assert(object(gap)&&clock(gap.start)&&clock(gap.end)&&ordered(gap.start,gap.end)&&typeof gap.seconds==='number'&&numberOrNull(gap.seconds));}
}
function sourceUrl(s){try{const u=new URL(s.url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['drive.google.com','docs.google.com'].includes(u.hostname)&&u.pathname.split('/').includes(s.id)&&u.href===s.url&&!/[?#]/.test(s.url);}catch{return false;}}
export function validateRouteEvidence(a){
 assert(a?.version==='matter-route-evidence-v1'&&clock(a.generatedAt)&&day(a.range?.from)&&day(a.range?.to)&&a.range.from<=a.range.to);
 assert(['sources','days','cases','stops'].every(k=>Array.isArray(a[k]))&&a.sources.length<=10000&&a.cases.length<=100000&&a.stops.length<=100000);
 const expected=[];for(let t=Date.parse(a.range.from);t<=Date.parse(a.range.to);t+=86400000){assert(expected.length<370);expected.push(new Date(t).toISOString().slice(0,10));}
 const sourceIds=new Set();for(const s of a.sources){assert(text(s.id,200)&&s.id&&!sourceIds.has(s.id)&&text(s.title,1000)&&hex(s.sha256)&&['connector_text','original_file'].includes(s.representation)&&sourceUrl(s));sourceIds.add(s.id);}
 const refs=x=>strings(x)&&x.every(id=>sourceIds.has(id));
 const dates=new Set();for(const d of a.days){assert(day(d.date)&&expected.includes(d.date)&&!dates.has(d.date)&&['reviewed','partial','not_found'].includes(d.status)&&text(d.note)&&refs(d.sourceIds));dates.add(d.date);}assert(dates.size===expected.length);
 const ids=new Set();for(const c of a.cases){assert(text(c.id,300)&&c.id&&!ids.has(c.id)&&dates.has(c.date)&&text(c.recordKey,300)&&c.recordKey.startsWith(c.date+'/')&&c.recordKey.length>11&&['customer','driver','vehicle','summary','sourceRow'].every(k=>text(c[k]))&&['timing_discrepancy','presence_alignment','location_conflict','unknown'].includes(c.category)&&['source_reported','corroborated','suspected','unknown'].includes(c.confidence)&&refs(c.sourceIds)&&c.sourceIds.length>0&&strings(c.limitations));ids.add(c.id);for(const k of ['observedStart','observedEnd','uploadAt'])assert(c[k]===null||clock(c[k]));if(c.observedStart&&c.observedEnd)assert(Date.parse(c.observedStart)<=Date.parse(c.observedEnd));if(c.binding)assert(hex(c.binding.assessmentHash)&&hex(c.binding.deliverySourceSha256));assert(c.handoverConfirmed!==true&&c.personalBreakConfirmed!==true);validateContext(c);}
 for(const s of a.stops){assert(text(s.id,300)&&s.id&&!ids.has(s.id)&&dates.has(s.date)&&['reported_stop','telemetry_gap'].includes(s.kind)&&['driver','vehicle','summary','sourceRow'].every(k=>text(s[k]))&&clock(s.start)&&clock(s.end)&&Date.parse(s.start)<=Date.parse(s.end)&&['reportedMinutes','rawPoints','largestGapSeconds'].every(k=>numberOrNull(s[k]))&&['unknown','source_reported_kitchen'].includes(s.purpose)&&refs(s.sourceIds)&&s.sourceIds.length>0&&strings(s.limitations));ids.add(s.id);assert(s.personalBreakConfirmed!==true);}
 if(a.unmatchedIntervals!==undefined){assert(Array.isArray(a.unmatchedIntervals)&&a.unmatchedIntervals.length<=100000);for(const interval of a.unmatchedIntervals)assert(object(interval)&&dates.has(interval.date)&&sourceIds.has(interval.sourceId)&&['sourceRow','originalStart','originalEnd','driver','vehicle','reason','sourceEventType'].every(k=>text(interval[k])));}
 if(a.unmatched!==undefined)assert(Array.isArray(a.unmatched)&&a.unmatched.length<=100000);
 return a;
}
export async function loadRouteEvidence(repository){
 const p=repository?.publication?.routeEvidence;if(!p)return null;
 assert(p.version===1&&hex(p.sha256)&&p.path==='route-evidence/'+p.sha256+'.json'&&typeof repository.readFile==='function');
 const bytes=await repository.readFile('state',p.path,{maxBytes:24*1024*1024});
 if(!Buffer.isBuffer(bytes)||sha(bytes)!==p.sha256)throw Error('Historical route evidence integrity failure');
 return {artifact:validateRouteEvidence(JSON.parse(bytes)),artifactSha256:p.sha256};
}
export function bindRouteEvidence(artifact,rows,artifactSha256){
 validateRouteEvidence(artifact);assert(Array.isArray(rows)&&hex(artifactSha256));
 const byKey=new Map();for(const row of rows){assert(typeof row?.key==='string'&&!byKey.has(row.key));byKey.set(row.key,row);}
 const cases=artifact.cases.map(c=>{const row=byKey.get(c.recordKey),present=row&&row.date===c.date,current=present&&c.binding&&c.binding.assessmentHash===row.assessmentHash&&c.binding.deliverySourceSha256===row.delivery?.source_sha256;return {...c,association:current?'current':present?'historical_context_changed':'record_not_in_report',...(current?{boundAssessmentHash:row.assessmentHash}:{}),handoverConfirmed:false};});
 return {...artifact,status:'ready',artifactSha256,cases};
}
