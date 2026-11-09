import Conversation from '../models/ServiceConversation.js';
import {observeServiceContacts,startServiceIdentityReconciliation} from './customerServiceIdentity.js';
import {randomUUID,createHash} from 'node:crypto';
import State from '../models/ServiceGallaboxSync.js';
import Message from '../models/ServiceMessage.js';
import {listGallaboxConversations,readGallaboxMessagePage} from './customerServiceGallabox.js';
import {extractHistoryContactSeeds} from './customerServiceHistorySeeds.js';
import {ingestServiceBatch} from './customerServiceCapture.js';
const scopeOf=env=>`${env.CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID?.trim()||''}:${env.CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID?.trim()||''}`;
const discoveryIntervalMs=30000;
const enabled=env=>env.CUSTOMER_SERVICE_GALLABOX_SYNC_ENABLED==='true';
export async function getGallaboxSyncStatus({env=process.env}={}){
 const state=await State.findOne({scope:scopeOf(env)}).lean();
 return {enabled:enabled(env),running:Boolean(state?.leaseUntil>new Date()),pending:state?.queue?.length||0,livePending:state?.liveQueue?.length||0,liveFailed:state?.liveQueue?.filter(j=>j.error).length||0,lastLiveSuccessAt:state?.lastLiveSuccessAt||null,liveError:state?.liveError||'',failed:state?.queue?.filter(j=>j.error).length||0,inserted:state?.inserted||0,duplicates:state?.duplicates||0,pages:state?.pages||0,discovered:state?.discovered||0,lastSuccessAt:state?.lastSuccessAt||null,lastAttemptAt:state?.lastAttemptAt||null,error:state?.liveError||state?.error||'',limited:state?.limited||0,historyQueued:state?.historyQueued||0,historyCompleted:state?.historyCompleted||0,historyStarted:(state?.historyCompleted||0)+(state?.queue?.filter(j=>j.history&&j.page>1).length||0),coverage:'partial',message:'Automatic discovery checks the recent and open Gallabox windows every thirty seconds. Incoming pages are captured ahead of one bounded historical page per step. History continues independently. Source retention is not verified.'};
}
export async function runGallaboxSyncStep({env=process.env,fetchImpl=fetch,now=new Date(),historyOnly=false,skipDiscovery=false}={}){
 if(!enabled(env))return;
 const scope=scopeOf(env);if(!env.CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID||scope.startsWith(':'))return;
 // Unique scope plus expiring fenced lease protects multiple server processes.
 try{await State.updateOne({scope},{$setOnInsert:{scope}},{upsert:true});}catch(e){if(e.code!==11000)throw e;}
 const token=randomUUID();
 const state=await State.findOneAndUpdate({scope,$or:[{leaseUntil:{$lt:now}},{leaseUntil:{$exists:false}}]},{$set:{leaseToken:token,leaseUntil:new Date(+now+120000),lastAttemptAt:now}},{new:true}).lean();
 if(!state)return;
 let queue=state.queue||[],completed=state.completed||{},error='',lastSuccessAt=state.lastSuccessAt,lastDiscoveryAt=state.lastDiscoveryAt,discovered=state.discovered||0,nextDiscoveryAttemptAt=state.nextDiscoveryAttemptAt,discoveryFailures=state.discoveryFailures||0;
 let liveQueue=state.liveQueue||[],liveCompleted=state.liveCompleted||{},lastLiveSuccessAt=state.lastLiveSuccessAt,liveError=state.liveError||'';
 const delta={inserted:0,duplicates:0,pages:0,limited:0,historyCompleted:0};
 try{
  if(!historyOnly&&!skipDiscovery&&(!lastDiscoveryAt||+now-+lastDiscoveryAt>=discoveryIntervalMs)&&(!nextDiscoveryAttemptAt||nextDiscoveryAttemptAt<=now)){
   try{
   const {conversations}=await listGallaboxConversations({env,fetchImpl,includeOpen:true});
   await observeServiceContacts({scope,contacts:conversations.map(c=>({...c,externalContactId:c.contactId}))});
   // The newest native conversation determines the contact's current queue.
   // Never touch review ownership, classifications, message chronology or history.
   const current=new Map();
   for(const c of [...conversations].sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0)))if(!current.has(c.contactId))current.set(c.contactId,c);
   for(const c of current.values()){
    const state=c.providerInbox;
    // A discovered open conversation must be visible even before its first
    // history page is captured. Only provider identities are used here.
    await Conversation.updateOne({source:'gallabox',scope,externalConversationId:c.id},{$setOnInsert:{customerName:c.name,coverageStatus:'partial',sourceRevision:1,'sourceMetadata.externalContactId':c.contactId}},{upsert:true});
    if(state)await Conversation.updateMany({source:'gallabox',scope,'sourceMetadata.externalContactId':c.contactId,$or:[{'sourceMetadata.providerInbox.externalConversationId':{$ne:state.externalConversationId}},{'sourceMetadata.providerInbox.providerUpdatedAt':{$ne:state.providerUpdatedAt}},{'sourceMetadata.providerInbox.status':{$ne:state.status}},{'sourceMetadata.providerInbox.assignment':{$ne:state.assignment}},{'sourceMetadata.providerInbox.assigneeId':{$ne:state.assigneeId}}]},{$set:{'sourceMetadata.providerInbox':{...state,observedAt:now.toISOString()}}});
   }
   for(const c of conversations){
    const active=liveQueue.find(j=>j.id===c.id),done=liveCompleted[c.id];
    if(active&&active.updatedAt!==c.updatedAt){Object.assign(active,c,{page:1,hashes:[]});}
    else if(!active&&(!done||done.updatedAt!==c.updatedAt||+now-new Date(done.at)>=1800000))liveQueue.push({...c,page:1,hashes:[],failures:0});
    if(!queue.some(j=>j.id===c.id)&&(!completed[c.id]||completed[c.id].updatedAt!==c.updatedAt||+now-new Date(completed[c.id].at)>=1800000))queue.push({...c,allContactConversations:true,page:1,hashes:[],failures:0});
   }
   liveQueue.sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0));
   const liveRetained=new Set([...conversations.map(c=>c.id),...liveQueue.map(c=>c.id)]);
   liveCompleted=Object.fromEntries(Object.entries(liveCompleted).filter(([id])=>liveRetained.has(id)));
   if(liveQueue.length>1000)throw new Error('live queue capacity');
   if(queue.length>1000)throw new Error('queue capacity');
   const retained=new Set([...conversations.map(c=>c.id),...queue.map(c=>c.id)]);
   completed=Object.fromEntries(Object.entries(completed).filter(([id,checkpoint])=>id.startsWith('contact:')||checkpoint.history===true||retained.has(id)));
   discovered=conversations.length;lastDiscoveryAt=now;nextDiscoveryAttemptAt=null;discoveryFailures=0;
   }catch{discoveryFailures++;nextDiscoveryAttemptAt=new Date(+now+Math.min(3600000,30000*2**Math.min(discoveryFailures-1,7)));error='Gallabox discovery is unavailable; saved pages continue and discovery will retry automatically.';}
  }
  // Incoming catch-up has its own durable cursor, independent of deep scans.
  // Run one live page first, then one historical page so both make progress.
  const liveIndex=historyOnly?-1:liveQueue.findIndex(j=>!j.retryAt||new Date(j.retryAt)<=now);
  if(liveIndex>=0){
   const job=liveQueue.splice(liveIndex,1)[0];
   try{
    const page=await readGallaboxMessagePage({conversation:{...job,allContactConversations:true},page:job.page,pageSize:100,env,fetchImpl});
    const hash=createHash('sha256').update(JSON.stringify([...page.ids].sort())).digest('hex');
    if(!page.exhausted&&job.hashes.includes(hash))throw new Error('Repeated live provider page');
    const prior=await Message.find({source:page.source,scope:page.scope,externalMessageId:{$in:page.messages.map(m=>m.externalMessageId)}}).lean();
    const saved=new Map(prior.map(m=>[m.externalMessageId,m]));
    const caughtUp=page.messages.length>0&&page.messages.every(m=>saved.has(m.externalMessageId));
    for(const m of page.messages){const old=saved.get(m.externalMessageId);if(old&&old.externalConversationId===m.externalConversationId&&old.externalAuthorId===m.externalAuthorId&&old.authorType===m.authorType)m.authorName=old.authorName;}
    if(page.contacts?.length)await observeServiceContacts({scope,contacts:page.contacts});
    if(page.messages.length){const counts=await ingestServiceBatch({source:page.source,scope:page.scope,messages:page.messages,requestId:'gallabox-sync-live:'+randomUUID(),actor:null});delta.inserted+=counts.inserted;delta.duplicates+=counts.duplicates;}
    delta.pages++;lastLiveSuccessAt=now;lastSuccessAt=now;liveError='';
    if(page.exhausted||caughtUp||job.page>=1000){if(job.page>=1000&&!page.exhausted&&!caughtUp)delta.limited++;liveCompleted[job.id]={updatedAt:job.updatedAt,at:now,caughtUp,apiWindowExhausted:page.exhausted};}
    else liveQueue.push({...job,page:job.page+1,hashes:[...job.hashes,hash],failures:0,error:'',retryAt:null});
   }catch{liveError='Incoming capture is retrying; saved messages and history progress are retained.';const failures=(job.failures||0)+1;liveQueue.push({...job,error:liveError,failures,retryAt:new Date(+now+Math.min(3600000,30000*2**Math.min(failures-1,7)))});}
  }
  const ready=j=>(!historyOnly||j.history)&&(!j.retryAt||new Date(j.retryAt)<=now);
  // Keep live discovery and recovery responsive during a large history scan.
  const urgent=(state.pages||0)%4===0?queue.findIndex(j=>ready(j)&&(!j.history||j.error)):-1;
  const index=urgent>=0?urgent:queue.findIndex(ready);
  if(index>=0){
   const job=queue.splice(index,1)[0];
   try{
    const page=await readGallaboxMessagePage({conversation:{...job,allContactConversations:true},page:job.page,pageSize:job.pageSize||20,env,fetchImpl});
    if(page.contacts?.length)await observeServiceContacts({scope,contacts:page.contacts});
    const hash=createHash('sha256').update(JSON.stringify([...page.ids].sort())).digest('hex');
    if(!page.exhausted&&job.hashes.includes(hash))throw new Error('Repeated provider page');
    if(job.from)page.messages=page.messages.filter(m=>new Date(m.sentAt)>=new Date(job.from));
    if(page.messages.length){
     const prior=await Message.find({source:page.source,scope:page.scope,externalMessageId:{$in:page.messages.map(m=>m.externalMessageId)}}).lean();const saved=new Map(prior.map(m=>[m.externalMessageId,m]));
     for(const m of page.messages){const p=saved.get(m.externalMessageId);if(p&&p.externalConversationId===m.externalConversationId&&p.externalAuthorId===m.externalAuthorId&&p.authorType===m.authorType)m.authorName=p.authorName;}
     // At-least-once import precedes checkpoint. A crash replays IDs safely.
     const counts=await ingestServiceBatch({source:page.source,scope:page.scope,messages:page.messages,requestId:`gallabox-sync:${randomUUID()}`,actor:null});delta.inserted+=counts.inserted;delta.duplicates+=counts.duplicates;
    }
    delta.pages++;lastSuccessAt=now;
    if(page.exhausted||job.page>=1000){if(!page.exhausted)delta.limited++;else if(job.history)delta.historyCompleted++;completed[job.id]={updatedAt:job.updatedAt,at:now,history:Boolean(job.history),contactId:job.contactId,pagesRead:job.page,from:job.from||null,apiWindowExhausted:page.exhausted};}
    else{queue.push({...job,page:job.page+1,hashes:[...job.hashes,hash],error:'',failures:0,retryAt:null});}
   }catch{
    error='A Gallabox page could not be saved. Progress is retained and the page will retry automatically.';
    const failures=(job.failures||0)+1;queue.push({...job,error,failures,retryAt:new Date(+now+Math.min(3600000,30000*2**Math.min(failures-1,7)))});
   }
  }
 }catch{error='Gallabox discovery is unavailable. Saved conversations and sync progress are retained.';}
 await State.updateOne({scope,leaseToken:token},{$set:{queue,completed,liveQueue,liveCompleted,lastLiveSuccessAt,liveError,error,lastSuccessAt,lastDiscoveryAt,discovered,nextDiscoveryAttemptAt,discoveryFailures,leaseUntil:new Date(0)},$inc:delta,$unset:{leaseToken:1}});
 return getGallaboxSyncStatus({env});
}
export function startGallaboxSync({env=process.env,fetchImpl=fetch,intervalMs=2000,identityEnabled=true}={}){
 if(!enabled(env))return null;const identity=identityEnabled?startServiceIdentityReconciliation({enabled:true}):null;let running=null,stopped=false;
 // Short-lived staff-directory cache avoids doubling provider reads when both
 // lanes are active. Message/discovery responses are never cached. Each worker
 // owns its cache, so credentials/accounts cannot share cached identities.
 let staffCache=null,staffCacheUntil=0;
 const workerFetch=async(url,options)=>{
  if(!url.endsWith('/users'))return fetchImpl(url,options);
  if(staffCache&&Date.now()<staffCacheUntil)return Response.json(staffCache);
  const response=await fetchImpl(url,options);
  if(response.ok){
   const reader=response.clone().body?.getReader();let size=0;const parts=[];
   if(reader)try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){void reader.cancel();break;}parts.push(value);}
    if(size<=1024*1024){const rows=JSON.parse(Buffer.concat(parts).toString('utf8'));if(Array.isArray(rows)){staffCache=rows;staffCacheUntil=Date.now()+30000;}}
   }catch{/* The normal scoped reader reports invalid provider responses. */}finally{reader.releaseLock();}
  }
  return response;
 };
 const run=()=>{if(running||stopped)return running;running=(async()=>{try{await runGallaboxSyncStep({env,fetchImpl:workerFetch});}catch{console.error('Customer service Gallabox sync paused after a local error; retrying.');}finally{running=null;}})();return running;};
 const timer=setInterval(run,intervalMs);timer.unref();void run();return {async stop(){stopped=true;clearInterval(timer);await running;await identity?.stop();},run};
}

