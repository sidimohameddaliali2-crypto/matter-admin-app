import test from 'node:test';import assert from 'node:assert/strict';import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import {readFile} from 'node:fs/promises';
import {createCloudStore,encodeCloudRecord,decodeCloudRecord} from '../services/customerServiceCloudStore.js';
import {createCloudInboxReader} from '../services/customerServiceCloudInbox.js';
const exec=promisify(execFile),enabled=process.env.CUSTOMER_SERVICE_CLOUD_TEST==='true',db='gallabox_fixture_'+Date.now(),base=['-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','65436','-U','gallabox_test'];
const transport=({sql,readOnly})=>new Promise((resolve,reject)=>{const p=spawn('/opt/homebrew/bin/psql',[...base,'-d',db,'-f','-'],{env:{...process.env,...(readOnly!==undefined?{PGOPTIONS:'-c default_transaction_read_only=on'}:{})}});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('close',code=>code?reject(Error(err)):resolve(out));p.stdin.end(sql);});
let store,reader;
test.before(async()=>{if(!enabled)return;await exec('/opt/homebrew/bin/psql',[...base,'-d','postgres','-c',`CREATE DATABASE ${db}`]);await transport({sql:await readFile(new URL('../migrations/20261107_gallabox_inbox.sql',import.meta.url),'utf8')});store=createCloudStore({env:{},transport});reader=createCloudInboxReader(store);});
test.after(async()=>{if(enabled)await exec('/opt/homebrew/bin/psql',[...base,'-d','postgres','-c',`DROP DATABASE ${db}`]);});
const cid='aaaaaaaaaaaaaaaaaaaaaaaa',actor={_id:'bbbbbbbbbbbbbbbbbbbbbbbb',role:'admin',isActive:true},profile={userId:actor._id,enabled:true,mode:'supervisor'};
const doc=(id,rest)=>({_id:id,...rest,updatedAt:new Date('2026-11-07T00:00:00Z')});
test('atomic cloud migration, paging, review retention, idempotency and conflict rejection',{skip:!enabled},async()=>{
 const rows=[encodeCloudRecord('serviceconversations',doc(cid,{source:'gallabox',scope:'account:channel',externalConversationId:'native-thread',customerName:'Real-source shape',sourceMetadata:{externalContactId:'contact'},lastMessageAt:'2026-11-07T10:00:00.000Z'})),...Array.from({length:3},(_,i)=>encodeCloudRecord('servicemessages',doc('c'.repeat(23)+i,{conversationId:cid,source:'gallabox',scope:'account:channel',externalMessageId:'native-'+i,authorType:'customer',text:'Message '+i,sentAt:`2026-11-07T0${i}:00:00.000Z`,sourceMetadata:{replyContext:{text:'Original quotation'}}}))),encodeCloudRecord('serviceissues',doc('d'.repeat(24),{conversationId:cid,summary:'Original issue',categoryIds:['delivery'],version:1})),encodeCloudRecord('servicereviews',doc('e'.repeat(24),{issueId:'d'.repeat(24),reviewerId:actor._id,revisions:[{note:'Preserve review'}],version:1}))];
 await store.stage('first',rows);await assert.rejects(store.commit({runId:'first',origin:'test-only',expectedRevision:0,capturedAt:new Date(),count:rows.length+1}),/Incomplete/);assert.equal(await store.head(),null);assert.equal(await store.record('serviceconversations',cid),null);
 const input={runId:'first',origin:'test-only',expectedRevision:0,capturedAt:new Date(),count:rows.length};assert.equal((await store.commit(input)).revision,1);assert.equal((await store.commit(input)).revision,1);
 assert.equal((await store.archivePage('servicereviews')).map(decodeCloudRecord)[0].revisions[0].note,'Preserve review');
 const page=await reader.detail({actor,profile,conversationId:cid,filters:{limit:2}});assert.equal(page.messages.length,2);assert.equal(page.hasMore,true);assert.equal(page.messages[0].text,'Message 1');assert.equal(page.messages[0].display.replyContext.text,'Original quotation');
 const older=await reader.detail({actor,profile,conversationId:cid,filters:{limit:2,cursor:page.nextCursor}});assert.equal(older.messages.length,1);assert.equal(older.messages[0].text,'Message 0');
 assert.equal((await reader.list({actor,profile,filters:{q:'shape'}})).conversations.length,1);
 assert.equal((await reader.list({actor,profile,filters:{q:'unmatched string'}})).conversations.length,0);
 assert.equal((await reader.list({actor,profile,filters:{categoryId:'delivery'}})).conversations.length,1);
 await assert.rejects(reader.list({actor,profile:{enabled:false},filters:{}}));
 await store.stage('review-change',[encodeCloudRecord('servicereviews',doc('e'.repeat(24),{issueId:'d'.repeat(24),reviewerId:actor._id,revisions:[{note:'Preserve review'},{note:'Second review'}],version:2}))]);
 await assert.rejects(store.commit({runId:'review-change',origin:'test-only',expectedRevision:0,capturedAt:new Date(),count:1}));
 await store.commit({runId:'review-change',origin:'test-only',expectedRevision:1,capturedAt:new Date(),count:1});
 assert.equal((await store.query("SELECT count(*)::integer FROM gallabox_private.inbox_record_history WHERE kind='servicereviews';")),1);
 assert.equal((await store.record('servicereviews','e'.repeat(24))).revisions.length,2);
 await assert.rejects(transport({sql:'SET ROLE anon; SELECT * FROM gallabox_private.inbox_record;'}));
});

