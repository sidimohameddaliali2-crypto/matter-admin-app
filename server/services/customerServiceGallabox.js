import {Buffer} from 'node:buffer';
import {gallaboxInboxState} from './customerServiceProviderInbox.js';
import {nativeContentFromWhatsapp} from './customerServiceNativeContext.js';
import {normalizeContactPhone,normalizeContactEmail} from './customerServiceContactFormat.js';
// Verified contract: https://developers.gallabox.com/gallabox-api/users
// This probe is read-only and intentionally independent of renewal-message keys.
export async function checkGallaboxConnection({env=process.env,fetchImpl=fetch}={}) {
 const key=env.CUSTOMER_SERVICE_GALLABOX_API_KEY?.trim();
 const secret=env.CUSTOMER_SERVICE_GALLABOX_API_SECRET?.trim();
 const account=env.CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID?.trim();
 const channel=env.CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID?.trim();
 const result=(state,message,extra={})=>({state,message,captureConnected:false,checkedAt:new Date().toISOString(),...extra});
 if(!key||!secret||!account||!/^[a-zA-Z0-9_-]{1,120}$/.test(account)) return result('not_configured','Enter the private customer-service Gallabox API key, secret and account ID on the server.');
 try {
  const response=await fetchImpl(`https://server.gallabox.com/devapi/accounts/${account}/users`,{
   method:'GET',headers:{apiKey:key,apiSecret:secret,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000),cache:'no-store',
  });
  if(!response.ok) return result([401,403].includes(response.status)?'access_denied':'unavailable',[401,403].includes(response.status)?'Gallabox denied account access. Check the key permissions and account.':'Gallabox is unavailable. Retry the check later.');
  // Bound the body while streaming, including responses without Content-Length.
  if(Number(response.headers.get('content-length')||0)>1024*1024) return result('unverified','Gallabox returned an unsupported account response.');
  const reader=response.body?.getReader();if(!reader) return result('unverified','Gallabox returned no account evidence.');
  let size=0;const parts=[];
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();return result('unverified','Gallabox returned an unsupported account response.');}parts.push(value);}}finally{reader.releaseLock();}
  const users=JSON.parse(Buffer.concat(parts).toString('utf8'));
  if(!Array.isArray(users)||!users.length||users.some(user=>!user.id||!Array.isArray(user.accounts)||!user.accounts.some(a=>a.accountId===account))) return result('unverified','The response did not verify the configured Gallabox account.');
  if(channel&&!users.some(user=>user.accounts.some(a=>a.accountId===account&&a.channelIds?.includes(channel)))) return result('unverified','The configured channel was not verified in this account.');
  return result('account_verified','Gallabox account access verified. Read-only conversation access is available. See automatic sync status for progress and historical coverage.',{staffCount:users.length});
 } catch {return result('unavailable','Gallabox could not be verified. Check the connection and retry.');}
}

