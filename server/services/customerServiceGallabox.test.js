import test from 'node:test';
import assert from 'node:assert/strict';
import {checkGallaboxConnection} from './customerServiceGallabox.js';
const env={CUSTOMER_SERVICE_GALLABOX_API_KEY:'private-fixture-key',CUSTOMER_SERVICE_GALLABOX_API_SECRET:'private-fixture-secret',CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID:'account-fixture'};
test('missing configuration never calls Gallabox or reuses the renewal integration credentials',async()=>{
 const result=await checkGallaboxConnection({env:{GALLABOX_API_KEY:'legacy',GALLABOX_API_SECRET:'legacy'},fetchImpl:()=>{throw new Error('Must not call provider')}});
 assert.equal(result.state,'not_configured');assert.equal(result.captureConnected,false);
});
test('read-only account check requires matching membership and returns no private profile or credentials',async()=>{
 const calls=[];
 const result=await checkGallaboxConnection({env,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify([{id:'staff-fixture',name:'Test staff',email:'private@fixture.invalid',accounts:[{accountId:'account-fixture',channelIds:['channel-fixture']}]}]),{headers:{'content-type':'application/json'}});}});
 assert.equal(result.state,'account_verified');assert.equal(result.captureConnected,false);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://server.gallabox.com/devapi/accounts/account-fixture/users');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'error');
 assert.equal(calls[0].options.headers.apiSecret,'private-fixture-secret');
 assert.equal(result.staffCount,1);assert.ok(!JSON.stringify(result).includes('private'));
});
test('wrong account, unexpected response and unverified channel never become connected',async()=>{
 for(const payload of [[],{success:true},[{id:'x',accounts:[{accountId:'other'}]}]]){
  const result=await checkGallaboxConnection({env,fetchImpl:async()=>new Response(JSON.stringify(payload))});assert.equal(result.state,'unverified');
 }
 const result=await checkGallaboxConnection({env:{...env,CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID:'other'},fetchImpl:async()=>new Response(JSON.stringify([{id:'x',accounts:[{accountId:'account-fixture',channelIds:['channel-fixture']}]}]))});assert.equal(result.state,'unverified');
});
test('provider failure is sanitized, does not retry or expose response bodies',async()=>{
 for(const status of [401,403,429,500]){
  let calls=0;const result=await checkGallaboxConnection({env,fetchImpl:async()=>{calls++;return new Response('private provider details',{status});}});
  assert.equal(calls,1);assert.notEqual(result.state,'account_verified');assert.ok(!JSON.stringify(result).includes('private'));
 }
 const result=await checkGallaboxConnection({env,fetchImpl:async()=>{throw new Error('private-secret')}});assert.equal(result.state,'unavailable');assert.ok(!JSON.stringify(result).includes('private'));
});
test('account identifier cannot inject paths or queries into the provider URL',async()=>{
 const result=await checkGallaboxConnection({env:{...env,CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID:'../me?key=secret'},fetchImpl:()=>{throw new Error('Must not call provider')}});assert.equal(result.state,'not_configured');
});

