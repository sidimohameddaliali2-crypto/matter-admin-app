import test,{before,after}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import mongoose from'mongoose';import{ingestServiceBatch}from'../services/customerServiceCapture.js';import Staff from'../models/ServiceStaffProfile.js';import Message from'../models/ServiceMessage.js';import Conversation from'../models/ServiceConversation.js';import Issue from'../models/ServiceIssue.js';import Review from'../models/ServiceReview.js';
const enabled=process.env.CUSTOMER_SERVICE_TEST_ISOLATED==='true'&&!!process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI;const dbName=`matter_service_test_${randomUUID().replaceAll('-','')}`;
before(async()=>{if(!enabled)return;await mongoose.connect(process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI,{dbName});for(const model of Object.values(mongoose.models)){await model.createCollection();if(model.modelName!=='Customer')await model.createIndexes();}});
after(async()=>{if(!enabled)return;if(mongoose.connection.name===dbName)await mongoose.connection.dropDatabase();await mongoose.disconnect();});
test('internal note attribution never creates contributors or invalidates saved reviews',{skip:!enabled},async()=>{
 const messages=[{externalMessageId:'internal-note',externalConversationId:'note-thread',externalAuthorId:'note-author',authorType:'staff',authorName:'Fixture staff',sentAt:'2026-11-06T00:00:00Z',type:'other',text:'Internal note',sourceMetadata:{nativeEvent:{kind:'internal_note',timestampBasis:'createdAt'}}}];
 await ingestServiceBatch({source:'gallabox',scope:'account:channel',messages,requestId:randomUUID()});const issue=await Issue.findOne().lean();assert.deepEqual(issue.contributorIds,[]);assert.equal(issue.sourceMetadata.unmappedStaff,false);assert.equal((await Message.findOne()).internalNote,true);
 await Review.updateOne({issueId:issue._id},{$set:{status:'submitted',revisions:[{sourceRevision:issue.sourceRevision,summary:'Saved review',verdict:'insufficient',at:new Date()}]}});
 const before={review:JSON.stringify(await Review.findOne().lean()),conversation:JSON.stringify(await Conversation.findOne().lean())};
 await Staff.create({userId:new mongoose.Types.ObjectId(),displayName:'Fixture',mode:'reviewer',externalAuthorIds:['gallabox:account:channel:note-author']});
 await ingestServiceBatch({source:'gallabox',scope:'account:channel',messages,requestId:randomUUID()});
 assert.equal(JSON.stringify(await Review.findOne().lean()),before.review);assert.equal(JSON.stringify(await Conversation.findOne().lean()),before.conversation);assert.deepEqual((await Issue.findOne()).contributorIds,[]);
});
test('legacy private-note repair changes no source text, source revision or saved review', {skip:!enabled},async()=>{
 const{repairInternalNoteClassification}=await import('../services/customerServiceInternalNoteRepair.js');const message=await Message.findOne();const issue=await Issue.findOne();
 await Message.updateOne({_id:message._id},{$unset:{internalNote:1}});await Issue.updateOne({_id:issue._id},{$set:{contributorIds:[message.authorId],'sourceMetadata.unmappedStaff':true}});
 const reviewBefore=JSON.stringify(await Review.findOne().lean()),conversationBefore=JSON.stringify(await Conversation.findOne().lean()),sourceText=message.text,revision=issue.sourceRevision;
 const result=await repairInternalNoteClassification();assert.equal(result.notes,1);assert.equal(result.issuesUpdated,1);assert.equal((await Message.findOne()).internalNote,true);assert.equal((await Message.findOne()).text,sourceText);assert.equal((await Issue.findOne()).sourceRevision,revision);assert.deepEqual((await Issue.findOne()).contributorIds,[]);assert.equal(JSON.stringify(await Review.findOne().lean()),reviewBefore);assert.equal(JSON.stringify(await Conversation.findOne().lean()),conversationBefore);
 assert.equal((await repairInternalNoteClassification()).issuesUpdated,0);
});
