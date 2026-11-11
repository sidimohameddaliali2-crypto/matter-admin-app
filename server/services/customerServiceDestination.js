import {createCloudStore,configureCloudInbox,cloudInbox} from './customerServiceCloudStore.js';
import {createCloudInboxReader} from './customerServiceCloudInbox.js';
import {createExistingAppStaffAuth} from './customerServiceStaffAuth.js';
import {resolveStaffLogin} from './customerServiceStaffDirectory.js';
import {issueKeyMigrationReady} from './customerServiceIssueMigration.js';

// Shared by the destination entrypoint and isolated local preview. This is a
// consumer of the existing cloud writers, not another capture/cache publisher.
// It never installs login routes, changes users/memberships, or runs migrations.
export async function startCustomerServiceDestination({app,env=process.env,store:providedStore,authenticate}){
 if(env.CUSTOMER_SERVICE_STORAGE!=='supabase')return null;
 const store=providedStore||createCloudStore({env});
 try{
  const head=await store.head();
  if(!head?.origin)throw Error('A verified canonical customer-service archive is required.');
  const control=await store.query('SELECT row_to_json(c) FROM gallabox_private.worker_control c WHERE singleton;');
  if(control?.writer_mode!=='cloud'||control?.workflow_mode!=='cloud')throw Error('Canonical capture and workflow writers must both be cloud-owned.');
  const ready=await issueKeyMigrationReady(store);
  if(!ready)throw Error('The reviewed issue-key migration must be verified before enabling the destination workflow.');
  const runtime={store,hosted:true,workflow:true,reader:createCloudInboxReader(store)};
  const auth=createExistingAppStaffAuth({resolve:resolveStaffLogin,authenticate});
  configureCloudInbox(runtime);app.set('customerServiceAuth',auth);
  return {...runtime,auth,async stop(){
   if(app.get('customerServiceAuth')===auth)app.set('customerServiceAuth',null);
   if(cloudInbox()===runtime)configureCloudInbox(null);
   if(!providedStore)await store.close();
  }};
 }catch(error){if(!providedStore)await store.close().catch(()=>{});throw error;}
}

// The destination also serves unrelated operational screens. A customer-service
// connection/configuration failure must close only these routes, not hold the
// entire app's startup or fall back to writing an old Mongo workflow.
export function installCustomerServiceDestination({app,env=process.env,start=startCustomerServiceDestination,onError=()=>{},...options}){
 if(env.CUSTOMER_SERVICE_STORAGE!=='supabase')return null;
 let available=false;
 app.use(['/api/customer-service','/api/customer-service-capture'],(req,res,next)=>available?next():res.status(503).set('Cache-Control','no-store').json({success:false,message:'Customer service is unavailable while its connection is being verified. Saved work is retained.'}));
 const ready=Promise.resolve().then(()=>start({app,env,...options})).then(runtime=>{
  if(!runtime)throw Error('Canonical customer-service runtime was not initialized.');
  available=true;return runtime;
 }).catch(error=>{try{onError(error);}catch{}return null;});
 // Cloud ownership is explicit even when startup fails: never start superseded
 // local collectors against a second source/workflow store.
 return {hosted:true,ready};
}