test('real workflow saves reach cloud before acknowledgement and recover into a fresh cache',{skip:!enabled||!process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI},async()=>{
 const {default:mongoose}=await import('mongoose');const {randomUUID}=await import('node:crypto');
 const {createCloudPublisher,configureCloudInbox,restoreCloudCache}=await import('../services/customerServiceCloudStore.js');
 const {default:User}=await import('../models/User.js');const {default:Staff}=await import('../models/ServiceStaffProfile.js');const {default:Conversation}=await import('../models/ServiceConversation.js');const {default:Message}=await import('../models/ServiceMessage.js');const {default:Issue}=await import('../models/ServiceIssue.js');const {default:Review}=await import('../models/ServiceReview.js');const {default:Action}=await import('../models/ServiceAction.js');const {default:Command}=await import('../models/ServiceCommand.js');const {default:Allocation}=await import('../models/ServiceAllocationState.js');
 const {ingestServiceBatch}=await import('../services/customerServiceCapture.js');
 const {claimNextReview,submitServiceReview,updateServiceAction}=await import('../services/customerServiceWorkflow.js');
 const {getServiceConversationDetail}=await import('../services/customerServiceInbox.js');
 const name='matter_service_test_'+randomUUID().replaceAll('-',''),uri=process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI;assert.match(uri,/127\.0\.0\.1/);await mongoose.connect(uri,{dbName:name,autoIndex:false});let restoreDb;
 try{
  await transport({sql:'TRUNCATE gallabox_private.inbox_record_history,gallabox_private.inbox_record,gallabox_private.inbox_staging,gallabox_private.inbox_commit,gallabox_private.inbox_head;'});
  for(const m of Object.values(mongoose.models)){await m.createCollection();if(m.modelName!=='Customer')await m.createIndexes();}
  const [worker,reviewer]=await User.create(['worker','reviewer'].map(label=>({email:label+'@cloud-fixture.invalid',password:randomUUID(),role:'admin',isActive:true})));
  const memberships=await Staff.create([worker,reviewer].map(u=>({userId:u._id,mode:'reviewer',enabled:true,displayName:'Cloud fixture',availableMinutes:60,grants:['assignRequests']})));
  const c=await Conversation.create({source:'gallabox',scope:'test:only',externalConversationId:'fixture-thread',customerName:'Cloud test',sourceRevision:1});
  const msg=await Message.create({source:'gallabox',scope:'test:only',externalMessageId:'fixture-message',conversationId:c._id,authorType:'staff',authorId:worker._id,sentAt:new Date(),text:'We will correct the order.'});
  const issue=await Issue.create({conversationId:c._id,sourceRevision:1,evidenceMessageIds:[msg._id],contributorIds:[worker._id]});
  await Review.create({issueId:issue._id,reviewerId:reviewer._id,status:'assigned',sourceRevision:1});
  const publisher=createCloudPublisher({db:mongoose.connection.db,store,origin:name});await publisher.flush({full:true});await Message.deleteMany({});assert.equal(await Message.countDocuments(),0);configureCloudInbox({store,publisher,reader,hosted:true});
  await assert.rejects(ingestServiceBatch({}),/Source capture runs in Supabase/);
  const active=await claimNextReview({actor:reviewer,requestId:randomUUID()});
  const result=await submitServiceReview({actor:reviewer,reviewId:active._id,version:active.version,sourceRevision:1,verdict:'needs_work',summary:'Order correction',categoryIds:['wrong_meals'],outcome:'open',note:'Recorded staff confirmation',evidenceMessageIds:[msg._id],confirmIssueBoundary:true,requestId:randomUUID(),action:{description:'Confirm correction',ownerId:reviewer._id,dueAt:new Date(Date.now()+3600000).toISOString()}});
  assert.equal((await store.record('servicereviews',String(active._id))).revisions.length,1);
  const detail=await getServiceConversationDetail({actor:reviewer,profile:memberships[1],conversationId:String(c._id)});assert.equal(detail.storage,'supabase');assert.ok(detail.issues[0].categoryIds.includes('wrong_meals'));assert.equal(detail.actions.length,1);
  configureCloudInbox({store,publisher,reader:createCloudInboxReader({...store,query:async()=>{throw Error('Cloud offline');}})});await assert.rejects(getServiceConversationDetail({actor:reviewer,profile:memberships[1],conversationId:String(c._id)}),/Cloud offline/);configureCloudInbox({store,publisher,reader});
  await updateServiceAction({actor:reviewer,id:result.action._id,version:result.action.version,status:'in_progress',requestId:randomUUID()});assert.equal((await store.record('serviceactions',String(result.action._id))).status,'in_progress');
  const incoming={externalMessageId:'incoming-after-cloud-cutover',externalConversationId:'new-arrival-thread',authorType:'customer',text:'Automatic capture test only',sentAt:new Date().toISOString(),type:'text'};
  const capture={source:'gallabox',scope:'test:only',requestId:randomUUID(),messages:[incoming]};
  await ingestServiceBatch(capture);await ingestServiceBatch(capture);
  const savedIncoming=await Message.findOne({externalMessageId:incoming.externalMessageId}).lean();
  const incomingView=await getServiceConversationDetail({actor:reviewer,profile:memberships[1],conversationId:String(savedIncoming.conversationId)});
  assert.equal(incomingView.storage,'supabase');assert.equal(incomingView.messages.filter(m=>m.externalMessageId===incoming.externalMessageId).length,1);
  restoreDb=mongoose.connection.client.db(name+'_restored');const restored=await restoreCloudCache({db:restoreDb,store});assert.ok(restored.counts.servicereviews>=1);assert.equal((await restoreDb.collection('servicereviews').findOne({_id:active._id})).revisions.length,1);assert.equal((await restoreDb.collection('serviceactions').findOne()).status,'in_progress');
  await assert.rejects(restoreCloudCache({db:restoreDb,store}),/empty/);
 }finally{configureCloudInbox(null);if(restoreDb)await restoreDb.dropDatabase();await mongoose.connection.db.dropDatabase();await mongoose.disconnect();}
});