// Fictional fixtures preserve the field shapes independently observed in the
// authenticated read-only API on 2026-11-06; never check in captured customer data.
const conversation={id:'conversation-fixture',accountId:'account-fixture',channelId:'channel-fixture',contactId:'contact-fixture',contact:{id:'contact-fixture',name:'Fictional customer'},updatedAt:'2026-11-06T06:00:00Z'};
const message={id:'message-fixture',accountId:'account-fixture',channelId:'channel-fixture',contactId:'contact-fixture',conversationId:'conversation-fixture',sender:'contact-fixture',createdAt:'2026-11-06T06:00:01Z',whatsapp:{from:'fictional',time:'2026-11-06T06:00:00Z',type:'text',text:{body:'Fictional question'}}};
const users=[{id:'agent-fixture',name:'Fictional agent',accounts:[{accountId:'account-fixture',channelIds:['channel-fixture']}]}];
const configured={...env,CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID:'channel-fixture'};
const provider=(messages=[message])=>async(url,options)=>{assert.equal(options.method,'GET');if(url.endsWith('/users'))return Response.json(users);if(new URL(url).pathname.endsWith('/conversations'))return Response.json([conversation]);const u=new URL(url);assert.equal(u.pathname,'/devapi/accounts/account-fixture/messages');assert.equal(u.searchParams.get('channelId'),'channel-fixture');assert.equal(u.searchParams.get('contactId'),'contact-fixture');return Response.json(Number(u.searchParams.get('page')||1)>1?[]:messages);};
test('native list exposes bounded conversation choices with explicit partial coverage',async()=>{
 const {listGallaboxConversations}=await import('./customerServiceGallabox.js');
 const r=await listGallaboxConversations({env:configured,fetchImpl:provider()});assert.equal(r.coverage,'partial');assert.equal(r.conversations[0].name,'Fictional customer');assert.equal(r.conversations[0].id,'conversation-fixture');
});
test('native capture preserves source IDs and timestamp without guessing a Matter customer',async()=>{
 const {readGallaboxConversation}=await import('./customerServiceGallabox.js');
 const r=await readGallaboxConversation({conversationId:'conversation-fixture',env:configured,fetchImpl:provider()});assert.equal(r.source,'gallabox');assert.equal(r.messages[0].externalMessageId,'message-fixture');assert.equal(r.messages[0].externalConversationId,'conversation-fixture');assert.equal(r.messages[0].sentAt,'2026-11-06T06:00:00Z');assert.equal(r.messages[0].authorType,'customer');assert.equal(r.messages[0].customerId,undefined);assert.equal(r.coverage,'partial');
});
test('unverified outbound authors, broadcast automation and missing media cannot become staff text',async()=>{
 const {readGallaboxConversation}=await import('./customerServiceGallabox.js');
 const outgoing={...message,id:'out',sender:'agent-fixture',userId:'agent-fixture',whatsapp:{to:'fictional',time:message.whatsapp.time,type:'audio',audio:{id:'media-fixture'}}};
 const r=await readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:provider([outgoing,{...outgoing,id:'auto',context:{broadcastId:'broadcast-fixture'}},{...outgoing,id:'unknown',sender:'unknown'}])});assert.equal(r.messages[0].authorType,'staff');assert.equal(r.messages[0].type,'audio');assert.equal(r.messages[0].text,'');assert.equal(r.messages[1].authorType,'unknown');assert.equal(r.messages[2].authorType,'unknown');
});
test('wrong account/channel/contact payloads fail before any import, unrelated conversation messages are excluded',async()=>{
 const {readGallaboxConversation}=await import('./customerServiceGallabox.js');
 for(const field of ['accountId','channelId','contactId'])await assert.rejects(readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:provider([{...message,[field]:'wrong'}])}));
 const r=await readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:provider([message,{...message,id:'older',conversationId:'another'}])});assert.equal(r.messages.length,1);
 await assert.rejects(readGallaboxConversation({conversationId:'unlisted',env:configured,fetchImpl:provider()}));
});

