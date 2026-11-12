import {encodeBrowserReport} from './browser-projection.mjs';
import {completedPhotoDay} from '../hosted/photo-completion.mjs';
import {createHash} from 'node:crypto';
import {gunzipSync,createGunzip} from 'node:zlib';
import {Readable} from 'node:stream';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {pinPhotoRows} from '../hosted/generation-photos.mjs';
import {createPhotoProposalService} from '../hosted/photo-proposals.mjs';
import {combinedPhotoProgress} from '../hosted/automatic-publication.mjs';
import {completedReport} from '../hosted/completed-report.mjs';
import {bindReportManifest} from '../hosted/report-projection.mjs';
import {readWeekendIdentityCheckpoint,weekendIdentityView} from './weekend-identities.mjs';
import {photoCaseReviewed} from './photo-review-guard.mjs';
import {currentPhotoProgress,chooseLegacyProposal} from './photo-progress.mjs';
import {overlayForRow} from './evidence-overlay.mjs';
import {loadRecoveredPhotoBindings,applyRecoveredPhotoBindings} from './recovered-photo-bindings.mjs';
import {applyPhotoBindingRepair,loadPhotoBindingRepair} from './photo-binding-repair.mjs';
import {loadDirectVisualReviews,directVisualReviewForRow} from './direct-visual-review.mjs';
import {loadRouteEvidence,bindRouteEvidence} from './route-evidence.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),hash=x=>sha(Buffer.from(JSON.stringify(x))),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),fail=status=>Object.assign(Error('Report unavailable'),{status});
const route=/^report-data\/(detail|history|query|archive|snapshot)-([a-f0-9]{64})\.json$/;
const generationCache=new Map();
const photoProgressCache=new Map();
const photoProgressRetryMs=30_000;
let photoProgressFlight=false;
function rememberPhotoProgress(key,value){
 photoProgressCache.set(key,value);
 while(photoProgressCache.size>2)photoProgressCache.delete(photoProgressCache.keys().next().value);
}
function readDeferredPhotoProgress(key,load){
 if(!key)return {progress:null,progressStatus:'unavailable'};
 const cached=photoProgressCache.get(key);
 if(cached?.status==='ready')return {progress:cached.progress,progressStatus:'ready'};
 if(cached?.retryAfter>Date.now())return {progress:null,progressStatus:'unavailable'};
 if(!photoProgressFlight){
  const entry={status:'pending'};
  rememberPhotoProgress(key,entry);
  photoProgressFlight=true;
  // One serial scan for the process. Requests never queue another generation.
  void nextTurn().then(load).then(({progress})=>{
   if(photoProgressCache.get(key)===entry)Object.assign(entry,{status:'ready',progress});
   photoProgressFlight=false;
  },()=>{
   if(photoProgressCache.get(key)===entry)Object.assign(entry,{status:'unavailable',retryAfter:Date.now()+photoProgressRetryMs});
   photoProgressFlight=false;
  });
 }
 return {progress:null,progressStatus:'pending'};
}
const evidenceRevision=p=>hash([p?.evidenceOverlay??null,p?.directVisualReviews??null,p?.recoveredPhotoBindings??null,p?.photoBindingRepair??null,p?.routeEvidence??null]);
const scheduledTasks=new Set(['delivery','delivery-history','gps','gps-publish','photo-grade']);
function verifiedScheduleTimestamp(value,deploymentId){
 const keys=(v,allowed)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===allowed.length&&Object.keys(v).every(k=>allowed.includes(k));
 const time=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
 if(!/^dpl_[A-Za-z0-9]+$/.test(deploymentId||'')||!keys(value,['version','source','deploymentId','checkedAt','invocations'])||value.version!==1||value.source!=='vercel-cron'||value.deploymentId!==deploymentId||!time(value.checkedAt)||Date.parse(value.checkedAt)>Date.now()+60000||!Array.isArray(value.invocations)||value.invocations.length<2||value.invocations.length>32)return null;
 const ids=new Set(),tasks=new Set();for(const r of value.invocations){if(!keys(r,['id','task','observedAt','accepted','scheduled'])||typeof r.id!=='string'||!/^[A-Za-z0-9._:-]{8,160}$/.test(r.id)||ids.has(r.id)||!scheduledTasks.has(r.task)||!time(r.observedAt)||Date.parse(r.observedAt)>Date.parse(value.checkedAt)||r.accepted!==true||r.scheduled!==true)return null;ids.add(r.id);tasks.add(r.task);}return tasks.size>=2?value.checkedAt:null;
}
const todayDubai=()=>new Date(Date.now()+4*3600e3).toISOString().slice(0,10);
function installPublicReportDataPath(prefix){
 window.__matterReportDataPath=pathname=>pathname.startsWith(prefix+'/report-data/')?pathname.slice(prefix.length):pathname;
}
function hostedSessionBridge(){
 const original=window.fetch.bind(window);let refreshing=null,failedAt=0;window.addEventListener?.('focus',()=>{failedAt=0;});
 function notify(){window.dispatchEvent?.(new Event('matter-session-expired'));if(document.getElementById('hosted-session-expired'))return;const box=document.createElement('aside'),link=document.createElement('a');box.id='hosted-session-expired';box.setAttribute('role','status');box.style.cssText='padding:12px;background:#f0ede5;color:#17213a;font:14px system-ui';box.append('Your reporting session expired. Sign in again, then retry; this page keeps your draft. ');link.href='/login';link.target='_blank';link.rel='noopener noreferrer';link.textContent='Sign in';box.append(link);document.body.prepend(box);}
 function refresh(){if(failedAt&&Date.now()-failedAt<10000)return Promise.resolve(false);if(!refreshing)refreshing=original('/api/session/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',credentials:'same-origin',cache:'no-store'}).then(r=>r.ok).catch(()=>false).then(ok=>{failedAt=ok?0:Date.now();return ok;}).finally(()=>{refreshing=null;});return refreshing;}
 window.fetch=async(input,init)=>{let request=new Request(input,init);const url=new URL(request.url,location.href);if(url.origin!==location.origin||url.pathname.startsWith('/api/session'))return original(request);const dataPath=window.__matterReportDataPath?.(url.pathname)??url.pathname;if(/^\/report-data\/(?:detail|history|query|archive|snapshot)-[a-f0-9]{64}\.json$/.test(dataPath)&&!url.search){url.searchParams.set('generation',window.__matterReportingGeneration);request=new Request(url.href,request);}const retry=request.clone(),response=await original(request);if(response.status!==401)return response;if(!await refresh()){notify();return response;}if(retry.headers.has('x-reporting-token')){const status=await original('/api/reporting/status',{cache:'no-store',credentials:'same-origin'});if(!status.ok){notify();return response;}const data=await status.json();if(typeof data.token!=='string'){notify();return response;}retry.headers.set('x-reporting-token',data.token);}return original(retry);};
}
export function cloudHtml({html,priorManifest,head,generation=head?.manifest?.sha256,publicPathPrefix=''}){
 if(typeof html!=='string'||!hex(head?.manifest?.sha256)||html.split('</head>').length!==2)throw Error('Renderer unavailable');
 if(publicPathPrefix!==''&&publicPathPrefix!=='/api/reporting')throw Error('Invalid reporting route prefix');
 const routing=publicPathPrefix?'('+installPublicReportDataPath.toString()+')('+JSON.stringify(publicPathPrefix)+');':'';
 return bindReportManifest(html,priorManifest,head.manifest).replace('</head>','<script>window.__matterReportingGeneration='+JSON.stringify(generation)+';'+routing+'('+hostedSessionBridge.toString()+')();</script></head>');
}
export function createCloudReportService({repository,reviewStore,identityStore,now=todayDubai,maxPlainBytes=512*1024*1024,deploymentId,evidenceCache,photoBindingRegistry=null,deferredPhotoProgress=false}){
 if(!Number.isSafeInteger(maxPlainBytes)||maxPlainBytes<1||maxPlainBytes>512*1024*1024)throw Error('Invalid report size limit');
 if(typeof deferredPhotoProgress!=='boolean')throw Error('Invalid photo progress mode');
 if(!repository||typeof repository.getHead!=='function'||typeof repository.readFile!=='function'||!reviewStore||!identityStore)throw Error('Cloud report dependencies required');
 async function routeEvidenceFor(rows){try{const loaded=await loadRouteEvidence(repository);if(!loaded)return {status:'unavailable'};const currentRows=typeof rows==='function'?await rows():rows;return bindRouteEvidence(loaded.artifact,currentRows,loaded.artifactSha256);}catch{return {status:'unavailable'};}}
 async function read(domain,file,maxBytes){const bytes=await repository.readFile(domain,file,{maxBytes});if(!Buffer.isBuffer(bytes)||bytes.length>maxBytes)throw Error('Invalid retained object');return bytes;}
 async function retained(file,maxBytes){try{return await read('state',file,maxBytes);}catch(e){if(e.code!=='ENOENT')throw e;return read('archive',file,maxBytes);}}
 // The runtime owns this cache; every request still uses its freshly pinned publication.
 if(evidenceCache!==undefined&&typeof evidenceCache?.getOrLoad!=='function')throw Error('Invalid immutable evidence cache');
 function immutableEvidence(kind,id,limit,load){const catalog=repository.publication?.catalog?.sha256;if(!evidenceCache||!hex(catalog))return Promise.resolve().then(load).then(result=>result.value);return evidenceCache.getOrLoad(JSON.stringify(['report-evidence-v1',catalog,kind,id,limit,maxPlainBytes]),load);}
 async function resourceBytes(name,{includePlain=false}={}){if(includePlain)return loadResourceBytes(name,{includePlain});const value=await immutableEvidence('resource-gzip',name,128*1024*1024,async()=>{const value=await loadResourceBytes(name);return {value,bytes:value.body.length};});return {...value,body:Buffer.from(value.body)};}
 async function loadResourceBytes(name,{includePlain=false}={}){const match=route.exec(name);if(!match)throw fail(404);const packed=await retained('assets/'+name.slice('report-data/'.length)+'.gz',128*1024*1024),decoder=createGunzip(),source=Readable.from([packed]),digest=createHash('sha256'),chunks=[];let size=0;source.pipe(decoder);try{for await(const chunk of decoder){size+=chunk.length;if(size>maxPlainBytes)throw Error('Report resource exceeds size limit');digest.update(chunk);if(includePlain)chunks.push(chunk);}}finally{source.destroy();decoder.destroy();}if(digest.digest('hex')!==match[2])throw Error('Report resource integrity failure');return {body:packed,gzip:true,decodedBytes:size,...(includePlain?{plain:Buffer.concat(chunks,size)}:{})};}
 let cached=null;
 async function current(){const head=await repository.getHead();if(!head||!hex(head.manifest?.sha256)||head.manifest.url!=='report-data/snapshot-'+head.manifest.sha256+'.json'||!hex(head.reportHash))throw Error('Invalid report head');if(cached?.head.manifest.sha256===head.manifest.sha256&&cached.head.reportHash===head.reportHash)return {...cached,head};const catalog=repository.publication?.catalog?.sha256,key=hex(catalog)?catalog+':'+head.manifest.sha256+':'+head.reportHash+':'+maxPlainBytes:null;let pending=key&&generationCache.get(key);if(!pending){pending=(async()=>{const resource=await resourceBytes(head.manifest.url,{includePlain:true}),app=JSON.parse(resource.plain);if(app.matter?.validatedReporting?.snapshotHash!==head.reportHash)throw Error('Report head mismatch');return {app,allowed:allowedResources(app,head)};})();if(key){generationCache.set(key,pending);while(generationCache.size>2)generationCache.delete(generationCache.keys().next().value);}}try{const value=await pending;cached={head,...value};return cached;}catch(e){if(key&&generationCache.get(key)===pending)generationCache.delete(key);throw e;}}
 async function browserResource(view){return immutableEvidence('browser-projection-v1',view.generation,maxPlainBytes,async()=>{const value=await encodeBrowserReport(view.app);return {value,bytes:value.body.length};});}
 async function retainedGeneration(generation,currentHead){if(!hex(generation))throw fail(400);let bytes;try{bytes=await retained('content-heads/'+generation+'.json',1024*1024);}catch(e){if(e.code==='ENOENT')throw fail(404);throw e;}const old=JSON.parse(bytes);if(old?.manifest?.sha256!==generation||old.manifest.url!=='report-data/snapshot-'+generation+'.json'||!hex(old.reportHash)||!hex(old.originalSha)||old.originalSha!==currentHead.originalSha)throw fail(404);const key=repository.publication?.catalog?.sha256+':'+generation+':'+old.reportHash+':'+maxPlainBytes;let pending=generationCache.get(key);if(!pending){pending=(async()=>{const resource=await resourceBytes(old.manifest.url,{includePlain:true}),app=JSON.parse(resource.plain);if(app.matter?.validatedReporting?.snapshotHash!==old.reportHash)throw Error('Retained report head mismatch');return {app,allowed:allowedResources(app,old)};})();generationCache.set(key,pending);while(generationCache.size>2)generationCache.delete(generationCache.keys().next().value);}try{return await pending;}catch(e){if(generationCache.get(key)===pending)generationCache.delete(key);throw e;}}
 async function loadSnapshotFor(reportHash){if(!hex(reportHash))throw fail(400);const raw=await retained('review-snapshots/'+reportHash+'.json.gz',128*1024*1024),plain=gunzipSync(raw,{maxOutputLength:128*1024*1024}),snapshot=JSON.parse(plain);if(snapshot.snapshotHash!==reportHash||!Array.isArray(snapshot.rows))throw Error('Review snapshot mismatch');return {value:snapshot,bytes:plain.length};}
 const snapshotCache=new Map();async function snapshotFor(reportHash){let pending=snapshotCache.get(reportHash);if(!pending){pending=immutableEvidence('snapshot',reportHash,128*1024*1024,()=>loadSnapshotFor(reportHash));snapshotCache.set(reportHash,pending);while(snapshotCache.size>2)snapshotCache.delete(snapshotCache.keys().next().value);}try{return await pending;}catch(e){if(snapshotCache.get(reportHash)===pending)snapshotCache.delete(reportHash);throw e;}}
 async function loadPinnedInventories(reportHash){if(!hex(reportHash))throw fail(400);const generation=JSON.parse(await retained('photo-generations/'+reportHash+'.json',1024*1024));if(!hex(generation.digest))throw Error('Invalid photo generation');let domain='state',bytes;try{bytes=await read(domain,'photo-inventories/'+generation.digest+'.json',128*1024*1024);}catch(e){if(e.code!=='ENOENT')throw e;domain='archive';bytes=await read(domain,'photo-inventories/'+generation.digest+'.json',128*1024*1024);}const refs=JSON.parse(bytes);if(!Array.isArray(refs)||refs.length!==2)throw Error('Invalid photo inventories');const inventories=[];for(const ref of refs){const {queueDigest,...receipts}=ref;if(!hex(queueDigest))throw Error('Invalid photo queue digest');const queue=JSON.parse(await read(domain,'photo-inventories/queues/'+queueDigest+'.json',64*1024*1024));if(hash(queue)!==queueDigest)throw Error('Photo queue integrity failure');inventories.push({queue,...receipts});}const serialized=Buffer.from(JSON.stringify(inventories));if(sha(serialized)!==generation.digest)throw Error('Photo inventory integrity failure');return {value:inventories,bytes:serialized.length};}
 const inventoriesCache=new Map();async function pinnedInventories(reportHash){let pending=inventoriesCache.get(reportHash);if(!pending){pending=immutableEvidence('inventories',reportHash,128*1024*1024,()=>loadPinnedInventories(reportHash));inventoriesCache.set(reportHash,pending);while(inventoriesCache.size>2)inventoriesCache.delete(inventoriesCache.keys().next().value);}try{return await pending;}catch(e){if(inventoriesCache.get(reportHash)===pending)inventoriesCache.delete(reportHash);throw e;}}
 async function readImage(digest){const value=await immutableEvidence('image',digest,8*1024*1024,async()=>{const value=await loadImage(digest);return {value,bytes:value.length};});return Buffer.from(value);}
 async function loadImage(digest){if(!hex(digest))throw fail(400);let bytes;try{bytes=await read('objects',digest,8*1024*1024);}catch(e){if(e.code!=='ENOENT')throw e;try{bytes=await read('legacyObjects',digest,8*1024*1024);}catch(err){if(err.code!=='ENOENT')throw err;bytes=gunzipSync(await retained('photos/'+digest+'.gz',9*1024*1024),{maxOutputLength:8*1024*1024});}}if(sha(bytes)!==digest)throw Error('Photo integrity failure');return bytes;}
 let recoveredPromise,repairPromise;async function photoBoundRows(reportHash,rows,inventories){let base=pinPhotoRows({rows,inventories});const head=await repository.getHead();if(reportHash!==head.reportHash)return base;
  const repair=photoBindingRegistry||await (repairPromise??=loadPhotoBindingRepair(repository).catch(e=>{repairPromise=undefined;throw e;}));
  if(photoBindingRegistry&&(repair.reportHash!==reportHash||repair.generation!==head.manifest.sha256))throw Error('Photo registry generation mismatch');
  if(repair?.reportHash===reportHash&&repair.generation===head.manifest.sha256)base=applyPhotoBindingRepair(base,repair);
  recoveredPromise??=loadRecoveredPhotoBindings(repository);try{return applyRecoveredPhotoBindings(base,await recoveredPromise)}catch(e){recoveredPromise=undefined;throw e}}
 async function photoRowsFor(reportHash){const [snapshot,inventories]=await Promise.all([snapshotFor(reportHash),pinnedInventories(reportHash)]);return photoBoundRows(reportHash,snapshot.rows,inventories)}
 const proposalSnapshot=async h=>{const snapshot=await snapshotFor(h);return {...snapshot,rows:await photoRowsFor(h)};};
 const proposals=[0,1].map(index=>createPhotoProposalService({root:'',objectsRoot:'',snapshotFor:proposalSnapshot,inventoryFor:async h=>(await pinnedInventories(h))[index],readImage}));
 function allowedResources(app,head){const found=new Set([head.manifest.url]);const visit=value=>{if(!value||typeof value!=='object')return;if(typeof value.url==='string'&&route.test(value.url))found.add(value.url);for(const x of Object.values(value))if(x&&typeof x==='object')visit(x);};for(const x of [app._dataAppQueryLoading?.queries,app.matter?.localQueryResources,app.matter?.lazyQueries,app.matter?.lazyDeliveryDetails])visit(x);return found;}
 return {
  async getHead(){return (await current()).head;},
  async evidenceOverlay(params){const keys=[...params.keys()],requested=params.getAll('generation');if(keys.some(k=>k!=='generation')||requested.length!==1||!hex(requested[0]))throw fail(400);const {head}=await current(),generation=head.manifest.sha256,pointer=repository.publication?.evidenceOverlay;if(requested[0]!==generation)return {status:'stale',generation,entries:[]};if(!pointer){const routeEvidence=await routeEvidenceFor(async()=>(await snapshotFor(head.reportHash)).rows),ready=routeEvidence.status==='ready';return {status:ready?'ready':'unavailable',generation,evidenceRevision:evidenceRevision(repository.publication),bindingsVerified:ready,entries:[],routeEvidence};}if(pointer.version!==1||!hex(pointer.generation)||!hex(pointer.sha256)||pointer.path!=='evidence-overlays/'+pointer.sha256+'.json')throw Error('Invalid evidence overlay pointer');const bytes=await read('state',pointer.path,16*1024*1024);if(sha(bytes)!==pointer.sha256)throw Error('Evidence overlay integrity failure');const overlay=JSON.parse(bytes);if(overlay.version!=='matter-evidence-overlay-v1'||overlay.generation!==pointer.generation||!Array.isArray(overlay.entries)||overlay.entries.length>100000)throw Error('Invalid evidence overlay');const indexed=new Map();for(const e of overlay.entries){if(!e||typeof e.recordKey!=='string'||indexed.has(e.recordKey))throw Error('Invalid evidence overlay records');indexed.set(e.recordKey,e)}const snapshot=await snapshotFor(head.reportHash),inventories=await pinnedInventories(head.reportHash),rows=await photoBoundRows(head.reportHash,snapshot.rows,inventories),direct=await loadDirectVisualReviews(repository),entries=[],staleRecordKeys=[],seen=new Set();for(const row of rows){if(seen.has(row.key))throw Error('Ambiguous current evidence row');seen.add(row.key);const e=indexed.get(row.key);if(!e)continue;const verified=overlayForRow({version:overlay.version,generation:overlay.generation,auditedAt:overlay.auditedAt,entries:[e]},row,generation);if(verified){if(direct){const receipt=direct.reviews.get(row.key);verified.directPhoto=receipt?{...directVisualReviewForRow(receipt.review,row,verified.source),artifactSha256:direct.artifactSha256,queueSha256:direct.queueSha256,reviewSha256:receipt.reviewSha256}:{status:hex(row.delivery?.photo_sha256)?'not_reviewed':'unavailable',independentlyConfirmed:false};}entries.push(verified);}else staleRecordKeys.push(row.key)}return {status:'ready',generation,evidenceRevision:evidenceRevision(repository.publication),auditedGeneration:overlay.generation,auditedAt:overlay.auditedAt??null,bindingsVerified:true,entries,staleRecordKeys,routeEvidence:await routeEvidenceFor(rows)};},
  async browserManifest(){const view=await current();return (await browserResource({...view,generation:view.head.manifest.sha256})).manifest;},
  async resource(name,{generation}={}){const {head}=await current();if(generation!==undefined&&!hex(generation))throw fail(400);const selected=generation||head.manifest.sha256,view=selected!==head.manifest.sha256?await retainedGeneration(selected,head):cached;let result;if(!view.allowed.has(name)){if(!/^report-data\/snapshot-[a-f0-9]{64}\.json$/.test(name))throw fail(404);const browser=await browserResource({...view,generation:selected});if(name!==browser.manifest.url)throw fail(404);result=browser;}else result=await resourceBytes(name);const bytes=result.body;function* chunks(){for(let offset=0;offset<bytes.length;offset+=65536)yield bytes.subarray(offset,offset+65536);}return {body:bytes.length>4*1024*1024?Readable.from(chunks()):Buffer.from(bytes),gzip:true,decodedBytes:result.decodedBytes,encodedBytes:bytes.length};},
  async status(actor){const {head,app}=await current(),publication=repository.publication,schedule=publication?.schedule,pending=Array.isArray(schedule?.pending)?schedule.pending:null,gps=publication?.gpsState&&typeof publication.gpsState==='object'&&!Array.isArray(publication.gpsState)?Object.values(publication.gpsState):null,clock=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null,gpsClocks=(gps||[]).map(x=>clock(x?.lastSuccessfulRead)).filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b)),weekend=await readWeekendIdentityCheckpoint(repository,head,publication?.weekendIdentities),lastVerifiedAt=verifiedScheduleTimestamp(publication?.schedulerVerification,deploymentId);return {cloud:true,storage:'hosted',evidenceRevision:evidenceRevision(publication),weekendCustomerIdentities:weekend?weekendIdentityView(weekend.entries):{},authenticatedActor:actor&&typeof actor.email==='string'&&['owner','reviewer','viewer'].includes(actor.role)?{email:actor.email,role:actor.role,verified:true}:null,records:head.records,history:head.history,generation:head.manifest.sha256,reportHash:head.reportHash,source:head.source||null,automaticPipeline:{lastSuccessfulCapture:publication?.lastCapture&&publication.lastCapture.observedAt===head.source?.observedAt&&publication.lastCapture.day===head.source?.day&&clock(publication.lastCapture.observedAt)?{day:publication.lastCapture.day,observedAt:publication.lastCapture.observedAt,runId:publication.lastCapture.runId,atomic:false}:(head.automaticPipeline||app.matter?.automaticPipeline)?.lastSuccessfulCapture||null,lastAssessmentAt:(head.automaticPipeline||app.matter?.automaticPipeline)?.lastAssessmentAt||null,availability:lastVerifiedAt?'Automatic cloud updates last checked '+lastVerifiedAt:'Saved capture; source sync status unverified'},cloudPipeline:{deliveryObservedAt:clock(head.source?.observedAt),gpsEvidenceObservedAt:clock(head.gps?.observedAt),gpsCollectionObservedAt:gpsClocks.at(-1)||null,pendingCaptures:pending?.length??null,failedCaptures:pending?pending.filter(item=>item?.attempts>0).length:null,deliverySourceHalted:schedule?!!schedule.sourceHalt:null,photoSourceHalted:publication?!!(publication.photoSourceHalt||schedule?.photoSourceHalt):null,gpsNamespaces:gps?.length??null,gpsStarted:gps?gps.filter(x=>x?.phase==='started').length:null,gpsRetainedWindows:gps?gps.reduce((n,x)=>n+(Number.isSafeInteger(x?.successfulWindows)&&x.successfulWindows>=0?x.successfulWindows:0),0):null,schedulerVerified:!!lastVerifiedAt,lastVerifiedAt},sourceRefreshEnabled:false,busy:false};},
  async completed(params){const {head,app}=await current(),meta=app.matter.validatedReporting,rows=app.queries[meta.queryId||'reporting_validated_deliveries_summary']?.rows||[];return completedReport({...app,queries:{...app.queries,reporting_validated_deliveries:{rows}}},head,{from:params.get('from'),to:params.get('to')||params.get('from'),reportId:params.get('reportId')},now());},
  snapshotFor,photoRowsFor,photoInventoryFor:pinnedInventories,reviews:actor=>reviewStore.read(actor),saveReview:async(input,actor)=>{const receipt=await reviewStore.save(input,actor);return {...receipt,state:await reviewStore.read(actor)};},identities:actor=>identityStore.read(actor),saveIdentity:(input,actor)=>identityStore.save(input,actor),
  async photo(params,image){const keys=params.getAll('record'),hashes=params.getAll('snapshot');if(keys.length!==1||hashes.length!==1||!keys[0]||keys[0].length>300||!hex(hashes[0]))throw fail(400);const [snapshot,inventories]=await Promise.all([snapshotFor(hashes[0]),pinnedInventories(hashes[0])]);let row=snapshot.rows.find(r=>r.key===keys[0]);if(!row)return {status:'unavailable',message:'This record is not part of the requested report.'};[row]=await photoBoundRows(hashes[0],[row],inventories);const digest=row.delivery?.photo_sha256;if(!hex(digest))return {status:'unavailable',message:'No matching retained image is available for this evidence version.'};let bytes;try{bytes=await readImage(digest);}catch(e){if(e.code==='ENOENT')return {status:'unavailable',message:'No matching retained image is available for this evidence version.'};throw e;}let mime;if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';else if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';else if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')mime='image/webp';else throw Error('Invalid image');if(image)return {bytes,mime};const query=new URLSearchParams({record:keys[0],snapshot:hashes[0]});return {status:'cached',sha256:digest,downloadedAt:null,thumbnail:'/api/reporting/photo/image?'+query,original:'/api/reporting/photo/image?'+query+'&original=1',reviewed:false};},
  async photoProposals(params,actor){
   const reportHash=params.get('snapshot'),results=await Promise.all(proposals.map(s=>s(params))),inventories=await pinnedInventories(reportHash);if(results.length!==2)throw Error('Photo inventory unavailable');
   const merged=results[0].proposals.map((old,i)=>chooseLegacyProposal(old,results[1].proposals[i])),snapshot=await snapshotFor(reportHash),rows=await photoBoundRows(reportHash,snapshot.rows,inventories),pointers=repository.publication?.cloudPhotoResults||{},journal=actor?await reviewStore.read(actor):{records:{reportingReviews:[]}};if(!Array.isArray(journal?.records?.reportingReviews))throw Error('Invalid review journal');
   const completedDays=new Set(),blockedKeys=new Set();for(const inv of inventories){for(const day of inv.queue.completedReportDays||[])completedDays.add(day);for(const item of inv.queue.items)if(inv.proposals?.[item.id]||inv.flags?.[item.id]||inv.attempts?.[item.id]){if(item.recordKey)blockedKeys.add(item.recordKey);if(item.datedRecordKey)blockedKeys.add(item.datedRecordKey);}}
   async function loadCloud(row){const list=pointers[sha(row.key)];if(list===undefined)return null;if(!Array.isArray(list)||photoCaseReviewed(row,journal)||completedPhotoDay(row,completedDays)||blockedKeys.has(row.key))return null;const d=row.delivery||{},binding={recordKey:row.key,urlSha256:sha(d.photo_url||''),proofTimestamp:d.raw_upload??d.upload??null,imageSha256:d.photo_sha256},matches=list.filter(x=>x.bindingSha256===hash(binding));if(matches.length>1)throw Error('Ambiguous cloud photo result');const pointer=matches[0];if(!pointer)return null;if(!hex(pointer.sha256)||pointer.path!=='cloud-photo-results/'+pointer.sha256+'.json')throw Error('Invalid cloud photo result pointer');const bytes=await read('state',pointer.path,65536);if(sha(bytes)!==pointer.sha256)throw Error('Cloud photo result integrity failure');const result=JSON.parse(bytes),b=result.binding;if(result.attemptId!==pointer.attemptId||result.reviewMethod!=='cloud-ai-gateway'||result.reviewMethodVersion!=='cloud-ai-gateway-v1-20261103'||!hex(result.requestSha256)||b?.recordKey!==row.key||b.urlSha256!==binding.urlSha256||b.proofTimestamp!==binding.proofTimestamp||b.imageSha256!==binding.imageSha256||!['proposed','needs_review'].includes(result.status)||result.status==='proposed'&&(!Number.isInteger(result.grade)||result.grade<0||result.grade>3)||result.status==='needs_review'&&result.grade!==null||typeof result.reason!=='string'||!result.reason.trim()||result.reason.length>2000||typeof result.uncertainty!=='string'||result.uncertainty.length>2000||typeof result.reviewerModel!=='string'||!Number.isFinite(Date.parse(result.reviewedAt)))return null;try{await readImage(b.imageSha256);}catch(e){if(e.code==='ENOENT')return null;throw e;}return {recordKey:row.key,status:result.status,...(result.status==='proposed'?{grade:result.grade,imageSha256:b.imageSha256}:{}),reason:result.reason,uncertainty:result.uncertainty,rubricVersion:result.rubricVersion,reviewerModel:result.reviewerModel,reviewMethod:result.reviewMethod,reviewMethodVersion:result.reviewMethodVersion,reviewedAt:result.reviewedAt};}
   const cacheKey=hex(repository.publication?.catalog?.sha256)?[
    deferredPhotoProgress?'deferred':'blocking',repository.publication.catalog.sha256,reportHash,
    hash(journal),hash(photoBindingRegistry),hash(pointers),!!actor,
   ].join(':'):null;
   const applicable=proposal=>['pending','unavailable'].includes(proposal.status);
   function mergeCloud(cloud){
    for(let i=0;i<merged.length;i++){
     const result=cloud.get(merged[i].recordKey);
     if(result&&applicable(merged[i]))merged[i]=result;
    }
   }
   async function loadProgress(verifiedCloud=new Map()){
    const cloud=new Map(verifiedCloud),selected=actor?rows.filter(row=>pointers[sha(row.key)]&&!cloud.has(row.key)):[];
    async function inspect(items,verify){
     let cursor=0;
     await Promise.all(Array.from({length:Math.min(deferredPhotoProgress?1:6,items.length)},async()=>{
      while(cursor<items.length)await verify(items[cursor++]);
     }));
    }
    await inspect(selected,async row=>{
     const result=await loadCloud(row);
     if(result)cloud.set(row.key,result);
    });
    const verifiedSourceOnlyImages=new Set();
    const sourceOnly=rows.filter(row=>row.sourceOnly?.assessmentState==='unavailable'&&hex(row.delivery?.photo_sha256));
    await inspect(sourceOnly,async row=>{
     try{
      const b=await readImage(row.delivery.photo_sha256);
      const image=b[0]===255&&b[1]===216&&b[2]===255||b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
      if(image)verifiedSourceOnlyImages.add(row.key);
     }catch(error){
      if(deferredPhotoProgress&&error?.code!=='ENOENT')throw error;
     }
    });
    return {cloud,progress:currentPhotoProgress({rows,inventories,cloud,journal,verifiedSourceOnlyImages})};
   }
   const response={rubricVersion:results[1].rubricVersion||results[0].rubricVersion,progressScope:'current-photo-records',
    legacyProgress:combinedPhotoProgress(inventories),proposals:merged};
   if(deferredPhotoProgress){
    const requested=new Map(merged.map(proposal=>[proposal.recordKey,proposal]));
    const requestedRows=rows.filter(row=>requested.has(row.key));
    if(requestedRows.length!==requested.size||new Set(requestedRows.map(row=>row.key)).size!==requested.size){
     throw Error('Ambiguous requested photo record');
    }
    const selected=actor?requestedRows.filter(row=>applicable(requested.get(row.key))):[];
    const cloud=new Map(await Promise.all(selected.map(async row=>[row.key,await loadCloud(row)])));
    mergeCloud(cloud);
    return {...response,...readDeferredPhotoProgress(cacheKey,()=>loadProgress(cloud))};
   }
   let pending=cacheKey&&photoProgressCache.get(cacheKey);
   if(!pending){
    pending=loadProgress();
    if(cacheKey)rememberPhotoProgress(cacheKey,pending);
   }
   let computed;
   try{computed=await pending;}
   catch(error){
    if(cacheKey&&photoProgressCache.get(cacheKey)===pending)photoProgressCache.delete(cacheKey);
    throw error;
   }
   mergeCloud(computed.cloud);
   return {...response,progress:computed.progress};
  }
 };
}
