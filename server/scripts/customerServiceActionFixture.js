// Explicit loopback-only fixtures for reviewing the real application. No provider
// client, hosted credential or production server is loaded by this entry path.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import express from 'express';
import pg from 'pg';
import mongoose from 'mongoose';
import {createCloudStore,configureCloudInbox,encodeCloudRecord} from '../services/customerServiceCloudStore.js';
import {createCloudTransportFromPool} from '../services/customerServiceCloudTransport.js';
import {createCloudInboxReader} from '../services/customerServiceCloudInbox.js';
import {createServiceStaffAuth} from '../services/customerServiceStaffAuth.js';
import Staff from '../models/ServiceStaffProfile.js';
import Request from '../models/ServiceRequest.js';
import {REQUEST_TOPICS} from '../config/customerServiceRequests.js';
import service from '../routes/customerService.js';
import data from '../routes/customerServiceData.js';
import customers from '../routes/customerServiceCustomers.js';
import {createServiceMediaRouter} from '../routes/customerServiceMedia.js';
import {seedActionQa,createQaMediaProvider} from './customerServiceActionQa.js';

export async function startActionFixture(root){
 if(process.env.CUSTOMER_SERVICE_TEST_ISOLATED!=='true')throw Error('Explicit isolated review required.');
 const directory=path.join(root,'work/action-flow');fs.mkdirSync(directory,{recursive:true});
 const manifestPath=path.join(directory,'fixture.private.json');
 let manifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):null;
 if(process.env.CUSTOMER_SERVICE_SIDEBAR_SANDBOX==='true'&&manifest&&manifest.fictional!==true)throw Error('Sidebar sandbox may only reuse a fictional manifest.');
 const config={host:'127.0.0.1',port:65436,user:'gallabox_test'};
 const admin=new pg.Pool({...config,database:'postgres'});
 const db=manifest?.database||'gallabox_action_preview_'+randomUUID().replaceAll('-','');
 if(!/^gallabox_action_preview_[a-f0-9]{32}$/.test(db))throw Error('Invalid isolated database.');
 if(!manifest)await admin.query('CREATE DATABASE '+db);
 const pool=new pg.Pool({...config,database:db,max:5});
 if(!manifest){
  for(const file of ['server/migrations/20261107_gallabox_inbox.sql','supabase/migrations/20261107204719_gallabox_hosted_capture.sql','supabase/migrations/20261107221358_gallabox_cloud_workflow.sql','supabase/migrations/20261107231821_gallabox_staff_login_links.sql','supabase/migrations/20261107233132_gallabox_message_time_index.sql','supabase/migrations/20261109032038_gallabox_request_workflow.sql','supabase/migrations/20261109120000_gallabox_request_issue_keys.sql'])await pool.query(fs.readFileSync(path.join(root,file),'utf8').replace(/^CREATE EXTENSION.*\n/gm,''));
  await pool.query("INSERT INTO gallabox_private.inbox_head(singleton,origin) VALUES(true,'local-fictional-action-review'); INSERT INTO gallabox_private.worker_control(singleton,enabled,writer_mode,workflow_mode,token_hash) VALUES(true,false,'cloud','cloud','local-fictional');");
 }
 const store=createCloudStore({transport:createCloudTransportFromPool(async()=>pool)});
 configureCloudInbox({store,workflow:true,reader:createCloudInboxReader(store)});
 const source=async(kind,body)=>{const row=encodeCloudRecord(kind,body);await pool.query('INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES($1,$2,$3,$4,$5,1)',[row.kind,row.id,row.body,row.payload,row.sha256]);};
 if(!manifest){
  manifest={database:db,fictional:true,users:{},conversations:{}};
  for(const [role,name,mode,grants]of [['head','Local review lead','supervisor',['closeSensitive','approveExceptions']],['staff','Mariolle — demo','reviewer',[]],['adrian','Adrian — demo','reviewer',[]]]){
   const id=String(new mongoose.Types.ObjectId());await pool.query("INSERT INTO gallabox_private.staff_directory VALUES($1,'fixture-account',$2,$3,$4,true,now())",[id,role,name,role+'@fixture.invalid']);
   await pool.query("INSERT INTO gallabox_private.staff_login(provider,subject,staff_id,evidence) VALUES('matter',$1,$1,'local fictional review')",[id]);
   await Staff.create({userId:id,mode,enabled:true,displayName:name,grants});manifest.users[role]=id;
  }
  const names=['Alex Morgan','Casey Park','Taylor Reed','Jamie Brooks','Robin Ellis','Sam Patel','Morgan Blake','Riley Chen','Jordan Hayes','Cameron Dale','Sam Lee','Drew Lane','Avery Quinn','Parker Ross','Quinn Reed','Reese Bell','Charlie West'];
  const stamp=Date.now()-90*60000;
  for(const [i,topic]of REQUEST_TOPICS.entries()){
   const conversationId=new mongoose.Types.ObjectId(),messageId=new mongoose.Types.ObjectId();manifest.conversations[topic.id]=String(conversationId);
   await source('serviceconversations',{_id:conversationId,source:'gallabox',scope:'fixture-account:fixture-channel',externalConversationId:'fictional-'+topic.id,customerName:names[i],lastMessageAt:new Date(stamp+i*60000),sourceMetadata:{externalContactId:'fictional-'+topic.id,providerInbox:{status:'open',assignment:'assigned',assigneeId:'staff',assigneeType:'user',assigneeName:'Mariolle — demo',observedAt:new Date().toISOString()}}});
   const question=topic.id==='pause'?'Please pause my meals for Tuesday. Also, my delivery went to the wrong address.':topic.id==='nutrition'?'How much protein is in this meal?':topic.id==='refund'?'Please check my cancellation and refund request.':'Please help me with '+topic.label.toLowerCase()+'.';
   await source('servicemessages',{_id:messageId,conversationId,source:'gallabox',scope:'fixture-account:fixture-channel',externalMessageId:'fictional-source-'+topic.id,authorType:'customer',text:question,sentAt:new Date(stamp+i*60000),type:'text'});
   await source('servicemessages',{_id:new mongoose.Types.ObjectId(),conversationId,source:'gallabox',scope:'fixture-account:fixture-channel',externalMessageId:'fictional-answer-'+topic.id,externalAuthorId:'staff',authorType:'staff',authorName:'Mariolle — demo',text:topic.id==='nutrition'?'The example meal has 35g protein. This is fictional demonstration information.':'I am checking this for you and will update you here.',sentAt:new Date(stamp+i*60000+60000),type:'text'});
   if(topic.id!=='nutrition')await Request.create({conversationId,originMessageId:messageId,evidenceMessageIds:[messageId],excerpt:question,title:topic.id==='pause'?'Pause meals':topic.label,customerName:names[i],receivedAt:new Date(stamp+i*60000),ownerId:manifest.users.staff,assignedAt:new Date(stamp+i*60000+60000),classification:{kind:topic.id==='food_quality'||topic.id==='delivery_missed'?'complaint':'inquiry',topic:topic.id,group:topic.group},nextAction:{action:'Check '+topic.label.toLowerCase(),dueAt:new Date(Date.now()+3600000)},history:[{event:'create',actorId:manifest.users.head,at:new Date(stamp+i*60000+60000),reason:'Fictional local review item',after:{ownerId:manifest.users.staff,status:'open'}}]});
   if(topic.id==='pause')await Request.create({conversationId,originMessageId:messageId,evidenceMessageIds:[messageId],originIssueKey:'split:fictional-delivery',excerpt:question,title:'Wrong-address delivery',customerName:names[i],receivedAt:new Date(stamp+i*60000),ownerId:manifest.users.adrian,status:'waiting',waitingOn:'Delivery',classification:{kind:'complaint',topic:'delivery_missed',group:'Delivery'},nextAction:{action:'Check redelivery',dueAt:new Date(Date.now()+7200000)},history:[]});
  }
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600});
 }
 const tokens=new Map();
 // Additive and idempotent: existing review messages, work and history are untouched.
 await seedActionQa({root,manifest,pool,source});
 for(const [role,id]of Object.entries(manifest.users)){
  const user={_id:id,isActive:true,role:'viewer',profile:{firstName:role==='head'?'Local review lead':role==='staff'?'Mariolle — demo':'Adrian — demo'},permissions:{customer_service:true},permissionsConfigured:true,serviceOnly:true};
  const verifier=createServiceStaffAuth({supabase:{},resolve:async()=>user,fetchImpl:async()=>Response.json({success:true,data:{user}})});
  const result=await verifier.authenticate('Bearer cs-matter.local-fictional');
  let token=randomUUID();
  if(process.env.CUSTOMER_SERVICE_SIDEBAR_SANDBOX==='true'){manifest.sidebarSandboxTokens||={};token=manifest.sidebarSandboxTokens[role]||token;manifest.sidebarSandboxTokens[role]=token;}
  tokens.set(role,{token,user:result.user});
 }
 if(process.env.CUSTOMER_SERVICE_SIDEBAR_SANDBOX==='true')fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600});
 const app=express();app.use(express.json());app.set('customerServiceAuth',{authenticate:async header=>{const result=[...tokens.values()].find(x=>header==='Bearer '+x.token);if(!result)throw Object.assign(Error('Local session expired'),{statusCode:401});return {user:result.user};}});
 if(process.env.CUSTOMER_SERVICE_SIDEBAR_SANDBOX==='true'){
  const {installSidebarSandbox}=await import('./customerServiceSidebarSandbox.js');
  await installSidebarSandbox({app,pool,manifest,manifestPath,root,tokens});
 }
 app.get('/local-review',(req,res)=>res.type('html').send('<!doctype html><title>Matter local review</title><h1>Matter local workflow review</h1><p>Fictional records only. Changes stay in a separate local test database; nothing is sent or deployed.</p><p><a href="/test/session/head">Review as lead</a> · <a href="/test/session/staff">Review as Mariolle</a> · <a href="/test/session/adrian">Review as Adrian</a></p>'));
 app.get('/test/session/:role',(req,res)=>{const entry=tokens.get(req.params.role);if(!entry)return res.sendStatus(404);res.set('Cache-Control','no-store').type('html').send('<!doctype html><title>Matter local session</title><script>localStorage.setItem("token",'+JSON.stringify(entry.token)+');localStorage.setItem("user",'+JSON.stringify(JSON.stringify(entry.user))+');location.replace("/customer-service/chats?period=all");</script>');});
 app.get('/api/auth/me',async(req,res)=>{try{res.json({success:true,data:{user:(await app.get('customerServiceAuth').authenticate(req.headers.authorization)).user}});}catch{res.sendStatus(401);}});
 app.get('/api/customer-service/capture-health',(req,res)=>res.json({success:true,data:{control:{enabled:false},fictional:true}}));
 app.get(['/api/customer-service/metrics','/api/customer-service/gallabox/sync'],async(req,res)=>{try{await app.get('customerServiceAuth').authenticate(req.headers.authorization);res.json({success:true,data:{unavailable:true,enabled:false,reason:'Live provider capture and provider metrics are disabled in this fictional local review. Customer issue outcomes use the saved local work records.'}});}catch{res.sendStatus(401);}});
 app.use('/api/customer-service',createServiceMediaRouter({fetchImpl:createQaMediaProvider(root)}),customers,data,service);
 app.use(express.static(path.join(root,'client/build')));app.get('*',(req,res)=>res.sendFile(path.join(root,'client/build/index.html')));
 const port=Number(process.env.CUSTOMER_SERVICE_PREVIEW_PORT||51033);const server=app.listen(port,'127.0.0.1',()=>console.log('Local fictional workflow review: http://127.0.0.1:'+port+'/local-review'));
 // Stop without deleting any fixture work or recovery history. Restart reuses it.
 const stop=async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));configureCloudInbox(null);await pool.end();await admin.end();};
 process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));process.once('SIGINT',()=>stop().then(()=>process.exit(0)));
 return {app,server,store,pool,manifest};
}
