import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Staff from '../models/ServiceStaffProfile.js';
import Message from '../models/ServiceMessage.js';
import Conversation from '../models/ServiceConversation.js';
import Issue from '../models/ServiceIssue.js';
import {createGallaboxRouter} from '../routes/customerServiceGallabox.js';
const enabled=process.env.CUSTOMER_SERVICE_TEST_ISOLATED==='true'&&Boolean(process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI);
const dbName=`matter_service_test_${randomUUID().replaceAll('-','')}`;
let server,base,users,malformed=false,calls=0,recoveredQuote=false;
const originalSecret=process.env.JWT_SECRET;
const conversation={id:'conversation-fixture',accountId:'account-fixture',channelId:'channel-fixture',contactId:'contact-fixture',contact:{name:'Fictional native customer'}};
const env={CUSTOMER_SERVICE_GALLABOX_API_KEY:'fixture-key',CUSTOMER_SERVICE_GALLABOX_API_SECRET:'fixture-secret',CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID:'account-fixture',CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID:'channel-fixture'};
async function provider(url,options){calls++;assert.equal(options.method,'GET');if(url.endsWith('/users'))return Response.json([{id:'agent-fixture',name:'Fictional agent',accounts:[{accountId:'account-fixture',channelIds:['channel-fixture']}]}]);if(new URL(url).pathname.endsWith('/conversations'))return Response.json([conversation]);if(Number(new URL(url).searchParams.get('page')||1)>1)return Response.json([]);return Response.json([{...conversation,id:'message-fixture',conversationId:conversation.id,accountId:malformed?'wrong':conversation.accountId,sender:conversation.contactId,whatsapp:{from:'fixture',time:'2026-11-06T06:00:00Z',type:'text',text:{body:'Fictional native message'},...(recoveredQuote?{context:{reply:{messageId:'original-fixture',type:'text',text:'Original source quotation'}}}:{})}}]);}
before(async()=>{if(!enabled)return;process.env.JWT_SECRET=randomUUID();await mongoose.connect(process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI,{dbName,autoIndex:false});assert.equal(mongoose.connection.name,dbName);assert.ok((await mongoose.connection.db.admin().command({hello:1})).setName);for(const model of Object.values(mongoose.models)){await model.createCollection();if(model.modelName!=='Customer')await model.createIndexes();}users=await User.create(['supervisor','reviewer','outsider'].map(name=>({email:`${name}@fixture.invalid`,password:randomUUID(),role:'admin',isActive:true})));await Staff.create(users.slice(0,2).map((user,i)=>({userId:user._id,enabled:true,mode:i?'reviewer':'supervisor',displayName:'Fixture'})));const app=express();app.use(express.json());app.use('/gallabox',createGallaboxRouter({env,fetchImpl:provider}));server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{if(!enabled)return;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(mongoose.connection.name===dbName)await mongoose.connection.db.dropDatabase();await mongoose.disconnect();if(originalSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=originalSecret;});
const run=(name,fn)=>test(name,{skip:!enabled},fn);
async function request(path,user=users[0],body){return fetch(base+'/gallabox'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+jwt.sign({id:String(user._id)},process.env.JWT_SECRET),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
run('reviewers and unenrolled admins cannot trigger a provider read or capture',async()=>{const count=calls;for(const u of users.slice(1))for(const [path,body]of[['/conversations'],['/sync'],['/check',{}],['/capture',{requestId:randomUUID(),conversationId:conversation.id}]])assert.equal((await request(path,u,body)).status,403);assert.equal(calls,count);});
run('supervisor captures native messages durably and retry does not duplicate evidence or change user permissions',async()=>{const before=JSON.stringify(await User.find().lean());const check=await request('/check',users[0],{});assert.equal((await check.json()).data.state,'account_verified');const list=await request('/conversations');assert.equal(list.headers.get('cache-control'),'no-store');assert.equal((await list.json()).data.coverage,'partial');const body={requestId:randomUUID(),conversationId:conversation.id};for(let i=0;i<2;i++){const r=await request('/capture',users[0],body);assert.equal(r.status,200);assert.equal((await r.json()).data.coverage,'partial');}assert.equal(await Message.countDocuments(),1);assert.equal(JSON.stringify(await User.find().lean()),before);const saved=await Message.findOne().lean();assert.equal(saved.source,'gallabox');assert.equal(saved.authorType,'customer');assert.equal(saved.externalMessageId,'message-fixture');});
run('scope mismatch and missing request identity cannot commit or silently widen capture',async()=>{const count=await Message.countDocuments();malformed=true;const r=await request('/capture',users[0],{requestId:randomUUID(),conversationId:conversation.id});assert.equal(r.status,502);assert.equal(await Message.countDocuments(),count);malformed=false;const callsBefore=calls;assert.equal((await request('/capture',users[0],{conversationId:conversation.id})).status,400);assert.equal(calls,callsBefore);});

run('committed retry replays before a changed or unavailable provider read, and remains actor/conversation bound',async()=>{
 const body={requestId:randomUUID(),conversationId:conversation.id};assert.equal((await request('/capture',users[0],body)).status,200);const reads=calls;malformed=true;
 const retried=await request('/capture',users[0],body);assert.equal(retried.status,200);assert.equal((await retried.json()).data.duplicate,true);assert.equal(calls,reads);
 assert.equal((await request('/capture',users[0],{...body,conversationId:'different'})).status,409);assert.equal(calls,reads);
 await Staff.create({userId:users[2]._id,enabled:true,mode:'supervisor',displayName:'Other fixture'});
 assert.equal((await request('/capture',users[2],body)).status,409);assert.equal(calls,reads);malformed=false;
});
run('later provider display-name changes do not rewrite or invalidate existing message evidence',async()=>{
 malformed=false;const prior=await Message.findOne().lean();conversation.contact.name='Renamed fictional customer';
 const result=await request('/capture',users[0],{requestId:randomUUID(),conversationId:conversation.id});assert.equal(result.status,200);assert.equal((await result.json()).data.duplicates,1);assert.equal((await Message.findOne().lean()).authorName,prior.authorName);
});

run('later source context enriches duplicate messages without changing issue or conversation revisions',async()=>{
 const beforeMessage=await Message.findOne().lean(),beforeConversation=await Conversation.findById(beforeMessage.conversationId).lean(),beforeIssues=await Issue.find({conversationId:beforeMessage.conversationId}).lean();recoveredQuote=true;
 for(let i=0;i<2;i++){const r=await request('/capture',users[0],{requestId:randomUUID(),conversationId:conversation.id});assert.equal(r.status,200);assert.equal((await r.json()).data.duplicates,1);}
 const after=await Message.findOne().lean();assert.deepEqual(after.sourceMetadata.replyContext,{messageId:'original-fixture',type:'text',text:'Original source quotation'});assert.equal(after.text,beforeMessage.text);assert.equal(+after.sentAt,+beforeMessage.sentAt);assert.equal((await Conversation.findById(beforeMessage.conversationId).lean()).sourceRevision,beforeConversation.sourceRevision);assert.deepEqual((await Issue.find({conversationId:beforeMessage.conversationId}).lean()).map(x=>[String(x._id),x.sourceRevision]),beforeIssues.map(x=>[String(x._id),x.sourceRevision]));
});
