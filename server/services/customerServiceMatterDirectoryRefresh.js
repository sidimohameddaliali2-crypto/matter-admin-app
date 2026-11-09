import {readMysqlCustomerDirectory} from './customerServiceMysqlDirectory.js';
import {combineMysqlAndApiDirectories} from './customerServiceMysqlComposition.js';
import {mirrorNutritionMysqlDirectory,mirrorMatterApiDirectory} from './customerServiceSupabaseApiMirror.js';
import {readSupabaseCustomerDirectory} from './customerServiceSupabaseDirectory.js';
import {overlaySupabaseDirectory} from './customerServiceSupabaseOverlay.js';
import {readMatterCustomerDirectoryWithNutrition} from './customerServiceNutritionComposition.js';
import {readRemoteCustomerDirectory} from './customerServiceRemoteDirectory.js';
import {readFile}from'node:fs/promises';
import mongoose from'mongoose';
import ServiceCustomer from'../models/ServiceCustomer.js';
import State from'../models/ServiceCustomerDirectoryState.js';
import{readMatterCustomerDirectory,normalizeCombinedMatterDirectory,enrichMissingMatterPhones}from'./customerServiceMatterDirectory.js';
import{persistCustomerDirectory}from'./customerServiceMatterDirectoryPersistence.js';
export function matterDirectoryReadEnvironment(values={}){
 return Object.fromEntries(['MATTER_API_BASE_URL','MATTER_API_TOKEN','MATTER_API_READ_ENABLED',...['CUSTOMER_SERVICE_NUTRITION_COOKIE','CUSTOMER_SERVICE_NUTRITION_ACTION'].filter(key=>values[key]!==undefined)].map(key=>[key,values[key]]));
}
// Full reconciliation evidence belongs to the generation manifest once. Copying
// thousands of source links into every customer can exceed JSON/BSON limits.
export function compactCustomerSourceReport(report){
 const keys=['source','observedAt','status','coverage','uniqueCustomers','totalRemoteRecords','remoteCollectionReconciled','fullCustomerDirectory','fullAdminCustomerDirectory','apiCustomers','apiSubscriptions','nutritionCustomers','nutritionDatabaseCustomers','apiObservedAt','nutritionObservedAt','nutritionDatabaseObservedAt','remoteDatabaseObservedAt','remoteSnapshotObservedAt','supabaseObservedAt'];
 return{manifestKey:'matter_customer_directory',...Object.fromEntries(keys.filter(key=>report[key]!==undefined).map(key=>[key,report[key]])),sources:Object.fromEntries(Object.entries(report.sources||{}).map(([key,value])=>[key,{state:value.state,observedAt:value.observedAt}]))};
}
// Reading the same source row again updates its observation date, not its
// identity. Property order and absent/default fields are not evidence changes.
function profileEvidenceKey(p){
 return JSON.stringify(['source','sourceRecordId','sourceSubscriptionId','name','email','phone','sourceUpdatedAt','rawPhone'].map(key=>p[key]??''));
}
function mergeProfileEvidence(fresh,retained){
 const observations=new Map(),freshKeys=new Set();
 for(const p of fresh){if(p.eligibleForAutomaticMatching===false)continue;const key=profileEvidenceKey(p);observations.set(key,structuredClone(p));freshKeys.add(key);}
 for(const p of retained){
  if(p.eligibleForAutomaticMatching===false)continue;const key=profileEvidenceKey(p),current=observations.get(key);
  if(!current||(!freshKeys.has(key)&&Date.parse(p.sourceObservedAt)>Date.parse(current.sourceObservedAt||0)))observations.set(key,structuredClone(p));
 }
 return [...observations.values()];
}
// Retain the committed projection verbatim; never reconstruct source rows or infer links.
function overlayApiOnRetainedDirectory(existing,prior,api){
 const report=prior?.report,remoteAt=report?.remoteDatabaseObservedAt||report?.remoteSnapshotObservedAt;
 if(!prior?.activeGeneration||!report?.remoteCollectionReconciled||!Number.isFinite(Date.parse(remoteAt))||existing.length!==report.uniqueCustomers||existing.some(c=>c.generation!==prior.activeGeneration))throw new Error('No reconciled retained remote generation');
 const profiles=existing.flatMap(c=>c.deliveryProfiles||[]),ids=profiles.map(p=>p.customerId);
 if(!Number.isSafeInteger(report.totalRemoteRecords)||profiles.length!==report.totalRemoteRecords||new Set(ids).size!==ids.length)throw new Error('Retained remote profile count mismatch');
 const customers=new Map(existing.map(c=>{
  const {_id,__v,createdAt,updatedAt,generation,active,...retained}=c;
  return[c.customerId,{...structuredClone(retained),sourceStates:{...retained.sourceStates,...(retained.sourceStates?.nutritionAdmin?{nutritionAdmin:{...retained.sourceStates.nutritionAdmin,state:'retained'}}:{}),...(c.matterCustomerId?{api:{state:'retained',observedAt:c.sourceStates?.api?.observedAt||report.apiObservedAt||c.sourceObservedAt}}:{}),...(c.deliveryProfiles?.length?{remoteDatabase:{state:'retained',observedAt:remoteAt}}:{})}}];
 }));
 for(const fresh of api.customers){
  const retained=customers.get(fresh.customerId);
  if(retained&&retained.matterCustomerId!==fresh.matterCustomerId)throw new Error('Canonical source identity mismatch');
  const profiles=retained?.deliveryProfiles||[];
  // Saved admin observations remain distinct evidence; isolated Supabase copies
  // never enter this automatic matching projection.
  const observations=mergeProfileEvidence(fresh.profileObservations||[],[...(retained?.profileObservations||[]),...profiles.filter(p=>p.eligibleForAutomaticMatching!==false).map(p=>({name:p.name||'',email:p.email||'',phone:p.phone||''}))]);
  customers.set(fresh.customerId,{...retained,...structuredClone(fresh),sourceAliases:[...new Set([...(retained?.sourceAliases||[]),fresh.customerId])],deliveryCustomerIds:retained?.deliveryCustomerIds||[],deliveryProfiles:profiles,profileObservations:observations,identityNeedsReview:observations.length>1,source:profiles.length?'matter_delivery_db_and_api':fresh.source,sourceCoverage:profiles.length?'remote_customer_collection_and_subscription_customers':fresh.sourceCoverage,sourceStates:{...retained?.sourceStates,...(fresh.sourceStates||{api:{state:'available',observedAt:api.report.observedAt}})},sourceObservedAt:fresh.sourceObservedAt||api.report.observedAt});
 }
 return{expectedGeneration:prior.activeGeneration,customers:[...customers.values()],report:{...report,observedAt:api.report.observedAt,apiCustomers:api.customers.length,apiSubscriptions:api.report.sourceSubscriptionTotal,uniqueCustomers:customers.size,retainedRemoteCollection:true,limitations:[...(report.limitations||[]).filter(v=>!v.startsWith('Remote database is unavailable'))]}};
}
// Local preview writes only. Each source is read independently; a partial API
// refresh retains the complete, reconciled remote projection and its old date.
export function createMatterDirectoryRefresh({env,remoteSnapshotPath,intervalMs=30*60*1000,detailBudget=20,
 mirrorSource=mirrorMatterApiDirectory,readApi,readComposed=readMatterCustomerDirectoryWithNutrition,combine=normalizeCombinedMatterDirectory,enrich=enrichMissingMatterPhones,persist=persistCustomerDirectory,
 loadRemote,loadSupabase,readMysql=readMysqlCustomerDirectory,mirrorMysql=mirrorNutritionMysqlDirectory,
 loadSnapshot=async()=>JSON.parse(await readFile(remoteSnapshotPath,'utf8')),
 loadExisting=async()=>ServiceCustomer.find({active:true}).lean(),
 loadState=async()=>State.findOne({key:'matter_customer_directory'}).lean(),
 recordFailure=async(sources,expectedGeneration)=>State.updateOne({key:'matter_customer_directory',...(expectedGeneration!==undefined?{activeGeneration:expectedGeneration}:{})},{$set:{...(sources?{'report.sources':sources}:{}),status:'failed',lastAttemptAt:new Date(),error:'Automatic source refresh failed; previous directory remains available.'},$setOnInsert:{key:'matter_customer_directory'}},{upsert:expectedGeneration===undefined}),
 assertLocal=()=>{if(!/^matter_service_test_[a-f0-9]{32}$/.test(mongoose.connection.name||'')||!['127.0.0.1','localhost','::1'].includes(mongoose.connection.host))throw new Error('Directory refresh requires the explicit local preview database');},
 setTimer=setTimeout,clearTimer=clearTimeout}={}){
 if(!Number.isSafeInteger(intervalMs)||intervalMs<60000||intervalMs>24*3600000)throw new Error('Invalid directory refresh interval');
 if(!Number.isSafeInteger(detailBudget)||detailBudget<0||detailBudget>20)throw new Error('Invalid directory detail budget');
 const mysqlMode=env?.CUSTOMER_SERVICE_MYSQL_ENABLED==='true';
 const mysqlEnv=Object.fromEntries(['CUSTOMER_SERVICE_MYSQL_REQUIRED_MODE_APPROVED','MATTER_V2_DB_READ_ENABLED','MATTER_V2_DB_SSLMODE','MATTER_V2_DB_HOST','MATTER_V2_DB_PORT','MATTER_V2_DB_USERNAME','MATTER_V2_DB_PASSWORD','MATTER_V2_DB_DATABASE'].map(key=>[key,env?.[key]]));
 const supabaseEnv=Object.fromEntries(['CUSTOMER_SERVICE_SUPABASE_CREDENTIALS_PATH','CUSTOMER_SERVICE_SUPABASE_CA_PATH'].map(k=>[k,env?.[k]]));
 const supabaseMode=Boolean(loadSupabase||supabaseEnv.CUSTOMER_SERVICE_SUPABASE_CREDENTIALS_PATH||supabaseEnv.CUSTOMER_SERVICE_SUPABASE_CA_PATH);
 const config=matterDirectoryReadEnvironment(env);
 if(supabaseMode||mysqlMode){delete config.CUSTOMER_SERVICE_NUTRITION_COOKIE;delete config.CUSTOMER_SERVICE_NUTRITION_ACTION;}
 const sourceSync=supabaseMode&&env?.CUSTOMER_SERVICE_SUPABASE_SOURCE_SYNC_ENABLED==='true';
 const sourceReader=readApi||(config.CUSTOMER_SERVICE_NUTRITION_COOKIE?readComposed:readMatterCustomerDirectory);
 const directoryReader=sourceSync?async options=>mirrorSource(await sourceReader(options),{env:supabaseEnv}):sourceReader;
 const remoteEnv=Object.fromEntries(['CUSTOMER_SERVICE_REMOTE_MONGODB_URI','CUSTOMER_SERVICE_REMOTE_MONGODB_DATABASE'].map(k=>[k,env?.[k]]));
 const liveLoader=supabaseMode?(loadSupabase||(()=>readSupabaseCustomerDirectory({env:supabaseEnv}))):loadRemote||(remoteEnv.CUSTOMER_SERVICE_REMOTE_MONGODB_URI||remoteEnv.CUSTOMER_SERVICE_REMOTE_MONGODB_DATABASE?()=>readRemoteCustomerDirectory({env:remoteEnv}):null);
 let pending=null,timer=null,stopped=false;
 async function work(){
  assertLocal();
  let sources,expectedGeneration;
  try{
   const [remoteResult,apiResult,mysqlResult]=await Promise.allSettled([
    Promise.resolve().then(()=>liveLoader?liveLoader():loadSnapshot()).then(remote=>{if(!Array.isArray(remote.customers)||!Number.isSafeInteger(remote.count)||remote.customers.length!==remote.count||!Number.isFinite(Date.parse(remote.observedAt)))throw new Error('Remote directory read is incomplete');return remote;}),
    Promise.resolve().then(()=>directoryReader({env:config})),
    mysqlMode?Promise.resolve().then(()=>readMysql({env:mysqlEnv,assertLocal})).then(d=>mirrorMysql(d,{env:supabaseEnv})):Promise.resolve(null)
   ]);
   const [existing,prior]=await Promise.all([loadExisting(),loadState()]);
   expectedGeneration=prior?.activeGeneration;
   const remote=remoteResult.status==='fulfilled'?remoteResult.value:null,api=apiResult.status==='fulfilled'?apiResult.value:null;
   const mysql=mysqlResult.status==='fulfilled'?mysqlResult.value:null;
   const attemptAt=api?.report.observedAt||new Date().toISOString(),priorReport=prior?.report||{};
   const apiReport=api?.report.apiRead||api?.report,nutritionReport=api?.report.nutritionRead;
   const nutritionConfigured=Boolean(config.CUSTOMER_SERVICE_NUTRITION_COOKIE||nutritionReport);
   sources={
    remoteDatabase:{state:remote?(liveLoader?'available':'snapshot'):'unavailable',observedAt:remote?.observedAt||priorReport.remoteDatabaseObservedAt||priorReport.remoteSnapshotObservedAt||null,lastAttemptAt:attemptAt,error:remote?'':'Remote database unavailable; retained records have not been refreshed.'},
    ...(nutritionConfigured?{nutritionAdmin:{state:nutritionReport?'available':'unavailable',observedAt:nutritionReport?.observedAt||priorReport.nutritionObservedAt||null,lastAttemptAt:attemptAt,error:nutritionReport?'':'Nutrition admin unavailable; previous directory retained.'}}:{}),
    api:{state:api?'available':'unavailable',observedAt:apiReport?.observedAt||priorReport.apiObservedAt||null,lastAttemptAt:attemptAt,error:api?'':'Matter API unavailable; previous observations retained.'}
   };
   if(supabaseMode){
    sources.remoteDatabase={state:'retained',observedAt:priorReport.remoteDatabaseObservedAt||priorReport.remoteSnapshotObservedAt||null};
    sources.nutritionAdmin={state:'retained',observedAt:priorReport.nutritionObservedAt||priorReport.sources?.nutritionAdmin?.observedAt||null};
    sources.supabase={state:remote?'available':'unavailable',observedAt:remote?.observedAt||priorReport.supabaseObservedAt||null,lastAttemptAt:attemptAt,historicalStoredCopy:true,upstreamLiveSyncVerified:false,error:remote?'':'Supabase stored copy unavailable; retained records have not been refreshed.'};
   }
   if(mysqlMode){sources.remoteDatabase={state:'retained',observedAt:priorReport.remoteDatabaseObservedAt||priorReport.remoteSnapshotObservedAt||null};sources.nutritionAdmin={state:'retained',observedAt:priorReport.nutritionObservedAt||priorReport.sources?.nutritionAdmin?.observedAt||null};}
   if(mysqlMode)sources.nutritionDatabase={state:mysql?'available':'unavailable',observedAt:mysql?.report.observedAt||priorReport.nutritionDatabaseObservedAt||null,lastAttemptAt:attemptAt,error:mysql?'':'Full customer source unavailable; previous observations retained.'};
   if(!api){await recordFailure(sources,expectedGeneration);return{ok:false,error:'Directory refresh failed; last good generation retained.'};}
   const partial=!remote||(mysqlMode&&!mysql);
   const currentDirectory=mysql?combineMysqlAndApiDirectories(mysql,api):api;
   let directory=remote&&!supabaseMode&&!mysqlMode?combine(remote.customers,currentDirectory,{expectedRemoteRecords:remote.count,observedAt:api.report.observedAt}):overlayApiOnRetainedDirectory(existing,prior,currentDirectory);
   if(supabaseMode){
    for(const c of directory.customers)if(c.sourceStates?.supabase)c.sourceStates.supabase={...c.sourceStates.supabase,state:'retained'};
    if(remote)directory=overlaySupabaseDirectory(directory,remote,currentDirectory);

   }
   if(mysqlMode){
    const currentIds=new Set(mysql?.customers.map(c=>c.customerId)||[]);
    for(const c of directory.customers){
     if(!currentIds.has(c.customerId)&&c.sourceStates?.nutritionDatabase)c.sourceStates.nutritionDatabase={...c.sourceStates.nutritionDatabase,state:'retained'};
     const excluded=mysql?.report.excludedSourceRecords?.find(row=>row.customerId===c.customerId);
     if(excluded){c.eligibleForAutomaticMatching=false;c.sourceStates={...c.sourceStates,nutritionDatabase:{state:excluded.reason,observedAt:mysql.report.observedAt,sourceUpdatedAt:excluded.sourceUpdatedAt||null}};}
    }
   }
   const priorPhones=new Map(existing.filter(c=>c.matterCustomerId&&c.phone).map(c=>[c.matterCustomerId,c]));let cachedPhones=0;
   const apiById=new Map(api.customers.map(c=>[c.customerId,c]));
   for(const customer of directory.customers){
    const fresh=apiById.get(customer.customerId);
    if(remote&&!supabaseMode&&!mysqlMode)customer.sourceStates={...(fresh?(fresh.sourceStates||{api:{state:'available',observedAt:apiReport.observedAt}}):{}),...(customer.deliveryProfiles?.length?{remoteDatabase:{state:liveLoader?'available':'snapshot',observedAt:remote.observedAt}}:{})};
    if(mysql?.customers.some(c=>c.customerId===customer.customerId&&c.phone))customer.phoneObservedAt=mysql.report.observedAt;else if(fresh?.phone)customer.phoneObservedAt=api.report.observedAt;
    const prior=priorPhones.get(customer.matterCustomerId);if(!customer.phone&&prior?.phone){customer.phone=prior.phone;customer.phoneObservedAt=prior.phoneObservedAt||prior.sourceObservedAt;cachedPhones++;}}
   const missing=directory.customers.filter(c=>!c.phone&&c.matterCustomerId&&c.subscriptions.length);
   if(missing.length&&detailBudget){const subset={customers:missing.slice(0,detailBudget),report:{}};const enriched=await enrich(subset,{env:config});const byId=new Map(enriched.customers.map(c=>[c.customerId,c]));directory.customers=directory.customers.map(c=>byId.get(c.customerId)||c);directory.report.phoneEnrichment=enriched.report.phoneEnrichment;}
   directory.report={...directory.report,status:partial?'partial':'ready',sources,...(remote&&!supabaseMode&&!mysqlMode?(liveLoader?{remoteDatabaseObservedAt:remote.observedAt,remoteDatabaseRead:remote.report}:{remoteSnapshotObservedAt:remote.observedAt}):{}),apiCustomers:apiReport.uniqueCustomers??api.customers.length,apiSubscriptions:apiReport.sourceSubscriptionTotal,sourceSubscriptionTotal:apiReport.sourceSubscriptionTotal,apiObservedAt:apiReport.observedAt,apiRead:apiReport,...(nutritionReport?{nutritionRead:nutritionReport,nutritionObservedAt:nutritionReport.observedAt,fullAdminCustomerDirectory:true,fullCustomerDirectory:true,nutritionCustomers:api.report.nutritionCustomers??nutritionReport.sourceCustomerTotal,coverage:'remote_customer_collection_and_nutrition_admin_and_subscription_customers'}:{}),automaticRefresh:{api:true,nutritionAdmin:Boolean(nutritionReport),remoteDatabase:Boolean(liveLoader&&remote),remoteDatabaseConfigured:Boolean(liveLoader),intervalMs},cachedPhoneObservations:cachedPhones,deferredPhoneDetails:Math.max(0,missing.length-detailBudget),customersWithPhone:directory.customers.filter(c=>c.phone).length};
   if(supabaseMode){
    directory.report={...directory.report,coverage:'supabase_stored_customer_copy_and_subscription_customers',...(remote?{supabaseObservedAt:remote.observedAt,supabaseRead:remote.report}:{}),automaticRefresh:{...directory.report.automaticRefresh,supabase:true,supabaseConfigured:true,supabaseSource:sourceSync&&apiReport.supabaseMirror?.verified===true,nutritionAdmin:false,remoteDatabase:false,remoteDatabaseConfigured:false}};
    directory.report.limitations=(directory.report.limitations||[]).filter(v=>!v.startsWith('Remote database is unavailable')&&!v.startsWith('Remote customer records and Matter subscriptions')&&!v.startsWith('Automatic refresh updates'));
    directory.report.limitations.push('Supabase is reread from a historical imported customer copy; live upstream synchronization is not verified. Saved remote and Nutrition observations retain their original dates.');
   }
   if(mysqlMode){
    directory.report={...directory.report,coverage:'nutrition_database_customers_and_subscription_customers',automaticRefresh:{...directory.report.automaticRefresh,nutritionDatabase:true,nutritionAdmin:false,remoteDatabase:false},...(mysql?{nutritionDatabaseObservedAt:mysql.report.observedAt,nutritionDatabaseRead:mysql.report,nutritionDatabaseCustomers:mysql.customers.length,fullCustomerDirectory:true}:{})};
    directory.report.limitations.push(mysql?'Full customer database and subscription API are independently observed; customers absent from this database response retain their original source evidence.':'Full customer database refresh failed; previously saved customer observations retain their original dates.');
   }
   if(nutritionReport){directory.report.limitations=directory.report.limitations.filter(v=>!v.includes('completeness of the separate Matter website'));directory.report.limitations.push(...(api.report.limitations||[]));for(const customer of directory.customers){customer.source='matter_delivery_db_nutrition_and_api';customer.sourceCoverage='remote_customer_collection_and_nutrition_admin_and_subscription_customers';}}
   if(!supabaseMode&&partial)directory.report.limitations.push('Remote database is unavailable. API observations are current; delivery profiles and API records absent from this response retain their original observations.');
   else if(!supabaseMode)directory.report.limitations.push(liveLoader?'Remote customer records and Matter subscriptions refresh automatically through separate read-only connections; their observation times differ and do not form an atomic snapshot.':(nutritionReport?'Automatic refresh updates Nutrition customers and Matter subscriptions; delivery customer records remain the explicitly dated remote snapshot.':'Automatic refresh updates Matter subscriptions only; delivery customer records remain the explicitly dated remote snapshot.'));
   directory.report.limitations.push('Previously verified phone observations are retained and may be older than either source refresh.');
   directory.report.limitations=[...new Set(directory.report.limitations)];
   const customerReport=compactCustomerSourceReport(directory.report);
   for(const customer of directory.customers)customer.sourceReport=customerReport;
   const result=await persist(directory);return{ok:true,partial,...result,report:directory.report};
  }catch{await recordFailure(sources,expectedGeneration);return{ok:false,error:'Directory refresh failed; last good generation retained.'};}
 }
 function run(){if(stopped)return Promise.resolve({ok:false,stopped:true});if(pending)return pending;pending=work().finally(()=>{pending=null;});return pending;}
 function start(){if(timer||stopped)return;const tick=async()=>{timer=null;await run();if(!stopped){timer=setTimer(tick,intervalMs);timer.unref?.();}};timer=setTimer(tick,1000);timer.unref?.();}
 async function stop(){stopped=true;if(timer)clearTimer(timer);timer=null;if(pending)await pending;}
 return{run,start,stop};
}
