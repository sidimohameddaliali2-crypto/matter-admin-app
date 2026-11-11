// Registry-wide persistence acceptance; every record here is synthetic and local.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import mongoose from 'mongoose';
import Staff from '../models/ServiceStaffProfile.js';
import Request from '../models/ServiceRequest.js';
import Issue from '../models/ServiceIssue.js';
import Review from '../models/ServiceReview.js';
import {getOwnServiceReviews,getServiceTeam} from '../services/customerServiceWorkflow.js';
import {getServiceSnapshot,buildServiceWorkbook} from '../services/customerServiceReports.js';
import {REQUEST_TOPIC_TAGS} from '../config/customerServiceTopicTags.js';
import {ACTION_VERSION,TOPIC_ACTIONS} from '../config/customerServiceActions.js';
import {REQUEST_TOPICS} from '../config/customerServiceRequests.js';
import {createCloudStore,configureCloudInbox,encodeCloudRecord} from '../services/customerServiceCloudStore.js';
import {createCloudTransportFromPool} from '../services/customerServiceCloudTransport.js';
import {createCloudInboxReader} from '../services/customerServiceCloudInbox.js';
import {createServiceStaffAuth} from '../services/customerServiceStaffAuth.js';
import {commandRequest,listRequestReport,listRequestFollowups} from '../services/customerServiceRequests.js';

