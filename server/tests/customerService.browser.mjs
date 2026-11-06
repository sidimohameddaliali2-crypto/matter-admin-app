// Remote, isolated QA only. Never imports production server.js or starts its jobs.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {once} from 'node:events';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Staff from '../models/ServiceStaffProfile.js';
import Action from '../models/ServiceAction.js';
import {protect} from '../middleware/auth.js';
import service from '../routes/customerService.js';
import data from '../routes/customerServiceData.js';
import {ingestServiceBatch} from '../services/customerServiceCapture.js';
import {allocateServiceReviews} from '../services/customerServiceWorkflow.js';

assert.equal(process.env.CUSTOMER_SERVICE_TEST_ISOLATED,'true');
const uri=process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI;
assert.ok(uri,'Explicit isolated database required');
const dbName=`matter_service_test_${randomUUID().replaceAll('-','')}`;
process.env.JWT_SECRET=randomUUID();
let server,browser;
try {
  await mongoose.connect(uri,{dbName,autoIndex:false,serverSelectionTimeoutMS:5000});
  assert.equal(mongoose.connection.name,dbName);
  assert.ok((await mongoose.connection.db.admin().command({hello:1})).setName);
  for(const model of Object.values(mongoose.models)) {
    await model.createCollection();
    if(model.modelName!=='Customer') await model.createIndexes();
  }
  const users=await User.create(['Salek QA','Koko QA','Adrien QA','Responder QA'].map((name,i)=>({email:`browser-${i}@fixture.invalid`,password:randomUUID(),role:'admin',isActive:true,profile:{firstName:name,lastName:'Fixture'}})));
  await Staff.create(users.map((u,i)=>({userId:u._id,displayName:u.profile.firstName,mode:i===2?'supervisor':'reviewer',enabled:i!==3,availableMinutes:i<2?120:0,externalAuthorIds:i===3?['gallabox_export:ci:original-agent']:[]})));
  await Customer.create({customerId:'CUST-QA',firstName:'Example',lastName:'Customer'});
  const sentAt='2026-11-06T06:00:00Z';
  await ingestServiceBatch({source:'gallabox_export',scope:'ci',requestId:randomUUID(),actor:users[2],messages:Array.from({length:4},(_,i)=>[
    {externalMessageId:`q-${i}`,externalConversationId:`thread-${i}`,customerId:'CUST-QA',customerName:`Example customer ${i}`,authorName:'Example customer',authorType:'customer',sentAt,type:'text',text:'Can you check the pause on my plan?'},
    {externalMessageId:`a-${i}`,externalConversationId:`thread-${i}`,customerId:'CUST-QA',authorName:'Original responder',externalAuthorId:'original-agent',authorType:'staff',sentAt:'2026-11-06T06:03:00Z',type:'text',text:'I have your request. I will check and confirm here.'},
  ]).flat()});
  await allocateServiceReviews({actor:users[2],requestId:randomUUID()});
  const app=express();app.use(express.json());app.get('/api/auth/me',protect,(req,res)=>res.json({success:true,data:{user:req.user}}));
  app.use('/api/customer-service',data);app.use('/api/customer-service',service);
  app.use(express.static(resolve('../client/build')));app.get('*',(req,res)=>res.sendFile(resolve('../client/build/index.html')));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  browser=await chromium.launch({headless:true});await mkdir('/tmp/service-evidence',{recursive:true});
  async function open(user,path) {
    const context=await browser.newContext({viewport:{width:1440,height:1024}});
    const token=jwt.sign({id:String(user._id)},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'15m'});
    await context.addInitScript(({token,user})=>{localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify(user));},{token,user:JSON.parse(JSON.stringify(user))});
    const page=await context.newPage();await page.goto(`${base}/customer-service/${path}`);return page;
  }
  const salek=await open(users[0],'chats');
  await salek.getByRole('button',{name:'Start next review',exact:true}).waitFor();
  await salek.screenshot({path:'/tmp/service-evidence/salek-queue.png',fullPage:true});
  const koko=await open(users[1],'chats');
  await koko.getByRole('button',{name:'Start next review',exact:true}).click();
  await koko.getByLabel('Review summary',{exact:true}).fill('Clear response; pause confirmation remains open.');
  await koko.getByLabel('Subscription changes',{exact:true}).check();
  await koko.getByLabel('Good',{exact:true}).check();
  await koko.getByLabel('Review note',{exact:true}).fill('Original responder states the next step clearly.');
  for(const box of await koko.locator('.cs-evidence input').all()) await box.check();
  await koko.getByLabel(/The selected messages define this issue episode/).check();
  await koko.getByLabel('Follow-up needed',{exact:true}).check();
  await koko.getByLabel('Follow-up action',{exact:true}).fill('Confirm the pause status and update the customer.');
  const due=new Date(Date.now()+86400000+14400000).toISOString().slice(0,16);
  await koko.getByLabel('Action due in Dubai',{exact:true}).fill(due);
  await koko.getByRole('button',{name:'Save draft',exact:true}).click();
  await koko.getByText('Draft saved',{exact:false}).waitFor();
  await koko.reload();
  await koko.getByLabel('Review summary',{exact:true}).waitFor();
  assert.equal(await koko.getByLabel('Review summary',{exact:true}).inputValue(),'Clear response; pause confirmation remains open.');
  await koko.screenshot({path:'/tmp/service-evidence/koko-review.png',fullPage:true});
  await koko.getByRole('button',{name:'Save review & next',exact:true}).click();
  await koko.getByText(/Review saved/).waitFor();
  assert.equal(await Action.countDocuments({ownerId:users[1]._id}),1);
  const adrien=await open(users[2],'summary');
  await adrien.getByRole('button',{name:'Balance new reviews',exact:true}).waitFor();
  await adrien.getByRole('heading',{name:'Review workload',exact:true}).waitFor();
  await adrien.screenshot({path:'/tmp/service-evidence/adrien-summary.png',fullPage:true});
  await adrien.getByRole('navigation',{name:'Customer service pages'}).getByRole('link',{name:'Problems',exact:true}).click();
  await adrien.getByRole('button',{name:'Manage action',exact:true}).first().click();
  const editor=adrien.getByRole('region',{name:'Manage customer follow-up'});
  await editor.getByLabel('Action owner',{exact:true}).selectOption(String(users[0]._id));
  await editor.getByLabel('Action update reason',{exact:true}).fill('Share the follow-up with the available team member.');
  await editor.getByRole('button',{name:'Save action update',exact:true}).click();
  await adrien.getByText(/Action update saved/).waitFor();
  assert.equal(await Action.countDocuments({ownerId:users[0]._id}),1);
  await adrien.reload();await adrien.getByRole('button',{name:'Manage action',exact:true}).first().waitFor();
  await adrien.screenshot({path:'/tmp/service-evidence/adrien-actions.png',fullPage:true});
  await adrien.setViewportSize({width:1280,height:800});
  assert.ok(await adrien.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'No horizontal page overflow');
  console.log('PASS: real browser reviewer queue, claim, draft/reload, review+action transaction, supervisor reassignment/reload, 1440/1280 views.');
} finally {
  await browser?.close();
  if(server) {server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
  if(mongoose.connection.name===dbName) for(const {name} of await mongoose.connection.db.listCollections().toArray()) await mongoose.connection.db.collection(name).drop();
  await mongoose.disconnect();
}
