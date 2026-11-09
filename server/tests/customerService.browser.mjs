import {startGallaboxSync,getGallaboxSyncStatus} from '../services/customerServiceGallaboxSync.js';
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
import User, {effectivePermissions} from '../models/User.js';
import Message from '../models/ServiceMessage.js';
import {createGallaboxRouter} from '../routes/customerServiceGallabox.js';
import Customer from '../models/Customer.js';
import Staff from '../models/ServiceStaffProfile.js';
import Action from '../models/ServiceAction.js';
import {protect} from '../middleware/auth.js';
import service from '../routes/customerService.js';
import data from '../routes/customerServiceData.js';
import directory from '../routes/customerServiceCustomers.js';
import ServiceCustomer from '../models/ServiceCustomer.js';
import DirectoryState from '../models/ServiceCustomerDirectoryState.js';

assert.equal(process.env.CUSTOMER_SERVICE_TEST_ISOLATED,'true');
const uri=process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI;
assert.ok(uri,'Explicit isolated database required');
const dbName=`matter_service_test_${randomUUID().replaceAll('-','')}`;
process.env.JWT_SECRET=randomUUID();
let server,browser,sync;
try {
  await mongoose.connect(uri,{dbName,autoIndex:false,serverSelectionTimeoutMS:5000});
  assert.equal(mongoose.connection.name,dbName);
  assert.ok((await mongoose.connection.db.admin().command({hello:1})).setName);
  for(const model of Object.values(mongoose.models)) {
    await model.createCollection();
    if(model.modelName!=='Customer') await model.createIndexes();
  }
  const users=await User.create(['Salek QA','Koko QA','Adrien QA','Responder QA'].map((name,i)=>({email:`browser-${i}@fixture.invalid`,password:randomUUID(),role:'admin',isActive:true,profile:{firstName:name,lastName:'Fixture'}})));
  await Staff.create(users.map((u,i)=>({userId:u._id,displayName:u.profile.firstName,mode:i===2?'supervisor':'reviewer',enabled:i!==3,availableMinutes:i<2?120:0,externalAuthorIds:i===3?['gallabox:fixture-account:fixture-channel:original-agent']:[]})));
  await Customer.create({customerId:'CUST-QA',firstName:'Example',lastName:'Customer'});
  await DirectoryState.create({key:'matter_customer_directory',activeGeneration:'browser-fixture',status:'ready',lastSuccessfulAt:new Date(),sourceObservedAt:new Date(),report:{coverage:'fixture'}});
  await ServiceCustomer.create({customerId:'matter:fixture',name:'Actual directory fixture',email:'directory@fixture.invalid',source:'matter',sourceCoverage:'fixture',sourceObservedAt:new Date(),active:true,generation:'browser-fixture',subscriptions:[{id:'subscription-fixture',status:'active',plan:{name:'Balanced fixture'},start:'2026-11-01',end:'2026-11-30'}]});
  const sentAt='2026-11-06T06:00:00Z';
  const nativeFixture = ({source:'gallabox_export',scope:'ci',requestId:randomUUID(),actor:users[2],messages:Array.from({length:4},(_,i)=>[
    {externalMessageId:`q-${i}`,externalConversationId:`thread-${i}`,customerId:'CUST-QA',customerName:`Example customer ${i}`,authorName:'Example customer',authorType:'customer',sentAt,type:'text',text:'Can you check the pause on my plan?'},
    {externalMessageId:`a-${i}`,externalConversationId:`thread-${i}`,customerId:'CUST-QA',authorName:'Original responder',externalAuthorId:'original-agent',authorType:'staff',sentAt:'2026-11-06T06:03:00Z',type:'text',text:'I have your request. I will check and confirm here.'},
  ]).flat()});

  let providerDown=false,conversationCount=4;
  const providerEnv={CUSTOMER_SERVICE_GALLABOX_API_KEY:'fixture-key',CUSTOMER_SERVICE_GALLABOX_API_SECRET:'fixture-secret',CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID:'fixture-account',CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID:'fixture-channel'};
  const provider=async(url,options)=>{
    assert.equal(options.method,'GET','Native integration never sends provider writes');
    if(providerDown)return Response.json({error:'Fictional provider outage'},{status:503});
    if(url.endsWith('/users'))return Response.json([{id:'original-agent',name:'Original responder',accounts:[{accountId:'fixture-account',channelIds:['fixture-channel']}]}]);
    if(new URL(url).pathname.endsWith('/conversations'))return Response.json(Array.from({length:conversationCount},(_,i)=>({status:'OPEN',id:'thread-'+i,accountId:'fixture-account',channelId:'fixture-channel',contactId:'contact-'+i,contact:{name:'Example customer '+i}})));
    if(Number(new URL(url).searchParams.get('page')||1)>1)return Response.json([]);
    const contact=new URL(url).searchParams.get('contactId');const i=Number(contact.split('-').at(-1));
    return Response.json(nativeFixture.messages.filter(m=>m.externalConversationId==='thread-'+i).map(m=>({id:m.externalMessageId,accountId:'fixture-account',channelId:'fixture-channel',contactId:contact,conversationId:m.externalConversationId,sender:m.authorType==='customer'?contact:'original-agent',...(m.authorType==='staff'?{userId:'original-agent'}:{}),whatsapp:{...(m.authorType==='customer'?{from:'fixture'}:{to:'fixture'}),time:m.sentAt,type:'text',text:{body:m.text}}})));
  };
  const app=express();app.use(express.json());app.get('/api/auth/me',protect,(req,res)=>res.json({success:true,data:{user:{...req.user.toObject(),permissions:effectivePermissions(req.user)}}}));
  app.use('/api/customer-service/gallabox',createGallaboxRouter({env:providerEnv,fetchImpl:provider}));
  app.use('/api/customer-service',directory);app.use('/api/customer-service',data);app.use('/api/customer-service',service);
  app.use(express.static(resolve('../client/build')));app.get('*',(req,res)=>res.sendFile(resolve('../client/build/index.html')));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});await mkdir('/tmp/service-evidence',{recursive:true});
  async function open(user,path,period="all") {
    const context=await browser.newContext({viewport:{width:1440,height:1024}});
    const token=jwt.sign({id:String(user._id)},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'15m'});
    await context.addInitScript(({token,user})=>{localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify(user));},{token,user:JSON.parse(JSON.stringify(user))});
    const page=await context.newPage();await page.goto(`${base}/customer-service/${path}${period ? `?period=${period}` : ''}`);return page;
  }
  const intake=await open(users[2],'summary','');
  const today=new Date(Date.now()+14400000).toISOString().slice(0,10);
  assert.equal(await intake.getByLabel('From date in Dubai').inputValue(),today);
  assert.equal(await intake.getByLabel('To date in Dubai').inputValue(),today);
  await intake.getByRole('button',{name:'All time',exact:true}).click();
  await intake.locator('summary').filter({hasText:'Sources and settings'}).click();
  await intake.getByRole('button',{name:'Check Gallabox account',exact:true}).click();
  await intake.getByText(/Gallabox account access verified/).waitFor();
  await intake.getByRole('button',{name:'Load recent conversations',exact:true}).click();
  await intake.getByLabel('Gallabox conversation',{exact:true}).selectOption('thread-0');
  providerDown=true;
  await intake.getByRole('button',{name:'Capture recent messages',exact:true}).click();
  await intake.getByRole('alert').filter({hasText:/Gallabox/}).waitFor();
  assert.equal(await Message.countDocuments(),0);
  providerDown=false;
  for(let i=0;i<4;i++){
    await intake.getByLabel('Gallabox conversation',{exact:true}).selectOption('thread-'+i);
    await intake.getByRole('button',{name:'Capture recent messages',exact:true}).click();
    await intake.getByText(/2 new messages saved/).waitFor();
  }
  assert.equal(await Message.countDocuments(),8);
  await intake.getByRole('button',{name:'Capture recent messages',exact:true}).click();
  await intake.getByText(/0 new messages saved; 2 already captured/).waitFor();
  assert.equal(await Message.countDocuments(),8);
  await intake.reload();
  await intake.locator('summary').filter({hasText:'Internal quality reviews'}).click();
  await intake.getByRole('button',{name:'Balance new reviews',exact:true}).click();
  await intake.getByText(/4 reviews allocated/).waitFor();
  console.log('PASS: native provider fixture account check, conversation selection, failed capture/retry, import/replay/reload and allocation through the real UI');
  const salek=await open(users[0],'reviews');
  await salek.getByRole('button',{name:'Start next review',exact:true}).waitFor();
  await salek.screenshot({path:'/tmp/service-evidence/salek-queue.png',fullPage:true});
  const koko=await open(users[1],'reviews');
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
  const submittedReview = koko.waitForResponse(response => response.url().includes('/submit') && response.request().method() === 'POST');
  await koko.getByRole('button',{name:'Save review & next',exact:true}).click();
  const submitResponse = await submittedReview;
  assert.equal(submitResponse.status(),200, await submitResponse.text());
  await koko.getByText(/Review saved/).waitFor();
  assert.equal(await Action.countDocuments({ownerId:null,status:'unassigned'}),1);
  const adrien=await open(users[2],'summary');
  await adrien.locator('summary').filter({hasText:'Internal quality reviews'}).click();
  await adrien.getByRole('button',{name:'Balance new reviews',exact:true}).waitFor();
  await adrien.getByText('Internal quality reviews',{exact:true}).waitFor();
  await adrien.screenshot({path:'/tmp/service-evidence/adrien-summary.png',fullPage:true});
  await adrien.getByRole('navigation',{name:'Customer service pages'}).getByRole('link',{name:'Follow-ups',exact:true}).click();
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
  // Timer, real provider adapter and DB complete without clicking capture.
  conversationCount=5;nativeFixture.messages.push({externalMessageId:'automatic-new',externalConversationId:'thread-4',authorType:'customer',sentAt,type:'text',text:'Automatic source message'});
  providerEnv.CUSTOMER_SERVICE_GALLABOX_SYNC_ENABLED='true';sync=startGallaboxSync({env:providerEnv,fetchImpl:provider,intervalMs:50});
  const deadline=Date.now()+30000;let status;
  do{await new Promise(r=>setTimeout(r,50));status=await getGallaboxSyncStatus({env:providerEnv});}while((status.pending||status.inserted!==1)&&Date.now()<deadline);
  await sync.stop();assert.equal(status.pending,0);assert.equal(status.inserted,1);assert.equal(await Message.countDocuments(),9);
  await intake.goto(base+'/customer-service/summary?period=all');await intake.locator('summary').filter({hasText:'Sources and settings'}).click();await intake.getByText(/1 new messages saved by automatic sync/).waitFor();
  await intake.reload();await intake.locator('summary').filter({hasText:'Sources and settings'}).click();await intake.getByRole('heading',{name:'Automatic sync on',exact:true}).waitFor();
  await intake.getByRole('navigation',{name:'Customer service pages'}).getByRole('link',{name:'Customers',exact:true}).click();
  assert.equal(await intake.getByLabel('From date in Dubai').inputValue(),'');
  await intake.reload();assert.equal(await intake.getByLabel('From date in Dubai').inputValue(),'');
  await intake.getByText('1 customers in this scope',{exact:true}).waitFor();
  await intake.getByRole('row').filter({hasText:'Actual directory fixture'}).getByRole('button',{name:'View customer',exact:true}).click();
  await intake.getByRole('dialog',{name:'Customer context'}).getByText('Balanced fixture',{exact:true}).waitFor();
  await intake.getByRole('button',{name:'Close customer context',exact:true}).click();
  await intake.getByRole('button',{name:'Unmatched conversations',exact:true}).click();
  await intake.getByRole('row').filter({hasText:'Example customer 4'}).getByRole('button',{name:'View captured chats',exact:true}).click();
  await intake.getByRole('button',{name:'View captured conversation',exact:true}).click();
  await intake.getByText('Automatic source message',{exact:true}).waitFor();
  console.log('PASS: automatic timer capture, persisted sync status after reload, actual customer directory, unmatched contact and original message visible through full UI.');

} finally {
  await sync?.stop();
  await browser?.close();
  if(server) {server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
  if(mongoose.connection.name===dbName) for(const {name} of await mongoose.connection.db.listCollections().toArray()) await mongoose.connection.db.collection(name).drop();
  await mongoose.disconnect();
}
