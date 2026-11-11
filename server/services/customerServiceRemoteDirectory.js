import mongoose from 'mongoose';
const projection=Object.fromEntries(['_id','customerId','firstName','lastName','email','phone','matterCustomerId','matterSubscriptionId','planStartDate','cycleDuration','updatedAt'].map(k=>[k,1]));
// This client is independent of the application's Mongoose connection. Only
// countDocuments and projected find queries are issued to the remote database.
export async function readRemoteCustomerDirectory({env=process.env,pageSize=250,maxPages=1000,maxRecords=100000,
 clientFactory=(uri,options)=>new mongoose.mongo.MongoClient(uri,options),clock=()=>new Date()}={}){
 const uri=env.CUSTOMER_SERVICE_REMOTE_MONGODB_URI,database=env.CUSTOMER_SERVICE_REMOTE_MONGODB_DATABASE;
 if(typeof uri!=='string'||!/^mongodb(?:\+srv)?:\/\//.test(uri)||typeof database!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(database))throw new Error('Explicit remote database read configuration is required');
 const params=new URLSearchParams(uri.split('?')[1]||'');
 for(const [key,value]of params){const k=key.toLowerCase(),v=value.toLowerCase();if((['tls','ssl'].includes(k)&&v!=='true')||(['tlsinsecure','tlsallowinvalidcertificates','tlsallowinvalidhostnames'].includes(k)&&v!=='false'))throw new Error('Remote database requires verified TLS');}
 if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000||!Number.isInteger(maxPages)||maxPages<1||maxPages>1000||!Number.isInteger(maxRecords)||maxRecords<1||maxRecords>100000)throw new Error('Invalid remote read budget');
 let client;
 try{
  client=clientFactory(uri,{tls:true,tlsAllowInvalidCertificates:false,tlsAllowInvalidHostnames:false,readPreference:'primary',retryWrites:false,maxPoolSize:1,serverSelectionTimeoutMS:10000,connectTimeoutMS:10000,socketTimeoutMS:15000});
  await client.connect();const collection=client.db(database).collection('customers');
  const count=await collection.countDocuments({},{maxTimeMS:10000});
  if(!Number.isSafeInteger(count)||count<0||count>maxRecords||Math.ceil(count/pageSize)>maxPages)throw new Error('Remote collection exceeds read budget');
  const customers=[],recordIds=new Set(),customerIds=new Set();let lastId,bytes=0,pagesRead=0;
  while(customers.length<count){
   if(pagesRead>=maxPages)throw new Error('Remote page budget exhausted');
   const rows=await collection.find(lastId===undefined?{}:{_id:{$gt:lastId}},{projection,maxTimeMS:10000}).sort({_id:1}).limit(Math.min(pageSize,count-customers.length)).toArray();
   if(!rows.length||rows.length>pageSize)throw new Error('Remote page truncated');
   bytes+=Buffer.byteLength(JSON.stringify(rows));if(bytes>64*1024*1024)throw new Error('Remote read exceeds memory budget');
   for(const row of rows){
    const sourceRecordId=row._id?.toString(),customerId=String(row.customerId??'');
    if(!sourceRecordId||sourceRecordId==='[object Object]'||!customerId||customerId.length>140||recordIds.has(sourceRecordId)||customerIds.has(customerId))throw new Error('Remote identity reconciliation failed');
    recordIds.add(sourceRecordId);customerIds.add(customerId);const {_id,...fields}=row;customers.push({...fields,sourceRecordId});
   }
   lastId=rows.at(-1)._id;pagesRead++;
  }
  if(await collection.countDocuments({},{maxTimeMS:10000})!==count||customers.length!==count)throw new Error('Remote totals changed during read');
  const observedAt=new Date(clock()).toISOString();
  return{customers,count,observedAt,report:{source:'remote_customer_collection',observedAt,pagesRead,countBefore:count,countAfter:count,uniqueSourceRecords:recordIds.size,uniqueCustomerIds:customerIds.size,reconciled:true,atomicSnapshot:false,limitations:['Count and unique identities reconcile; concurrent updates are not an atomic database snapshot.']}};
 }catch{throw new Error('Remote customer directory read failed; previous local directory must be retained.');}
 finally{if(client)try{await client.close();}catch{/* No credential-bearing driver errors are exposed. */}}
}