test('message capture follows verified pages to an empty response and deduplicates overlapping IDs',async()=>{
 const {readGallaboxConversation}=await import('./customerServiceGallabox.js');let messageReads=0;const fake=provider();
 const result=await readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:async(url,options)=>{if(!url.includes('/messages?'))return fake(url,options);messageReads++;const page=Number(new URL(url).searchParams.get('page'));return Response.json(page===1?[message]:page===2?[message,{...message,id:'older-message',whatsapp:{...message.whatsapp,time:'2026-11-05T06:00:00Z'}}]:[]);}});
 assert.equal(messageReads,3);assert.equal(result.messages.length,2);assert.equal(result.apiWindowExhausted,true);assert.equal(result.coverage,'partial');
});
test('ignored pagination and conflicting repeated messages cannot masquerade as a complete capture',async()=>{
 const {readGallaboxConversation}=await import('./customerServiceGallabox.js');const fake=provider();
 await assert.rejects(readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:async(url,options)=>url.includes('/messages?')?Response.json([message]):fake(url,options)}),/pagination/i);
});
test('capture stops at its message/page budget and explicitly leaves history incomplete',async()=>{
 const {readGallaboxConversation}=await import('./customerServiceGallabox.js');const fake=provider();let pages=0;
 const result=await readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:async(url,options)=>{if(!url.includes('/messages?'))return fake(url,options);pages++;return Response.json(Array.from({length:20},(_,i)=>({...message,id:`page-${pages}-${i}`})));}});
 assert.equal(pages,25);assert.equal(result.messages.length,500);assert.equal(result.apiWindowExhausted,false);assert.match(result.message,/limit/);
});
test('changed duplicate content and wrong-scope later pages fail the whole read',async()=>{
 const {readGallaboxConversation}=await import('./customerServiceGallabox.js');const fake=provider();
 for(const second of [{...message,whatsapp:{...message.whatsapp,text:{body:'Changed evidence'}}},{...message,id:'other',accountId:'wrong'}]){
  await assert.rejects(readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:async(url,options)=>{if(!url.includes('/messages?'))return fake(url,options);return Response.json([Number(new URL(url).searchParams.get('page'))===1?message:second]);}}));
 }
});
test('overlapping pages cannot change staff evidence into broadcast/customer evidence silently',async()=>{
 const {readGallaboxConversation}=await import('./customerServiceGallabox.js');const fake=provider();
 const outbound={...message,sender:'agent-fixture',userId:'agent-fixture',whatsapp:{time:message.whatsapp.time,to:'fixture',type:'text',text:{body:'Fictional agent reply'}}};
 await assert.rejects(readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:async(url,options)=>{if(!url.includes('/messages?'))return fake(url,options);const page=Number(new URL(url).searchParams.get('page'));return Response.json(page===1?[outbound]:page===2?[{...outbound,context:{broadcastId:'broadcast-fixture'}},{...message,id:'next'}]:[]);}}),/changed across pages/);
});
test('native system log entries retain their event timestamp without becoming staff replies',async()=>{
 const {readGallaboxConversation}=await import('./customerServiceGallabox.js');
 const system={...message,id:'system-event',sender:'system-fixture',whatsapp:undefined,log:{actor:'system-fixture',action:'assignment',time:'2026-11-05T07:00:00Z'}};
 const r=await readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:provider([message,system])});assert.equal(r.messages.length,2);assert.equal(r.messages[1].authorType,'system');assert.equal(r.messages[1].sentAt,'2026-11-05T07:00:00Z');assert.equal(r.messages[1].text,'');
});

