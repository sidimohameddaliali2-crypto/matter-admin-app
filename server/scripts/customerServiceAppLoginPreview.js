// Existing app login + canonical workflow, confined to a preserved local copy.
// No environment secrets, provider clients, driver jobs or live database loaded.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import express from 'express';
import pg from 'pg';
import mongoose from 'mongoose';
import User from '../models/User.js';
import authRoutes from '../routes/auth.js';
import service from '../routes/customerService.js';
import data from '../routes/customerServiceData.js';
import customers from '../routes/customerServiceCustomers.js';
import {createServiceMediaRouter} from '../routes/customerServiceMedia.js';
import {createQaMediaProvider} from './customerServiceActionQa.js';
import {createCloudStore,encodeCloudRecord} from '../services/customerServiceCloudStore.js';
import {createCloudTransportFromPool} from '../services/customerServiceCloudTransport.js';
import {startCustomerServiceDestination} from '../services/customerServiceDestination.js';
import {applyLocalIssueKeyMigration,privateTableSignatures} from '../services/customerServiceIssueMigration.js';

export async function startAppLoginPreview(root){
 if(process.env.CUSTOMER_SERVICE_TEST_ISOLATED!=='true')throw Error('Explicit isolated existing-login review required.');
 const directory=path.join(root,'work/action-flow/existing-login');await fs.mkdir(directory,{recursive:true});
 const file=path.join(directory,'fixture.private.json');
 let manifest=await fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 const config={host:'127.0.0.1',port:65436,user:'gallabox_test'},admin=new pg.Pool({...config,database:'postgres'});
 if(!manifest){
  const source=JSON.parse(await fs.readFile(path.join(root,'work/action-flow/fixture.private.json'),'utf8'));
  if(source.fictional!==true||!/^gallabox_action_preview_[a-f0-9]{32}$/.test(source.database))throw Error('Only the existing fictional local review can be copied.');
  const original=new pg.Pool({...config,database:source.database});let signatures;
  try{signatures=await privateTableSignatures(original);}finally{await original.end();}
  const database='gallabox_app_review_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE DATABASE ${database} TEMPLATE ${source.database}`);
  manifest={database,fictional:true,sourceDatabase:source.database,sourceSignatures:signatures,users:source.users,conversations:source.conversations,jwtSecret:randomUUID(),password:'Matter local review only 2026!'};
  await fs.writeFile(file,JSON.stringify(manifest,null,2),{mode:0o600});
 }
 if(manifest.fictional!==true||!/^gallabox_app_review_[a-f0-9]{32}$/.test(manifest.database))throw Error('Invalid local existing-login review.');
 const pool=new pg.Pool({...config,database:manifest.database,max:3});
 if(!manifest.copyVerified){
  const copied=await privateTableSignatures(pool);
  if(JSON.stringify(copied)!==JSON.stringify(manifest.sourceSignatures))throw Error('The local review copy does not match the preserved source.');
  manifest.copyVerified=true;await fs.writeFile(file,JSON.stringify(manifest,null,2),{mode:0o600});
 }
 const receipt=await applyLocalIssueKeyMigration({pool,isolated:true,apply:true});
 await fs.writeFile(path.join(directory,'migration-receipt.private.json'),JSON.stringify(receipt,null,2),{mode:0o600});
 process.env.JWT_SECRET=manifest.jwtSecret;
 await mongoose.connect('mongodb://127.0.0.1:60999',{dbName:manifest.database});
 for(const [role,id]of Object.entries(manifest.users)){
  if(!await User.exists({_id:id}))await User.create({_id:id,email:role+'@fixture.invalid',password:manifest.password,role:'viewer',isActive:true,permissionsConfigured:true,permissions:{customer_service:true},profile:{firstName:role==='head'?'Local review lead':role==='staff'?'Mariolle — demo':'Adrian — demo'}});
 }
 // Add separate, explicitly synthetic examples for the newly supplied support
 // reasons. Existing conversations, classifications, reviews and history stay.
 for(const [key,name,question,answer,followup]of [
  ['account','QA · Website & Account','I cannot sign in. My reset link says it expired. Please help me regain access.','I am checking the expired-link problem with Technical Support. Please use the existing account recovery process.','I can sign in again now. Thank you.'],
  ['menu','QA · Menu & Meal Selection','The menu photo and description show different ingredients. Please check the entry for LOCAL-MENU-10.','I have referred the published photo and description to the menu team for verification.',''],
  ['safety','QA · Food Safety & Allergies','I found a small plastic fragment in the sealed meal. Please review order LOCAL-SAFETY-10 urgently.','I am escalating this to the authorized food-safety reviewer and recording the evidence for assessment.',''],
 ]){
  const exists=await pool.query("SELECT id FROM gallabox_private.inbox_record WHERE kind='serviceconversations' AND body->>'scope'='local-topic-tag-review' AND body->>'externalConversationId'=$1",[key]);
  if(exists.rowCount)continue;
  const cid=new mongoose.Types.ObjectId(),start=new Date('2026-11-10T07:10:00Z');
  const save=async(kind,body)=>{const row=encodeCloudRecord(kind,body);await pool.query('INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES($1,$2,$3,$4,$5,1)',[row.kind,row.id,row.body,row.payload,row.sha256]);};
  await save('serviceconversations',{_id:cid,source:'gallabox',scope:'local-topic-tag-review',externalConversationId:key,customerName:name,lastMessageAt:new Date(+start+180000),sourceMetadata:{synthetic:true,externalContactId:'local-topic-'+key,providerInbox:{status:'open',assignment:'assigned',assigneeId:'staff',assigneeName:'Mariolle — demo',assigneeType:'user'}}});
  const base={conversationId:cid,source:'gallabox',scope:'local-topic-tag-review',type:'text',sourceMetadata:{synthetic:true}};
  await save('servicemessages',{...base,_id:new mongoose.Types.ObjectId(),externalMessageId:key+'-start',authorType:'system',type:'system',sentAt:start,sourceMetadata:{synthetic:true,systemEvent:{action:'initiate'}}});
  await save('servicemessages',{...base,_id:new mongoose.Types.ObjectId(),externalMessageId:key+'-question',authorType:'customer',text:question,sentAt:new Date(+start+60000)});
  await save('servicemessages',{...base,_id:new mongoose.Types.ObjectId(),externalMessageId:key+'-answer',authorType:'staff',authorId:manifest.users.staff,externalAuthorId:'staff',authorName:'Mariolle — demo',text:answer,sentAt:new Date(+start+120000)});
  if(followup)await save('servicemessages',{...base,_id:new mongoose.Types.ObjectId(),externalMessageId:key+'-confirmation',authorType:'customer',text:followup,sentAt:new Date(+start+180000)});
 }
 const app=express();app.use(express.json());
 const store=createCloudStore({transport:createCloudTransportFromPool(async()=>pool)});
 const runtime=await startCustomerServiceDestination({app,env:{CUSTOMER_SERVICE_STORAGE:'supabase'},store});
 app.use('/api/auth',authRoutes);
 app.get('/local-review',(req,res)=>res.redirect('/customer-service/chats?period=all'));
 app.use('/api/customer-service',createServiceMediaRouter({fetchImpl:createQaMediaProvider(root)}),customers,data,service);
 app.use(express.static(path.join(root,'client/build')));app.get('*',(req,res)=>res.sendFile(path.join(root,'client/build/index.html')));
 const port=Number(process.env.CUSTOMER_SERVICE_PREVIEW_PORT||51046);
 const server=app.listen(port,'127.0.0.1',()=>console.log(`Existing app login, fictional local copy: http://127.0.0.1:${port}/local-review`));
 const stop=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.stop();await mongoose.disconnect();await pool.end();await admin.end();};
 process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));process.once('SIGINT',()=>stop().then(()=>process.exit(0)));
 return {app,server,store,pool,manifest,stop};
}
