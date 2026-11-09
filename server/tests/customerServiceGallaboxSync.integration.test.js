import * as XLSX from 'xlsx';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import {runGallaboxSyncStep,getGallaboxSyncStatus,queueGallaboxHistory} from '../services/customerServiceGallaboxSync.js';
import State from '../models/ServiceGallaboxSync.js';
import Message from '../models/ServiceMessage.js';
const enabled=process.env.CUSTOMER_SERVICE_TEST_ISOLATED==='true'&&!!process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI;
const dbName=`matter_service_test_${randomUUID().replaceAll('-','')}`;
const env={CUSTOMER_SERVICE_GALLABOX_SYNC_ENABLED:'true',CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID:'account',CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID:'channel',CUSTOMER_SERVICE_GALLABOX_API_KEY:'fixture',CUSTOMER_SERVICE_GALLABOX_API_SECRET:'fixture'};
let failPage=false,reads=0;
const conv={status:'OPEN',id:'conversation',accountId:'account',channelId:'channel',contactId:'contact',contact:{name:'Fixture'},updatedAt:'2026-11-06T00:00:00Z'};
const provider=async url=>{reads++;if(new URL(url).pathname.endsWith('/conversations'))return Response.json([conv]);if(url.endsWith('/users'))return Response.json([{id:'agent',accounts:[{accountId:'account'}]}]);const page=Number(new URL(url).searchParams.get('page'));if(failPage)throw Error('private provider failure');return Response.json(page>1?[]:[{id:'message',accountId:'account',channelId:'channel',contactId:'contact',conversationId:'conversation',sender:'contact',whatsapp:{time:'2026-11-06T00:00:00Z',from:'fixture',type:'text',text:{body:'Fixture message'}}}]);};
before(async()=>{if(!enabled)return;await mongoose.connect(process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI,{dbName,autoIndex:false});for(const m of Object.values(mongoose.models)){await m.createCollection();if(m.modelName!=='Customer')await m.createIndexes();}});
after(async()=>{if(!enabled)return;if(mongoose.connection.name===dbName)await mongoose.connection.db.dropDatabase();await mongoose.disconnect();});
const run=(name,fn)=>test(name,{skip:!enabled},fn);
run('disabled scheduler makes no provider calls or database writes',async()=>{await runGallaboxSyncStep({env:{},fetchImpl:provider});assert.equal(reads,0);assert.equal(await State.countDocuments(),0);});
run('automatic discovery, durable page checkpoint and restart finish without duplicates',async()=>{await runGallaboxSyncStep({env,fetchImpl:provider});assert.equal(await Message.countDocuments(),1);let s=await getGallaboxSyncStatus({env});assert.equal(s.pending,1);assert.equal(s.inserted,1);assert.equal((await State.findOne().lean()).queue[0].allContactConversations,true);await runGallaboxSyncStep({env,fetchImpl:provider});s=await getGallaboxSyncStatus({env});assert.equal(s.pending,0);assert.ok(s.lastSuccessAt);assert.equal(await Message.countDocuments(),1);});
run('failed provider page stays pending and retries without advancing coverage',async()=>{await State.updateMany({},{$set:{lastDiscoveryAt:new Date(0)}});conv.updatedAt='2026-11-06T01:00:00Z';failPage=true;await runGallaboxSyncStep({env,fetchImpl:provider});let s=await getGallaboxSyncStatus({env});assert.equal(s.pending,1);assert.ok(s.error);assert.ok(!JSON.stringify(s).includes('private'));failPage=false;await State.updateMany({},{$set:{'queue.0.retryAt':new Date(0)}});await runGallaboxSyncStep({env,fetchImpl:provider});await runGallaboxSyncStep({env,fetchImpl:provider});assert.equal(await Message.countDocuments(),1);assert.equal((await getGallaboxSyncStatus({env})).pending,0);});
run('overlapping workers lease the same scope and never import concurrently',async()=>{await State.updateMany({},{$set:{lastDiscoveryAt:new Date(0)}});conv.updatedAt='2026-11-06T02:00:00Z';let active=0,max=0;await Promise.all([1,2,3].map(()=>runGallaboxSyncStep({env,fetchImpl:async u=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));try{return await provider(u);}finally{active--;}}})));assert.equal(max,1);assert.equal(await Message.countDocuments(),1);});

