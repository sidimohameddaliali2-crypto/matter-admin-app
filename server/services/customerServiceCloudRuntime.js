import {createCloudCacheReader,workflowKinds} from './customerServiceCloudCache.js';
import {createCloudStore,createCloudPublisher,configureCloudInbox,cloudKinds} from './customerServiceCloudStore.js';
import {createCloudInboxReader} from './customerServiceCloudInbox.js';
// Explicit opt-in only. The unrelated driver/reporting runtime is untouched.
export async function startCustomerServiceCloud({env,db,onError=()=>{}}){
 if(env.CUSTOMER_SERVICE_STORAGE!=='supabase')return null;
 const store=createCloudStore({env}),head=await store.head();
 if(!head)throw Error('Complete and verify the Gallabox cloud migration before enabling cloud reads');
 if(head.origin!==db.databaseName)throw Error('Cloud origin does not match the configured worker cache');
 for(const kind of cloudKinds)await db.collection(kind).createIndex({updatedAt:1,_id:1},{name:'cloud_sync_updated_at'});
 const control=await store.query("SELECT row_to_json(c) FROM gallabox_private.worker_control c WHERE singleton;").catch(()=>null);
 const hosted=control?.writer_mode==='cloud';
 const workflow=control?.workflow_mode==='cloud';
 const publisher=createCloudPublisher({db,store,origin:head.origin,onError,...(hosted?{kinds:workflow?workflowKinds.filter(k=>['servicecustomers','servicecustomerdirectorystates'].includes(k)):workflowKinds,concurrent:true,checkpointKey:'local-staff-workflow'}:{})});
 const cache=hosted&&!workflow?createCloudCacheReader({db,store,startRevision:0}):null;
 const refresh=()=>cache?.refresh();
 const cacheTimer=cache?setInterval(()=>refresh().catch(onError),5000):null;cacheTimer?.unref();
 // The verified published head is immediately readable; catch-up runs in the
 // background so a restart does not hold the staff shell behind bookkeeping.
 configureCloudInbox({store,publisher,reader:createCloudInboxReader(store),hosted,workflow,refresh});publisher.start();
 return {store,publisher,hosted,async stop(){if(cacheTimer)clearInterval(cacheTimer);try{await publisher.stop();}finally{configureCloudInbox(null);await store.close();}}};
}
