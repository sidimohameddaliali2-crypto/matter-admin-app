import {createCandidateMapAccess} from './candidate-map-access.mjs';
import {prioritizePreviewStartup} from './preview-early-startup.mjs';
import {addPreviewPhotoPrime} from './preview-photo-prime.mjs';
import {addStatusFlight} from './preview-status-flight.mjs';
import {addPrivateEvidenceCache} from './preview-http-cache.mjs';
import {addPreviewStartup} from './preview-startup.mjs';
import {createPreviewRoadCache} from './preview-road-cache.mjs';
import {createHouseholdStore} from './household-arrangements.mjs';
import {connectPreviewOrderTiming} from './preview-order-timing.mjs';
import {connectPreviewCorrections} from './preview-corrections.mjs';
import {createPreviewRoads} from './preview-roads.mjs';
import {createPreviewReadView} from './preview-read-view.mjs';
import {previewArchiveTransport} from './preview-archive-cache.mjs';
import {extractPreviewFonts} from './preview-fonts.mjs';
import {addDriverAuditSyncStatus} from './driver-audit-status.mjs';
import fs from 'node:fs';import path from 'node:path';import {gunzipSync} from 'node:zlib';import {createHash} from 'node:crypto';
import {createHostedIdentities} from './hosted-identities.mjs';
import {createImmutableEvidenceCache} from './immutable-evidence-cache.mjs';
import {createCloudState} from './cloud-state.mjs';import {createHostedRpc} from './rpc.mjs';import {createSupabaseArchiveTransport} from '../hosted/supabase-archive.mjs';import {createCloudRepository} from './repository.mjs';import {createHostedAccess} from './hosted-access.mjs';import {createHostedAuth} from './hosted-auth.mjs';import {createHostedReviews} from './hosted-reviews.mjs';import {createCloudReportService,cloudHtml} from './report-service.mjs';import {createCloudHttp} from './cloud-http.mjs';import {createPasswordLogin,createLoginThrottle,passwordLoginHtml} from './password-login.mjs';import {createPreviewGps} from './preview-gps.mjs';import {createPreviewMapAccess} from './preview-map-access.mjs';import {createReaderBudgetPool} from './reader-budget-pool.mjs';import {addCasePrefetch} from './case-prefetch.mjs';import {addBrowserReadCache} from './browser-read-cache.mjs';import {addBrowserRequestQueue} from './browser-request-queue.mjs';import {initializeReportTab} from './initial-report-tab.mjs';
export const PREVIEW_NAMESPACE='preview-gps-map-20261106:';
const sha=b=>createHash('sha256').update(b).digest('hex');
const allowedReviewNamespace=prefix=>prefix===PREVIEW_NAMESPACE||/^preview-acceptance-[a-z0-9-]+:$/.test(prefix);
export function namespaceState(state,prefix=PREVIEW_NAMESPACE){if(!allowedReviewNamespace(prefix))throw Error('Unsupported preview review namespace');return {read:key=>state.read(prefix+key),compareAndSwap:input=>state.compareAndSwap({...input,key:prefix+input.key})};}
export function createPreviewRuntime(options){return buildPreviewRuntime(options,false);}
// Trusted server integration, never selected by a browser parameter. The host
// supplies verified staff identity and a hash-checked imported release package.
export function createImportedAuditRuntime(options){
 if(!options?.packageOverride||typeof options.authOverride?.authenticate!=='function'||typeof options.authOverride?.csrfMatches!=='function'||typeof options.stateOverride?.read!=='function'||typeof options.stateOverride?.compareAndSwap!=='function'||typeof options.transportOverride?.readObject!=='function')throw Error('Verified audit integration dependencies required');
 const url=new URL(options.origin);if(url.origin!==options.origin||!(url.protocol==='https:'||url.hostname==='127.0.0.1'&&url.protocol==='http:'))throw Error('Invalid audit integration origin');
 return buildPreviewRuntime({...options,roadsKey:null},true);
}
async function buildPreviewRuntime({origin,secret,publishableKey,cookieKey,allowedEmail,additionalAllowedEmails=[],privateRoot,packageOverride,authOverride,stateOverride,transportOverride,roadsKey=process.env.MATTER_PREVIEW_ROADS_KEY,local=false,reviewNamespace=PREVIEW_NAMESPACE,afterResponse,automaticFeed=false,automaticRefresh=false,onAuthenticatedRequest,auditImportStatus,auditSyncStatus,publicPathPrefix=''},staffIntegration){
 if(auditImportStatus!==undefined&&(!staffIntegration||typeof auditImportStatus!=='function'))throw Error('Trusted audit import status required');
 if(auditSyncStatus!==undefined&&(!staffIntegration||typeof auditSyncStatus!=='function'))throw Error('Trusted audit sync status required');
 if(publicPathPrefix!==''&&(!staffIntegration||publicPathPrefix!=='/api/reporting'))throw Error('Trusted audit route prefix required');
 if(automaticFeed&&!local&&!packageOverride)throw Error('Automatic hosted feed requires a verified package');
 if(local&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error('Local test must stay loopback-only');
 if(!local&&!staffIntegration&&(authOverride||stateOverride||transportOverride))throw Error('Hosted preview cannot use test adapters');
 if(packageOverride&&(!packageOverride.manifest||typeof packageOverride.read!=='function'||typeof packageOverride.readAsync!=='function'||typeof packageOverride.has!=='function'||typeof packageOverride.read==='object'))throw Error('Invalid internal preview package');
 if(!packageOverride&&!path.isAbsolute(privateRoot||''))throw Error('Private preview package root required');
 if(!allowedReviewNamespace(reviewNamespace))throw Error('Unsupported preview review namespace');
 const manifest=packageOverride?packageOverride.manifest:JSON.parse(fs.readFileSync(path.join(privateRoot,'files.private.json')));
 const has=name=>packageOverride?packageOverride.has(name):Object.hasOwn(manifest,name);
 const read=name=>{if(!has(name)||!Object.hasOwn(manifest,name))throw Error('File outside preview manifest');const bytes=packageOverride?packageOverride.read(name):fs.readFileSync(path.join(privateRoot,name));if(!Buffer.isBuffer(bytes)||sha(bytes)!==manifest[name])throw Error('Preview file integrity failure');return bytes;};
 const readAsync=async name=>{if(!has(name)||!Object.hasOwn(manifest,name))throw Error('File outside preview manifest');const bytes=packageOverride?await packageOverride.readAsync(name):read(name);if(!Buffer.isBuffer(bytes)||sha(bytes)!==manifest[name])throw Error('Preview file integrity failure');return bytes;};
 const json=name=>JSON.parse(read(name)),publication=json('publication.private.json'),identity=json('identities.private.json'),index=JSON.parse(gunzipSync(read('gps-index.private.json.gz'))),maps=json('maps.private.json');
 if(packageOverride&&(packageOverride.generation&&packageOverride.generation!==publication.head.manifest.sha256||packageOverride.reportHash&&packageOverride.reportHash!==publication.head.reportHash))throw Error('Preview package head mismatch');
 const rpc=createHostedRpc({secret}),rawState=stateOverride||createCloudState({rpc}),state=namespaceState(rawState,reviewNamespace),transport=previewArchiveTransport({remote:transportOverride||createSupabaseArchiveTransport({secret}),has,read,readAsync});
 const repository=await createCloudRepository({stateStore:{read:async()=>({revision:publication.revision||0,body:JSON.stringify(publication)})},transport,key:'frozen-preview',cacheBytes:96*1024*1024}).pin(),head=await repository.getHead();
 const access=createHostedAccess({rpc}),auth=authOverride||createHostedAuth({supabaseUrl:'https://trhhjfgfmxofxhnzocks.supabase.co',publishableKey,cookieKey,membership:access.membership,sessionActive:access.sessionActive,cookieName:'__Host-matter_preview'});
 const login=createPasswordLogin({supabaseUrl:'https://trhhjfgfmxofxhnzocks.supabase.co',publishableKey,allowedEmail,additionalAllowedEmails,throttle:createLoginThrottle({stateStore:state})});
 const readView=JSON.parse(gunzipSync(read('preview-read-view.private.json.gz')));
 let report;const reviews=createHostedReviews({stateStore:state,snapshotFor:hash=>report.snapshotFor(hash)}),identities=createHostedIdentities({stateStore:{read:async()=>identity,compareAndSwap:async()=>{throw Object.assign(Error('Preview is read-only for identities'),{status:403});}},config:JSON.parse(identity.body).config,rows:async()=>(await report.gpsSnapshotFor(head.reportHash)).rows});
 report=createCloudReportService({repository,reviewStore:reviews,identityStore:identities,evidenceCache:createImmutableEvidenceCache({maxBytes:96*1024*1024,maxEntries:96}),photoBindingRegistry:has('preview-photo-bindings.private.json')?json('preview-photo-bindings.private.json'):null});
 report=createPreviewReadView({service:report,repository,read,readAsync,view:readView,has});
 if(Object.hasOwn(manifest,'corrections.private.json'))report=connectPreviewCorrections(report,readView,{...json('corrections.private.json'),...(Object.hasOwn(manifest,'release-gps-availability.private.json')?{gpsAvailability:json('release-gps-availability.private.json')}:{})});
 report=connectPreviewOrderTiming(report,readView,index,{frozen:true,households:createHouseholdStore(state),decisions:Object.hasOwn(manifest,'case-decisions.private.json')?json('case-decisions.private.json'):undefined});
 const streams=new Map();const gps=createPreviewGps({snapshotFor:report.gpsSnapshotFor,index,readStream:async key=>{const file=index.streamFiles[key];if(!file)throw Error('GPS stream unavailable');if(!streams.has(key)){streams.set(key,JSON.parse(gunzipSync(await readAsync(file))));while(streams.size>8)streams.delete(streams.keys().next().value);}return streams.get(key);}});
 const fonts=extractPreviewFonts(read('renderer.private.html').toString(),publicPathPrefix);
 const roads=createPreviewRoads({gps,state,config:maps.roads,key:roadsKey,geometryCache:local?undefined:createPreviewRoadCache({rpc})});
 report={...report,roadEvidence:roads.read,fontAsset:fonts.asset,gpsEvidence:async(...args)=>{const evidence=await gps.read(...args),sharedHouseholdStop=await report.householdStopFor(evidence.recordKey);return {...evidence,sharedHouseholdStop,roadDisplayAvailable:false};},mapsAccess:maps.candidateConfiguration?createCandidateMapAccess({stateStore:rawState,allowanceStore:namespaceState(rawState,PREVIEW_NAMESPACE),stateKey:maps.candidateConfiguration.stateKey,origin,config:maps}):createPreviewMapAccess({stateStore:state,config:maps})};
 const syncStatus=async()=>{
  const status=await auditSyncStatus();
  const observed=head.source?.observedAt;
  return {...status,visibleCutoffAt:typeof observed==='string'&&Number.isFinite(Date.parse(observed))?new Date(observed).toISOString():null};
 };
 const status=report.status;report.status=async actor=>{
  const result={...await status(actor),privatePreview:true,automaticFeed,automaticRefresh,sourceRefreshEnabled:false};
  if(auditImportStatus){const value=auditImportStatus();if(!value||!['disabled','not-requested','checking','imported','unchanged','failed','budget-exhausted','superseded'].includes(value.status))throw Error('Invalid audit import status');result.auditImport=value;
   if(['checking','failed','budget-exhausted','superseded'].includes(value.status))result.error=value.status==='checking'?'New audit evidence is being checked; the saved report is retained.':'New audit evidence could not be refreshed; the saved report is retained.';
  }
  if(auditSyncStatus){
   result.auditSync=await syncStatus();
   if(['failed','capacity-blocked','budget-deferred'].includes(result.auditSync.status))result.error='New audit evidence could not be refreshed. The last verified audit is retained.';
  }
  return result;
 };
 const build=json('build.private.json'),photoHints=Object.hasOwn(manifest,'photo-prime.private.json')?json('photo-prime.private.json'):null;let html=null;
 return createCloudHttp({auth,service:report,origin,login,loginPage:passwordLoginHtml,compressPreviewReads:true,localFontAssets:staffIntegration,afterResponse,onAuthenticatedRequest,mapsEnabled:maps.enabled===true,readerBudget:local?undefined:createReaderBudgetPool({stateStore:rawState}),renderer:async(_actor,_service,url)=>{
  if(!html){let source=fonts.html.replace(build.snapshot.path,'report-data/snapshot-'+build.snapshot.sha256+'.json');source=cloudHtml({html:initializeReportTab(source),priorManifest:build.snapshot,head:{...head,manifest:await report.browserManifest()},generation:head.manifest.sha256,publicPathPrefix});html=addCasePrefetch(addBrowserReadCache(addBrowserRequestQueue(addPrivateEvidenceCache(source.replace('</head>','<script>window.__matterPrivatePreview=true;window.__matterGpsPreview=true;window.__matterAutomaticPreview='+JSON.stringify(automaticRefresh||automaticFeed)+';</script></head>')))));html=addPreviewStartup(addStatusFlight(html),{...(await report.browserManifest()),generation:head.manifest.sha256,publicPathPrefix});}
  const page=prioritizePreviewStartup(addPreviewPhotoPrime(html,photoHints,url));
  return auditSyncStatus?addDriverAuditSyncStatus(page,await syncStatus()):page;
 }});
}
