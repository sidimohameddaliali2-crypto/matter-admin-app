import {createDriverAuditAuth} from './driverAuditAuth.js';
import {createDriverAuditReplica} from './driverAuditReplica.js';
import {readDriverAuditSyncStatus} from './driverAuditSyncStatus.js';
import {createHostedRpc} from '../vendor/driver-audits/integration/cloud/rpc.mjs';
import {createCloudState} from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import {createSupabaseArchiveTransport} from '../vendor/driver-audits/integration/hosted/supabase-archive.mjs';
import {createImportedAuditRuntime} from '../vendor/driver-audits/integration/cloud/preview-runtime.mjs';
import {createAutomaticHostedPreview} from '../vendor/driver-audits/integration/cloud/automatic-hosted-preview.mjs';
import {loadRemotePreviewPackage} from '../vendor/driver-audits/integration/cloud/remote-preview-package.mjs';
import {importAuditReplica} from '../vendor/driver-audits/integration/cloud/audit-replica.mjs';
import {AUTOMATIC_PREVIEW_HEAD} from '../vendor/driver-audits/integration/cloud/automatic-preview-publication.mjs';
import {createReaderBudgetPool} from '../vendor/driver-audits/integration/cloud/reader-budget-pool.mjs';
import {runWithWorkerBudget} from '../vendor/driver-audits/integration/cloud/worker-budget.mjs';
import {readerTransferMicros,MAX_READER_BODY_BYTES,MAX_READER_REQUEST_BYTES} from '../vendor/driver-audits/integration/cloud/reader-budget.mjs';

const reportApi='/api/reporting';
const auditView=reportApi+'/view';
const evidenceAlias=/^\/api\/reporting(\/report-data\/(?:detail|history|query|archive|snapshot)-[a-f0-9]{64}\.json|\/report-assets\/font-[a-f0-9]{64}\.(?:woff2?|ttf|otf))$/;