const fail=(message,statusCode=502)=>Object.assign(new Error(message),{statusCode});
function configuration(env){
 const account=env.CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID?.trim(),channel=env.CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID?.trim();
 const key=env.CUSTOMER_SERVICE_GALLABOX_API_KEY?.trim(),secret=env.CUSTOMER_SERVICE_GALLABOX_API_SECRET?.trim();
 if(!key||!secret||!account||!/^[a-zA-Z0-9_-]{1,120}$/.test(account))throw fail('Gallabox customer-service configuration is incomplete.',503);
 return {account,channel,key,secret};
}
async function nativeGet(path,{env,fetchImpl,object=false}){
 const c=configuration(env);
 try{
  const response=await fetchImpl(`https://server.gallabox.com/devapi/accounts/${c.account}/${path}`,{method:'GET',headers:{apiKey:c.key,apiSecret:c.secret,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000),cache:'no-store'});
  if(!response.ok)throw fail(response.status===429?'Gallabox rate limit reached. Wait before retrying.':'Gallabox could not supply the requested data. Check account permissions and retry.',response.status===429?429:502);
  const reader=response.body?.getReader();if(!reader)throw fail('Gallabox returned no data.');let size=0;const parts=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>5*1024*1024){await reader.cancel();throw fail('Gallabox response exceeds the safe capture limit.');}parts.push(value);}}finally{reader.releaseLock();}
  const rows=JSON.parse(Buffer.concat(parts).toString('utf8'));if(object?(!rows||typeof rows!=='object'||Array.isArray(rows)):(!Array.isArray(rows)||rows.length>500))throw fail('Gallabox returned an unsupported or oversized response.');return rows;
 }catch(error){if(error.statusCode)throw error;throw fail('Gallabox could not be reached or returned unsupported data. Retry later.');}
}
// These two native read contracts were verified against this account on
// 2026-11-06. Message page=1/2/3 yielded distinct pages then an empty page.
// Verified 2026-11-07: conversation page/offset/skip repeat the same window;
// channelId must be sent to discover each authorized channel. Even exhausted message pages do
// not prove source retention or a stable snapshot while new messages arrive.
export async function listGallaboxConversations({env=process.env,fetchImpl=fetch,includeOpen=false}={}){
 const {account,channel}=configuration(env);
 const query=new URLSearchParams({limit:'100',...(channel?{channelId:channel}:{})});
 let rows=await nativeGet(`conversations?${query}`,{env,fetchImpl});
 if(includeOpen){
  // Verified read-only status filter includes open chats outside the recent window.
  const open=await nativeGet(`conversations?${query}&status=OPEN`,{env,fetchImpl});
  if(open.some(c=>c.status!=='OPEN'))throw fail('Gallabox did not honor the open-conversation filter.');
  rows=[...new Map([...rows,...open].map(c=>[c.id,c])).values()];
 }
 if(rows.some(c=>c.accountId!==account||!c.id||!c.channelId||!c.contactId))throw fail('Gallabox conversation identity could not be verified.');
 const conversations=rows.filter(c=>!channel||c.channelId===channel).map(c=>({id:c.id,channelId:c.channelId,contactId:c.contactId,...(normalizeContactPhone(c.contact?.formattedPhone)?{phone:normalizeContactPhone(c.contact.formattedPhone)}:{}),...(normalizeContactEmail(c.contact?.email)?{email:normalizeContactEmail(c.contact.email)}:{}),name:typeof c.contact?.name==='string'?c.contact.name.slice(0,200):'Name not recorded',updatedAt:c.updatedAt||null,providerInbox:gallaboxInboxState(c)}));
 return {conversations,coverage:'partial',returned:rows.length,message:'Recent conversation window only. Older conversations may be omitted.'};
}
export async function readGallaboxConversation({conversationId,env=process.env,fetchImpl=fetch}={}){
 const {account}=configuration(env);
 const {conversations}=await listGallaboxConversations({env,fetchImpl});
 const conversation=conversations.find(c=>c.id===conversationId);
 if(!conversation)throw fail('Conversation is not in the current permitted Gallabox window. Reload the list.',409);
 const users=await nativeGet('users',{env,fetchImpl});
 if(users.some(u=>!u.id||!u.accounts?.some(a=>a.accountId===account)))throw fail('Gallabox staff identity could not be verified.');
 const knownUsers=new Map(users.map(u=>[u.id,u]));
 const unique=new Map();let apiWindowExhausted=false,pagesRead=0;
 for(let page=1;page<=25&&unique.size<500;page++){
  const query=new URLSearchParams({channelId:conversation.channelId,contactId:conversation.contactId,page:String(page)});
  const rows=await nativeGet(`messages?${query}`,{env,fetchImpl});pagesRead++;
  if(!rows.length){apiWindowExhausted=true;break;}
  if(rows.some(m=>m.accountId!==account||m.channelId!==conversation.channelId||m.contactId!==conversation.contactId))throw fail('Gallabox message scope did not match the requested account and contact.');
  let added=0;
  for(const row of rows){
   if(!row.id)throw fail('Gallabox message identity is missing.');
   if(unique.has(row.id)){
    const old=unique.get(row.id);
    if(['conversationId','sender','userId'].some(key=>old[key]!==row[key])||JSON.stringify([old.whatsapp?.time,old.whatsapp?.type,old.whatsapp?.text,old.whatsapp?.from,old.context?.broadcastId,old.log,old.createdAt,old.private?.type,old.private?.text?.body,old.private?.[old.private?.type]?.caption])!==JSON.stringify([row.whatsapp?.time,row.whatsapp?.type,row.whatsapp?.text,row.whatsapp?.from,row.context?.broadcastId,row.log,row.createdAt,row.private?.type,row.private?.text?.body,row.private?.[row.private?.type]?.caption]))throw fail('Gallabox evidence changed across pages. Retry the capture.');
   }else{unique.set(row.id,row);added++;}
  }
  if(!added)throw fail('Gallabox pagination repeated a page. Capture was not committed.');
  if(unique.size>500)throw fail('Gallabox history exceeds the 500-message capture limit. No capture was committed.',422);
 }
 const rows=[...unique.values()];
 const messages=normalizeNativeMessages(rows,conversation,knownUsers);
 return {source:'gallabox',scope:`${account}:${conversation.channelId}`,messages,coverage:'partial',received:rows.length,pagesRead,apiWindowExhausted,message:apiWindowExhausted?'Available message pages reached their end. Source retention, historical completeness and media contents remain unverified.':'Capture reached its page/message limit; older history may be omitted. Media contents remain unverified.'};
}