// Local/administrative backfill entrypoint. Workbook scope must match configured
// native account+channel; no names or guessed conversation identities are used.
export async function queueGallaboxHistory({bytes,from,env=process.env}){
 if(typeof from!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(from)||!Number.isFinite(Date.parse(from)))throw new Error('Historical start requires an explicit ISO timestamp with timezone.');
 const extracted=extractHistoryContactSeeds(bytes,{accountId:env.CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID,channelId:env.CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID});
 const hash=createHash('sha256').update(bytes).update(new Date(from).toISOString()).digest('hex'),scope=scopeOf(env),token=randomUUID(),now=new Date();
 await State.updateOne({scope},{$setOnInsert:{scope}},{upsert:true});
 const state=await State.findOneAndUpdate({scope,$or:[{leaseUntil:{$lt:now}},{leaseUntil:{$exists:false}}]},{$set:{leaseToken:token,leaseUntil:new Date(+now+120000)}},{new:true}).lean();
 if(!state)throw new Error('Sync is busy; retry the historical queue request.');
 try{
  await observeServiceContacts({scope,contacts:extracted.seeds.map(c=>({...c,externalContactId:c.contactId})),origin:'gallabox_conversation_export'});
  if(state.historySeedHashes?.includes(hash))return {duplicate:true,queued:0};
  const jobs=extracted.seeds.map(c=>({...c,id:`contact:${c.contactId}`,allContactConversations:true,history:true,from,page:1,pageSize:100,hashes:[],failures:0}));
  if(state.queue.length+jobs.length>1000)throw new Error('Historical queue exceeds capacity.');
  await State.updateOne({scope,leaseToken:token},{$push:{queue:{$each:jobs},historySeedHashes:hash},$inc:{historyQueued:jobs.length}});
  return {queued:jobs.length,duplicate:false,report:extracted.report};
 }finally{await State.updateOne({scope,leaseToken:token},{$set:{leaseUntil:new Date(0)},$unset:{leaseToken:1}});}
}

