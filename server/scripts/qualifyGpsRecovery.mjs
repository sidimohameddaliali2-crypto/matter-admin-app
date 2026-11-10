// Explicit, synthetic qualification only. Never loads application environment or startup.
// Supply an absolute path to a separately installed mongodb-memory-server/index.js.
import { pathToFileURL } from 'node:url';
import { isAbsolute, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const toolingPath = process.argv[2];
if (!toolingPath || !isAbsolute(toolingPath)) throw new Error('Supply an absolute mongodb-memory-server/index.js path');
const { MongoMemoryReplSet } = await import(pathToFileURL(toolingPath).href);
import mongoose from 'mongoose';
import assert from 'node:assert/strict';
import Batch from '../models/VehicleLocationCaptureBatch.js';
import History from '../models/VehicleLocationHistory.js';
import Receipt from '../models/TruckoomGpsReceipt.js';
import { createVehicleLocationCaptureStore, captureObservationId } from '../services/vehicleLocationCaptureStore.js';
import { createGpsEvidenceStore, decodeGpsReceipt } from '../services/truckoomGpsEvidence.js';
import { writeFile, readFile, mkdtemp, rm, realpath } from 'node:fs/promises';
const scratchBase=await realpath(tmpdir());
const scratch=await mkdtemp(join(scratchBase,'gps-synthetic-qualification-'));
const backupFile=join(scratch,'synthetic-backup.bson');
let rs;
let time=+new Date('2026-01-01T00:00:00Z'); let owner=0;
const opts={batches:Batch,history:History,clock:()=>new Date(time),ownerId:()=>`worker-${++owner}`,leaseMs:1000,chunkSize:2};
const store=()=>createVehicleLocationCaptureStore(opts);
const input={rows:[0,1,2].map(i=>({vehicleNo:`SYNTHETIC-${i}`,latitude:25,longitude:55,recordedAt:new Date(time),gpsTime:null,driver:null})),summary:{fleetRows:3},sourceReferences:[]};
const evidence=[];
try {
 rs=await MongoMemoryReplSet.create({replSet:{count:1,ip:'127.0.0.1',storageEngine:'wiredTiger'}});
 const uri=rs.getUri('qualification');
 assert.match(uri,/^mongodb:\/\/127\.0\.0\.1:\d+\/qualification\?/); // newly spawned loopback-only database
 await mongoose.connect(uri,{autoIndex:true}); await Promise.all([Batch.init(),History.init(),Receipt.init()]);
 const [a,b]=await Promise.all([store().claimTick(new Date(time)),store().claimTick(new Date(time))]);
 assert.equal([a,b].filter(Boolean).length,1); evidence.push('competing workers: exactly one claim');
 const lease=await store().saveBatch(a||b,input);
 const originalBulk=History.bulkWrite.bind(History); let fail=true;
 History.bulkWrite=async(ops,options)=>{if(fail){await originalBulk(ops.slice(0,1),options);throw Error('synthetic partial acknowledgement');}return originalBulk(ops,options);};
 await assert.rejects(store().persistBatch(lease)); assert.equal(await History.countDocuments(),1);
 await store().release(lease,'PARTIAL_WRITE'); fail=false; History.bulkWrite=originalBulk;
 await mongoose.disconnect(); await mongoose.connect(uri,{autoIndex:false});
 await store().persistBatch(await store().claimPending()); assert.equal(await History.countDocuments(),3);
 evidence.push('partial write + application reconnect/restart: 3 exact rows, no duplicates');
 time+=60000; const uncertain=await store().saveBatch(await store().claimTick(new Date(time)),input);
 History.bulkWrite=async(ops,options)=>{await originalBulk(ops,options);throw Error('synthetic lost ack after committed write');};
 await assert.rejects(store().persistBatch(uncertain)); assert.equal(await History.countDocuments(),5);
 time+=1001; History.bulkWrite=originalBulk; const recovered=await store().claimPending();
 await assert.rejects(store().persistBatch(uncertain),{code:'CAPTURE_LEASE_LOST'});
 await store().persistBatch(recovered); assert.equal(await History.countDocuments(),6);
 evidence.push('lost write ack + lease expiry + new worker: 6 exact rows, stale owner fenced');
 time+=60000; const completion=await store().saveBatch(await store().claimTick(new Date(time)),input);
 const originalUpdate=Batch.updateOne.bind(Batch); let lost=true;
 Batch.updateOne=async(filter,update,options)=>{const result=await originalUpdate(filter,update,options); if(lost&&update.$set?.state==='complete'){lost=false;throw Error('synthetic lost completion ack');}return result;};
 await assert.rejects(store().persistBatch(completion)); await store().release(completion,'UNKNOWN_ACK'); Batch.updateOne=originalUpdate;
 assert.equal((await Batch.findById(completion.batchId).lean()).state,'complete'); assert.equal(await store().claimPending(),null);
 evidence.push('lost completion ack: complete batch cannot reopen');
 await mongoose.disconnect(); await rs.stop({doCleanup:false,force:false}); await rs.start(); await rs.waitUntilRunning();
 await mongoose.connect(rs.getUri('qualification'),{autoIndex:false});
 assert.equal(await History.countDocuments(),9); assert.equal(await Batch.countDocuments({state:'complete'}),3);
 evidence.push('graceful mongod stop/restart on same WiredTiger data: 3 complete batches and 9 rows retained');
 const retain=createGpsEvidenceStore(); const reference=await retain({kind:'live',scope:{company:'SYNTHETIC'},requestStartedAt:new Date(time),responseReceivedAt:new Date(time),payload:{rows:[{Vehicle_No:'SYNTHETIC',Latitude:null}]}});
 const receipt=await Receipt.findById(reference.receiptId).select('+payload').lean(); assert.equal(decodeGpsReceipt(receipt).rows[0].Latitude,null);
 const collections=[Batch.collection.name,History.collection.name,Receipt.collection.name];
 const backup={}; for(const name of collections) backup[name]=await mongoose.connection.db.collection(name).find({}).toArray();
 const BSON=mongoose.mongo.BSON; await writeFile(backupFile,BSON.serialize(backup));
 const restored=BSON.deserialize(await readFile(backupFile));
 const restoreDb=mongoose.connection.client.db('qualification_restore');
 for(const name of collections) if(restored[name].length) await restoreDb.collection(name).insertMany(restored[name]);
 assert.equal(await restoreDb.collection(History.collection.name).countDocuments(),9);
 const rb=await restoreDb.collection(Batch.collection.name).find({}).toArray();
 for(const batch of rb){assert.equal(batch.state,'complete');assert.equal(createHash('sha256').update(JSON.stringify(batch.payload)).digest('hex'),batch.payloadSha256);const rows=await restoreDb.collection(History.collection.name).find({captureBatchId:batch._id}).toArray();assert.equal(rows.length,batch.payload.rows.length);for(const row of rows){assert.equal(String(row._id),String(captureObservationId(batch._id,row.captureRow)));assert.equal(row.vehicleNo,batch.payload.rows[row.captureRow].vehicleNo);assert.equal(row.gpsTime,null);
 const expected=batch.payload.rows[row.captureRow];
 for(const [key,value] of Object.entries(expected)){
  if(key==='recordedAt'||key==='gpsTime')assert.equal(row[key]===null?null:+row[key],value===null?null:+new Date(value));
  else assert.deepEqual(BSON.EJSON.serialize(row[key],{relaxed:false}),BSON.EJSON.serialize(value,{relaxed:false}));
 }
 const original=backup[History.collection.name].find(item=>String(item._id)===String(row._id));
 assert.deepEqual(BSON.EJSON.serialize(row,{relaxed:false}),BSON.EJSON.serialize(original,{relaxed:false}));}}
 const rr=await restoreDb.collection(Receipt.collection.name).findOne({_id:reference.receiptId}); assert.equal(rr.payloadSha256,reference.sha256);assert.deepEqual(decodeGpsReceipt(rr),decodeGpsReceipt(receipt));
 evidence.push('BSON backup/restore to separate local namespace: 3 complete batches, 9 row identities, receipt hash/decode preserved');
 console.log(JSON.stringify({passed:evidence,notes:['single-node local replica set; synthetic fault injection after actual Mongo writes','graceful mongod restart; abrupt host crash and production backup tooling not tested']},null,2));
} finally {
 try { await mongoose.disconnect(); }
 finally { try { await rs?.stop(); } finally { const resolvedScratch=await realpath(scratch);
 assert.ok(isAbsolute(resolvedScratch));assert.equal(dirname(resolvedScratch),scratchBase);
 assert.ok(basename(resolvedScratch).startsWith('gps-synthetic-qualification-'));
 await rm(resolvedScratch,{recursive:true,force:true}); } }
}