function normalizeNativeMessages(rows,conversation,knownUsers,allConversations=false){
 return rows.filter(m=>allConversations||m.conversationId===conversation.id).map(m=>{
  if(m.conversationId!=null&&typeof m.conversationId!=='string')throw fail('Gallabox conversation identity has an unsupported format.');
  // Some source messages have no conversation ID. Retain them under an
  // explicit contact group instead of inventing an assignment or dropping them.
  const externalConversationId=m.conversationId||`unthreaded:${conversation.contactId}`;
  if(!m.whatsapp&&m.log&&typeof m.log.time==='string'&&Number.isFinite(Date.parse(m.log.time))){
   return {externalMessageId:m.id,externalConversationId,customerName:conversation.name,externalAuthorId:'',authorType:'system',authorName:'Gallabox system event',sentAt:m.log.time,type:'other',text:'',sourceMetadata:{externalContactId:conversation.contactId,systemEvent:{action:m.log.action?.event,actorType:m.log.actor?.type,trigger:m.log.actor?.source,actorName:m.log.actor?.user?.name,assigneeName:m.log.action?.assign?.user?.name}}};
  }
  if(!m.whatsapp&&m.private&&typeof m.private.type==='string'&&typeof m.createdAt==='string'&&Number.isFinite(Date.parse(m.createdAt))){
   const staff=m.userId&&m.sender===m.userId&&knownUsers.has(m.userId),note=m.private;
   if(note.type==='text'&&typeof note.text?.body!=='string')throw fail('Gallabox internal note has no readable body.');
   const type=['audio','image','video','document','location'].includes(note.type)?note.type:'other';
   const text=note.type==='text'?note.text.body:typeof note[note.type]?.caption==='string'?note[note.type].caption:'';
   return {externalMessageId:m.id,externalConversationId,customerName:conversation.name,externalAuthorId:typeof m.sender==='string'?m.sender:'',authorType:staff?'staff':'unknown',authorName:staff?knownUsers.get(m.userId).name||'':'',sentAt:m.createdAt,type,text,sourceMetadata:{externalContactId:conversation.contactId,nativeEvent:{kind:'internal_note',timestampBasis:'createdAt'},media:{url:note[type]?.path,mimeType:note[type]?.mimeType}}};
  }
  const wa=m.whatsapp;if(!m.id||!wa||typeof wa.time!=='string'||!Number.isFinite(Date.parse(wa.time)))throw fail('Gallabox returned a message without a stable identity or source timestamp.');
  const customer=m.sender===m.contactId&&Boolean(wa.from);
  const staff=!customer&&m.userId&&m.sender===m.userId&&knownUsers.has(m.userId)&&!m.context?.broadcastId;
  const type=['text','audio','image','video','document','location'].includes(wa.type)?wa.type:'other';
  if(type==='text'&&typeof wa.text?.body!=='string')throw fail('Gallabox text message has no readable body.');
  return {externalMessageId:m.id,externalConversationId,customerName:conversation.name,externalAuthorId:typeof m.sender==='string'?m.sender:'',authorType:customer?'customer':staff?'staff':'unknown',authorName:customer?conversation.name:staff?knownUsers.get(m.userId).name||'':'',sentAt:wa.time,type,text:type==='text'?wa.text.body:'',sourceMetadata:{externalContactId:conversation.contactId,nativeContent:nativeContentFromWhatsapp(wa),nativeMessageId:wa.id,direction:customer?'incoming':wa.to?'outgoing':undefined,replyContext:wa.context?.reply,location:wa.type==='location'?wa.location:undefined,media:wa.type==='template'&&['image','video','document'].includes(wa.template?.header?.type)?{type:wa.template.header.type,url:wa.template.header[wa.template.header.type]?.path,mimeType:wa.template.header[wa.template.header.type]?.mimeType}:wa.type==='sticker'?{type:'image',url:wa.sticker?.path,mimeType:wa.sticker?.mimeType}:{url:wa[type]?.path,mimeType:wa[type]?.mimeType}}};
 });
}