const enabled=process.env.CUSTOMER_SERVICE_TEST_ISOLATED==='true'&&process.env.CUSTOMER_SERVICE_CLOUD_TEST==='true';
const db='gallabox_actions_qa_'+randomUUID().replaceAll('-','');
let admin,pool,head,owner,other;const coverage=[];
const fieldsFor=fields=>Object.fromEntries(fields.map(f=>[f.id,f.type==='checkbox'?true:f.type==='number'?120:f.type==='date'?'2026-11-12':'Synthetic attributable '+f.id]));
async function source(kind,body){const row=encodeCloudRecord(kind,body);await pool.query('INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES($1,$2,$3,$4,$5,1)',[row.kind,row.id,row.body,row.payload,row.sha256]);}
async function actor(label,mode,grants=[]){const id=String(new mongoose.Types.ObjectId()),user={_id:id,isActive:true,role:'viewer'};await pool.query("INSERT INTO gallabox_private.staff_directory VALUES($1,'fixture',$1,$2,$3,true,now())",[id,label,id+'@fixture.invalid']);await pool.query("INSERT INTO gallabox_private.staff_login(provider,subject,staff_id,evidence) VALUES('matter',$1,$1,'synthetic QA')",[id]);await Staff.create({userId:id,displayName:label,mode,enabled:true,grants});const auth=createServiceStaffAuth({supabase:{},resolve:async()=>user,fetchImpl:async()=>Response.json({success:true,data:{user}})});return(await auth.authenticate('Bearer cs-matter.fixture')).user;}
test.before(async()=>{
 if(!enabled)return;
 const config={host:'127.0.0.1',port:65436,user:'gallabox_test'};
 admin=new pg.Pool({...config,database:'postgres'});await admin.query('CREATE DATABASE '+db);pool=new pg.Pool({...config,database:db,max:5});
 for(const p of ['server/migrations/20261107_gallabox_inbox.sql','supabase/migrations/20261107204719_gallabox_hosted_capture.sql','supabase/migrations/20261107221358_gallabox_cloud_workflow.sql','supabase/migrations/20261107231821_gallabox_staff_login_links.sql','supabase/migrations/20261107233132_gallabox_message_time_index.sql','supabase/migrations/20261109032038_gallabox_request_workflow.sql','supabase/migrations/20261109120000_gallabox_request_issue_keys.sql'])await pool.query(fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/^CREATE EXTENSION.*\n/gm,''));
 await pool.query("INSERT INTO gallabox_private.inbox_head(singleton,origin) VALUES(true,'isolated-registry-qa');INSERT INTO gallabox_private.worker_control(singleton,enabled,writer_mode,workflow_mode,token_hash) VALUES(true,false,'cloud','cloud','synthetic');");
 const store=createCloudStore({transport:createCloudTransportFromPool(async()=>pool)});configureCloudInbox({store,workflow:true,reader:createCloudInboxReader(store)});
 head=await actor('QA lead','supervisor',['closeSensitive']);owner=await actor('QA handler','reviewer');other=await actor('QA other','reviewer');
});
test.after(async()=>{
 if(!enabled)return;
 if(process.env.CUSTOMER_SERVICE_QA_COVERAGE_OUTPUT)fs.writeFileSync(process.env.CUSTOMER_SERVICE_QA_COVERAGE_OUTPUT,JSON.stringify({synthetic:true,definitionVersion:ACTION_VERSION,coverage},null,2));
 configureCloudInbox(null);await pool?.end();if(admin){await admin.query('DROP DATABASE '+db);await admin.end();}
});
const scenarios=[...REQUEST_TOPICS.map(t=>({...t,workflowTopic:t.id})),...REQUEST_TOPIC_TAGS.flatMap(t=>t.includes.map(d=>({id:t.id,subtopic:d.id,label:t.label+' / '+d.label,workflowTopic:d.workflowTopic})))];
for(const topic of scenarios)test(topic.id+(topic.subtopic?'/'+topic.subtopic:'')+': every action/outcome persists for Complaint and Inquiry; roles, replay and reopen retain source',{skip:!enabled},async()=>{
 for(const creationScope of topic.subtopic?['conversation']:['conversation','message'])for(const kind of ['complaint','inquiry'])for(const action of TOPIC_ACTIONS[topic.workflowTopic])for(const outcome of action.outcomes||[null]){
  const conversationId=new mongoose.Types.ObjectId(),messageId=new mongoose.Types.ObjectId(),replyId=new mongoose.Types.ObjectId();
  await source('serviceconversations',{_id:conversationId,source:'gallabox',scope:'fixture',customerName:'Synthetic '+topic.label,externalConversationId:randomUUID(),lastMessageAt:new Date(),sourceMetadata:{providerInbox:{status:'open',assignment:'unassigned'}}});
  for(const [_id,authorType,text]of [[messageId,'customer','Synthetic request or withdrawal'],[replyId,'staff','Synthetic human answer already sent']])await source('servicemessages',{_id,conversationId,source:'gallabox',scope:'fixture',externalMessageId:randomUUID(),authorType,text,type:'text',sentAt:new Date()});
  const sourceBefore=(await pool.query("SELECT id,sha256 FROM gallabox_private.inbox_record WHERE kind IN ('serviceconversations','servicemessages') AND (id=$1 OR body->>'conversationId'=$1) ORDER BY id",[String(conversationId)])).rows;
  const input={actor:head,requestId:randomUUID(),operation:'work',...(creationScope==='conversation'?{conversationId:String(conversationId),issueKey:randomUUID()}:{messageId:String(messageId)}),ownerId:owner._id,classification:{kind,topic:topic.id,...(topic.subtopic?{subtopic:topic.subtopic}:{})},title:topic.label,definitionVersion:ACTION_VERSION,actionCode:action.code,outcomeCode:outcome?.code,details:fieldsFor([...(action.fields||[]),...(outcome?.fields||[])]),nextAction:'Confirm the requested operational change',dueAt:new Date(Date.now()+3600000).toISOString(),waitingOn:action.terminal?'':'Delivery',evidenceMessageId:String(outcome?.group==='withdrawn'?messageId:replyId)};
  await assert.rejects(commandRequest({...input,actor:owner}),e=>e.statusCode===403,'registration requires assignment authority');
  const saved=await commandRequest(input),read=await Request.findById(saved._id).lean();
  assert.deepEqual(await commandRequest(input),saved,'same command is idempotent');
  assert.equal(read.classification.kind,kind);assert.equal(read.classification.topic,topic.id);if(topic.subtopic)assert.equal(read.classification.subtopic,topic.subtopic);assert.equal(read.currentActionCode,action.code);assert.equal(String(read.ownerId),owner._id);assert.equal(read.status,action.terminal?'resolved':'waiting');
  if(outcome)assert.equal(read.resolution.outcomeCode,outcome.code);
  const body={id:String(saved._id),version:saved.version,operation:'work',...input,requestId:randomUUID()};delete body.messageId;delete body.ownerId;body.actor=other;
  await assert.rejects(commandRequest(body),e=>e.statusCode===403||e.statusCode===409,'unrelated staff cannot change issue');
  if(action.terminal){
   const pending=TOPIC_ACTIONS[topic.workflowTopic].find(a=>!a.terminal);
   assert.ok(pending,'each topic has a follow-up for explicit reopening');
   const reopened=await commandRequest({...body,actor:owner,actionCode:pending.code,outcomeCode:undefined,details:fieldsFor(pending.fields||[]),reopen:true,reopenReason:'Customer followed up about the same issue',reopenMessageId:String(messageId),waitingOn:'Customer'});
   assert.equal(reopened.status,'waiting');assert.deepEqual(reopened.resolution,saved.resolution,'prior outcome retained');assert.equal(reopened.history.length,saved.history.length+1);
  }else{
   await assert.rejects(commandRequest({...body,actor:owner,version:saved.version-1}),e=>e.statusCode===409);
   const invalid={...body,actor:owner,details:{...input.details},dueAt:'not a date'};
   await assert.rejects(commandRequest(invalid),e=>e.statusCode===400);
   assert.deepEqual(await Request.findById(saved._id).lean(),read,'invalid action preserves all fields/history');
  }
  assert.deepEqual((await pool.query("SELECT id,sha256 FROM gallabox_private.inbox_record WHERE kind IN ('serviceconversations','servicemessages') AND (id=$1 OR body->>'conversationId'=$1) ORDER BY id",[String(conversationId)])).rows,sourceBefore);
  coverage.push({creationScope,topic:topic.id,...(topic.subtopic?{subtopic:topic.subtopic}:{}),kind,action:action.code,outcome:outcome?.code||null,fields:[...(action.fields||[]),...(outcome?.fields||[])].map(f=>f.id),persistence:'passed',authorization:'passed',sourcePreservation:'passed',reopen:action.terminal?'passed':'not applicable',verdict:'passed'});
 }
});
test('all outcome drilldowns reconcile across every registry case and page',{skip:!enabled},async()=>{
 const report=await listRequestReport({actor:head,filters:{period:'all',limit:20}});
 // All terminal cases were explicitly reopened, so previous outcomes cannot count as resolved.
 assert.equal(report.outcomeCounts.pending,coverage.length);
 for(const group of ['information','fulfilled','not_fulfilled','withdrawn'])assert.equal((await listRequestReport({actor:head,filters:{period:'all',outcomeGroup:group}})).requests.length,0);
 let offset=0,total=0;do{const page=await listRequestReport({actor:head,filters:{period:'all',outcomeGroup:'pending',limit:20,offset}});total+=page.requests.length;offset=page.nextOffset;}while(offset!==null);
 assert.equal(total,coverage.length);
});
test('cloud-only review lists, supervisor team and export never require a Mongo connection',{skip:!enabled},async()=>{
 assert.equal(mongoose.connection.readyState,0);
 const issue=await Issue.create({conversationId:new mongoose.Types.ObjectId(),customerName:'Synthetic review',summary:'Review without Mongo',sourceRevision:1});
 await Review.create({issueId:issue._id,reviewerId:owner._id,status:'assigned',sourceRevision:1});
 const profile=await Staff.findOne({userId:owner._id}).lean();
 const reviews=await getOwnServiceReviews({actor:owner,profile,filters:{period:'all'}});assert.equal(reviews.length,1);assert.equal(reviews[0].issue.summary,'Review without Mongo');
 const headProfile=await Staff.findOne({userId:head._id}).lean(),team=await getServiceTeam({actor:head,profile:headProfile});assert.equal(team.members.length,3);assert.equal(team.candidates.length,3);
 const snapshot=await getServiceSnapshot({userId:head._id,supervise:true,filters:{period:'all'}});assert.equal(snapshot.profiles.length,3);assert.equal(snapshot.capture,null);assert.equal(snapshot.reviews.length,1);
 assert.ok((await buildServiceWorkbook(snapshot)).length>1000);assert.equal(mongoose.connection.readyState,0);
 const captureId=new mongoose.Types.ObjectId();await source('servicecapturebatches',{_id:captureId,status:'completed',source:'gallabox',createdAt:new Date('2026-11-09T06:00Z'),coverage:'Synthetic saved capture'});
 assert.equal(String((await getServiceSnapshot({userId:head._id,supervise:true,filters:{period:'all'}})).capture._id),String(captureId));
 await pool.query('UPDATE gallabox_private.staff_login SET active=false WHERE staff_id=$1',[owner._id]);
 try{const [disabled]=await Staff.find({userId:owner._id}).populate('userId','isActive').lean();assert.equal(disabled.userId,null);assert.equal((await getServiceTeam({actor:head,profile:headProfile})).candidates.length,2);}finally{await pool.query('UPDATE gallabox_private.staff_login SET active=true WHERE staff_id=$1',[owner._id]);}
});
test('saved next steps appear in Follow-ups once, stay scoped, and disappear on resolution',{skip:!enabled},async()=>{
 const cid=new mongoose.Types.ObjectId(),mid=new mongoose.Types.ObjectId();await source('serviceconversations',{_id:cid,source:'gallabox',scope:'fixture',customerName:'Synthetic next step',externalConversationId:randomUUID()});await source('servicemessages',{_id:mid,conversationId:cid,source:'gallabox',scope:'fixture',externalMessageId:randomUUID(),type:'text',text:'Please check the request',authorType:'customer',sentAt:new Date()});
 const input={actor:head,operation:'work',requestId:randomUUID(),messageId:String(mid),ownerId:other._id,classification:{kind:'inquiry',topic:'other'},definitionVersion:ACTION_VERSION,actionCode:'followup',details:{},nextAction:'Check the remaining request',dueAt:new Date(Date.now()-60000).toISOString(),waitingOn:'Finance'};
 let saved=await commandRequest(input);let list=await listRequestFollowups({actor:other});assert.equal(list.followups.length,1);assert.equal(list.followups[0].action,input.nextAction);assert.equal(String(list.followups[0].responsibleId),other._id);assert.equal(list.followups[0].source,'next_action');assert.equal((await listRequestFollowups({actor:other,filters:{queue:'overdue'}})).followups.length,1);
 assert.equal((await listRequestFollowups({actor:other,filters:{q:'no match'}})).followups.length,0);
 saved=await commandRequest({actor:other,operation:'followup',requestId:randomUUID(),id:String(saved._id),version:saved.version,action:'Explicit existing obligation',dueAt:new Date(Date.now()+3600000).toISOString()});
 list=await listRequestFollowups({actor:other});assert.equal(list.followups.length,1,'embedded obligation replaces the projected next step');assert.equal(list.followups[0].action,'Explicit existing obligation');
 saved=await commandRequest({actor:other,operation:'followup_update',requestId:randomUUID(),id:String(saved._id),version:saved.version,followupId:saved.followups[0].id,completed:true,evidence:'Synthetic operational confirmation',reason:'Work completed'});
 saved=await commandRequest({actor:other,operation:'work',requestId:randomUUID(),id:String(saved._id),version:saved.version,definitionVersion:ACTION_VERSION,actionCode:'complete',outcomeCode:'action_completed',details:{result:'Synthetic requested change completed',customerInformed:true},evidenceReference:'Synthetic confirmed completion'});
 list=await listRequestFollowups({actor:other});assert.equal(list.followups.filter(f=>f.source==='next_action').length,0);assert.equal(list.followups.filter(f=>f.status==='completed').length,1,'recorded completion history remains');
});
