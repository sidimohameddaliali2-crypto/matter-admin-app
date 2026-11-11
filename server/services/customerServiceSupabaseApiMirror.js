import{createHash}from'node:crypto';
import{executeSupabaseDirectorySql}from'./customerServiceSupabaseDirectory.js';
const digest=text=>createHash('sha256').update(text).digest('hex');
function validate(directory){
 const r=directory?.report,customers=directory?.customers;
 if(r?.source!=='matter_api_subscriptions'||r.sourcePagesExhausted!==true||r.detailsFailed!==0||!Number.isFinite(Date.parse(r.observedAt))||!Array.isArray(customers)||customers.length>10000||r.uniqueCustomers!==customers.length||!Number.isSafeInteger(r.sourceSubscriptionTotal)||r.sourceSubscriptionTotal<0)throw Error();
 const ids=new Set();for(const c of customers){if(typeof c.customerId!=='string'||!/^matter:\d+$/.test(c.customerId)||c.customerId!==`matter:${c.matterCustomerId}`||ids.has(c.customerId)||!Array.isArray(c.subscriptions))throw Error();ids.add(c.customerId);}
 const subscriptions=customers.flatMap(c=>c.subscriptions);if(subscriptions.length!==r.sourceSubscriptionTotal||new Set(subscriptions.map(s=>s.id)).size!==subscriptions.length||subscriptions.some(s=>typeof s.id!=='string'||!s.id)||r.detailsRead!==r.sourceSubscriptionTotal)throw Error();
 return directory;
}
// A completed upstream read is committed before the local app receives the data.
// The historical source_private import is never modified by this writer.
async function mirrorDirectory(directory,{env,transport=executeSupabaseDirectorySql}={},source,coverage,validator){
 try{
  validator(directory);const payload=JSON.stringify(directory);if(Buffer.byteLength(payload)>8*1024*1024)throw Error();const generation=digest(payload),hex=Buffer.from(payload).toString('hex'),observedAt=new Date(directory.report.observedAt).toISOString();
  const sql=`BEGIN;
SELECT pg_advisory_xact_lock(hashtext('customer_service_${source}'));
INSERT INTO customer_service_private.live_source(source,generation,observed_at,customer_count,payload)
VALUES('${source}','${generation}','${observedAt}',${directory.customers.length},convert_from(decode('${hex}','hex'),'UTF8'))
ON CONFLICT(source) DO UPDATE SET generation=excluded.generation,observed_at=excluded.observed_at,persisted_at=now(),customer_count=excluded.customer_count,payload=excluded.payload
WHERE live_source.observed_at < excluded.observed_at OR (live_source.observed_at = excluded.observed_at AND live_source.generation = excluded.generation);
COMMIT;`;
  await transport({env,sql,readOnly:false,maxBytes:1024,timeoutMs:30000});
  const output=await transport({env,sql:`SELECT jsonb_build_object('generation',generation,'payload',payload) FROM customer_service_private.live_source WHERE source='${source}';`,readOnly:true,maxBytes:16*1024*1024,timeoutMs:30000});
  const stored=JSON.parse(output);if(stored.generation!==generation||typeof stored.payload!=='string'||digest(stored.payload)!==generation)throw Error();const result=validator(JSON.parse(stored.payload));
  return{...result,report:{...result.report,supabaseMirror:{verified:true,generation,sourceObservedAt:observedAt,coverage}}};
 }catch{throw new Error('Source-to-Supabase verification failed; previous local generation retained.');}
}

export const mirrorMatterApiDirectory=(directory,options)=>mirrorDirectory(directory,options,'matter_api_subscriptions','subscription_customers_only',validate);
function validateMysql(directory){
 const r=directory?.report,cs=directory?.customers;
 if(r?.source!=='nutrition_mysql_customers'||!Number.isFinite(Date.parse(r.observedAt))||r.fullCustomerDirectory!==true||r.atomicSnapshot!==true||r.reconciled!==true||r.sourcePagesExhausted!==true||!Array.isArray(cs)||cs.length>10000||r.sourceCustomerTotal!==cs.length||r.uniqueCustomers!==cs.length||r.countBefore!==r.countAfter||r.sourceRecordTotal!==r.countBefore||r.sourceRecordTotal!==cs.length+r.excludedCount)throw Error();
 const ids=new Set();for(const c of cs){if(!/^matter:\d+$/.test(c.customerId)||c.customerId!==`matter:${c.matterCustomerId}`||ids.has(c.customerId)||c.eligibleForAutomaticMatching!==true)throw Error();ids.add(c.customerId);}
 if(!Array.isArray(r.excludedSourceRecords)||r.excludedSourceRecords.length!==r.excludedCount)throw Error();
 for(const c of r.excludedSourceRecords){if(!/^matter:\d+$/.test(c.customerId)||c.customerId!==`matter:${c.matterCustomerId}`||ids.has(c.customerId)||!['deleted','anonymized'].includes(c.reason))throw Error();ids.add(c.customerId);}
 return directory;
}
export const mirrorNutritionMysqlDirectory=(directory,options)=>mirrorDirectory(directory,options,'nutrition_mysql_customers','all_non_deleted_non_anonymized_users',validateMysql);
