import {createHash,randomUUID} from 'node:crypto';
import {routeSegments,metresBetween,timelineRange} from '../../app/src/content/dashboard/review-map.mjs';
const location=p=>({lat:p.latitude,lng:p.longitude});
// Google recommends <=300 m between inputs. Split instead of inventing a road
// through a missing interval. These thresholds affect display, never grading.
export function roadChunks(points){
 const chunks=[];
 for(const segment of routeSegments(points,300)){
  let chunk=[];
  for(const p of segment){
   if(chunk.length&&metresBetween(location(chunk.at(-1)),location(p))>300){if(chunk.length>1)chunks.push(chunk);chunk=[];}
   chunk.push(p);
   if(chunk.length===100){chunks.push(chunk);chunk=[p];}
  }
  if(chunk.length>1)chunks.push(chunk);
 }
 return chunks;
}
export function validateRoadPath(value,input){
 if(value?.warningMessage||!Array.isArray(value?.snappedPoints)||value.snappedPoints.length>20000)return [];
 const paths=[];let anchor=null,between=[];
 for(const p of value.snappedPoints){
  const lat=p?.location?.latitude,lng=p?.location?.longitude;
  if(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lng)||Math.abs(lng)>180)return [];
  const coordinate={lat,lng};
  if(p.originalIndex===undefined){if(anchor)between.push(coordinate);continue;}
  const i=p.originalIndex;
  if(!Number.isInteger(i)||i<0||i>=input.length||anchor&&i<=anchor.i)return [];
  const valid=metresBetween(coordinate,location(input[i]))<=75;
  if(valid&&anchor?.valid&&i===anchor.i+1){
   const path=[anchor.coordinate,...between,coordinate];
   // Refuse a provider detour/jump outside the local observed corridor.
   if(path.every(x=>Math.min(metresBetween(x,anchor.coordinate),metresBetween(x,coordinate))<=500))paths.push({pointIds:[input[anchor.i].id,input[i].id],path});
  }
  anchor={i,coordinate,valid};between=[];
 }
 return paths;
}
export function createPreviewRoads({gps,state,config={},key,geometryCache,clock=Date.now,fetchImpl=fetch}){
 const cache=new Map();
 const enabled=()=>config.enabled===true&&!!key&&config.verifiedFreeMonth===new Date(clock()).toISOString().slice(0,7)&&Number.isSafeInteger(config.maxRequests)&&config.maxRequests>0&&config.maxRequests<=4000;
 async function admit(hash){
  const month=new Date(clock()).toISOString().slice(0,7),ledger='road-display-requests:'+month;
  for(let attempt=0;attempt<8;attempt++){
   const old=await state.read(ledger),body=old.body?JSON.parse(old.body):{count:0};
   if(!Number.isSafeInteger(body.count)||body.count<0)throw Error('Invalid Roads allowance');
   if(body.providerPauseUntil>clock())return {status:'quota',reason:body.providerPauseReason||'provider_limit',retryAfter:body.providerPauseUntil,paths:[]};
   if(body.count>=config.maxRequests)return {status:'quota',reason:'monthly_limit',paths:[]};
   try{await state.compareAndSwap({key:ledger,expectedRevision:old.revision,eventId:randomUUID(),body:JSON.stringify({...body,count:body.count+1}),event:JSON.stringify({kind:'road-display-request',month,geometryHash:hash}),request:JSON.stringify({month,count:body.count+1})});return null;}catch(e){if(e.status!==409||attempt===7)throw e;}
  }
 }
 async function pauseProvider(reason){
  const month=new Date(clock()).toISOString().slice(0,7),ledger='road-display-requests:'+month,until=clock()+3600000;
  for(let attempt=0;attempt<8;attempt++){
   const old=await state.read(ledger),body=JSON.parse(old.body);
   if(body.providerPauseUntil>=until)return body.providerPauseUntil;
   try{await state.compareAndSwap({key:ledger,expectedRevision:old.revision,eventId:randomUUID(),body:JSON.stringify({...body,providerPauseUntil:until,providerPauseReason:reason}),event:JSON.stringify({kind:'road-provider-pause',reason,until}),request:JSON.stringify({reason,until})});return until;}catch(e){if(e.status!==409||attempt===7)throw e;}
  }
 }
 async function match(chunk){
  // The geometry key excludes customer IDs and clocks. Returned links are rebound
  // to this authorized evidence's original IDs; cached geometry never grades it.
  const hash=createHash('sha256').update(JSON.stringify(['roads-display-v2',chunk.map(p=>[p.latitude,p.longitude])])).digest('hex'),now=clock();
  for(const [k,v] of cache)if(v.until<=now)cache.delete(k);
  const bind=value=>({...value,paths:(value.paths||[]).map(p=>({pointIds:p.indices.map(i=>chunk[i].id),path:p.path}))});
  if(cache.has(hash))return bind(await cache.get(hash).promise);
  const owner=randomUUID();let claimed=false;
  const promise=(async()=>{
   if(geometryCache){
    let entry=await geometryCache.claim(hash,owner);
    const deadline=Date.now()+12000;
    while(entry.state==='busy'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,250));entry=await geometryCache.claim(hash,owner);}
    if(entry.state==='hit')return entry.value;
    if(entry.state!=='claimed')return {status:'unavailable',paths:[]};
    claimed=true;
   }
   const blocked=await admit(hash);if(blocked)return blocked;
   const url=new URL('https://roads.googleapis.com/v1/snapToRoads');url.searchParams.set('path',chunk.map(p=>p.latitude+','+p.longitude).join('|'));url.searchParams.set('interpolate','true');
   const response=await fetchImpl(url,{headers:{'X-Goog-Api-Key':key},signal:AbortSignal.timeout(10000)});
   if(response.status===429){
    const error=await response.json().catch(()=>({})),reason=/Requests per day/i.test(error.error?.message||'')?'provider_daily_limit':'provider_limit';
    return {status:'quota',reason,retryAfter:await pauseProvider(reason),paths:[]};
   }
   if(!response.ok)throw Error('Road matching unavailable');
   const text=await response.text();if(text.length>4*1024*1024)throw Error('Road response exceeds limit');
   const indexed=chunk.map((p,i)=>({...p,id:i})),paths=validateRoadPath(JSON.parse(text),indexed).map(p=>({indices:p.pointIds,path:p.path}));
   const value={status:paths.length===chunk.length-1?'ready':'partial',paths};
   if(geometryCache)await geometryCache.save(hash,owner,value);
   return value;
  })().catch(()=>({status:'unavailable',paths:[]})).finally(async()=>{if(claimed)await geometryCache.release(hash,owner).catch(()=>{});});
  cache.set(hash,{until:now+3600000,promise});while(cache.size>128)cache.delete(cache.keys().next().value);
  const result=await promise;
  // Short-lived failures can recover without a page repeatedly calling Google.
  if(result.status==='unavailable')cache.set(hash,{until:now+60000,promise});
  return bind(result);
 }
 return {enabled,async read(params,actor){
  const copy=new URLSearchParams(params),mode=copy.get('mode')||'upload';
  if(copy.getAll('mode').length>1||!['upload','full'].includes(mode))throw Object.assign(Error('Invalid road view'),{status:400});copy.delete('mode');
  const evidence=await gps.read(copy,actor),base={recordKey:evidence.recordKey,snapshotHash:evidence.snapshotHash,assessmentHash:evidence.assessmentHash,vehicle:evidence.vehicle,mode,paths:[],basis:'estimated-road-display',expiresAt:new Date(clock()+3600000).toISOString()};
  if(!enabled())return {...base,status:'disabled'};
  if(evidence.status!=='ready')return {...base,status:'unavailable'};
  const range=timelineRange(evidence,mode),points=evidence.points.filter(p=>p.timeMs>=range.start&&p.timeMs<=range.end),chunks=roadChunks(evidence.points).filter(c=>c.some(p=>p.timeMs>=range.start&&p.timeMs<=range.end)&&c.some(p=>metresBetween(location(c[0]),location(p))>=1));
  if(!chunks.length)return {...base,status:'sparse'};
  const anchor=Date.parse(evidence.upload),selected=[...chunks].sort((a,b)=>Math.min(...a.map(p=>Math.abs(p.timeMs-anchor)))-Math.min(...b.map(p=>Math.abs(p.timeMs-anchor)))).slice(0,mode==='upload'?2:8),results=[];
  for(let i=0;i<selected.length;i+=2){results.push(...await Promise.all(selected.slice(i,i+2).map(match)));if(results.some(r=>r.status==='quota'))break;}
  const paths=results.flatMap(r=>r.paths),complete=chunks.length===selected.length&&results.every(r=>r.status==='ready');
  const limited=results.find(r=>r.status==='quota');
  return {...base,status:paths.length?(complete?'ready':'partial'):results.find(r=>r.status!=='ready')?.status||'sparse',...(limited?{reason:limited.reason,retryAfter:limited.retryAfter}:{}),paths,matchedLinks:paths.length,sourcePoints:points.length};
 }};
}
