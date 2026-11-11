import mongoose from 'mongoose';
const HOST='read-only-production-do-user-27569392-0.m.db.ondigitalocean.com';
const PROJECTION='id,name,first_name,last_name,telephone,whatsapp_number,email,deleted_at,anonymized_at,created_at,updated_at';
const assertLocalPreview=()=>{if(!/^matter_service_test_[a-f0-9]{32}$/.test(mongoose.connection.name||'')||!['127.0.0.1','localhost','::1'].includes(mongoose.connection.host))throw Error();};
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
function sourceDate(v){if(v==null)return null;if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(v))throw Error();const d=new Date(v.replace(' ','T')+'Z');if(!Number.isFinite(+d))throw Error();return d.toISOString();}
// Local preview only. The owner explicitly approved this source's existing
// REQUIRED encryption-only mode; this is not certificate-verified transport.
export async function readMysqlCustomerDirectory({env=process.env,assertLocal=assertLocalPreview,clientFactory=async options=>(await import('mysql2/promise')).createConnection(options),clock=()=>new Date(),pageSize=1000,maxRecords=10000,maxIdentityRecords=25000,maxBytes=16*1024*1024,timeoutMs=30000}={}){
 let connection,timer,expired=false,transaction=false;
 try{
  await assertLocal();
  if(env.CUSTOMER_SERVICE_MYSQL_REQUIRED_MODE_APPROVED!=='true'||env.MATTER_V2_DB_READ_ENABLED!=='true'||env.MATTER_V2_DB_SSLMODE!=='REQUIRED'||env.MATTER_V2_DB_HOST!==HOST)throw Error();
  const port=Number(env.MATTER_V2_DB_PORT);
  if(!Number.isInteger(port)||port<1||port>65535||!env.MATTER_V2_DB_USERNAME||!env.MATTER_V2_DB_PASSWORD||!env.MATTER_V2_DB_DATABASE)throw Error();
  for(const [value,limit]of [[pageSize,1000],[maxRecords,10000],[maxIdentityRecords,25000],[maxBytes,16*1024*1024],[timeoutMs,60000]])if(!Number.isSafeInteger(value)||value<1||value>limit)throw Error();
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;connection?.destroy();reject(Error());},timeoutMs);});
  const bounded=p=>Promise.race([p,deadline]);
  const pending=Promise.resolve().then(()=>clientFactory({host:HOST,port,user:env.MATTER_V2_DB_USERNAME,password:env.MATTER_V2_DB_PASSWORD,database:env.MATTER_V2_DB_DATABASE,ssl:{rejectUnauthorized:false,verifyIdentity:false},connectTimeout:Math.min(timeoutMs,10000),multipleStatements:false,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true}));
  pending.then(c=>{if(expired)c.destroy();},()=>{});connection=await bounded(pending);
  if(connection?.connection?.stream?.encrypted!==true)throw Error();
  const query=async(sql,values)=>{if(expired)throw Error();const [rows]=await bounded(connection.query(values===undefined?sql:{sql,values,timeout:Math.min(timeoutMs,10000)}));return rows;};
  await query("SET SESSION time_zone = '+00:00'");
  await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');transaction=true;
  let bytes=0,pagesRead=0;
  const readTable=async(table,projection,recordLimit=maxRecords)=>{
  const readCount=async()=>{const rows=await query(`SELECT COUNT(*) AS count FROM ${table}`,[]);if(rows.length!==1)throw Error();const n=Number(rows[0].count);if(!Number.isSafeInteger(n)||n<0||n>recordLimit)throw Error();return n;};
  const count=await readCount(),raw=[],ids=new Set();let last='0';
  while(raw.length<count){
   const rows=await query(`SELECT ${projection} FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`,[last,Math.min(pageSize,count-raw.length)]);
   if(!Array.isArray(rows)||!rows.length||rows.length>Math.min(pageSize,count-raw.length))throw Error();
   bytes+=Buffer.byteLength(JSON.stringify(rows));if(bytes>maxBytes)throw Error();
   for(const row of rows){const id=String(row.id);if(!/^[1-9]\d{0,19}$/.test(id)||BigInt(id)<=BigInt(last)||ids.has(id))throw Error();ids.add(id);last=id;raw.push(row);}pagesRead++;
  }
  if(await readCount()!==count||raw.length!==count)throw Error();
  return{raw,count,ids};};
  const {raw,count,ids}=await readTable('users',PROJECTION);
  const subscriptions=await readTable('subscription','id,user_id,telephone,whatsapp_number,created_at,updated_at',maxIdentityRecords);
  const imports=await readTable('offline_customer_imports','id,name,phone,email,created_user_id,created_subscription_id,processed_at,created_at,updated_at',maxIdentityRecords);
  await query('ROLLBACK');transaction=false;
  const observedAt=new Date(clock()).toISOString(),customers=[],excludedSourceRecords=[];
  for(const row of raw){
   const matterCustomerId=String(row.id),deletedAt=sourceDate(row.deleted_at),anonymizedAt=sourceDate(row.anonymized_at),sourceUpdatedAt=sourceDate(row.updated_at),sourceCreatedAt=sourceDate(row.created_at);
   if(deletedAt||anonymizedAt){excludedSourceRecords.push({customerId:`matter:${matterCustomerId}`,matterCustomerId,deletedAt,anonymizedAt,sourceUpdatedAt,reason:anonymizedAt?'anonymized':'deleted'});continue;}
   const profile={name:text(row.name,200)||[text(row.first_name,100),text(row.last_name,100)].filter(Boolean).join(' '),email:text(row.email,320),phone:text(row.telephone,80)||text(row.whatsapp_number,80)};
   const phones=[...new Set([text(row.telephone,80),text(row.whatsapp_number,80)].filter(Boolean))];
   customers.push({customerId:`matter:${matterCustomerId}`,matterCustomerId,...profile,telephone:text(row.telephone,80),whatsappNumber:text(row.whatsapp_number,80),profileObservations:phones.length?phones.map(phone=>({...profile,phone})):[profile],subscriptions:[],identityNeedsReview:phones.length>1,eligibleForAutomaticMatching:true,accountStatus:'not_deleted_or_anonymized',source:'nutrition_mysql_customers',sourceCoverage:'all_non_deleted_non_anonymized_users',sourceObservedAt:observedAt,sourceUpdatedAt,sourceCreatedAt,sourceStates:{nutritionDatabase:{state:'available',observedAt,sourceUpdatedAt,eligibleForAutomaticMatching:true}}});
  }
  const byId=new Map(customers.map(c=>[c.matterCustomerId,c])),subscriptionCustomerLinks=[],subscriptionOwners=new Map();
  const parentId=value=>{const id=String(value??'');if(!/^[1-9]\d{0,19}$/.test(id))return null;return id;};
  const exactPhone=raw=>/^[1-9]\d{7,14}\.0+$/.test(raw)&&Number.isSafeInteger(Number(raw))?raw.replace(/\.0+$/,''):raw;
  const evidence=(row,source)=>({source,sourceRecordId:String(row.id),sourceObservedAt:observedAt,sourceUpdatedAt:sourceDate(row.updated_at),sourceCreatedAt:sourceDate(row.created_at),eligibleForAutomaticMatching:true});
  let orphanSubscriptions=0,orphanImports=0,conflictingImports=0;
  for(const row of subscriptions.raw){const id=parentId(row.user_id),customer=byId.get(id);subscriptionOwners.set(String(row.id),id);if(!customer){orphanSubscriptions++;continue;}subscriptionCustomerLinks.push({subscriptionId:String(row.id),matterCustomerId:id});for(const phone of [...new Set([text(row.telephone,80),text(row.whatsapp_number,80)].filter(Boolean))])customer.profileObservations.push({name:customer.name,email:'',phone:exactPhone(phone),rawPhone:phone,...evidence(row,'nutrition_mysql_subscription'),sourceSubscriptionId:String(row.id)});}
  for(const row of imports.raw){const id=parentId(row.created_user_id),customer=byId.get(id);if(!customer){orphanImports++;continue;}const subId=parentId(row.created_subscription_id);if(subId&&subscriptionOwners.get(subId)!==id){conflictingImports++;continue;}const rawPhone=text(row.phone,80);const phone=exactPhone(rawPhone);const email=text(row.email,320);if(phone||email)customer.profileObservations.push({name:text(row.name,200),email,phone,rawPhone,...evidence(row,'nutrition_mysql_offline_import'),sourceSubscriptionId:subId,sourceProcessedAt:sourceDate(row.processed_at)});}
  const report={subscriptionCustomerLinks,identitySourceCounts:{subscriptions:subscriptions.count,offlineImports:imports.count,orphanSubscriptions,orphanImports,conflictingImports},source:'nutrition_mysql_customers',observedAt,sourceRecordTotal:count,sourceCustomerTotal:customers.length,uniqueCustomers:customers.length,uniqueSourceRecords:ids.size,excludedSourceRecords,excludedCount:excludedSourceRecords.length,pagesRead,sourcePagesExhausted:true,fullCustomerDirectory:true,fullAdminCustomerDirectory:true,reconciled:true,atomicSnapshot:true,countBefore:count,countAfter:count,readOnly:true,encrypted:true,certificateVerified:false,tlsMode:'REQUIRED',coverage:'all_non_deleted_non_anonymized_users',limitations:['The owner-approved REQUIRED mode encrypts traffic without verifying the server certificate.','All users were counted in one read-only consistent snapshot; deleted and anonymized users are excluded from automatic identity matching.']};
  return{customers,report};
 }catch{throw new Error('Nutrition database customer read failed; previous local directory must be retained.');}
 finally{clearTimeout(timer);if(connection){if(transaction&&!expired)try{await connection.query({sql:'ROLLBACK',timeout:1000});}catch{}try{connection.destroy();}catch{}}}
}