export const auditRoute=pathname=>pathname==='/driver-audit-view'||pathname==='/api/driver-audits/session'||pathname==='/api/session'||pathname==='/api/session/refresh'||pathname.startsWith('/api/reporting/')||pathname.startsWith('/report-data/')||pathname.startsWith('/report-assets/');
// Disabled by default. No new source collector, model worker, timer, migration,
// or operational database write is started by mounting this middleware.
export function createDriverAuditIntegration({db,authenticateStaffToken,env=process.env,dependencies={}}){
 const clock=dependencies.clock||Date.now;let pending;
 async function initialize(){
  const origin=env.DRIVER_AUDIT_ORIGIN,url=new URL(origin);if(url.origin!==origin||!(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw Error('Explicit audit origin required');
  const auth=dependencies.auth||createDriverAuditAuth({authenticateStaffToken,secret:env.JWT_SECRET,origin});
  const state=dependencies.state||createCloudState({rpc:createHostedRpc({secret:env.DRIVER_AUDIT_SUPABASE_SECRET})});
  const archive=dependencies.archive||createSupabaseArchiveTransport({secret:env.DRIVER_AUDIT_SUPABASE_SECRET});
  const store=dependencies.store||createDriverAuditReplica(db(),{capacityBytes:Number(env.DRIVER_AUDIT_CAPACITY_BYTES)});
  let budget=dependencies.budget;
  async function budgetedImport(){
   budget??=createReaderBudgetPool({stateStore:state});
   const usage={responseBytes:0,requestBytes:0},chargeRequest=()=>{usage.requestBytes+=2048+2*Buffer.byteLength(env.DRIVER_AUDIT_SUPABASE_SECRET||'');if(usage.requestBytes>MAX_READER_REQUEST_BYTES)throw Error('Audit request allowance exceeded');},chargeBytes=n=>{usage.responseBytes+=n;if(usage.responseBytes>MAX_READER_BODY_BYTES)throw Error('Audit transfer allowance exceeded');};
   const counted={readObject:async(key,options)=>{chargeRequest();const body=await archive.readObject(key,options);return (async function*(){for await(const chunk of body){chargeBytes(chunk.length);yield chunk;}})();}};
   return runWithWorkerBudget({reserve:()=>budget.reserve({responseBytes:MAX_READER_BODY_BYTES}),settle:(reservation,value)=>budget.settle(reservation,{...value,extraMicros:readerTransferMicros(usage)})},()=>importAuditReplica({loadSource:async()=>{chargeRequest();const value=await state.read(AUTOMATIC_PREVIEW_HEAD);chargeBytes(Buffer.byteLength(JSON.stringify(value)));return value;},sourceTransport:counted,store}));
  }
  let importStatus='not-requested',attempt=null,flight;
  const refresh=()=>{
   if(env.DRIVER_AUDIT_IMPORT_ENABLED!=='1'||attempt!==null&&clock()-attempt<60000)return flight;
   if(flight)return flight;attempt=clock();importStatus='checking';
   flight=budgetedImport().then(r=>{importStatus=r.status;}).catch(()=>{importStatus='failed';}).finally(()=>{flight=null;});return flight;
  };
  const createCoordinator=dependencies.createCoordinator||createAutomaticHostedPreview;
  const coordinator=createCoordinator({clock,refreshOnRequest:false,restorePrevious:true,loadPointer:async()=>await store.head(),async loadPackage({descriptor,pointer}){
   const directSnapshot=pointer?.directImport?.version===1;
   const restore=pointer?.restore;
   const recoverable=directSnapshot&&restore?.verified===true&&restore.archive==='matter-report-archive'&&
    restore.descriptorSha256===descriptor.sha256&&restore.generation===pointer.generation&&restore.reportHash===pointer.reportHash;
   const transport={async readObject(key,options){
    try{return await store.readObject(key,options);}
    catch(error){if(!recoverable||error.code!=='AUDIT_OBJECT_MISSING')throw error;return archive.readObject(key,options);}
   }};
   return {...await loadRemotePreviewPackage({descriptor,transport}),directSnapshot};
  },createRuntime:({packageOverride,automaticFeed})=>createImportedAuditRuntime({origin,publicPathPrefix:reportApi,packageOverride,automaticFeed,
   auditImportStatus:health,auditSyncStatus:packageOverride.directSnapshot?()=>readDriverAuditSyncStatus(db(),packageOverride.generation,clock):undefined,
   authOverride:auth,stateOverride:state,transportOverride:archive,secret:env.DRIVER_AUDIT_SUPABASE_SECRET||'local-fixture',publishableKey:'staff-session',cookieKey:Buffer.alloc(32),allowedEmail:'staff@invalid.example',...(dependencies.runtimeOptions||{})}),fallback:async(_req,res)=>{res.writeHead(503,{'Cache-Control':'no-store','Content-Type':'text/plain'});res.end('Driver audits are not imported yet. Existing delivery reports remain available.');}});
  function health(){const runtime=coordinator.status();return {status:runtime.status==='stale'?'failed':runtime.status==='refreshing'?'checking':env.DRIVER_AUDIT_IMPORT_ENABLED!=='1'?'disabled':importStatus,checkedAt:attempt===null?null:new Date(attempt).toISOString(),servingGeneration:runtime.active?.generation||null};}
  return {origin,auth,coordinator,refresh,getImportStatus:()=>health().status};
 }
 return async(req,res,next)=>{
  const url=new URL(req.url,'http://audit.invalid'),path=url.pathname;if(!auditRoute(path))return next();
  if(env.DRIVER_AUDIT_ENABLED!=='1'){res.writeHead(503,{'Cache-Control':'no-store'});res.end('Driver audits are not enabled.');return;}
  try{
   if(!pending)pending=initialize().catch(e=>{pending=null;throw e;});const context=await pending;
   if(req.headers.host!==new URL(context.origin).host||req.headers.origin&&req.headers.origin!==context.origin)throw Object.assign(Error('Invalid origin'),{status:403});
   if(path==='/api/driver-audits/session'){
    if(req.method==='DELETE'&&req.headers.origin===context.origin){req.resume();res.writeHead(204,{'Cache-Control':'no-store','Set-Cookie':context.auth.clearCookie});res.end();return;}
    if(req.method!=='POST'||req.headers.origin!==context.origin||!/^application\/json(?:;|$)/.test(req.headers['content-type']||''))throw Object.assign(Error('Invalid session request'),{status:403});
    if(req.headers['x-driver-audit-client']!=='reporting-v1'){
     req.resume();res.writeHead(428,{'Cache-Control':'no-store','Content-Type':'text/plain'});res.end('Reload the app to open driver audits.');return;
    }
    const session=await context.auth.issue(req.headers.authorization);req.resume();res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':session.cookie});res.end(JSON.stringify({url:auditView+'?screen=reports&view=1&tab=mirror'}));return;
   }
   await context.auth.authenticate(req.headers.cookie);
   // The existing audit client probes its session before enabling review/maps.
   // Staff identity stays with this app; never invoke the Supabase login flow.
   if(path==='/api/session/refresh'){
    if(req.method!=='POST'||req.headers.origin!==context.origin||!/^application\/json(?:;|$)/.test(req.headers['content-type']||''))throw Object.assign(Error('Invalid session refresh'),{status:403});
    req.resume();res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"connected":true}');return;
   }
   if(path==='/api/session'){
    if(!['GET','HEAD'].includes(req.method))throw Object.assign(Error('Staff sign-in required'),{status:403});
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:'{"connected":true}');return;
   }
   const isDocument=path===auditView||path==='/driver-audit-view';
   const update=async()=>{await context.refresh();await context.coordinator.poll();};
   if(!context.coordinator.status().active)await update();
   else if(req.method==='GET'&&(isDocument||path==='/api/reporting/status'))void update().catch(()=>{});
   // Existing generations stay available while imports are in flight. In
   // particular, saving a review must never join a slow source transfer.
   res.setHeader('X-Audit-Import-Status',context.getImportStatus());
   const canonicalPath=isDocument?'/':evidenceAlias.exec(path)?.[1];
   if(canonicalPath)req.url=canonicalPath+url.search;
   return await context.coordinator(req,res);
  }catch(error){if(res.headersSent){res.destroy();return;}const code=[401,403,409].includes(error.status)?error.status:503;res.writeHead(code,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end(code===401?'Sign in to the delivery app again.':'Driver audits are temporarily unavailable. Existing reports and saved findings are retained.');}
 };
}
