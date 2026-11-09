// Explicit local-cache migration/recovery only; never falls back to MONGODB_URI.
import mongoose from 'mongoose';
import {createCloudStore,createCloudPublisher,restoreCloudCache,cloudKinds,decodeCloudRecord,encodeCloudRecord} from '../services/customerServiceCloudStore.js';
const {CUSTOMER_SERVICE_CACHE_MONGODB_URI:uri,CUSTOMER_SERVICE_CACHE_DB:dbName}=process.env;
if(!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri||'')||!/^matter_service_[a-z0-9_]+$/.test(dbName||''))throw Error('Explicit loopback cache URI and database are required');
const mode=process.argv[2];if(!['migrate','verify','restore'].includes(mode))throw Error('Choose migrate, verify or restore');
await mongoose.connect(uri,{dbName});const db=mongoose.connection.db,store=createCloudStore({env:process.env});
try{
 if(mode==='migrate'){console.log(JSON.stringify(await createCloudPublisher({db,store,origin:dbName}).flush({full:true})));}
 if(mode==='restore')console.log(JSON.stringify(await restoreCloudCache({db,store})));
 if(mode==='verify'){let count=0,mismatches=0;for(const kind of cloudKinds){const local=new Map();for await(const doc of db.collection(kind).find())local.set(String(doc._id),encodeCloudRecord(kind,doc).sha256);let after='';while(true){const rows=await store.archivePage(kind,after);if(!rows.length)break;for(const row of rows){decodeCloudRecord(row);count++;if(local.get(row.id)!==row.sha256)mismatches++;local.delete(row.id);}after=rows.at(-1).id;}mismatches+=local.size;}console.log(JSON.stringify({count,mismatches}));if(mismatches)process.exitCode=1;}
}finally{await mongoose.disconnect();}
