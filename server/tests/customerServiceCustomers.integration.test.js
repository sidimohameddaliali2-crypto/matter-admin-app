import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Staff from '../models/ServiceStaffProfile.js';
import Customer from '../models/ServiceCustomer.js';
import DirectoryState from '../models/ServiceCustomerDirectoryState.js';
import Message from '../models/ServiceMessage.js';
import SourceContact from '../models/ServiceSourceContact.js';
import Conversation from '../models/ServiceConversation.js';
import Issue from '../models/ServiceIssue.js';
import Review from '../models/ServiceReview.js';
import Action from '../models/ServiceAction.js';
import router from '../routes/customerServiceCustomers.js';
const uri=process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI;
const enabled=Boolean(uri&&process.env.CUSTOMER_SERVICE_TEST_ISOLATED==='true');
const dbName=`matter_service_test_${randomUUID().replaceAll('-','')}`;
let server,base,users,issues;
const originalSecret=process.env.JWT_SECRET;
before(async()=>{
 if(!enabled)return;
 assert.equal(mongoose.connection.readyState,0);await mongoose.connect(uri,{dbName,autoIndex:false,serverSelectionTimeoutMS:5000});assert.equal(mongoose.connection.name,dbName);
 for(const model of Object.values(mongoose.models)){await model.createCollection();if(model.modelName!=='Customer')await model.createIndexes();}
 users=await User.create(['supervisor','reviewer','outsider','ungranted'].map(name=>({email:`${name}@fixture.invalid`,password:randomUUID(),role:'admin',isActive:true,profile:{firstName:name}})));
 await Staff.create(users.slice(0,3).map((u,i)=>({userId:u._id,mode:i?'reviewer':'supervisor',enabled:true,availableMinutes:60})));
 await DirectoryState.create({key:'matter_customer_directory',activeGeneration:'current',status:'ready',sourceObservedAt:new Date('2026-11-06T00:00:00Z'),lastSuccessfulAt:new Date(),counts:{customers:105},report:{coverage:'partial'}});
 await Customer.create(Array.from({length:105},(_,i)=>({customerId:`matter:${i}`,name:i===0?'Literal .* customer':`Directory ${String(i).padStart(3,'0')}`,email:`person${i}@fixture.invalid`,phone:`97150${i}`,source:'matter',sourceObservedAt:new Date(),sourceCoverage:'partial',active:true,generation:'current',subscriptions:i===0?[{id:'subscription1',status:'active',plan:{id:'p1',name:'Balanced'},start:'2026-11-01',end:'2026-11-30'}]:[]})));
 await Customer.create({customerId:'matter:old',name:'Old generation',source:'matter',sourceObservedAt:new Date(),sourceCoverage:'partial',active:true,generation:'old'});
 const conversations=await Conversation.create(Array.from({length:5},(_,i)=>({source:'gallabox',scope:i===4?'other-scope':'scope',externalConversationId:`conversation${i}`,customerId:i<2?`matter:${i}`:'',customerName:`Source contact ${i}`,sourceMetadata:{externalContactId:i<2?`contact${i}`:'shared-contact'}})));
 issues=await Issue.create(conversations.map((c,i)=>({conversationId:c._id,customerId:c.customerId,customerName:c.customerName,summary:`Issue ${i}`})));
 await Review.create([0,2].map(i=>({issueId:issues[i]._id,reviewerId:users[1]._id,status:'assigned'})));
 await Action.create({issueId:issues[1]._id,ownerId:users[1]._id,description:'Fixture owned follow-up'});
 await SourceContact.create([{scope:'scope',externalContactId:'contact0',customerId:'matter:0',matchState:'matched',matchedBy:'phone'},{scope:'scope',externalContactId:'contact1',customerId:'matter:1',matchState:'conflict',candidateCustomerIds:['matter:98','matter:99']}]);
 process.env.JWT_SECRET=randomUUID();const app=express();app.use('/api/customer-service',router);app.get('/api/customer-service/customers/:id/context',(req,res)=>res.json({legacy:true}));server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}/api/customer-service`;
});
after(async()=>{if(!enabled)return;if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}if(mongoose.connection.name===dbName)await mongoose.connection.dropDatabase();await mongoose.disconnect();if(originalSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=originalSecret;});
const get=async(path,user=users[0])=>{const response=await fetch(`${base}${path}`,{headers:user?{Authorization:`Bearer ${jwt.sign({id:String(user._id)},process.env.JWT_SECRET,{expiresIn:'5m'})}`}:{}});return {status:response.status,headers:response.headers,body:await response.json()};};
const check=(name,fn)=>test(name,{skip:!enabled},fn);
check('directory totals come from committed customer records; unmatched contacts group within source scope',async()=>{
 const result=await get('/customers');assert.equal(result.status,200);const d=result.body.data;assert.equal(d.total,105);assert.equal(d.records.length,50);assert.equal(d.pageSize,50);assert.deepEqual(d.counts,{directoryCustomers:105,linkedCustomers:2,unmatchedContacts:2,unmatchedConversations:3});assert.equal(d.source.state,'available');assert.equal(d.source.coverage,'partial');assert.match(result.headers.get('cache-control'),/no-store/);
 const unmatched=(await get('/customers?view=unmatched')).body.data;assert.equal(unmatched.total,2);assert.deepEqual(unmatched.records.map(r=>r.issues.length).sort(),[1,2]);assert.ok(unmatched.records.every(r=>r.customerId===''));assert.ok(!JSON.stringify(unmatched).includes('candidateCustomerIds'));
});
check('pagination and literal directory email/name search are bounded and do not expose staged generations',async()=>{
 const result=(await get('/customers?page=3')).body.data;assert.equal(result.records.length,5);assert.equal(result.page,3);assert.ok(!result.records.some(r=>r.customerId==='matter:old'));
 assert.equal((await get('/customers?pageSize=101')).status,400);assert.equal((await get('/customers?q='+encodeURIComponent('.*'))).body.data.total,1);assert.equal((await get('/customers?q=person104%40fixture.invalid')).body.data.total,1);assert.equal((await get('/customers?q='+('a'.repeat(201)))).status,400);
 assert.equal((await get('/customers?page=99')).body.data.page,3);
});
check('reviewers see only assigned and action-owned customers, scoped unmatched issues and no candidate identities',async()=>{
 const d=(await get('/customers',users[1])).body.data;assert.equal(d.total,2);assert.equal(d.counts.directoryCustomers,2);assert.deepEqual(new Set(d.records.map(r=>r.customerId)),new Set(['matter:0','matter:1']));assert.equal(d.records.find(r=>r.customerId==='matter:1').matchState,'conflict');assert.ok(!JSON.stringify(d).includes('matter:98'));assert.ok(!JSON.stringify(d).includes('candidateCustomerIds'));
 const unmatched=(await get('/customers?view=unmatched',users[1])).body.data;assert.equal(unmatched.total,1);assert.equal(unmatched.records[0].issues.length,1);assert.equal(unmatched.counts.unmatchedConversations,1);
 assert.equal((await get('/customers',users[2])).body.data.total,0);assert.equal((await get('/customers',users[3])).status,403);assert.equal((await get('/customers',null)).status,401);
});
check('context enforces customer scope, shapes subscriptions and falls through only for allowed legacy lookups',async()=>{
 const d=(await get('/customers/matter%3A0/context',users[1])).body.data;assert.equal(d.customer.customerId,'matter:0');assert.equal(d.issues.length,1);assert.equal(d.matchState,'matched');assert.deepEqual(d.subscriptions,[{subscriptionId:'subscription1',status:'active',planName:'Balanced',startDate:'2026-11-01',endDate:'2026-11-30'}]);
 assert.equal((await get('/customers/matter%3A99/context',users[1])).status,403);assert.equal((await get('/customers/matter%3A99/context',users[2])).status,403);assert.equal((await get('/customers/legacy-id/context')).body.legacy,true);
});
check('failed refresh retains committed records with explicit stale source status',async()=>{
 await DirectoryState.updateOne({key:'matter_customer_directory'},{$set:{status:'failed',error:'private provider diagnostic'}});
 const d=(await get('/customers')).body.data;assert.equal(d.total,105);assert.equal(d.source.state,'stale');assert.match(d.source.message,/Sync failed/);assert.ok(!JSON.stringify(d).includes('private provider diagnostic'));
});

check('selected Dubai day scopes customer list and context; All time restores full directory',async()=>{
 const first=await Issue.findById(issues[0]._id);const second=await Issue.findById(issues[1]._id);
 await Message.create([{source:'gallabox',scope:'scope',conversationId:first.conversationId,externalMessageId:'day-start',sentAt:new Date('2026-11-05T20:00:00Z'),type:'text',text:'Today'}, {source:'gallabox',scope:'scope',conversationId:second.conversationId,externalMessageId:'before-start',sentAt:new Date('2026-11-05T19:59:59Z'),type:'text',text:'Yesterday'}]);
 const d=(await get('/customers?from=2026-11-06&to=2026-11-06')).body.data;assert.equal(d.total,1);assert.equal(d.records[0].customerId,'matter:0');assert.equal(d.counts.directoryCustomers,105);
 assert.equal((await get('/customers')).body.data.total,105);
 const context=(await get('/customers/matter%3A1/context?from=2026-11-06&to=2026-11-06')).body.data;assert.equal(context.issues.length,0);
 const previous=(await get('/customers?from=2026-11-05&to=2026-11-05')).body.data;assert.equal(previous.total,1);assert.equal(previous.records[0].customerId,'matter:1');
});
check('verified Excel source links resolve native contact identity; outdated attestations stay unverified',async()=>{
 const c=await Conversation.create({source:'gallabox_history',scope:'workbook:fixture',externalConversationId:'history-mapped',customerId:'matter:0',sourceRevision:3,sourceMetadata:{historySourceIdentity:{scope:'scope',externalContactId:'contact0',sourceRevision:3}}});
 await Issue.create({conversationId:c._id,customerId:'matter:0'});
 let context=(await get('/customers/matter%3A0/context')).body.data;assert.equal(context.matchState,'matched');
 await Conversation.updateOne({_id:c._id},{$set:{sourceRevision:4}});
 context=(await get('/customers/matter%3A0/context')).body.data;assert.equal(context.matchState,'linked_identity_unverified');
});
check('more than 5000 unrelated issues cannot block paginated customer search/context or Today scope',async()=>{
 await Issue.collection.insertMany(Array.from({length:5001},(_,i)=>({_id:new mongoose.Types.ObjectId(),conversationId:new mongoose.Types.ObjectId(),episodeKey:'primary',customerId:'matter:104',customerName:'Unrelated fixture',summary:`Unrelated ${i}`,sourceRevision:1})));
 const found=await get('/customers?q=person0%40fixture.invalid');assert.equal(found.status,200);assert.equal(found.body.data.total,1);assert.equal(found.body.data.records[0].customerId,'matter:0');
 const context=await get('/customers/matter%3A0/context',users[1]);assert.equal(context.status,200);assert.equal(context.body.data.customer.customerId,'matter:0');assert.equal((await get('/customers/matter%3A104/context',users[1])).status,403);
 const today=await get('/customers?from=2026-11-06&to=2026-11-06');assert.equal(today.status,200);assert.equal(today.body.data.records.length,1);assert.equal(today.body.data.records[0].customerId,'matter:0');
});
check('reviewer issue scope includes assignments after the former 10001-row cutoff',async()=>{
 const person=await User.create({email:`many-${randomUUID()}@fixture.invalid`,password:randomUUID(),role:'admin',isActive:true});await Staff.create({userId:person._id,mode:'reviewer',enabled:true});
 await Review.collection.insertMany(Array.from({length:10001},()=>({_id:new mongoose.Types.ObjectId(),issueId:new mongoose.Types.ObjectId(),reviewerId:person._id,status:'assigned'})));
 await Review.create({issueId:issues[0]._id,reviewerId:person._id,status:'assigned',sampleKey:'late-assignment'});
 const legacyScope=await Review.find({reviewerId:person._id}).select('issueId').limit(10001).lean();assert.ok(!legacyScope.some(r=>String(r.issueId)===String(issues[0]._id)));
 const result=await get('/customers/matter%3A0/context',person);assert.equal(result.status,200);assert.equal(result.body.data.issues.length,1);
});
check('customer-specific queries preserve independent calibration blinding',async()=>{
 const person=await User.create({email:`blind-${randomUUID()}@fixture.invalid`,password:randomUUID(),role:'admin',isActive:true});await Staff.create({userId:person._id,mode:'reviewer',enabled:true});
 await Issue.updateOne({_id:issues[0]._id},{$set:{summary:'Secret prior verdict',categoryIds:['wrong_meals'],outcome:'resolved'}});
 await Review.create({issueId:issues[0]._id,reviewerId:person._id,status:'assigned',sampleKey:'blind-directory',sampleType:'calibration'});
 const result=await get('/customers/matter%3A0/context',person);assert.equal(result.status,200);assert.equal(result.body.data.issues[0].summary,'');assert.deepEqual(result.body.data.issues[0].categoryIds,[]);assert.equal(result.body.data.issues[0].outcome,'unknown');assert.ok(!JSON.stringify(result.body).includes('Secret prior verdict'));
});
check('report window admits the complete bounded backfill and fails explicitly above its limit',async()=>{
 const {getServiceSnapshot}=await import('../services/customerServiceReports.js');
 const count=await Issue.countDocuments();assert.ok(count>5000&&count<10000);
 const full=await getServiceSnapshot({userId:users[0]._id,supervise:true});assert.equal(full.issues.length,count);
 await Issue.collection.insertMany(Array.from({length:10001-count},()=>({_id:new mongoose.Types.ObjectId(),conversationId:new mongoose.Types.ObjectId(),episodeKey:'primary',customerId:'matter:104',sourceRevision:1})));
 await assert.rejects(getServiceSnapshot({userId:users[0]._id,supervise:true}),e=>e.statusCode===422&&/10000/.test(e.message));
 const today=await getServiceSnapshot({userId:users[0]._id,supervise:true,filters:{from:'2026-11-06',to:'2026-11-06'}});assert.ok(today.issues.length>0&&today.issues.length<10000);
});
check('partial API refresh survives directory reload with independently dated unavailable database',async()=>{
 const previous=await DirectoryState.findOne({key:'matter_customer_directory'}).lean();
 try{
  await DirectoryState.updateOne({key:'matter_customer_directory'},{$set:{status:'partial','report.automaticRefresh':{api:true,remoteDatabase:true},'report.apiObservedAt':'2026-11-06T02:00:00Z','report.remoteSnapshotObservedAt':'2026-11-04T00:00:00Z','report.sources':{api:{state:'available',observedAt:'2026-11-06T02:00:00Z'},remoteDatabase:{state:'unavailable',observedAt:'2026-11-04T00:00:00Z',error:'safe status'}}}});
  for(let reload=0;reload<2;reload++){const d=(await get('/customers')).body.data;assert.equal(d.total,105);assert.equal(d.source.state,'partial');assert.match(d.source.message,/API updated/);assert.match(d.source.message,/database unavailable/);assert.equal(d.source.remoteObservedAt,'2026-11-04T00:00:00Z');assert.equal(d.source.apiObservedAt,'2026-11-06T02:00:00Z');assert.equal(d.source.sources.remoteDatabase.state,'unavailable');}
 }finally{await DirectoryState.updateOne({_id:previous._id},{$set:{status:previous.status,report:previous.report}});}
});
check('Nutrition status survives reload, failure and recovery without relabeling captured delivery data as live',async()=>{
 const previous=await DirectoryState.findOne({key:'matter_customer_directory'}).lean();
 const nutritionAt='2026-11-06T03:00:00Z',remoteAt='2026-11-04T00:00:00Z';
 try{
  const report={nutritionRead:{observedAt:nutritionAt},nutritionObservedAt:nutritionAt,remoteSnapshotObservedAt:remoteAt,automaticRefresh:{nutritionAdmin:true,remoteDatabase:false},sources:{nutritionAdmin:{state:'available',observedAt:nutritionAt},remoteDatabase:{state:'unavailable',observedAt:remoteAt,error:'private diagnostic'}}};
  await DirectoryState.updateOne({_id:previous._id},{$set:{status:'partial',report}});
  for(let reload=0;reload<2;reload++){
   const d=(await get('/customers')).body.data;assert.equal(d.total,105);assert.equal(d.source.message,'Customers synced · delivery database unavailable');assert.equal(d.source.state,'partial');assert.equal(d.source.nutritionObservedAt,nutritionAt);assert.equal(d.source.remoteObservedAt,remoteAt);assert.equal(d.source.automaticNutritionSync,true);assert.equal(d.source.automaticRemoteSync,false);assert.ok(!JSON.stringify(d).includes('private diagnostic'));
  }
  await DirectoryState.updateOne({_id:previous._id},{$set:{status:'failed','report.sources.nutritionAdmin.state':'unavailable'}});
  const failed=(await get('/customers')).body.data;assert.equal(failed.total,105);assert.equal(failed.source.state,'stale');assert.equal(failed.source.message,'Sync failed · showing saved data');assert.equal(failed.source.nutritionObservedAt,nutritionAt);
  await DirectoryState.updateOne({_id:previous._id},{$set:{status:'ready','report.sources.nutritionAdmin.state':'available','report.sources.remoteDatabase.state':'snapshot'}});
  const recovered=(await get('/customers')).body.data;assert.equal(recovered.source.state,'available');assert.equal(recovered.source.message,'Customers synced · delivery snapshot');assert.equal(recovered.source.automaticRemoteSync,false);
  await DirectoryState.updateOne({_id:previous._id},{$set:{'report.sources.remoteDatabase.state':'available','report.automaticRefresh.remoteDatabase':true}});
  assert.equal((await get('/customers')).body.data.source.message,'Live sync');
 }finally{await DirectoryState.updateOne({_id:previous._id},{$set:{status:previous.status,report:previous.report}});}
});
check('Nutrition account and phone observations persist without changing subscription evidence',async()=>{
 const original=await Customer.findOne({customerId:'matter:0'}).lean();
 try{
  await Customer.updateOne({_id:original._id},{$set:{telephone:'+971500000001',whatsappNumber:'+971500000002',accountStatus:'active',hasActiveSubscription:false,subscriptionCoverage:'api_not_returned',phoneObservedAt:new Date('2026-11-06T03:00:00Z'),sourceStates:{nutritionAdmin:{state:'available',observedAt:'2026-11-06T03:00:00Z'},api:{state:'not_returned'}}}});
  const saved=await Customer.findById(original._id).lean();assert.equal(saved.telephone,'+971500000001');assert.equal(saved.whatsappNumber,'+971500000002');assert.equal(saved.accountStatus,'active');assert.equal(saved.hasActiveSubscription,false);assert.equal(saved.subscriptionCoverage,'api_not_returned');assert.equal(saved.phoneObservedAt.toISOString(),'2026-11-06T03:00:00.000Z');assert.equal(saved.sourceStates.api.state,'not_returned');assert.deepEqual(saved.subscriptions,original.subscriptions);
 }finally{await Customer.replaceOne({_id:original._id},original);}
});

check('Supabase connection status distinguishes stored source data and retained admin records',async()=>{
 const previous=await DirectoryState.findOne({key:'matter_customer_directory'}).lean();
 try{
  await DirectoryState.updateOne({_id:previous._id},{$set:{status:'ready',report:{automaticRefresh:{supabase:true,nutritionAdmin:false,api:true},supabaseObservedAt:'2026-11-06T04:00:00Z',sources:{supabase:{state:'available',observedAt:'2026-11-06T04:00:00Z'},nutritionAdmin:{state:'retained',observedAt:'2026-11-06T01:00:00Z'}}}}});
  for(let reload=0;reload<2;reload++){const s=(await get('/customers')).body.data.source;assert.equal(s.message,'Supabase connected · stored customer data');assert.equal(s.automaticSupabaseSync,true);assert.equal(s.automaticNutritionSync,false);assert.equal(s.sources.nutritionAdmin.state,'retained');}
  await DirectoryState.updateOne({_id:previous._id},{$set:{status:'partial','report.sources.supabase.state':'unavailable'}});
  assert.equal((await get('/customers')).body.data.source.message,'Supabase unavailable · showing saved data');
 }finally{await DirectoryState.updateOne({_id:previous._id},{$set:{status:previous.status,report:previous.report}});}
});
check('multi-contact history context validates every current canonical owner and stale or missing members',async()=>{
 const refs=['multi-route-a','multi-route-b'].map(externalContactId=>({scope:'multi-route',externalContactId,sourceRevision:3,customerId:'matter:3'}));
 const contacts=await SourceContact.create(refs.map(ref=>({...ref,matchState:'matched'})));
 const conversation=await Conversation.create({source:'gallabox_history',scope:'book',externalConversationId:'multi-route',customerId:'matter:3',sourceRevision:3,sourceMetadata:{historySourceIdentityState:'verified_same_customer',historySourceIdentities:refs}});await Issue.create({conversationId:conversation._id,customerId:'matter:3'});
 const state=async()=>{const context=(await get('/customers/matter%3A3/context')).body.data;const list=(await get('/customers?q=person3%40fixture.invalid')).body.data;assert.equal(list.records[0].matchState,context.matchState);return context.matchState;};
 assert.equal(await state(),'matched');await SourceContact.updateOne({_id:contacts[1]._id},{$set:{customerId:'matter:4'}});assert.equal(await state(),'linked_identity_unverified');await SourceContact.updateOne({_id:contacts[1]._id},{$set:{customerId:'matter:3',matchState:'conflict'}});assert.equal(await state(),'conflict');await SourceContact.updateOne({_id:contacts[1]._id},{$set:{matchState:'matched'}});assert.equal(await state(),'matched');await Conversation.updateOne({_id:conversation._id},{$set:{sourceRevision:4}});assert.equal(await state(),'linked_identity_unverified');await Conversation.updateOne({_id:conversation._id},{$set:{sourceRevision:3}});await SourceContact.deleteOne({_id:contacts[1]._id});assert.equal(await state(),'linked_identity_unverified');
});
check('full customer source status survives reload and reports source failure honestly',async()=>{
 const previous=await DirectoryState.findOne({key:'matter_customer_directory'}).lean();
 try{
 await DirectoryState.updateOne({_id:previous._id},{$set:{status:'ready',report:{nutritionDatabaseRead:{supabaseMirror:{verified:true}},sources:{nutritionDatabase:{state:'available'},supabase:{state:'available'}}}}});
 for(let reload=0;reload<2;reload++)assert.equal((await get('/customers')).body.data.source.message,'Live customer database');
 await DirectoryState.updateOne({_id:previous._id},{$set:{status:'partial','report.sources.nutritionDatabase.state':'unavailable'}});
 assert.equal((await get('/customers')).body.data.source.message,'Customer database unavailable · showing saved data');
 }finally{await DirectoryState.updateOne({_id:previous._id},{$set:{status:previous.status,report:previous.report}});}
});

check('scoped native sender identity is verified only for the complete reviewed conversation set',async()=>{
 const {nativeSenderConversationHash,reconcileServiceCustomerLinks,reconcileHistoricalCustomerLinks}=await import('../services/customerServiceIdentity.js');
 const account='b'.repeat(24),scope=`${account}:reviewed-channel`,phone='971507654322',customerId='matter:sender-reviewed',externalContactId='sender-reviewed';
 await Customer.create({customerId,name:'Sender reviewed fixture',phone,source:'fixture',sourceObservedAt:new Date(),sourceCoverage:'fixture',active:true,generation:'current'});
 const c=await Conversation.create({source:'gallabox',scope,externalConversationId:'reviewed-thread',sourceMetadata:{externalContactId}});
 const m=await Message.create({source:'gallabox',scope,externalMessageId:'reviewed-message',conversationId:c._id,externalAuthorId:externalContactId,authorType:'customer',sentAt:new Date(),type:'text',text:'Fixture',sourceMetadata:{externalContactId,verifiedCustomerEndpoint:{phone,accountId:account,channelId:'reviewed-channel',contactId:externalContactId,sender:externalContactId,externalMessageId:'reviewed-message',externalConversationId:c.externalConversationId,direction:'inbound',sourceSha256:'a'.repeat(64)}}});
 await Issue.create({conversationId:c._id,summary:'Reviewed fixture'});
 const contact=await SourceContact.create({scope,externalContactId,phone,multiplePhones:true,reviewedNativeSenderProof:{state:'reviewed',method:'native_customer_phone_endpoint',reviewedAt:new Date().toISOString(),scope,externalContactId,originalContactPhone:phone,originalContactEmail:'',originalMultiplePhones:true,originalMultipleEmails:false,phone,customerId,conversations:[{conversationId:String(c._id),messageCount:1,messageSha256:nativeSenderConversationHash([m.toObject()])}]}});
 await reconcileServiceCustomerLinks();const history=await Conversation.create({source:'gallabox_history',scope:'reviewed-book',externalConversationId:'reviewed-history',sourceRevision:1});await Message.create({source:'gallabox_history',scope:'reviewed-book',externalMessageId:m.externalMessageId,conversationId:history._id,sentAt:m.sentAt,text:m.text,sourceMetadata:{history:{sourceWorkbook:`messagereport-${account}_06Nov260706AM-fixture.xlsx`}}});await Issue.create({conversationId:history._id,summary:'Historical reviewed fixture'});await reconcileHistoricalCustomerLinks();
 let response=await get('/customers/'+encodeURIComponent(customerId)+'/context');assert.equal(response.status,200);assert.equal(response.body.data.matchState,'matched');assert.equal(response.body.data.issues.length,2);assert.ok(!JSON.stringify(response.body).includes('reviewedNativeSenderProof'));assert.equal((await SourceContact.findById(contact._id)).matchState,'reviewed_scoped');
 const unrelated=await Conversation.create({source:'gallabox',scope,externalConversationId:'unreviewed-thread',customerId,sourceMetadata:{externalContactId}});const unrelatedIssue=await Issue.create({conversationId:unrelated._id,customerId,summary:'Unreviewed fixture'});response=await get('/customers/'+encodeURIComponent(customerId)+'/context');assert.equal(response.body.data.matchState,'reviewed_scoped');await Issue.deleteOne({_id:unrelatedIssue._id});
 await Message.updateOne({_id:m._id},{$set:{text:'Changed source'}});response=await get('/customers/'+encodeURIComponent(customerId)+'/context');assert.equal(response.body.data.matchState,'reviewed_scoped');
});
