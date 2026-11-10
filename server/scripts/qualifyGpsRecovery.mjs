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
import { createGpsEvidenceStore, decodeGpsReceipt, scopedLiveGpsPayload } from '../services/truckoomGpsEvidence.js';
import { normalizeTruckoomLiveData } from '../services/truckoomLiveData.js';
import { buildVehicleLocationSamples } from '../services/vehicleLocationCapture.js';
import { writeFile, readFile, mkdtemp, rm, realpath } from 'node:fs/promises';
const scratchBase=await realpath(tmpdir());
const scratch=await mkdtemp(join(scratchBase,'gps-synthetic-qualification-'));
const backupFile=join(scratch,'synthetic-backup.bson');
let rs;
let time=+new Date('2026-01-01T00:00:00Z'); let owner=0;
const opts={batches:Batch,history:History,clock:()=>new Date(time),ownerId:()=>`worker-${++owner}`,leaseMs:1000,chunkSize:2};
const store=()=>createVehicleLocationCaptureStore(opts);
// Independent originals survive in the test process, never reconstructed from backup.
const originals = new Map();
const BSON = mongoose.mongo.BSON;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function captureInput(label, batchId) {
  const raw = { root: { VehicleData: [
    { Company: 'OTHER', Vehicle_No: 'EXCLUDED', Latitude: '1', Longitude: '1' },
    { Company: 'SYNTHETIC', Vehicle_No: '', Latitude: null, Longitude: null },
    ...[2, 0, 1].map(i => ({ Company: 'SYNTHETIC', Vehicle_No: 'SYNTHETIC-' + i,
      Latitude: i === 1 ? null : String(25 + i / 100), Longitude: String(55 + originals.size / 100),
      GPSActualTime: i === 1 ? null : '01-01-2026 04:00:00', Datetime: null,
      ResponseMarker: label, Speed: '0', IGN: 'OFF' })),
  ] } };
  const payload = scopedLiveGpsPayload(raw, 'SYNTHETIC');
  const reference = await createGpsEvidenceStore()({ kind: 'live', scope: { company: 'SYNTHETIC' },
    requestStartedAt: new Date(time - 1000), responseReceivedAt: new Date(time), payload });
  const fleet = normalizeTruckoomLiveData(raw, 'SYNTHETIC').map(row => ({ ...row, sourceReceipt: reference }));
  const { rows, summary } = buildVehicleLocationSamples({ fleet, drivers: [], recordedAt: new Date(time) });
  assert.deepEqual(rows.map(row => row.sourceRow), [1, 2, 3]); // not capture-row indexes
  originals.set(batchId, structuredClone({ payload, reference, rows,
    requestStartedAt: new Date(time - 1000), responseReceivedAt: new Date(time), scope: { company: 'SYNTHETIC' } }));
  return { rows, summary, sourceReferences: [reference] };
}
function verifyLinks({ batches, rows, receipts }) {
  assert.equal(batches.length, originals.size, 'original batch inventory changed');
  assert.equal(receipts.length, originals.size, 'original receipt inventory changed');
  const archived = new Map(receipts.map(receipt => [receipt._id, receipt]));
  for (const batch of batches) {
    const original = originals.get(batch._id);
    assert.ok(original, 'unexpected capture batch');
    assert.equal(batch.state, 'complete');
    assert.equal(hash(batch.payload), batch.payloadSha256);
    assert.deepEqual(batch.payload.sourceReferences, [original.reference]);
    const members = rows.filter(row => row.captureBatchId === batch._id);
    assert.equal(members.length, original.rows.length);
    for (const row of members) {
      const expected = original.rows[row.captureRow];
      assert.ok(expected, 'unexpected capture row');
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(BSON.EJSON.serialize(row[key], { relaxed: false }),
          BSON.EJSON.serialize(value, { relaxed: false }), 'original normalized field changed: ' + key);
      }
      assert.equal(String(row._id), String(captureObservationId(batch._id, row.captureRow)));
      assert.deepEqual(row.sourceReceipt, original.reference);
      assert.equal(row.sourceRow, expected.sourceRow);
      assert.deepEqual(batch.payload.rows[row.captureRow].sourceReceipt, row.sourceReceipt);
      assert.equal(batch.payload.rows[row.captureRow].sourceRow, row.sourceRow);
      const receipt = archived.get(row.sourceReceipt.receiptId);
      assert.ok(receipt, 'linked archived response missing');
      assert.deepEqual(receipt.scope, original.scope);
      assert.equal(+receipt.requestStartedAt, +original.requestStartedAt);
      assert.equal(+receipt.responseReceivedAt, +original.responseReceivedAt);
      assert.equal(receipt.payloadSha256, row.sourceReceipt.sha256);
      assert.equal(receipt.kind, row.sourceReceipt.kind);
      assert.equal(+receipt.responseReceivedAt, +new Date(row.sourceReceipt.responseReceivedAt));
      const decoded = decodeGpsReceipt(receipt);
      assert.deepEqual(decoded, original.payload);
      assert.equal(hash(decoded), original.reference.sha256);
      assert.ok(Number.isSafeInteger(row.sourceRow) && row.sourceRow >= 0);
      const raw = decoded.rows[row.sourceRow];
      assert.ok(raw, 'linked source row missing');
      assert.equal(raw.Vehicle_No.trim(), row.vehicleNo);
      const [normalized] = normalizeTruckoomLiveData({ root: { VehicleData: [raw] } }, 'SYNTHETIC');
      const [replayed] = buildVehicleLocationSamples({ fleet: [{ ...normalized, sourceReceipt: row.sourceReceipt }],
        drivers: [], recordedAt: row.recordedAt }).rows;
      for (const key of ['latitude', 'longitude', 'gpsTime', 'trackerServerTime', 'rawGpsTime', 'rawTrackerServerTime']) {
        const value = row[key];
        const replay = replayed[key];
        if (key === 'gpsTime' || key === 'trackerServerTime') assert.equal(value == null ? null : +value, replay == null ? null : +replay);
        else assert.deepEqual(value, replay);
      }
    }
  }
  assert.equal(rows.length, batches.reduce((total, batch) => total + originalCount(batch), 0));
}
const originalCount = batch => originals.get(batch._id).rows.length;
async function linkedSnapshot(db) {
  return { batches: await db.collection(Batch.collection.name).find({}).toArray(),
    rows: await db.collection(History.collection.name).find({}).toArray(),
    receipts: await db.collection(Receipt.collection.name).find({}).toArray() };
}
async function verifyDatabaseLinks(db) { const snapshot = await linkedSnapshot(db); verifyLinks(snapshot); return snapshot; }
const evidence=[];
try {
 rs=await MongoMemoryReplSet.create({replSet:{count:1,ip:'127.0.0.1',storageEngine:'wiredTiger'}});
 const uri=rs.getUri('qualification');
 assert.match(uri,/^mongodb:\/\/127\.0\.0\.1:\d+\/qualification\?/); // newly spawned loopback-only database
 await mongoose.connect(uri,{autoIndex:true}); await Promise.all([Batch.init(),History.init(),Receipt.init()]);
 const [a,b]=await Promise.all([store().claimTick(new Date(time)),store().claimTick(new Date(time))]);
 assert.equal([a,b].filter(Boolean).length,1); evidence.push('competing workers: exactly one claim');
 const first = a || b;
 const lease=await store().saveBatch(first,await captureInput('partial-write-response', first.batchId));
 const originalBulk=History.bulkWrite.bind(History); let fail=true;
 History.bulkWrite=async(ops,options)=>{if(fail){await originalBulk(ops.slice(0,1),options);throw Error('synthetic partial acknowledgement');}return originalBulk(ops,options);};
 await assert.rejects(store().persistBatch(lease)); assert.equal(await History.countDocuments(),1);
 await store().release(lease,'PARTIAL_WRITE'); fail=false; History.bulkWrite=originalBulk;
 await mongoose.disconnect(); await mongoose.connect(uri,{autoIndex:false});
 await store().persistBatch(await store().claimPending()); assert.equal(await History.countDocuments(),3);
 await verifyDatabaseLinks(mongoose.connection.db);
 evidence.push('partial write + application reconnect/restart: 3 exact rows linked to original response');
 time+=60000; const next = await store().claimTick(new Date(time));
 const uncertain=await store().saveBatch(next,await captureInput('lost-write-ack-response', next.batchId));
 History.bulkWrite=async(ops,options)=>{await originalBulk(ops,options);throw Error('synthetic lost ack after committed write');};
 await assert.rejects(store().persistBatch(uncertain)); assert.equal(await History.countDocuments(),5);
 time+=1001; History.bulkWrite=originalBulk; const recovered=await store().claimPending();
 await assert.rejects(store().persistBatch(uncertain),{code:'CAPTURE_LEASE_LOST'});
 await store().persistBatch(recovered); assert.equal(await History.countDocuments(),6);
 await verifyDatabaseLinks(mongoose.connection.db);
 evidence.push('lost write ack + lease expiry + new worker: 6 exact linked rows, stale owner fenced');
 time+=60000; const last = await store().claimTick(new Date(time));
 const completion=await store().saveBatch(last,await captureInput('lost-completion-ack-response', last.batchId));
 const originalUpdate=Batch.updateOne.bind(Batch); let lost=true;
 Batch.updateOne=async(filter,update,options)=>{const result=await originalUpdate(filter,update,options); if(lost&&update.$set?.state==='complete'){lost=false;throw Error('synthetic lost completion ack');}return result;};
 await assert.rejects(store().persistBatch(completion)); await store().release(completion,'UNKNOWN_ACK'); Batch.updateOne=originalUpdate;
 assert.equal((await Batch.findById(completion.batchId).lean()).state,'complete'); assert.equal(await store().claimPending(),null);
 await verifyDatabaseLinks(mongoose.connection.db);
 evidence.push('lost completion ack: complete batch cannot reopen; all 9 rows linked');
 await mongoose.disconnect();
 // The tooling resolves stop on process exit, before Windows closes its pipes.
 // Await old child close events so they cannot reject the next start listeners.
 const oldChildrenClosed = Promise.all(rs.servers.map(server => {
   const child = server.instanceInfo?.instance.mongodProcess;
   assert.ok(child, 'test mongod child missing before restart');
   return new Promise((resolve, reject) => {
     // This referenced deadline also keeps Node alive after tooling unrefs children.
     const deadline = setTimeout(() => reject(new Error('test mongod close event timed out')), 10000);
     child.once('close', (code, signal) => {
       clearTimeout(deadline);
       if (code !== 0 || signal !== null) reject(new Error('test mongod did not close gracefully'));
       else resolve();
     });
     child.once('error', error => { clearTimeout(deadline); reject(error); });
   });
 }));
 await rs.stop({doCleanup:false,force:false});
 await oldChildrenClosed;
 await rs.start(); await rs.waitUntilRunning();
 await mongoose.connect(rs.getUri('qualification'),{autoIndex:false});
 assert.equal(await History.countDocuments(),9); assert.equal(await Batch.countDocuments({state:'complete'}),3);
 evidence.push('graceful mongod stop/restart on same WiredTiger data: 3 complete batches and 9 rows retained');
 await verifyDatabaseLinks(mongoose.connection.db);
 evidence.push('after database restart: all 9 row-to-response links, source indexes, clocks and hashes verified');
 const collections=[Batch.collection.name,History.collection.name,Receipt.collection.name];
 const backup={}; for(const name of collections) backup[name]=await mongoose.connection.db.collection(name).find({}).toArray();
 await writeFile(backupFile,BSON.serialize(backup));
 const restored=BSON.deserialize(await readFile(backupFile));
 const restoreDb=mongoose.connection.client.db('qualification_restore');
 for(const name of collections) if(restored[name].length) await restoreDb.collection(name).insertMany(restored[name]);
 assert.equal(await restoreDb.collection(History.collection.name).countDocuments(),9);
 const rb=await restoreDb.collection(Batch.collection.name).find({}).toArray();
 for(const batch of rb){assert.equal(batch.state,'complete');assert.equal(createHash('sha256').update(JSON.stringify(batch.payload)).digest('hex'),batch.payloadSha256);const rows=await restoreDb.collection(History.collection.name).find({captureBatchId:batch._id}).toArray();assert.equal(rows.length,batch.payload.rows.length);for(const row of rows){assert.equal(String(row._id),String(captureObservationId(batch._id,row.captureRow)));assert.equal(row.vehicleNo,batch.payload.rows[row.captureRow].vehicleNo);
 const expected=batch.payload.rows[row.captureRow];
 for(const [key,value] of Object.entries(expected)){
  if(key==='recordedAt'||key==='gpsTime'||key==='trackerServerTime')assert.equal(row[key]===null?null:+row[key],value===null?null:+new Date(value));
  else assert.deepEqual(BSON.EJSON.serialize(row[key],{relaxed:false}),BSON.EJSON.serialize(value,{relaxed:false}));
 }
 const original=backup[History.collection.name].find(item=>String(item._id)===String(row._id));
 assert.deepEqual(BSON.EJSON.serialize(row,{relaxed:false}),BSON.EJSON.serialize(original,{relaxed:false}));}}
 const linked = await verifyDatabaseLinks(restoreDb);
 assert.equal(linked.receipts.length, 3);
 evidence.push('BSON restore: 3 original responses linked to all 9 exact history rows through batch membership');
 // Negative controls are in-memory only; intact restored evidence is not changed.
 const clone = () => BSON.deserialize(BSON.serialize(linked));
 const missing = clone(); missing.receipts.shift();
 assert.throws(() => verifyLinks(missing), /original receipt inventory changed/);
 const missingBatch = clone();
 const [omitted] = missingBatch.batches.splice(0, 1);
 missingBatch.rows = missingBatch.rows.filter(row => row.captureBatchId !== omitted._id);
 const omittedReceipt = originals.get(omitted._id).reference.receiptId;
 missingBatch.receipts = missingBatch.receipts.filter(receipt => receipt._id !== omittedReceipt);
 assert.throws(() => verifyLinks(missingBatch), /original batch inventory changed/);
 const wrongRow = clone(); wrongRow.rows[0].sourceRow = 0;
 assert.throws(() => verifyLinks(wrongRow));
 const wrongHash = clone(); wrongHash.rows[0].sourceReceipt.sha256 = '0'.repeat(64);
 assert.throws(() => verifyLinks(wrongHash));
 const substituted = clone();
 const target = substituted.batches[0];
 const other = substituted.batches[1].payload.sourceReferences[0];
 target.payload.sourceReferences = [other];
 for (const row of target.payload.rows) row.sourceReceipt = other;
 for (const row of substituted.rows.filter(row => row.captureBatchId === target._id)) row.sourceReceipt = other;
 target.payloadSha256 = hash(target.payload);
 assert.throws(() => verifyLinks(substituted));
 const changedQuality = clone();
 const changedRow = changedQuality.rows[0];
 const changedBatch = changedQuality.batches.find(batch => batch._id === changedRow.captureBatchId);
 changedRow.qualityFlags = ['invented_quality'];
 changedBatch.payload.rows[changedRow.captureRow].qualityFlags = ['invented_quality'];
 changedBatch.payloadSha256 = hash(changedBatch.payload);
 assert.throws(() => verifyLinks(changedQuality), /original normalized field changed: qualityFlags/);
 evidence.push('negative controls reject missing batch/receipt inventories, wrong source-row index, changed hash, coherent receipt substitution and normalized-field mutation');
 console.log(JSON.stringify({passed:evidence,notes:['single-node local replica set; synthetic fault injection after actual Mongo writes','graceful mongod restart; abrupt host crash and production backup tooling not tested']},null,2));
} finally {
 try { await mongoose.disconnect(); }
 finally { try { await rs?.stop(); } finally { const resolvedScratch=await realpath(scratch);
 assert.ok(isAbsolute(resolvedScratch));assert.equal(dirname(resolvedScratch),scratchBase);
 assert.ok(basename(resolvedScratch).startsWith('gps-synthetic-qualification-'));
 await rm(resolvedScratch,{recursive:true,force:true}); } }
}
