import test from 'node:test';import assert from 'node:assert/strict';import {ObjectId} from 'bson';
import {createCloudCacheReader} from './customerServiceCloudCache.js';import {encodeCloudRecord} from './customerServiceCloudStore.js';
test('new cloud evidence keeps reviewer exclusions typed and marks stale without rewriting saved history',async()=>{
 const cid=new ObjectId(),iid=new ObjectId(),actor=new ObjectId(),writes=[];
 const c={_id:cid,sourceRevision:2,updatedAt:new Date()};let page=0;
 const store={head:async()=>({revision:2}),query:async sql=>sql.includes("body->>'authorType'='staff'")?[{authorId:String(actor),sentAt:new Date().toISOString()}]:page++===0?[encodeCloudRecord('serviceconversations',c)]:[]};
 const db={collection:kind=>({findOne:async()=>kind==='serviceconversations'?{sourceRevision:1,updatedAt:new Date(0)}:null,replaceOne:async()=>{},find:()=>({async *[Symbol.asyncIterator](){yield {_id:iid,episodeKey:'primary',sourceRevision:1};}}),updateOne:async(filter,update)=>writes.push({kind,filter,update}),updateMany:async(filter,update)=>writes.push({kind,filter,update})})};
 const reader=createCloudCacheReader({db,store});await reader.refresh();
 const issue=writes.find(w=>w.kind==='serviceissues');assert.ok(issue.update.$set.contributorIds[0] instanceof ObjectId);assert.equal(String(issue.update.$set.contributorIds[0]),String(actor));
 const review=writes.find(w=>w.kind==='servicereviews');assert.equal(review.update.$set.stale,true);assert.equal(review.update.$set.revisions,undefined);assert.equal(review.update.$set.assignmentHistory,undefined);assert.equal(review.update.$set.reviewerId,undefined);
 const count=writes.length;await reader.refresh();assert.equal(writes.length,count);
});
