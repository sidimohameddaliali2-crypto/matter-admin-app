// Explicit reads of the documented partner APIs. Never uses staff credentials or database access.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {atomicJson} from './reporting-local-store.mjs';
import {isDay,dubaiTimestampDay} from './app/src/content/dashboard/operations-model.mjs';

export const apiHash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pick=(value,keys)=>value&&typeof value==='object'?Object.fromEntries(keys.map(k=>[k,value[k]??null])):null;
export function projectDelivery(r,day){
 if(typeof r.id!=='string'||!r.id||dubaiTimestampDay(r.scheduledTime)!==day)throw Error('delivery_identity_or_date');
 return {...pick(r,['id','customerId','customerName','company','type','address','locationType','zone','addressId','matterSubscriptionId','scheduledTime','status','deliveredTime','createdAt','updatedAt']),
  date:day,driverName:r.driver?.name??null,timingStatus:r.timing?.status??null,lateMinutes:r.timing?.lateMinutes??null,earlyMinutes:r.timing?.earlyMinutes??null,
  driver:pick(r.driver,['id','name','phone','email','vehicleType']),proof:pick(r.proof,['photoUrl','timestamp','notes','photoCapturedAt','receivedAt','photoSource','location']),trackerVisit:r.trackerVisit?structuredClone(r.trackerVisit):null,gpsLocation:pick(r.gpsLocation,['lat','lng','link']),
  customer:pick(r.customer,['customerId','name','timing','zone','address','locationType','mealPerDay','mealPlan']),
  addressDetails:pick(r.addressDetails,['label','city','area','street','additionalDetails','sourceCategory','building','floor','apartment','addressStatus','locationType']),
  sources:{delivery:pick(r.sources?.delivery,['type','fetchedAt','upstreamUpdatedAt','effectiveState','pinSource']),meals:pick(r.sources?.meals,['type','verifiedAgainstMatter','effectiveDate'])}};
}
export const apiPhotoRow=r=>({key:'api:'+r.id,photo_url:r.proof?.photoUrl??null,raw_upload:r.proof?.timestamp??null});
export function validateLocations(body){
 if(body?.success!==true||!Array.isArray(body.data)||body.data.length>500||!Number.isFinite(Date.parse(body.fetchedAt)))throw Error('location_response_invalid');
 const rows=body.data.map(r=>{
  if(typeof r.vehicleNo!=='string'||!r.vehicleNo||r.location!=null&&(!Number.isFinite(r.location.lat)||Math.abs(r.location.lat)>90||!Number.isFinite(r.location.lng)||Math.abs(r.location.lng)>180))throw Error('location_response_invalid');
  return {vehicleNo:r.vehicleNo,vehicleType:r.vehicleType??null,location:pick(r.location,['lat','lng']),driver:pick(r.driver,['id','name','phone','email'])};
 }).sort((a,b)=>a.vehicleNo.localeCompare(b.vehicleNo));
 if(new Set(rows.map(r=>r.vehicleNo)).size!==rows.length)throw Error('duplicate_vehicle');
 return {rows,fetchedAt:body.fetchedAt,observedAt:new Date().toISOString()};
}
export async function readLocations(values,{fetchImpl=fetch}={}){
 if(values.DELIVERY_API_READ_ENABLED!=='true'||!values.DELIVERY_API_KEY)throw Error('delivery_connection_unavailable');
 if(values.DELIVERY_API_BASE_URL.replace(/\/$/,'')!=='https://matterapp.online/api/external')throw Error('delivery_origin_not_reviewed');
 const response=await fetchImpl('https://matterapp.online/api/external/drivers/locations',{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Accept:'application/json','x-api-key':values.DELIVERY_API_KEY}});
 if(!response.ok||response.redirected){await response.body?.cancel();throw Error(response.status===401||response.status===403?'location_authentication':'location_unavailable');}
 if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))throw Error('location_response_invalid');
 const chunks=[];let count=0;
 for await(const chunk of response.body){count+=chunk.length;if(count>1024*1024)throw Error('location_response_too_large');chunks.push(chunk);}
 return validateLocations(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export function sourceCoverage(rows,locations,website){
 const count=fn=>rows.filter(fn).length;
 return {records:rows.length,photoLinks:count(r=>!!r.proof?.photoUrl),uploadTimes:count(r=>!!r.proof?.timestamp),assignedDrivers:count(r=>!!r.driver?.id),addresses:count(r=>!!r.address),destinationPins:count(r=>Number.isFinite(r.gpsLocation?.lat)&&Number.isFinite(r.gpsLocation?.lng)),subscriptionIds:count(r=>!!r.matterSubscriptionId),mealProfiles:count(r=>r.customer?.mealPerDay!=null),
  independentPhotoCaptureTimes:0,independentReceiptTimes:0,reportedPhotoCaptureTimes:count(r=>!!r.proof?.photoCapturedAt),reportedReceiptTimes:count(r=>!!r.proof?.receivedAt),verifiedMealEntitlements:0,
  vehicles:locations?.rows.length??null,vehiclePins:locations?locations.rows.filter(r=>r.location).length:null,vehicleDriverMappings:locations?locations.rows.filter(r=>r.driver?.id).length:null,
  website:website?.configured&&website.readEnabled?'Configured; subscription refresh not run':'Website API token missing or reads disabled',
  limits:['Optional capture/receipt clocks are retained when supplied; capture clocks are device-reported and receipt fields alone do not establish independent attestation.','Customer meal count and plan are current delivery-app profiles, unverified against Matter Nutrition; they are not historical kitchen entitlements.','Destination pins are saved job values, not a verified entrance or historical address change log.','Vehicle locations are current observations; GPS fix time, routes and dated assignments are not supplied.','Bags, complaints, events, sales, menus and full customer/driver directories remain their saved captures. The partner API does not expose those collections.']};
}
export function buildApiSnapshot({day,rawRows,receipt,locations,locationError,website}){
 if(!isDay(day)||receipt.snapshotComplete!==true||receipt.rowCount!==rawRows.length||receipt.uniqueCount!==rawRows.length)throw Error('delivery_capture_incomplete');
 const rows=rawRows.map(r=>projectDelivery(r,day)).sort((a,b)=>a.id.localeCompare(b.id));
 if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('duplicate_delivery');
 const content={day,rows,locations:locations?.rows??[]};
 return {kind:'matter-api-mirror-v1',day,snapshotHash:apiHash(content),rows,locations:locations?.rows??[],locationError:locationError??null,deliveryObservedAt:receipt.sourceObservedAt?.to??receipt.updatedAt,locationObservedAt:locations?.observedAt??null,locationFetchedAt:locations?.fetchedAt??null,receipt,coverage:sourceCoverage(rows,locations,website)};
}
export function installApiSnapshot(app,snapshot){
 if(snapshot.kind!=='matter-api-mirror-v1'||snapshot.snapshotHash!==apiHash({day:snapshot.day,rows:snapshot.rows,locations:snapshot.locations}))throw Error('snapshot_integrity');
 const source={type:'api',system:'Matter delivery partner API',capturedAt:snapshot.deliveryObservedAt,executedAt:snapshot.deliveryObservedAt,readOnly:true,snapshotComplete:true,snapshotAtomic:false,snapshotHash:snapshot.snapshotHash,coverage:{dateMin:snapshot.day,dateMax:snapshot.day},filters:[`Scheduled Dubai day ${snapshot.day}`],limitations:snapshot.coverage.limits};
 const queries={...app.queries,api_delivery_current:{rows:snapshot.rows,source:{...source,endpoint:'https://matterapp.online/api/external/deliveries'}},api_vehicle_current:{rows:snapshot.locations,source:{...source,endpoint:'https://matterapp.online/api/external/drivers/locations',capturedAt:snapshot.locationObservedAt,executedAt:snapshot.locationObservedAt,snapshotComplete:!snapshot.locationError,providerFetchedAt:snapshot.locationFetchedAt}}};
 const meta={...snapshot};delete meta.rows;delete meta.locations;
 return {...app,buildStatus:'complete',queries,matter:{...app.matter,apiMirror:meta}};
}
export async function publishApiSnapshot({appFile,dist,dir,snapshot,build}){
 const before=await fs.readFile(appFile),app=JSON.parse(before),next=installApiSnapshot(app,snapshot);
 await fs.writeFile(path.join(dir,'before-data.private.json'),before,{mode:0o600});
 await fs.cp(dist,path.join(dir,'before-dist'),{recursive:true});
 if(!(await fs.readFile(appFile)).equals(before))throw Error('app_changed_during_refresh');
 await atomicJson(appFile,next);
 try{await build();}catch(error){await fs.writeFile(appFile,before,{mode:0o600});await fs.rm(dist,{recursive:true,force:true});await fs.cp(path.join(dir,'before-dist'),dist,{recursive:true});throw error;}
 return next;
}
export async function captureApiSnapshot({config,dir,day,runId}){
 if(!isDay(day))throw Error('invalid_day');
 const {loadMatterApiSource}=await import(pathToFileURL(path.join(config.fleetRoot,'operations/matter-api-config.mjs')));
 const {readMatterEnvironment}=await import(pathToFileURL(path.join(config.fleetRoot,'operations/matter-env.mjs')));
 const {createMatterHistoryArchive}=await import(pathToFileURL(path.join(config.fleetRoot,'operations/matter-history-archive.mjs')));
 const api=await loadMatterApiSource({file:config.envFile,environment:{}}),sources=api.status().sources;
 if(!sources.delivery.configured||!sources.delivery.readEnabled)throw Error('delivery_connection_unavailable');
 const archive=createMatterHistoryArchive({root:path.join(dir,'delivery'),api,apiOrigin:sources.delivery.baseOrigin,maxPagesPerRun:20,maxDurationMs:120000});
 const receipt=await archive.run({source:'delivery',query:{date:day},eventId:runId});await atomicJson(path.join(dir,'receipt.private.json'),receipt);
 if(!receipt.snapshotComplete)throw Error('delivery_capture_incomplete');
 const rawRows=[];const observations=[];for(let page=1;page<=receipt.pageCount;page++){const data=await archive.readPage({archiveId:receipt.archiveId,page});if(data.status!=='archived-page')throw Error('delivery_archive_integrity');rawRows.push(...data.rows);observations.push(data.observedAt);}
 receipt.sourceObservedAt={from:observations[0]??receipt.updatedAt,to:observations.at(-1)??receipt.updatedAt};await atomicJson(path.join(dir,'receipt.private.json'),receipt);
 let locations,locationError;
 if(config.captureVehicleLocations===false){locationError='GPS read omitted; use saved GPS feed.';}
 else{
  const locationFile=path.join(dir,'locations.private.json');
  try{try{locations=JSON.parse(await fs.readFile(locationFile,'utf8'));validateLocations({success:true,data:locations.rows,fetchedAt:locations.fetchedAt});}catch(e){if(e.code!=='ENOENT')throw e;locations=await readLocations(await readMatterEnvironment({file:config.envFile}));await atomicJson(locationFile,locations);}}
  catch{locationError='Vehicle-location read failed; no current vehicle locations are shown.';}
 }
 const snapshot=buildApiSnapshot({day,rawRows,receipt,locations,locationError,website:sources.admin});
 await atomicJson(path.join(dir,'snapshot.private.json'),snapshot);return snapshot;
}