export async function queueGallaboxRecoveredContacts({recoveries,from,env=process.env}){
 const scope=scopeOf(env),channel=env.CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID;
 if(!Array.isArray(recoveries)||recoveries.length>500||!Number.isFinite(Date.parse(from))||!/(?:Z|[+-]\d{2}:\d{2})$/.test(from))throw new Error('Invalid recovered history batch');
 const unique=new Map();
 for(const recovery of recoveries){const contact=recovery.contact;
  if(recovery.source!=='gallabox'||recovery.scope!==scope||!contact||contact.channelId!==channel||!/^[a-zA-Z0-9_-]{1,120}$/.test(contact.contactId||'')||!recovery.messages?.length||recovery.messages.some(m=>m.sourceMetadata?.externalContactId!==contact.contactId||!/^[a-zA-Z0-9_-]{1,180}$/.test(m.externalMessageId||'')))throw new Error('Recovered contact lacks matching native message scope');
  const old=unique.get(contact.contactId);unique.set(contact.contactId,{...contact,sourceMessageIds:[...new Set([...(old?.sourceMessageIds||[]),...recovery.messages.map(m=>m.externalMessageId)])]});
 }
 const token=randomUUID(),now=new Date();const state=await State.findOneAndUpdate({scope,$or:[{leaseUntil:{$lt:now}},{leaseUntil:{$exists:false}}]},{$set:{leaseToken:token,leaseUntil:new Date(+now+120000)}},{new:true}).lean();if(!state)throw new Error('Sync is busy or not initialized');
 try{
  for(const contact of unique.values()){
   const checkpoint=state.queue.find(j=>j.history&&j.contactId===contact.contactId)||state.completed?.[`contact:${contact.contactId}`];
   if(checkpoint&&(!checkpoint.from||!Number.isFinite(Date.parse(checkpoint.from))||Date.parse(from)<Date.parse(checkpoint.from)||checkpoint.apiWindowExhausted===false))throw new Error('Recovered history range requires an explicit replay; an existing checkpoint does not cover it.');
  }
  const jobs=[...unique.values()].filter(c=>!state.queue.some(j=>j.history&&j.contactId===c.contactId)&&!state.completed?.[`contact:${c.contactId}`]).map(c=>({...c,id:`contact:${c.contactId}`,allContactConversations:true,history:true,from,page:1,pageSize:100,hashes:[],failures:0,sourceKind:'native_message_lookup'}));
  if(state.queue.length+jobs.length>1000)throw new Error('Recovered history exceeds queue capacity');
  await observeServiceContacts({scope,contacts:[...unique.values()].map(c=>({...c,externalContactId:c.contactId})),origin:'gallabox_api'});
  if(jobs.length)await State.updateOne({scope,leaseToken:token},{$push:{queue:{$each:jobs}},$inc:{historyQueued:jobs.length}});
  return{queued:jobs.length,duplicateContacts:unique.size-jobs.length};
 }finally{await State.updateOne({scope,leaseToken:token},{$set:{leaseUntil:new Date(0)},$unset:{leaseToken:1}});}
}