test('verified historical contact reads preserve each native conversation ID',async()=>{
 const {readGallaboxMessagePage}=await import('./customerServiceGallabox.js');
 const r=await readGallaboxMessagePage({conversation:{...conversation,allContactConversations:true},env:configured,fetchImpl:provider([message,{...message,id:'older',conversationId:'older-native-thread'}])});
 assert.deepEqual(r.messages.map(m=>m.externalConversationId),['conversation-fixture','older-native-thread']);
 const missing=await readGallaboxMessagePage({conversation:{...conversation,allContactConversations:true},env:configured,fetchImpl:provider([{...message,conversationId:undefined}])});assert.equal(missing.messages[0].externalConversationId,'unthreaded:contact-fixture');assert.equal(missing.messages[0].externalMessageId,message.id);
});
test('native capture retains contact reference and listing exposes only explicit normalized contact fields',async()=>{
 const {readGallaboxConversation,listGallaboxConversations}=await import('./customerServiceGallabox.js');
 const r=await readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:provider()});assert.equal(r.messages[0].sourceMetadata.externalContactId,conversation.contactId);
 const p=provider();const listed=await listGallaboxConversations({env:configured,fetchImpl:async(u,o)=>new URL(u).pathname.endsWith('/conversations')?Response.json([{...conversation,contact:{name:'Fixture',formattedPhone:'+971 50 123 4567',email:' FIXTURE@example.invalid ',fieldValues:{email:'untrusted'}}}]):p(u,o)});
 assert.equal(listed.conversations[0].phone,'971501234567');assert.equal(listed.conversations[0].email,'fixture@example.invalid');
});
test('page contact observations accept only verified inbound sender phone strings',async()=>{
 const {readGallaboxMessagePage}=await import('./customerServiceGallabox.js');
 const p=provider();const r=await readGallaboxMessagePage({conversation:{...conversation,name:'Fixture',allContactConversations:true},env:configured,fetchImpl:async(u,o)=>u.includes('/messages?')?Response.json([{...message,whatsapp:{...message.whatsapp,from:'+971 50 123 4567'}},{...message,id:'outgoing',sender:'agent-fixture',whatsapp:{...message.whatsapp,from:'+971501111111'}}]):p(u,o)});
 assert.deepEqual(r.contacts,[{externalContactId:conversation.contactId,phone:'971501234567',name:'Fixture'}]);
});
test('missing native contact attributes are omitted so discovery cannot clear verified export attributes',async()=>{
 const {listGallaboxConversations}=await import('./customerServiceGallabox.js');
 const r=await listGallaboxConversations({env:configured,fetchImpl:async()=>Response.json([{...conversation,contact:{name:'Fixture',formattedPhone:null,fieldValues:{email:'unverified@fixture.invalid'}}}])});
 assert.equal(Object.hasOwn(r.conversations[0],'phone'),false);assert.equal(Object.hasOwn(r.conversations[0],'email'),false);
});
test('native internal notes preserve source creation time and body without becoming outbound text',async()=>{
 const {readGallaboxMessagePage}=await import('./customerServiceGallabox.js');
 const note={...message,id:'note-fixture',sender:'agent-fixture',userId:'agent-fixture',whatsapp:undefined,private:{type:'text',text:{body:'Internal fixture note'},mentions:[]}};
 const result=await readGallaboxMessagePage({conversation:{...conversation,allContactConversations:true},env:configured,fetchImpl:provider([note])});
 assert.equal(result.messages[0].type,'other');assert.equal(result.messages[0].text,'Internal fixture note');assert.equal(result.messages[0].sentAt,note.createdAt);assert.equal(result.messages[0].authorType,'staff');assert.deepEqual(result.messages[0].sourceMetadata.nativeEvent,{kind:'internal_note',timestampBasis:'createdAt'});
 const {normalizeServiceMessage}=await import('./customerServiceCaptureFormat.js');assert.deepEqual(normalizeServiceMessage(result.messages[0],result).sourceMetadata.nativeEvent,{kind:'internal_note',timestampBasis:'createdAt'});
});
test('private image notes retain media and internal-note provenance without blocking a page',async()=>{
 const{readGallaboxMessagePage}=await import('./customerServiceGallabox.js');
 const note={...message,id:'private-image',sender:'agent-fixture',userId:'agent-fixture',whatsapp:undefined,private:{type:'image',image:{path:'https://files.gallabox.com/account-fixture/fixture.png',mimeType:'image/png'}}};
 const result=await readGallaboxMessagePage({conversation:{...conversation,allContactConversations:true},env:configured,fetchImpl:provider([note])});assert.equal(result.messages[0].type,'image');assert.equal(result.messages[0].sourceMetadata.nativeEvent.kind,'internal_note');assert.equal(result.messages[0].sourceMetadata.media.mimeType,'image/png');
 const{normalizeServiceMessage}=await import('./customerServiceCaptureFormat.js');assert.equal(normalizeServiceMessage(result.messages[0],result).sourceMetadata.nativeEvent.kind,'internal_note');
});
test('exact historical message lookup derives contact only from matching source scope and ID',async()=>{
 const {readGallaboxSourceMessage}=await import('./customerServiceGallabox.js');
 const fake=async url=>url.endsWith('/users')?Response.json(users):Response.json(message);
 const result=await readGallaboxSourceMessage({messageId:message.id,env:configured,fetchImpl:fake});assert.equal(result.contact.contactId,conversation.contactId);assert.equal(result.messages[0].externalMessageId,message.id);assert.equal(result.messages[0].externalConversationId,conversation.id);
 for(const field of ['id','accountId','channelId'])await assert.rejects(readGallaboxSourceMessage({messageId:message.id,env:configured,fetchImpl:async()=>Response.json({...message,[field]:'wrong'})}));
 await assert.rejects(readGallaboxSourceMessage({messageId:'../messages',env:configured,fetchImpl:()=>{throw new Error('must not request');}}));
});
test('explicit 100-row pages keep legacy page size stable and reject oversized responses',async()=>{
 const{readGallaboxMessagePage}=await import('./customerServiceGallabox.js');const p=provider();let limit;
 const fetchImpl=async(u,o)=>{if(u.endsWith('/users'))return p(u,o);limit=new URL(u).searchParams.get('limit');return Response.json([message]);};
 await readGallaboxMessagePage({conversation,pageSize:100,env:configured,fetchImpl});assert.equal(limit,'100');
 await readGallaboxMessagePage({conversation,env:configured,fetchImpl});assert.equal(limit,null);
 await assert.rejects(readGallaboxMessagePage({conversation,pageSize:101,env:configured,fetchImpl}));
});
test('documented contact lookup retains only unambiguous direct contact fields',async()=>{
 const{readGallaboxSourceContact}=await import('./customerServiceGallabox.js');const source={id:'contact-fixture',accountId:'account-fixture',name:'Fixture',phone:['+971 50 123 4567'],email:[' FIXTURE@example.invalid ']};
 const result=await readGallaboxSourceContact({contactId:source.id,env:configured,fetchImpl:async()=>Response.json(source)});assert.equal(result.phone,'971501234567');assert.equal(result.email,'fixture@example.invalid');
 await assert.rejects(readGallaboxSourceContact({contactId:source.id,env:configured,fetchImpl:async()=>Response.json({...source,accountId:'other'})}));
});
test('automatic conversation discovery requests the verified 100-record window without claiming pagination',async()=>{
 const{listGallaboxConversations}=await import('./customerServiceGallabox.js');let url;
 const result=await listGallaboxConversations({env:configured,fetchImpl:async u=>{url=new URL(u);return Response.json([conversation]);}});assert.equal(url.searchParams.get('limit'),'100');assert.equal(result.coverage,'partial');
});
test('overlapping private note pages reject changed body and creation timestamp',async()=>{
 const{readGallaboxConversation}=await import('./customerServiceGallabox.js');const note={...message,id:'private-overlap',whatsapp:undefined,private:{type:'text',text:{body:'Original private note'}}},p=provider();
 for(const changed of [{...note,private:{type:'text',text:{body:'Changed private note'}}},{...note,createdAt:'2026-11-06T06:00:02Z'}])await assert.rejects(readGallaboxConversation({conversationId:conversation.id,env:configured,fetchImpl:async(u,o)=>!u.includes('/messages?')?p(u,o):Response.json(Number(new URL(u).searchParams.get('page'))===1?[note]:Number(new URL(u).searchParams.get('page'))===2?[changed,{...message,id:'additional'}]:[])}),/changed across pages/);
});
test('discovery requests the configured channel rather than filtering a different channel window',async()=>{
 const {listGallaboxConversations}=await import('./customerServiceGallabox.js');
 const secondary={...configured,CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID:'secondary'};
 const result=await listGallaboxConversations({env:secondary,fetchImpl:async(url,options)=>{
  assert.equal(options.method,'GET');const channel=new URL(url).searchParams.get('channelId');
  return Response.json([{...conversation,channelId:channel==='secondary'?'secondary':conversation.channelId}]);
 }});
 assert.equal(result.conversations.length,1);assert.equal(result.conversations[0].channelId,'secondary');
});

test('open discovery includes older backlog outside the recent window and deduplicates native IDs',async()=>{
 const {listGallaboxConversations}=await import('./customerServiceGallabox.js');let calls=0;
 const r=await listGallaboxConversations({env:configured,includeOpen:true,fetchImpl:async url=>{calls++;return Response.json(url.includes('status=OPEN')?[{...conversation,status:'OPEN'},{...conversation,id:'older-open',status:'OPEN'}]:[{...conversation,status:'OPEN'}]);}});
 assert.equal(calls,2);assert.equal(r.conversations.length,2);assert.equal(r.conversations[1].providerInbox.status,'open');assert.equal(r.coverage,'partial');
 await assert.rejects(listGallaboxConversations({env:configured,includeOpen:true,fetchImpl:async()=>Response.json([{...conversation,status:'CLOSE'}])}),/open-conversation filter/);
});