// A single bounded page supports durable automatic checkpoints. Only trusted
// server discovery supplies the conversation; every returned row is re-scoped.
export async function readGallaboxMessagePage({conversation,page=1,pageSize=20,env=process.env,fetchImpl=fetch}){
 const {account,channel}=configuration(env);
 if(!conversation?.id||!conversation.contactId||conversation.channelId!==channel||!Number.isInteger(page)||page<1||page>1000||![20,100].includes(pageSize))throw fail('Invalid sync checkpoint.',422);
 const users=await nativeGet('users',{env,fetchImpl});
 if(users.some(u=>!u.id||!u.accounts?.some(a=>a.accountId===account)))throw fail('Gallabox staff identity could not be verified.');
 const query=new URLSearchParams({channelId:channel,contactId:conversation.contactId,page:String(page)});
 if(pageSize===100)query.set('limit','100');
 const rows=await nativeGet(`messages?${query}`,{env,fetchImpl});
 if(rows.length>pageSize)throw fail('Gallabox exceeded the requested message page size.');
 if(rows.some(m=>!m.id||m.accountId!==account||m.channelId!==channel||m.contactId!==conversation.contactId))throw fail('Gallabox message scope did not match the sync checkpoint.');
 const phones=[...new Set(rows.filter(m=>m.sender===m.contactId&&typeof m.whatsapp?.from==='string').map(m=>normalizeContactPhone(m.whatsapp.from)).filter(Boolean))];
 const contacts=phones.length===1?[{externalContactId:conversation.contactId,phone:phones[0],name:conversation.name||''}]:[];
 return {source:'gallabox',scope:`${account}:${channel}`,staffDirectory:users.map(u=>({id:u.id,name:u.name,email:u.email,active:u.exists!==false})),contacts,rawMessages:rows,ids:rows.map(m=>m.id),messages:normalizeNativeMessages(rows,conversation,new Map(users.map(u=>[u.id,u])),conversation.allContactConversations===true),exhausted:rows.length===0};
}

// Verified against known IDs preserved in the historical workbook on 2026-11-06.
// This recovers native contact scope without relying on names or guessed threads.
export async function readGallaboxSourceMessage({messageId,env=process.env,fetchImpl=fetch}={}){
 const {account,channel}=configuration(env);
 if(!channel||typeof messageId!=='string'||!/^[a-zA-Z0-9_-]{1,180}$/.test(messageId))throw fail('Invalid historical message identity.',422);
 const row=await nativeGet(`messages/${messageId}`,{env,fetchImpl,object:true});
 if(row.id!==messageId||row.accountId!==account||row.channelId!==channel||typeof row.contactId!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(row.contactId))throw fail('Historical message scope did not match the requested account and channel.');
 const users=await nativeGet('users',{env,fetchImpl});
 if(users.some(u=>!u.id||!u.accounts?.some(a=>a.accountId===account)))throw fail('Gallabox staff identity could not be verified.');
 const contact={id:row.conversationId||`contact:${row.contactId}`,contactId:row.contactId,channelId:row.channelId,name:'',updatedAt:row.updatedAt||null};
 const messages=normalizeNativeMessages([row],contact,new Map(users.map(u=>[u.id,u])),true);
 return{source:'gallabox',scope:`${account}:${channel}`,contact,messages,sourceCreatedAt:row.createdAt||null};
}

// https://developers.gallabox.com/gallabox-api/contacts (GET contact by ID).
export async function readGallaboxSourceContact({contactId,env=process.env,fetchImpl=fetch}={}){
 const {account,channel}=configuration(env);
 if(typeof contactId!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(contactId))throw fail('Invalid source contact identity.',422);
 const row=await nativeGet(`contacts/${contactId}`,{env,fetchImpl,object:true});
 if(row.id!==contactId||row.accountId!==account)throw fail('Source contact scope did not match the requested account.');
 const phones=[...new Set((Array.isArray(row.phone)?row.phone:[]).map(normalizeContactPhone).filter(Boolean))];
 const emails=[...new Set((Array.isArray(row.email)?row.email:[]).map(normalizeContactEmail).filter(Boolean))];
 return {externalContactId:contactId,contactId,channelId:channel,name:typeof row.name==='string'?row.name.slice(0,200):'',...(phones.length===1?{phone:phones[0]}:{}),...(emails.length===1?{email:emails[0]}:{}),multiplePhones:phones.length>1,multipleEmails:emails.length>1};
}