run('discovery failure backs off while saved page checkpoints continue',async()=>{
 await State.updateMany({},{$set:{lastDiscoveryAt:new Date(0)}});
 let discoveryReads=0;
 const failingDiscovery=async u=>{if(new URL(u).pathname.endsWith('/conversations')){discoveryReads++;throw Error('discovery down');}return provider(u);};
 await runGallaboxSyncStep({env,fetchImpl:failingDiscovery});
 assert.equal((await getGallaboxSyncStatus({env})).pending,0);
 await runGallaboxSyncStep({env,fetchImpl:failingDiscovery});assert.equal(discoveryReads,1);
 assert.ok((await State.findOne().lean()).nextDiscoveryAttemptAt>new Date());
});

run('historical queue validates scope, keeps real contact IDs and replays without duplicates',async()=>{
 const sheet=XLSX.utils.json_to_sheet([{conversationId:'old',accountId:'account',channelId:'channel',contactId:'historic-contact',contactName:'Fixture',updatedAt:'2026-11-06T00:00:00Z'}]);const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,sheet,'worksheet');const bytes=XLSX.write(w,{type:'buffer',bookType:'xlsx'});
 const r=await queueGallaboxHistory({bytes,from:'2026-08-08T00:00:00+04:00',env});assert.equal(r.queued,1);
 assert.equal((await queueGallaboxHistory({bytes,from:'2026-08-08T00:00:00+04:00',env})).duplicate,true);
 const state=await State.findOne().lean();assert.equal(state.queue[0].contactId,'historic-contact');assert.equal(state.queue[0].allContactConversations,true);
 assert.equal((await queueGallaboxHistory({bytes,from:'2026-07-08T00:00:00+04:00',env})).queued,1);
});
run('page limit leaves explicit partial coverage and permits fresh discovery',async()=>{
 await State.updateMany({},{$set:{queue:[{...conv,id:conv.id,name:'Fixture',page:1000,hashes:[]}],lastDiscoveryAt:new Date()}});
 const fake=async u=>u.endsWith('/users')?provider(u):Response.json([{id:'last-page-message',accountId:'account',channelId:'channel',contactId:'contact',conversationId:'conversation',sender:'contact',whatsapp:{time:'2026-11-06T00:00:00Z',from:'fixture',type:'text',text:{body:'Last page'}}}]);
 await runGallaboxSyncStep({env,fetchImpl:fake});const state=await State.findOne().lean();assert.equal(state.queue.length,0);assert.equal(state.limited,1);assert.ok(state.completed[conv.id]);
});
run('history-only drain leaves live jobs queued and never starts discovery',async()=>{
 const live={id:'live',contactId:'live-contact',channelId:'channel',page:1,hashes:[]};
 const history={id:'contact:history-contact',contactId:'history-contact',channelId:'channel',history:true,page:1,hashes:[]};
 await State.updateMany({},{$set:{queue:[live,history],lastDiscoveryAt:new Date(0)}});
 let discovery=0;
 await runGallaboxSyncStep({env,historyOnly:true,fetchImpl:async url=>{if(new URL(url).pathname.endsWith('/conversations')){discovery++;return Response.json([]);}if(url.endsWith('/users'))return provider(url);assert.equal(new URL(url).searchParams.get('contactId'),'history-contact');return Response.json([]);}});
 assert.equal(discovery,0);const state=await State.findOne().lean();assert.deepEqual(state.queue.map(j=>j.id),['live']);
});
run('fresh discovery preserves historical completion checkpoints',async()=>{
 await State.updateMany({},{$set:{queue:[],lastDiscoveryAt:new Date(0),nextDiscoveryAttemptAt:new Date(0),completed:{'contact:historic-done':{at:new Date(),updatedAt:'fixture'}}}});
 await runGallaboxSyncStep({env,fetchImpl:provider});assert.ok((await State.findOne().lean()).completed['contact:historic-done']);
});
run('native message recovery adds exact contact checkpoints once and rejects other scopes',async()=>{
 const{queueGallaboxRecoveredContacts}=await import('../services/customerServiceGallaboxSync.js');const recovery={source:'gallabox',scope:'account:channel',contact:{contactId:'recovered-contact',channelId:'channel',id:'actual-conversation',name:'Fixture'},messages:[{externalMessageId:'actual-source-message',sourceMetadata:{externalContactId:'recovered-contact'}}]};
 const args={recoveries:[recovery],from:'2026-08-08T00:00:00+04:00',env};assert.equal((await queueGallaboxRecoveredContacts(args)).queued,1);assert.equal((await queueGallaboxRecoveredContacts(args)).queued,0);
 const state=await State.findOne().lean(),job=state.queue.find(j=>j.contactId==='recovered-contact');assert.equal(job.pageSize,100);assert.equal(job.sourceKind,'native_message_lookup');await assert.rejects(queueGallaboxRecoveredContacts({...args,recoveries:[{...recovery,scope:'wrong:channel'}]}));
});
run('an earlier recovered range cannot silently reuse narrower checkpoints',async()=>{
 const{queueGallaboxRecoveredContacts}=await import('../services/customerServiceGallaboxSync.js');const recovery={source:'gallabox',scope:'account:channel',contact:{contactId:'narrow-contact',channelId:'channel',id:'actual'},messages:[{externalMessageId:'actual',sourceMetadata:{externalContactId:'narrow-contact'}}]};
 await State.updateMany({},{$set:{queue:[],completed:{'contact:narrow-contact':{from:'2026-09-01T00:00:00Z',apiWindowExhausted:true}}}});
 await assert.rejects(queueGallaboxRecoveredContacts({recoveries:[recovery],from:'2026-08-08T00:00:00+04:00',env}),/range/);
});
run('new incoming evidence is discovered automatically within thirty seconds and replay is deduplicated',async()=>{
 const start=new Date('2026-11-07T00:00:00Z');let incoming=false,discoveries=0;
 await State.deleteMany({});await Message.deleteMany({});
 const live=async url=>{
  if(new URL(url).pathname.endsWith('/conversations')){discoveries++;return Response.json([{...conv,updatedAt:incoming?'2026-11-07T00:00:15Z':'2026-11-07T00:00:00Z'}]);}
  if(url.endsWith('/users'))return provider(url);
  const rows=Number(new URL(url).searchParams.get('page'))>1?[]:[{id:incoming?'incoming-live':'initial-live',accountId:'account',channelId:'channel',contactId:'contact',conversationId:'conversation',sender:'contact',whatsapp:{time:incoming?'2026-11-07T00:00:15Z':'2026-11-07T00:00:00Z',from:'fixture',type:'text',text:{body:incoming?'New incoming fixture':'Existing fixture'}}}];return Response.json(rows);
 };
 await runGallaboxSyncStep({env,fetchImpl:live,now:start});
 await runGallaboxSyncStep({env,fetchImpl:live,now:new Date(+start+2000)});
 incoming=true;
 await runGallaboxSyncStep({env,fetchImpl:live,now:new Date(+start+29000)});assert.equal(discoveries,2);
 await runGallaboxSyncStep({env,fetchImpl:live,now:new Date(+start+30000)});
 assert.equal(discoveries,4);assert.equal(await Message.countDocuments({externalMessageId:'incoming-live'}),1);
 await runGallaboxSyncStep({env,fetchImpl:live,now:new Date(+start+32000)});
 await runGallaboxSyncStep({env,fetchImpl:live,now:new Date(+start+60000)});
 assert.equal(await Message.countDocuments(),2);
});
run('incoming capture bypasses an existing deep scan of the same contact and history keeps moving',async()=>{
 await State.deleteMany({});await Message.deleteMany({});const now=new Date('2026-11-08T00:00:00Z');
 await State.create({scope:'account:channel',queue:[{...conv,page:70,hashes:[],history:true}],lastDiscoveryAt:new Date(0)});
 const requested=[];const p=async url=>{if(url.endsWith('/users'))return provider(url);if(new URL(url).pathname.endsWith('/conversations'))return Response.json([{...conv,updatedAt:now.toISOString()}]);const page=Number(new URL(url).searchParams.get('page'));requested.push(page);return Response.json(page===1?[{id:'urgent-arrival',accountId:'account',channelId:'channel',contactId:'contact',conversationId:'conversation',sender:'contact',whatsapp:{time:now.toISOString(),from:'fixture',type:'text',text:{body:'Realistic incoming fixture'}}}]:[]);};
 await runGallaboxSyncStep({env,fetchImpl:p,now});assert.equal(await Message.countDocuments({externalMessageId:'urgent-arrival'}),1);assert.equal(requested[0],1);assert.ok(requested.includes(70),'History must keep advancing');
 await runGallaboxSyncStep({env,fetchImpl:p,now:new Date(+now+2000)});assert.equal(await Message.countDocuments({externalMessageId:'urgent-arrival'}),1);
});
run('live catch-up retries independently, spans a burst, and stops at saved evidence after restart',async()=>{
 await State.deleteMany({});await Message.deleteMany({});const now=new Date('2026-11-09T00:00:00Z');let down=true;const read=[];
 await State.create({scope:'account:channel',queue:[{...conv,id:conv.id,page:90,history:true,hashes:[]}],lastDiscoveryAt:new Date(0)});
 const p=async url=>{if(url.endsWith('/users'))return provider(url);if(new URL(url).pathname.endsWith('/conversations'))return Response.json([{...conv,updatedAt:now.toISOString()}]);const page=Number(new URL(url).searchParams.get('page'));read.push(page);if(page===1&&down)throw Error('fixture outage');if(page===90||page>2)return Response.json([]);return Response.json([{id:'burst-'+page,accountId:'account',channelId:'channel',contactId:'contact',conversationId:'conversation',sender:'contact',whatsapp:{time:now.toISOString(),from:'fixture',type:'text',text:{body:'Burst '+page}}}]);};
 await runGallaboxSyncStep({env,fetchImpl:p,now});let state=await State.findOne().lean();assert.equal(state.queue.length,0);assert.equal(state.liveQueue[0].page,1);assert.ok(state.liveQueue[0].retryAt);assert.ok(read.includes(90));
 down=false;await runGallaboxSyncStep({env,fetchImpl:p,now:new Date(+now+31000)});state=await State.findOne().lean();assert.equal(state.liveQueue[0].page,2);
 await runGallaboxSyncStep({env,fetchImpl:p,now:new Date(+now+33000)});assert.equal(await Message.countDocuments(),2);
 await runGallaboxSyncStep({env,fetchImpl:p,now:new Date(+now+35000)});state=await State.findOne().lean();assert.equal(state.liveQueue.length,0);assert.ok(state.liveCompleted[conv.id].apiWindowExhausted);
 const changed=async url=>new URL(url).pathname.endsWith('/conversations')?Response.json([{...conv,updatedAt:'2026-11-09T00:01:00Z'}]):p(url);
 await runGallaboxSyncStep({env,fetchImpl:changed,now:new Date(+now+62000)});state=await State.findOne().lean();assert.equal(state.liveQueue.length,0);assert.equal(state.liveCompleted[conv.id].caughtUp,true);assert.equal(await Message.countDocuments(),2);
});
run('two-lane worker reuses only its short-lived staff directory, never message pages',async()=>{
 const {startGallaboxSync}=await import('../services/customerServiceGallaboxSync.js');await State.deleteMany({});await Message.deleteMany({});let users=0,pages=0;
 const worker=startGallaboxSync({env,identityEnabled:false,intervalMs:60000,fetchImpl:async url=>{if(url.endsWith('/users'))users++;if(new URL(url).pathname.endsWith('/messages'))pages++;return provider(url);}});
 await worker.run();await worker.run();await worker.stop();assert.equal(users,1);assert.ok(pages>=4);
});

