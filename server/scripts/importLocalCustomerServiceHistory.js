// Explicit local preview only; never reads application environment credentials.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import mongoose from 'mongoose';
import {extractHistoryWorkbook,prepareIsolatedHistoryBatches} from '../services/customerServiceHistoryWorkbook.js';
import {ingestServiceBatch} from '../services/customerServiceCapture.js';
import User from '../models/User.js';
import ServiceCaptureBatch from '../models/ServiceCaptureBatch.js';
const [uriFile,dbName,input,reportFile]=process.argv.slice(2);
assert.ok(uriFile&&input&&reportFile,'Supply URI file, existing preview database, workbook, private report output');
assert.match(dbName||'',/^matter_service_test_[a-f0-9]{32}$/,'Only explicitly named fixture preview databases permitted');
const uri=(await fs.readFile(uriFile,'utf8')).trim();
assert.match(uri,/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|\?|$)/,'MongoDB must use an explicit loopback address without credentials');
assert.ok(!uri.split('?')[0].includes(','),'Multiple MongoDB hosts are not permitted');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const extraction=extractHistoryWorkbook(await fs.readFile(input));
const prepared=prepareIsolatedHistoryBatches(extraction);
await fs.writeFile(`${reportFile}.conflicts.private.json`,JSON.stringify(extraction.messages.filter(m=>m.conflicted)),{mode:0o600,flag:'wx'});
try {
 await mongoose.connect(uri,{dbName,autoIndex:false,serverSelectionTimeoutMS:5000});
 const db=mongoose.connection.db;assert.equal(db.databaseName,dbName);
 const hello=await db.admin().command({hello:1});assert.ok(hello.setName,'Transactions require a local replica set');
 for(const host of hello.hosts||[])assert.match(host,/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/,'Replica members must be local');
 const actor=await User.findOne({email:'browser-2@fixture.invalid'}).lean();assert.ok(actor,'Existing preview supervisor is required');
 const profile=await db.collection('servicestaffprofiles').findOne({userId:actor._id,mode:'supervisor'});assert.ok(profile);
 const allowed=new Set(['servicemessages','serviceconversations','serviceissues','servicereviews','servicecapturebatches']);
 const collections=(await db.listCollections().toArray()).map(c=>c.name);
 const snapshot=async names=>Object.fromEntries(await Promise.all(names.map(async name=>{const docs=await db.collection(name).find({}).sort({_id:1}).toArray();return [name,{count:docs.length,sha256:hash(docs)}];})));
 const protectedNames=collections.filter(n=>!allowed.has(n)&&!n.startsWith('system.'));
 const beforeProtected=await snapshot(protectedNames),beforeCounts=await snapshot([...allowed]);
 const existingReviews=await db.collection('servicereviews').find({}).sort({_id:1}).toArray();
 const reviewIds=existingReviews.map(r=>r._id),reviewsBefore=hash(existingReviews);
 const counts={received:0,inserted:0,duplicates:0};
 for(const batch of prepared.batches){const result=await ingestServiceBatch({...batch,actor});for(const k of Object.keys(counts))counts[k]+=result[k]||0;}
 const afterCounts=await snapshot([...allowed]);
 assert.equal(await db.collection('servicemessages').countDocuments({source:'gallabox_history',scope:prepared.batches[0].scope,'sourceMetadata.history.workbookSha256':extraction.workbookSha256}),prepared.report.isolatedMessages,'Every message must preserve source provenance');
 assert.equal(hash(await db.collection('servicereviews').find({_id:{$in:reviewIds}}).sort({_id:1}).toArray()),reviewsBefore,'Existing review revisions must remain unchanged');
 assert.deepEqual(await snapshot(protectedNames),beforeProtected,'Unrelated collections must remain unchanged');
 for(const batch of prepared.batches){const replay=await ingestServiceBatch({...batch,actor});assert.equal(replay.duplicate,true,'Replay must reuse completed batch receipt');}
 assert.deepEqual(await snapshot([...allowed]),afterCounts,'Replay must not mutate any captured data or reviews');
 const {quarantinedMessageIds,...report}=prepared.report;
 const requestId=`history-report:${extraction.workbookSha256}`;
 const old=await ServiceCaptureBatch.findOne({requestId}).lean();
 if(old)assert.equal(old.coverage?.workbookSha256,extraction.workbookSha256);
 await ServiceCaptureBatch.updateOne({requestId},{$setOnInsert:{source:'gallabox_history',scope:prepared.batches[0].scope,requestId,status:'partial',createdBy:actor._id,counts:{received:extraction.report.uniqueSourceMessageIds,inserted:prepared.report.isolatedMessages,quarantined:quarantinedMessageIds.length},coverage:{kind:'curated_workbook',first:report.firstMessageAt,last:report.lastMessageAt,report:{...report,quarantinedMessageIds:quarantinedMessageIds.length},sourceFilename:input.split('/').at(-1),workbookSha256:extraction.workbookSha256}}},{upsert:true});
 const final={database:dbName,workbookSha256:extraction.workbookSha256,counts,report:{...report,quarantinedMessageIds:quarantinedMessageIds.length},beforeCounts,afterCounts,protectedCollections:beforeProtected,existingReviewsPreserved:existingReviews.length,replayVerified:true};
 await fs.writeFile(reportFile,JSON.stringify(final,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({counts,existingReviewsPreserved:existingReviews.length,protectedCollectionCount:protectedNames.length,replayVerified:true,isolatedMessages:prepared.report.isolatedMessages,syntheticTranscriptGroups:prepared.report.syntheticTranscriptGroups}));
}finally{await mongoose.disconnect();}
