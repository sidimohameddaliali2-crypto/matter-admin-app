import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import express from 'express';
import pg from 'pg';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Staff from '../models/ServiceStaffProfile.js';
import authRoutes from '../routes/auth.js';
import serviceRoutes from '../routes/customerService.js';
import {createCloudStore,configureCloudInbox,encodeCloudRecord} from '../services/customerServiceCloudStore.js';
import {createCloudTransportFromPool} from '../services/customerServiceCloudTransport.js';
import {startCustomerServiceDestination} from '../services/customerServiceDestination.js';
import {mountCustomerServiceInAdmin} from '../services/customerServiceAdminMount.js';
import {applyLocalIssueKeyMigration,privateTableSignatures} from '../services/customerServiceIssueMigration.js';
import {ACTION_VERSION} from '../config/customerServiceActions.js';

const enabled=process.env.CUSTOMER_SERVICE_TEST_ISOLATED==='true'&&process.env.CUSTOMER_SERVICE_CLOUD_TEST==='true';
const name='gallabox_migration_test_'+randomUUID().replaceAll('-','');
const mongoUri=process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI;
let admin,pool,store,runtime,server,url,app,head,staff,unlinked,headId,staffId,conversationId,messageId,replyId,legacyId,baseline,originalSecret;
const password='Fictional local test only 2026!';
const id=()=>String(new mongoose.Types.ObjectId());
async function insert(kind,body){
 const row=encodeCloudRecord(kind,body),client=await pool.connect();
 try{await client.query("BEGIN; SET LOCAL gallabox.workflow_writer='cloud'");await client.query('INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES($1,$2,$3,$4,$5,1)',[row.kind,row.id,row.body,row.payload,row.sha256]);await client.query('COMMIT');return row;}
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function http(path,token,body,method=body?'POST':'GET'){
 const response=await fetch(url+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 return {status:response.status,body:await response.json()};
}
async function login(account){const result=await http('/api/auth/login',null,{email:account.email,password});assert.equal(result.status,200);return result.body.data.token;}
async function duplicate(body){
 const client=await pool.connect();try{await client.query("BEGIN; SET LOCAL gallabox.workflow_writer='cloud'");const row=encodeCloudRecord('servicerequests',body);await client.query('INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES($1,$2,$3,$4,$5,1)',[row.kind,row.id,row.body,row.payload,row.sha256]);await client.query('ROLLBACK');}
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

test.before(async()=>{
 if(!enabled)return;
 assert.match(mongoUri||'',/^mongodb:\/\/127\.0\.0\.1:/);
 originalSecret=process.env.JWT_SECRET;process.env.JWT_SECRET=randomUUID();
 admin=new pg.Pool({host:'127.0.0.1',port:65436,user:'gallabox_test',database:'postgres'});await admin.query('CREATE DATABASE '+name);
 pool=new pg.Pool({host:'127.0.0.1',port:65436,user:'gallabox_test',database:name,max:3});
 for(const file of ['server/migrations/20261107_gallabox_inbox.sql','supabase/migrations/20261107204719_gallabox_hosted_capture.sql','supabase/migrations/20261107221358_gallabox_cloud_workflow.sql','supabase/migrations/20261107231821_gallabox_staff_login_links.sql','supabase/migrations/20261107233132_gallabox_message_time_index.sql','supabase/migrations/20261109032038_gallabox_request_workflow.sql'])await pool.query((await fs.readFile(file,'utf8')).replace(/^CREATE EXTENSION.*\n/gm,''));
 await pool.query("INSERT INTO gallabox_private.inbox_head(singleton,origin) VALUES(true,'isolated-existing-app'); INSERT INTO gallabox_private.worker_control(singleton,enabled,writer_mode,workflow_mode,token_hash) VALUES(true,false,'cloud','cloud','fictional');");
 await mongoose.connect(mongoUri,{dbName:name});
 [head,staff,unlinked]=await User.create(['head','staff','unlinked'].map(label=>({email:label+'@fixture.invalid',password,role:'viewer',isActive:true,permissionsConfigured:true,permissions:{customer_service:true},profile:{firstName:'Local '+label}})));
 headId=id();staffId=id();
 for(const [account,canonical,mode,grants]of [[head,headId,'supervisor',['closeSensitive','approveExceptions']],[staff,staffId,'reviewer',[]]]){
  await pool.query("INSERT INTO gallabox_private.staff_directory VALUES($1,'fixture',$1,$2,$3,true,now());",[canonical,'Local '+mode,account.email]);
  await pool.query("INSERT INTO gallabox_private.staff_login(provider,subject,staff_id,evidence) VALUES('matter',$1,$2,'isolated verified existing app identity')",[String(account._id),canonical]);
  const profile=new mongoose.models.ServiceStaffProfile({userId:canonical,enabled:true,mode,grants});
  const client=await pool.connect();try{await client.query("BEGIN; SET LOCAL gallabox.workflow_writer='cloud'");const row=encodeCloudRecord('servicestaffprofiles',profile.toObject());await client.query('INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES($1,$2,$3,$4,$5,1)',[row.kind,row.id,row.body,row.payload,row.sha256]);await client.query('COMMIT');}finally{client.release();}
 }
 conversationId=id();messageId=id();replyId=id();legacyId=id();
 await insert('serviceconversations',{_id:conversationId,source:'gallabox',scope:'fixture',externalConversationId:'local-existing-app',customerName:'Fictional migration customer',lastMessageAt:new Date('2026-11-10T06:12:00Z'),sourceMetadata:{externalContactId:'local-fixture',providerInbox:{status:'open',assignment:'assigned',assigneeId:'staff',observedAt:'2026-11-10T06:12:00Z'}}});
 await insert('servicemessages',{_id:id(),conversationId,source:'gallabox',scope:'fixture',externalMessageId:'local-start',authorType:'system',sentAt:new Date('2026-11-10T06:10:00Z'),type:'system',sourceMetadata:{systemEvent:{action:'initiate'}}});
 await insert('servicemessages',{_id:messageId,conversationId,source:'gallabox',scope:'fixture',externalMessageId:'local-request',authorType:'customer',text:'Please explain my invoice and check the refund.',sentAt:new Date('2026-11-10T06:11:00Z'),type:'text'});
 await insert('servicemessages',{_id:replyId,conversationId,source:'gallabox',scope:'fixture',externalMessageId:'local-human-reply',authorType:'staff',authorId:staffId,authorName:'Local staff',text:'Here is the invoice explanation; the refund is still being checked.',sentAt:new Date('2026-11-10T06:12:00Z'),type:'text'});
 // Legacy key is deliberately absent. Include archived history and an old
 // command receipt so migration preservation is more than an empty-table test.
 const old={_id:legacyId,conversationId,originMessageId:messageId,evidenceMessageIds:[messageId],title:'Existing invoice issue',excerpt:'Please explain my invoice',receivedAt:new Date('2026-11-10T06:11:00Z'),ownerId:staffId,classification:{kind:'inquiry',topic:'billing',group:'Finance'},status:'open',version:1,history:[{event:'create',reason:'Pre-migration saved history',actorId:headId,at:'2026-11-10T06:11:30Z'}]};
 await insert('servicerequests',old);await insert('servicecommands',{_id:id(),requestId:'old-command-'+randomUUID(),kind:'legacy',actorId:headId,result:{preserved:true}});
 const review=await insert('servicereviews',{_id:id(),issueId:id(),reviewerId:staffId,sampleKey:'primary',status:'submitted',summary:'Original saved review',revisions:[{note:'Original review revision',at:'2026-11-09T06:00:00Z'}]});
 await pool.query('INSERT INTO gallabox_private.inbox_record_history(kind,id,revision,payload,sha256) VALUES($1,$2,0,$3,$4)',[review.kind,review.id,review.payload,review.sha256]);
 baseline=await privateTableSignatures(pool);
 store=createCloudStore({transport:createCloudTransportFromPool(async()=>pool)});
 app=express();app.use(express.json());
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));url='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{
 if(!enabled)return;
 if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await runtime?.stop();configureCloudInbox(null);
 if(mongoose.connection.readyState){await mongoose.connection.db.dropDatabase();await mongoose.disconnect();}
 await pool?.end();if(admin){await admin.query('DROP DATABASE IF EXISTS '+name);await admin.end();}
 if(originalSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=originalSecret;
});
const run=(name,fn)=>test(name,{skip:!enabled},fn);

run('populated old schema rejects a second issue and destination startup fails closed',async()=>{
 await assert.rejects(duplicate({_id:id(),conversationId,originMessageId:messageId,originIssueKey:'conversation:'+randomUUID()}),error=>error.code==='23505');
 await assert.rejects(startCustomerServiceDestination({app,env:{CUSTOMER_SERVICE_STORAGE:'supabase'},store}),/issue-key migration/);
 assert.deepEqual(await privateTableSignatures(pool),baseline);
});
run('local reviewed migration preserves every private table and supports idempotent verification',async()=>{
 await assert.rejects(applyLocalIssueKeyMigration({pool,isolated:false,apply:true}),/isolated/);
 const preflight=await applyLocalIssueKeyMigration({pool,isolated:true});assert.equal(preflight.status,'ready');assert.deepEqual(preflight.tables,baseline);
 const interrupted={options:pool.options,connect:async()=>{
  const client=await pool.connect();return {release:()=>client.release(),query:async(...args)=>{
   const result=await client.query(...args);
   if(typeof args[0]==='string'&&args[0].includes('CREATE UNIQUE INDEX gallabox_request_origin_issue'))throw Error('Simulated interruption after index replacement');
   return result;
  }};
 }};
 await assert.rejects(applyLocalIssueKeyMigration({pool:interrupted,isolated:true,apply:true}),/Simulated interruption/);
 assert.equal((await pool.query("SELECT to_regclass('gallabox_private.gallabox_request_origin') IS NOT NULL AND to_regclass('gallabox_private.gallabox_request_origin_issue') IS NULL AS protected")).rows[0].protected,true);
 assert.deepEqual(await privateTableSignatures(pool),baseline);
 const receipt=await applyLocalIssueKeyMigration({pool,isolated:true,apply:true});assert.equal(receipt.status,'applied');assert.deepEqual(receipt.tables,baseline);
 assert.equal((await applyLocalIssueKeyMigration({pool,isolated:true,apply:true})).status,'already_applied');
 await assert.rejects(duplicate({_id:id(),conversationId,originMessageId:messageId,originIssueKey:'primary'}),error=>error.code==='23505');
 assert.equal((await pool.query("SELECT body ? 'originIssueKey' AS present FROM gallabox_private.inbox_record WHERE kind='servicerequests' AND id=$1",[legacyId])).rows[0].present,false);
});
run('unchanged existing login and token map to the linked canonical identity without new login routes',async()=>{
 const installed=mountCustomerServiceInAdmin({app,env:{CUSTOMER_SERVICE_STORAGE:'supabase'},store});
 app.use('/api/auth',authRoutes);
 runtime=await installed.ready;assert.ok(runtime);assert.equal(installed.hosted,true);
 const token=await login(head),who=await http('/api/auth/me',token),service=await http('/api/customer-service/me',token);
 assert.equal(who.body.data.user._id,String(head._id));assert.equal(service.body.data.profile.userId,headId);assert.notEqual(headId,String(head._id));
 assert.equal(service.body.data.capabilities.assignRequests,true);assert.equal(service.body.data.capabilities.closeSensitive,true);
 const staffMe=await http('/api/customer-service/me',await login(staff));assert.equal(staffMe.body.data.profile.userId,staffId);assert.equal(staffMe.body.data.capabilities.assignRequests,false);assert.equal(staffMe.body.data.capabilities.closeSensitive,false);
 const definitions=await http('/api/customer-service/requests/definitions',token);assert.equal(definitions.status,200);
 assert.deepEqual(definitions.body.data.topics.map(t=>t.label),['Delivery Issues','Bags & Collections','Meal Accuracy','Damaged Food & Packaging','Food Quality','Food Safety & Allergies','Plan & Subscription','Menu & Meal Selection','Payments & Refunds','Website & Account']);
 assert.equal(definitions.body.data.topics.flatMap(t=>t.includes).length,50);assert.equal(definitions.body.data.legacyTopics.length,17);
 assert.equal((await http('/api/auth/login',null,{email:head.email,password:'wrong'})).status,401);
 assert.equal((await http('/api/customer-service/me','cs-matter.invented')).status,401);
 assert.equal((await http('/api/customer-service/me',jwt.sign({id:String(head._id)},'wrong-key'))).status,401);
 assert.deepEqual(await privateTableSignatures(pool),baseline);
});
run('unlinked, revoked, disabled and page-denied existing accounts receive no service access or new grants',async()=>{
 const token=await login(head);assert.equal((await http('/api/customer-service/conversations',await login(unlinked))).status,403);
 await pool.query("UPDATE gallabox_private.staff_login SET active=false WHERE staff_id=$1",[headId]);assert.equal((await http('/api/customer-service/me',token)).status,403);
 await pool.query("UPDATE gallabox_private.staff_login SET active=true WHERE staff_id=$1",[headId]);
 await User.updateOne({_id:head._id},{$set:{'permissions.customer_service':false}});assert.equal((await http('/api/customer-service/me',token)).status,403);
 await User.updateOne({_id:head._id},{$set:{'permissions.customer_service':true,isActive:false}});assert.equal((await http('/api/customer-service/me',token)).status,401);
 await User.updateOne({_id:head._id},{$set:{isActive:true}});assert.equal((await http('/api/customer-service/me',token)).status,200);
 assert.deepEqual(await privateTableSignatures(pool),baseline);
});
let first,second,headToken,staffToken;
run('existing app sessions create independent conversation issues while ordinary staff cannot assign',async()=>{
 headToken=await login(head);staffToken=await login(staff);
 const input={conversationId,issueKey:randomUUID(),title:'New invoice question',classification:{kind:'inquiry',topic:'tag_plan',subtopic:'billing_issue'},ownerId:staffId,nextAction:'Explain invoice',dueAt:'2026-11-11T08:00:00Z',requestId:randomUUID()};
 assert.equal((await http('/api/customer-service/requests',staffToken,input)).status,403);
 assert.equal((await http('/api/customer-service/requests',headToken,{...input,requestId:randomUUID(),classification:{kind:'inquiry',topic:'tag_plan'}})).status,400);
 assert.equal((await http('/api/customer-service/requests',headToken,{...input,requestId:randomUUID(),classification:{kind:'inquiry',topic:'tag_plan',subtopic:'website_issue',workflowTopic:'billing'}})).status,400);
 const saved=await http('/api/customer-service/requests',headToken,input);assert.equal(saved.status,200);first=saved.body.data;
 assert.equal(first.contextScope,'conversation');assert.equal(new Date(first.receivedAt).toISOString(),'2026-11-10T06:10:00.000Z');
 const repeated=await http('/api/customer-service/requests',headToken,input);assert.equal(repeated.status,200);assert.equal(repeated.body.data._id,first._id);
 const sibling=await http('/api/customer-service/requests',headToken,{...input,title:'Refund request',classification:{kind:'complaint',topic:'tag_payments',subtopic:'refund_status'},issueKey:randomUUID(),requestId:randomUUID()});assert.equal(sibling.status,200);second=sibling.body.data;
 assert.notEqual(first._id,second._id);assert.equal(first.originMessageId,second.originMessageId);
});
run('supported completion preserves sibling, original messages, reviews and source provider state',async()=>{
 const sourceBefore=(await pool.query("SELECT kind,id,body,payload,sha256,revision FROM gallabox_private.inbox_record WHERE kind IN ('servicemessages','serviceconversations','servicereviews') ORDER BY kind,id")).rows;
 const siblingBefore=(await pool.query("SELECT * FROM gallabox_private.inbox_record WHERE kind='servicerequests' AND id=$1",[second._id])).rows;
 const input={operation:'work',version:first.version,requestId:randomUUID(),definitionVersion:ACTION_VERSION,classification:first.classification,ownerId:staffId,actionCode:'answer',outcomeCode:'information_provided',details:{noRemainingAction:true},evidenceMessageId:replyId};
 const saved=await http('/api/customer-service/requests/'+first._id+'/commands',staffToken,input);assert.equal(saved.status,200);first=saved.body.data;assert.equal(first.status,'resolved');
 const sensitive=await http('/api/customer-service/requests/'+second._id+'/commands',staffToken,{...input,version:second.version,requestId:randomUUID(),classification:second.classification,actionCode:'refund',outcomeCode:'refund_processed',details:{amount:10,currency:'AED',transactionReference:'FICTIONAL-LOCAL',refundAuthorized:true,refundProcessed:true,customerInformed:true},evidenceReference:'Fictional Finance confirmation'});assert.equal(sensitive.status,403);
 assert.deepEqual((await pool.query("SELECT * FROM gallabox_private.inbox_record WHERE kind='servicerequests' AND id=$1",[second._id])).rows,siblingBefore);
 assert.deepEqual((await pool.query("SELECT kind,id,body,payload,sha256,revision FROM gallabox_private.inbox_record WHERE kind IN ('servicemessages','serviceconversations','servicereviews') ORDER BY kind,id")).rows,sourceBefore);
 const legacy=(await pool.query("SELECT body FROM gallabox_private.inbox_record WHERE kind='servicerequests' AND id=$1",[legacyId])).rows[0].body;assert.equal(legacy.history[0].reason,'Pre-migration saved history');
 await runtime.stop();runtime=await startCustomerServiceDestination({app,env:{CUSTOMER_SERVICE_STORAGE:'supabase'},store});
 const reloaded=await http('/api/customer-service/requests?queue=conversation&conversationId='+conversationId,headToken);assert.equal(reloaded.status,200);
 assert.equal(reloaded.body.data.requests.find(r=>r._id===first._id).status,'resolved');assert.equal(reloaded.body.data.requests.find(r=>r._id===second._id).status,'open');
});