run('discovery exposes an older open chat before message capture and updates assignment without changing review history',async()=>{
 const Conversation=(await import('../models/ServiceConversation.js')).default;
 await State.deleteMany({});
 let assigned=false;
 const p=async url=>{
  if(new URL(url).pathname.endsWith('/conversations'))return Response.json([{...conv,id:'older-open',contactId:'older-contact',status:'OPEN',...(assigned?{assigneeId:'agent',assigneeType:'user',user:{id:'agent',name:'Fictional agent'}}:{})}]);
  if(url.endsWith('/users'))return provider(url);
  throw Error('Temporary message history outage');
 };
 const now=new Date('2026-11-10T00:00:00Z');await runGallaboxSyncStep({env,fetchImpl:p,now});
 let c=await Conversation.findOne({externalConversationId:'older-open'}).lean();assert.ok(c);assert.equal(c.sourceMetadata.providerInbox.status,'open');assert.equal(c.sourceMetadata.providerInbox.assignment,'unassigned');assert.equal(c.lastMessageAt,undefined);
 assigned=true;await runGallaboxSyncStep({env,fetchImpl:p,now:new Date(+now+31000)});
 c=await Conversation.findById(c._id).lean();assert.equal(c.sourceMetadata.providerInbox.assignment,'assigned');assert.equal(c.sourceMetadata.providerInbox.assigneeName,'Fictional agent');assert.equal(await Message.countDocuments({conversationId:c._id}),0);
});
