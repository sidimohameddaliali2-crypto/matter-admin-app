import {cloudInbox} from './customerServiceCloudStore.js';
import {readCloudEvidence} from './customerServiceCloudEvidence.js';
import {createHash} from 'node:crypto';
import {matchHistoricalMessageIdentity} from './customerServiceHistoryIdentity.js';
import CaptureBatch from '../models/ServiceCaptureBatch.js';
import mongoose from 'mongoose';
import DirectoryState from '../models/ServiceCustomerDirectoryState.js';
import Customer from '../models/ServiceCustomer.js';
import Contact from '../models/ServiceSourceContact.js';
import Conversation from '../models/ServiceConversation.js';
import Issue from '../models/ServiceIssue.js';
import Message from '../models/ServiceMessage.js';
import {normalizeContactEmail,normalizeContactPhone} from './customerServiceContactFormat.js';
export {normalizeContactEmail,normalizeContactPhone} from './customerServiceContactFormat.js';
export function buildServiceCustomerIndex(customers){
 const email=new Map(),phone=new Map();const add=(map,key,id)=>{if(!key)return;const ids=map.get(key)||new Set();ids.add(id);map.set(key,ids);};
 for(const c of customers.filter(c=>c.eligibleForAutomaticMatching!==false))for(const p of [c,...(c.deliveryProfiles||[]),...(c.profileObservations||[])].filter(p=>p.eligibleForAutomaticMatching!==false)){add(email,normalizeContactEmail(p.email),c.customerId);add(phone,normalizeContactPhone(p.phone),c.customerId);}
 return {email,phone};
}
export function matchServiceContact(contact,customersOrIndex){
 const index=Array.isArray(customersOrIndex)?buildServiceCustomerIndex(customersOrIndex):customersOrIndex;
 const email=[...(index.email.get(normalizeContactEmail(contact.email))||[])],phone=[...(index.phone.get(normalizeContactPhone(contact.phone))||[])];
 if(contact.multiplePhones||contact.multipleEmails)return {state:'ambiguous',customerId:'',candidates:[...new Set([...email,...phone])]};
 let candidates,matchedBy;
 if(email.length&&phone.length){candidates=email.filter(id=>phone.includes(id));matchedBy='exact_email_and_phone';if(!candidates.length)return {state:'conflict',customerId:'',candidates:[...new Set([...email,...phone])]};}
 else{candidates=email.length?email:phone;matchedBy=email.length?'exact_email':'exact_phone';}
 return candidates.length===1?{state:'matched',customerId:candidates[0],matchedBy,candidates}: {state:candidates.length?'ambiguous':'unmatched',customerId:'',candidates};
}
// A reviewed declaration is evidence only while its exact native source and
// current directory identity still validate. It never rewrites the source phone.
export function reviewedPhoneMessageHash(message){
 const sentAt=new Date(message?.sentAt);if(!Number.isFinite(+sentAt))return '';
 return createHash('sha256').update(JSON.stringify({messageId:String(message._id),source:message.source,scope:message.scope,externalMessageId:message.externalMessageId,conversationId:String(message.conversationId),externalAuthorId:message.externalAuthorId,authorType:message.authorType,internalNote:Boolean(message.internalNote),type:message.type,text:message.text,sentAt:sentAt.toISOString(),externalContactId:message.sourceMetadata?.externalContactId,sourceRow:message.sourceRow??null})).digest('hex');
}
export function validateReviewedPhoneProof({contact,message,conversation,customers,index=buildServiceCustomerIndex(customers)}){
 const proof=contact?.reviewedPhoneProof;
 if(!proof||proof.state!=='reviewed'||proof.method!=='explicit_customer_self_phone'||proof.revokedAt||!Number.isFinite(Date.parse(proof.reviewedAt))||!message||!conversation)return null;
 if(proof.scope!==contact.scope||proof.externalContactId!==contact.externalContactId||proof.originalContactPhone!==normalizeContactPhone(contact.phone)||proof.originalContactEmail!==normalizeContactEmail(contact.email)||contact.multiplePhones||contact.multipleEmails)return null;
 if(proof.messageId!==String(message._id)||proof.externalMessageId!==message.externalMessageId||proof.conversationId!==String(message.conversationId)||proof.messageSha256!==reviewedPhoneMessageHash(message))return null;
 if(message.source!=='gallabox'||message.scope!==contact.scope||message.authorType!=='customer'||message.internalNote||message.type!=='text'||message.externalAuthorId!==contact.externalContactId||message.sourceMetadata?.externalContactId!==contact.externalContactId)return null;
 if(conversation.source!=='gallabox'||conversation.scope!==contact.scope||String(conversation._id)!==proof.conversationId||conversation.sourceMetadata?.externalContactId!==contact.externalContactId)return null;
 const declaration=/^\s*you can call me at[ \t]+([+\d][\d ()-]*)[.!]?\s*$/i.exec(message.text||'');
 const phone=normalizeContactPhone(proof.phone);if(!declaration||!phone||normalizeContactPhone(declaration[1])!==phone)return null;
 const candidates=[...(index.phone.get(phone)||[])];if(candidates.length!==1||candidates[0]!==proof.customerId)return null;
 const current=customers.find(c=>c.customerId===proof.customerId&&c.eligibleForAutomaticMatching!==false);
 if(!current||![current.phone,current.telephone,current.whatsappNumber].some(p=>normalizeContactPhone(p)===phone))return null;
 if((contact.customerId&&contact.customerId!==proof.customerId)||(conversation.customerId&&conversation.customerId!==proof.customerId))return null;
 const native=matchServiceContact(contact,index);if(native.candidates.some(id=>id!==proof.customerId))return null;
 return{state:'matched',customerId:proof.customerId,matchedBy:'reviewed_customer_self_phone',candidates};
}
// Reviewed sender evidence is conversation-scoped. A complete digest deliberately
// invalidates on any new or edited message; it never grants future contact ownership.
export function nativeSenderConversationHash(messages){
 return createHash('sha256').update(JSON.stringify(messages.map(m=>({id:String(m._id),hash:reviewedPhoneMessageHash(m),senderPhone:m.sourceMetadata?.verifiedCustomerEndpoint??null,...(m.sourceMetadata?.reviewedAccountSource?{accountSource:m.sourceMetadata.reviewedAccountSource,media:m.sourceMetadata.media??null}:{})})).sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex');
}
export function validateReviewedNativeSenderProof({contact,messages=[],conversations=[],customers,index=buildServiceCustomerIndex(customers)}){
 const p=contact?.reviewedNativeSenderProof;
 if(p?.method==='account_email_screenshot')return validateReviewedAccountScreenshot({contact,messages,conversations,customers,index});
 if(!p||p.state!=='reviewed'||p.method!=='native_customer_phone_endpoint'||p.revokedAt||!Number.isFinite(Date.parse(p.reviewedAt)))return null;
 if(p.scope!==contact.scope||p.externalContactId!==contact.externalContactId||p.originalContactPhone!==normalizeContactPhone(contact.phone)||p.originalContactEmail!==normalizeContactEmail(contact.email)||p.originalMultiplePhones!==Boolean(contact.multiplePhones)||p.originalMultipleEmails!==Boolean(contact.multipleEmails)||contact.multipleEmails)return null;
 const phone=normalizeContactPhone(p.phone),candidates=[...(index.phone.get(phone)||[])];
 if(!phone||phone!==normalizeContactPhone(contact.phone)||candidates.length!==1||candidates[0]!==p.customerId||(contact.customerId&&contact.customerId!==p.customerId))return null;
 const customer=customers.find(c=>c.customerId===p.customerId&&c.eligibleForAutomaticMatching!==false);
 if(!customer||![customer.phone,customer.telephone,customer.whatsappNumber].some(v=>normalizeContactPhone(v)===phone))return null;
 const emailCandidates=[...(index.email.get(normalizeContactEmail(contact.email))||[])];if(emailCandidates.some(id=>id!==p.customerId))return null;
 if(!Array.isArray(p.conversations)||!p.conversations.length||p.conversations.length>500)return null;
 const ids=p.conversations.map(c=>c.conversationId);if(new Set(ids).size!==ids.length||ids.some(id=>!/^[a-f0-9]{24}$/.test(id))||conversations.length!==ids.length||messages.some(m=>!ids.includes(String(m.conversationId))))return null;
 const [accountId,channelId,...extra]=contact.scope.split(':');if(!accountId||!channelId||extra.length)return null;
 for(const entry of p.conversations){
  const c=conversations.find(c=>String(c._id)===entry.conversationId),ms=messages.filter(m=>String(m.conversationId)===entry.conversationId);
  if(!c||c.source!=='gallabox'||c.scope!==contact.scope||c.sourceMetadata?.externalContactId!==contact.externalContactId||(c.customerId&&c.customerId!==p.customerId)||!ms.length||ms.length!==entry.messageCount||nativeSenderConversationHash(ms)!==entry.messageSha256)return null;
  let endpoints=0;
  for(const m of ms){const e=m.sourceMetadata?.verifiedCustomerEndpoint;
   if(m.source!=='gallabox'||m.scope!==contact.scope||m.sourceMetadata?.externalContactId!==contact.externalContactId||!e||e.accountId!==accountId||e.channelId!==channelId||e.contactId!==contact.externalContactId||e.externalMessageId!==m.externalMessageId||e.externalConversationId!==c.externalConversationId||!/^([a-f0-9]{64})$/.test(e.sourceSha256||''))return null;
   if(e.direction==='inbound'){
    if(m.internalNote||m.authorType!=='customer'||m.externalAuthorId!==contact.externalContactId||e.sender!==contact.externalContactId||normalizeContactPhone(e.phone)!==phone)return null;endpoints++;
   }else if(e.direction==='outbound'){
    const to=normalizeContactPhone(e.to);
    if(m.internalNote||m.authorType==='customer'||!e.sender||e.sender===contact.externalContactId||m.externalAuthorId!==e.sender||!to||normalizeContactPhone(e.phone)!==to)return null;
    if(to!==phone){
     // This is an exact provider recipient-ID join, never a suffix/country guess.
     // Preserve the raw local endpoint and require its canonical counterpart in
     // the same digest-bound reviewed set. Any current competing owner vetoes it.
     if(!/^[1-9]\d{8}$/.test(to)||typeof e.recipient!=='string'||!e.recipient||[...(index.phone.get(to)||[])].some(id=>id!==p.customerId))return null;
     const sameRecipient=messages.map(n=>n.sourceMetadata?.verifiedCustomerEndpoint).filter(n=>n?.direction==='outbound'&&n.recipient===e.recipient);
     if(!sameRecipient.some(n=>normalizeContactPhone(n.to)===phone)||sameRecipient.some(n=>normalizeContactPhone(n.to)!==phone&&!/^[1-9]\d{8}$/.test(normalizeContactPhone(n.to))))return null;
    }
    endpoints++;
   }else if(e.direction==='system_event'){
    if(m.authorType!=='system'||m.text||m.internalNote||e.phone||e.to)return null;
   }else if(e.direction==='internal_note'){
    if(m.authorType==='customer'||m.sourceMetadata?.nativeEvent?.kind!=='internal_note'||e.phone||e.to)return null;
   }else return null;
  }
  if(!endpoints)return null;
 }
 return{state:'reviewed_scoped',customerId:p.customerId,matchedBy:'reviewed_native_customer_phone_endpoint',candidates,conversationIds:ids};
}
// Explicit manual review of a successful account-selection screenshot. The email
// is not inferred by OCR, and ownership never extends beyond the reviewed digest.
function validateReviewedAccountScreenshot({contact,messages,conversations,customers,index}){
 const p=contact.reviewedNativeSenderProof,sha=v=>/^[a-f0-9]{64}$/.test(v||'');
 if(p.state!=='reviewed'||p.revokedAt||!Number.isFinite(Date.parse(p.reviewedAt))||typeof p.reviewedBy!=='string'||!p.reviewedBy.trim())return null;
 if(p.scope!==contact.scope||p.externalContactId!==contact.externalContactId||p.originalContactPhone!==normalizeContactPhone(contact.phone)||p.originalContactEmail!==normalizeContactEmail(contact.email)||p.originalMultiplePhones!==Boolean(contact.multiplePhones)||p.originalMultipleEmails!==Boolean(contact.multipleEmails))return null;
 const email=normalizeContactEmail(p.email),owners=[...(index.email.get(email)||[])],customer=customers.find(c=>c.customerId===p.customerId&&c.eligibleForAutomaticMatching!==false);
 if(!email||owners.length!==1||owners[0]!==p.customerId||!customer||normalizeContactEmail(customer.email)!==email||(contact.customerId&&contact.customerId!==p.customerId))return null;
 const native=matchServiceContact(contact,index);
 if(native.state==='conflict'||native.candidates.length&&!native.candidates.includes(p.customerId))return null;
 if(!Array.isArray(p.conversations)||!p.conversations.length||p.conversations.length>500)return null;
 const ids=p.conversations.map(c=>c.conversationId);
 if(new Set(ids).size!==ids.length||ids.some(id=>!/^[a-f0-9]{24}$/.test(id))||conversations.length!==ids.length||messages.some(m=>!ids.includes(String(m.conversationId))))return null;
 const [accountId,channelId,...extra]=contact.scope.split(':');if(!accountId||!channelId||extra.length)return null;
 for(const entry of p.conversations){
  const c=conversations.find(c=>String(c._id)===entry.conversationId),ms=messages.filter(m=>String(m.conversationId)===entry.conversationId),r=entry.screenshot;
  if(!c||c.source!=='gallabox'||c.scope!==contact.scope||c.sourceMetadata?.externalContactId!==contact.externalContactId||(c.customerId&&c.customerId!==p.customerId)||!ms.length||ms.length!==entry.messageCount||nativeSenderConversationHash(ms)!==entry.messageSha256)return null;
  for(const m of ms){const e=m.sourceMetadata?.reviewedAccountSource;
   if(m.source!=='gallabox'||m.scope!==contact.scope||m.sourceMetadata?.externalContactId!==contact.externalContactId||!e||e.accountId!==accountId||e.channelId!==channelId||e.contactId!==contact.externalContactId||e.externalMessageId!==m.externalMessageId||e.externalConversationId!==c.externalConversationId||!sha(e.sourceSha256))return null;
  }
  const m=ms.find(m=>String(m._id)===r?.messageId),e=m?.sourceMetadata?.reviewedAccountSource,url=m?.sourceMetadata?.media?.url;
  if(!m||r.reviewKind!=='successful_account_selection'||m.type!=='image'||m.internalNote||m.authorType!=='customer'||m.externalAuthorId!==contact.externalContactId||e.sender!==contact.externalContactId||r.externalMessageId!==m.externalMessageId||r.messageSha256!==reviewedPhoneMessageHash(m)||typeof url!=='string'||!url.startsWith('https://'))return null;
  const urlHash=createHash('sha256').update(url).digest('hex');
  if(!sha(r.mediaSha256)||!sha(r.sourceSha256)||r.mediaSha256!==e.mediaSha256||r.sourceSha256!==e.sourceSha256||r.mediaUrlSha256!==urlHash||e.mediaUrlSha256!==urlHash)return null;
 }
 return{state:'reviewed_scoped',customerId:p.customerId,matchedBy:'reviewed_account_email_screenshot',candidates:[...new Set([...native.candidates,p.customerId])],conversationIds:ids};
}
async function readReviewedNativeSenderSource(contact,session){
 const entries=contact.reviewedNativeSenderProof?.conversations;
 if(!Array.isArray(entries)||!entries.length||entries.length>500||entries.some(e=>!/^[a-f0-9]{24}$/.test(e.conversationId||'')))return{};
 const ids=entries.map(e=>e.conversationId);let mq=Message.find({conversationId:{$in:ids}}),cq=Conversation.find({_id:{$in:ids}});if(session){mq=mq.session(session);cq=cq.session(session);}const [messages,conversations]=await Promise.all([cloudInbox()?readCloudEvidence({conversationId:{$in:ids}}):mq.lean(),cq.lean()]);return{messages,conversations};
}
export async function readValidatedNativeSenderProof(contact,{session,customers,index}={}){
 if(contact?.matchState!=='reviewed_scoped')return null;
 if(!customers){let q=DirectoryState.findOne({key:'matter_customer_directory'});if(session)q=q.session(session);const state=await q.lean();if(!state?.activeGeneration||!state.lastSuccessfulAt)return null;let cq=Customer.find({active:true,generation:state.activeGeneration});if(session)cq=cq.session(session);customers=await cq.lean();}
 const source=await readReviewedNativeSenderSource(contact,session),match=validateReviewedNativeSenderProof({contact,...source,customers,index});return match?{...match,...source}:null;
}
export function scopedSenderProofCoversConversation(conversation,proof,historyMessages=[]){
 if(!proof||conversation.customerId!==proof.customerId)return false;
 if(conversation.source==='gallabox')return proof.conversationIds.includes(String(conversation._id));
 if(conversation.source!=='gallabox_history'||!historyMessages.length)return false;
 return historyMessages.every(m=>{const match=matchHistoricalMessageIdentity(m,proof.messages.filter(n=>n.externalMessageId===m.externalMessageId));return match.state==='matched'&&proof.conversationIds.includes(String(match.message.conversationId));});
}
async function readReviewedPhoneSource(contact,session){
 const p=contact.reviewedPhoneProof;if(!p||!/^[a-f0-9]{24}$/.test(p.messageId||'')||!/^[a-f0-9]{24}$/.test(p.conversationId||''))return{};
 let mq=Message.findOne({_id:p.messageId,source:'gallabox',scope:contact.scope}),cq=Conversation.findOne({_id:p.conversationId,source:'gallabox',scope:contact.scope});if(session){mq=mq.session(session);cq=cq.session(session);}
 const [message,conversation]=await Promise.all([cloudInbox()?readCloudEvidence({_id:p.messageId,source:'gallabox',scope:contact.scope}).then(rows=>rows[0]):mq.lean(),cq.lean()]);return{message,conversation};
}
export async function observeServiceContacts({scope,contacts,origin='gallabox_api'}){
 for(const c of contacts){
  if(!/^[a-zA-Z0-9_-]{1,120}$/.test(c.externalContactId||''))continue;
  let saved=false;
  for(let attempt=0;attempt<5&&!saved;attempt++){
   const prior=await Contact.findOne({scope,externalContactId:c.externalContactId}).lean();
   if(origin==='gallabox_conversation_export'&&prior?.origin==='gallabox_api')break;
   const fields={name:typeof c.name==='string'?c.name.slice(0,200):prior?.name||'',origin,observedAt:new Date()};
   if(c.email!==undefined)fields.email=normalizeContactEmail(c.email);
   if(c.phone!==undefined)fields.phone=normalizeContactPhone(c.phone);
   for(const key of ['multiplePhones','multipleEmails'])if(typeof c[key]==='boolean')fields[key]=c[key];
   const changed=!prior||['multiplePhones','multipleEmails'].some(key=>fields[key]!==undefined&&fields[key]!==Boolean(prior[key]))||['email','phone'].some(key=>fields[key]!==undefined&&fields[key]!==String(prior[key]||''));
   if(changed){fields.matchState='pending';fields.matchedBy='';}
   if(!prior){
    try{const created=await Contact.updateOne({scope,externalContactId:c.externalContactId},{$setOnInsert:fields},{upsert:true});saved=Boolean(created.upsertedCount);}catch(e){if(e.code!==11000)throw e;}
   }else{
    const updated=await Contact.updateOne({_id:prior._id,updatedAt:prior.updatedAt,email:prior.email??{$exists:false},phone:prior.phone??{$exists:false},origin:prior.origin??{$exists:false}},{$set:fields});saved=Boolean(updated.matchedCount);
   }
  }
  if(!saved&&!(origin==='gallabox_conversation_export'&&await Contact.exists({scope,externalContactId:c.externalContactId,origin:'gallabox_api'})))throw new Error('Source contact changed concurrently; retry the observation.');
 }
}
export async function reconcileServiceCustomerLinks(){
 const state=await DirectoryState.findOne({key:'matter_customer_directory'}).lean();
 if(!state?.activeGeneration||!state.lastSuccessfulAt)return {directoryCustomers:0,matchedContacts:0};
 const [customers,contacts]=await Promise.all([Customer.find({active:true,generation:state.activeGeneration}).lean(),Contact.find().lean()]);if(!customers.length)return {directoryCustomers:0,matchedContacts:0};
 const index=buildServiceCustomerIndex(customers),names=new Map(customers.map(c=>[c.customerId,c.name]));
 const result={directoryCustomers:customers.length,matchedContacts:0,reviewedScopedContacts:0,unmatchedContacts:0,ambiguousContacts:0,conflictingContacts:0,linkedConversations:0};
 for(const contact of contacts){
  const proofSource=await readReviewedPhoneSource(contact);
  const nativeProofSource=await readReviewedNativeSenderSource(contact);
  const nativeProofMatch=validateReviewedNativeSenderProof({contact,...nativeProofSource,customers,index});
  const proofMatch=validateReviewedPhoneProof({contact,...proofSource,customers,index});
  const match=nativeProofMatch||proofMatch||matchServiceContact(contact,index);
  // Changing a previous identity requires explicit reconciliation, not a silent move.
  if(contact.customerId&&match.customerId!==contact.customerId&&match.state!=='ambiguous'){match.state='conflict';match.customerId='';}
  let applied=false,linkedCount=0;
  const session=await mongoose.startSession();try{await session.withTransaction(async()=>{
   applied=false;linkedCount=0;
   const committed=await DirectoryState.findOne({key:'matter_customer_directory'}).session(session).lean();
   if(committed?.activeGeneration!==state.activeGeneration)return;
   const directoryFence=await DirectoryState.updateOne({_id:committed._id,activeGeneration:state.activeGeneration},{$inc:{__v:1}},{session,timestamps:false});if(!directoryFence.matchedCount)return;
   if(proofMatch){
    const liveSource=await readReviewedPhoneSource(contact,session);
    if(!validateReviewedPhoneProof({contact,...liveSource,customers,index}))return;
    const m=liveSource.message;
    const proofFence=await Message.updateOne({_id:m._id,updatedAt:m.updatedAt,text:m.text,authorType:'customer',externalAuthorId:contact.externalContactId,scope:contact.scope},{$inc:{__v:1}},{session,timestamps:false});if(!proofFence.matchedCount)return;
   }
   if(nativeProofMatch){
    const liveSource=await readReviewedNativeSenderSource(contact,session);
    if(!validateReviewedNativeSenderProof({contact,...liveSource,customers,index}))return;
    for(const m of liveSource.messages){const fence=await Message.updateOne({_id:m._id,updatedAt:m.updatedAt},{$inc:{__v:1}},{session,timestamps:false});if(!fence.matchedCount)return;}
   }
   const updated=await Contact.updateOne({_id:contact._id,updatedAt:contact.updatedAt,email:contact.email??{$exists:false},phone:contact.phone??{$exists:false}},{$set:{customerId:match.customerId||contact.customerId||'',matchState:match.state,matchedBy:match.matchedBy||'',candidateCustomerIds:match.candidates,matchedAt:new Date()}},{session});
   if(!updated.matchedCount)return;
   applied=true;
   if(match.state!=='matched'&&match.state!=='reviewed_scoped')return;
   const conversations=await Conversation.find({...(nativeProofMatch?{_id:{$in:nativeProofMatch.conversationIds}}:{}),source:'gallabox',scope:contact.scope,'sourceMetadata.externalContactId':contact.externalContactId,$or:[{customerId:null},{customerId:''},{customerId:match.customerId}]}).select('_id').session(session).lean();
   const ids=conversations.map(c=>c._id);
   await Conversation.updateMany({_id:{$in:ids},$or:[{customerId:{$ne:match.customerId}},{customerName:{$ne:names.get(match.customerId)}},{'sourceMetadata.identityMatch.method':{$ne:match.matchedBy}},{'sourceMetadata.identityMatch.kind':{$ne:'current_contact'}}]},{$set:{customerId:match.customerId,customerName:names.get(match.customerId),'sourceMetadata.identityMatch':{method:match.matchedBy,matchedAt:new Date(),kind:'current_contact'}}},{session});
   await Issue.updateMany({conversationId:{$in:ids},$or:[{customerId:{$ne:match.customerId}},{customerName:{$ne:names.get(match.customerId)}}]},{$set:{customerId:match.customerId,customerName:names.get(match.customerId)}},{session});
   linkedCount=ids.length;
  });}finally{await session.endSession();}
  if(applied){result[match.state==='reviewed_scoped'?'reviewedScopedContacts':match.state==='matched'?'matchedContacts':match.state==='ambiguous'?'ambiguousContacts':match.state==='conflict'?'conflictingContacts':'unmatchedContacts']++;result.linkedConversations+=linkedCount;}
 }
 return result;
}
// Upgrade earlier native captures with their verified source contact reference.
// A customer author ID is a native contact ID; staff author IDs are never used.
export async function backfillServiceContactReferences({scope,conversationContacts=[]}){
 const known=new Set(await Contact.distinct('externalContactId',{scope}));const mapping=new Map();
 for(const x of conversationContacts){if(!known.has(x.contactId))continue;const old=mapping.get(x.conversationId);if(old===null)continue;mapping.set(x.conversationId,old&&old!==x.contactId?null:x.contactId);}
 const conversations=await Conversation.find({source:'gallabox',scope}).lean();let linked=0,unresolved=0;
 for(const c of conversations){if(c.sourceMetadata?.externalContactId)continue;let contactId=c.externalConversationId.startsWith('unthreaded:')?c.externalConversationId.slice(11):mapping.get(c.externalConversationId);
  if(!contactId){const ids=await Message.distinct('externalAuthorId',{conversationId:c._id,authorType:'customer',externalAuthorId:{$in:[...known]}});if(ids.length===1)contactId=ids[0];}
  if(!contactId||!known.has(contactId)){unresolved++;continue;}
  await Conversation.updateOne({_id:c._id,'sourceMetadata.externalContactId':{$exists:false}},{$set:{'sourceMetadata.externalContactId':contactId}});linked++;
 }
 return {linked,unresolved};
}
export function startServiceIdentityReconciliation({enabled=false,intervalMs=60000}={}){
 if(!enabled)return null;let current=null,stopped=false;const run=()=>{if(current||stopped)return current;current=reconcileServiceCustomerLinks().then(()=>reconcileHistoricalCustomerLinks()).catch(()=>{console.error('Customer-service identity refresh failed; saved links retained.');}).finally(()=>{current=null;});return current;};const timer=setInterval(run,intervalMs);timer.unref();void run();return {run,async stop(){stopped=true;clearInterval(timer);await current;}};
}

// Original export filenames retain account identity. Match exact native IDs
// within that account, keeping the curated representation untouched. Group
// ownership additionally requires every message to resolve to verified contacts
// belonging to one currently verified customer; missing/mixed evidence stays unresolved.
export async function reconcileHistoricalCustomerLinks(){
 const revisions=new Map((await Conversation.find({source:'gallabox_history'}).select('_id sourceRevision').lean()).map(c=>[String(c._id),c.sourceRevision]));
 const history=await Message.find({source:'gallabox_history'}).limit(50001).lean();
 if(history.length>50000)return {linked:0,unresolved:0,limited:true};
 const native=await Message.find({source:'gallabox',externalMessageId:{$in:history.map(m=>m.externalMessageId)}}).lean();
 const state=await DirectoryState.findOne({key:'matter_customer_directory'}).lean();
 const activeIds=state?.activeGeneration&&state.lastSuccessfulAt?await Customer.distinct('customerId',{active:true,generation:state.activeGeneration,eligibleForAutomaticMatching:{$ne:false}}):[];
 const nativeConversations=await Conversation.find({_id:{$in:native.map(m=>m.conversationId)},source:'gallabox'}).lean();
 const nativeConversationMap=new Map(nativeConversations.map(c=>[String(c._id),c]));
 const conversations=nativeConversations.filter(c=>activeIds.includes(c.customerId));
 const pairs=conversations.filter(c=>c.sourceMetadata?.externalContactId).map(c=>({scope:c.scope,externalContactId:c.sourceMetadata.externalContactId,customerId:c.customerId,matchState:{$in:['matched','reviewed_scoped']}}));
 const contacts=pairs.length?await Contact.find({$or:pairs}).lean():[];
 const contactMap=new Map(contacts.map(c=>[JSON.stringify([c.scope,c.externalContactId,c.customerId]),c]));
 const scopedProofs=new Map();for(const c of contacts.filter(c=>c.matchState==='reviewed_scoped'))scopedProofs.set(String(c._id),await readValidatedNativeSenderProof(c));
 const owners=new Map(conversations.filter(c=>{const contact=contactMap.get(JSON.stringify([c.scope,c.sourceMetadata?.externalContactId,c.customerId]));return contact&&(contact.matchState==='matched'||scopedSenderProofCoversConversation(c,scopedProofs.get(String(contact._id))));}).map(c=>[String(c._id),c]));const evidence=new Map();
 for(const message of native){const list=evidence.get(message.externalMessageId)||[];list.push(message);evidence.set(message.externalMessageId,list);}
 const identityMatches=new Map(),metadataWrites=[];
 const audit={checkedAt:new Date(),messages:history.length,nativeMessageIdsFound:0,missingNativeMessageIds:0,ambiguousNativeMessageIds:0,unverifiedSourceMessageIds:0,messagesWithObservationDifferences:0,groups:revisions.size,linkedGroups:0,unresolvedGroups:0,mixedContactGroups:0,mappedSourceGroups:0,unresolvedSourceGroups:0};
 for(const message of history){
  const match=matchHistoricalMessageIdentity(message,evidence.get(message.externalMessageId)||[]);identityMatches.set(String(message._id),match);
  if(match.state==='matched'){
   audit.nativeMessageIdsFound++;if(match.observationDifferences.length)audit.messagesWithObservationDifferences++;
   const nativeIdentity={source:'gallabox',scope:match.message.scope,messageId:String(match.message._id),externalMessageId:match.message.externalMessageId,conversationId:String(match.message.conversationId),observationDifferences:match.observationDifferences,method:'export_account_and_native_message_id'};
   if(JSON.stringify(message.sourceMetadata?.nativeIdentity)!==JSON.stringify(nativeIdentity))metadataWrites.push({updateOne:{filter:{_id:message._id,source:'gallabox_history'},update:{$set:{'sourceMetadata.nativeIdentity':nativeIdentity,'sourceMetadata.nativeIdentityState':'verified'}}}});
  }else{
   audit[match.state==='missing'?'missingNativeMessageIds':match.state==='ambiguous'?'ambiguousNativeMessageIds':'unverifiedSourceMessageIds']++;
   if(message.sourceMetadata?.nativeIdentity)metadataWrites.push({updateOne:{filter:{_id:message._id,source:'gallabox_history'},update:{$unset:{'sourceMetadata.nativeIdentity':1},$set:{'sourceMetadata.nativeIdentityState':match.state}}}});
  }
 }
 if(metadataWrites.length)await Message.bulkWrite(metadataWrites,{ordered:true});
 const groups=new Map();for(const m of history){const key=String(m.conversationId),list=groups.get(key)||[];list.push(m);groups.set(key,list);}
 let linked=0,unresolved=0;
 for(const [id,messages] of groups){let owner=null,valid=revisions.has(id);const requiredContacts=new Map(),contactKeys=new Set(),sourceIdentities=new Map();let allSourceMatched=true;
  for(const m of messages){
   const match=identityMatches.get(String(m._id));
   const nativeConversation=match?.state==='matched'?nativeConversationMap.get(String(match.message.conversationId)):null;
   const sourceContact=nativeConversation?.sourceMetadata?.externalContactId;
   if(match?.state!=='matched'||!sourceContact)allSourceMatched=false;
   else{const sourceKey=JSON.stringify([nativeConversation.scope,sourceContact]);sourceIdentities.set(sourceKey,{scope:nativeConversation.scope,externalContactId:sourceContact});}
   const current=match?.state==='matched'?owners.get(String(match.message.conversationId)):null;
   if(!current){valid=false;continue;}
   const contact=contactMap.get(JSON.stringify([current.scope,current.sourceMetadata.externalContactId,current.customerId]));
   requiredContacts.set(String(contact._id),contact);contactKeys.add(JSON.stringify([current.scope,current.sourceMetadata.externalContactId]));
   if(owner&&owner.customerId!==current.customerId)valid=false;
   owner=current;
  }
  if(sourceIdentities.size>1&&!valid)audit.mixedContactGroups++;
  if(allSourceMatched&&sourceIdentities.size===1){
   const sourceIdentity=[...sourceIdentities.values()][0];
   const sourceUpdated=await Conversation.updateOne({_id:id,source:'gallabox_history',sourceRevision:revisions.get(id)},{$set:{'sourceMetadata.historySourceIdentityState':'verified','sourceMetadata.historySourceIdentity':{...sourceIdentity,method:'all_export_account_native_message_ids',sourceRevision:revisions.get(id),messages:messages.length}}});
   if(sourceUpdated.matchedCount)audit.mappedSourceGroups++;else audit.unresolvedSourceGroups++;
  }else{
   audit.unresolvedSourceGroups++;
   await Conversation.updateOne({_id:id,source:'gallabox_history',sourceRevision:revisions.get(id)},{$unset:{'sourceMetadata.historySourceIdentity':1,'sourceMetadata.historySourceIdentities':1},$set:{'sourceMetadata.historySourceIdentityState':sourceIdentities.size>1?'mixed_contacts':'incomplete','sourceMetadata.identityMatch.state':'needs_revalidation'}});
  }
  if(!valid||!owner){unresolved++;continue;}
  let applied=false;
  const session=await mongoose.startSession();try{await session.withTransaction(async()=>{
   applied=false;
   const committed=await DirectoryState.findOne({key:'matter_customer_directory'}).session(session).lean();
   if(committed?.activeGeneration!==state?.activeGeneration)return;
   const directoryFence=await DirectoryState.updateOne({_id:committed._id,activeGeneration:state.activeGeneration},{$inc:{__v:1}},{session,timestamps:false});if(!directoryFence.matchedCount)return;
   // Fence current identity observations before propagating their saved links.
   for(const contact of requiredContacts.values()){
    if(contact.matchState==='reviewed_scoped'&&!await readValidatedNativeSenderProof(contact,{session}))return;
    const locked=await Contact.updateOne({_id:contact._id,updatedAt:contact.updatedAt,customerId:contact.customerId,matchState:contact.matchState},{$inc:{__v:1}},{session,timestamps:false});
    if(!locked.matchedCount)return;
   }
   const multiIdentity=sourceIdentities.size>1?{'sourceMetadata.historySourceIdentityState':'verified_same_customer','sourceMetadata.historySourceIdentities':[...sourceIdentities.values()].map(ref=>({...ref,method:'all_export_account_native_message_ids',sourceRevision:revisions.get(id),messages:messages.length,customerId:owner.customerId}))}:{};
   const updated=await Conversation.updateOne({_id:id,source:'gallabox_history',sourceRevision:revisions.get(id),$or:[{customerId:null},{customerId:''},{customerId:owner.customerId}]},{$set:{...multiIdentity,customerId:owner.customerId,customerName:owner.customerName,'sourceMetadata.identityMatch':{method:'all_export_account_native_message_ids',matchedAt:new Date(),messages:messages.length}}},{session});
   if(updated.matchedCount){await Issue.updateMany({conversationId:id},{$set:{customerId:owner.customerId,customerName:owner.customerName}},{session});applied=true;}
  });}finally{await session.endSession();}
  if(applied){linked++;if(sourceIdentities.size>1){audit.mappedSourceGroups++;audit.unresolvedSourceGroups--;}}else unresolved++;
 }
 audit.linkedGroups=linked;audit.unresolvedGroups=unresolved;
 await CaptureBatch.updateMany({source:'gallabox_history',status:'partial','coverage.kind':'curated_workbook'},{$set:{'coverage.identityReconciliation':audit}});
 return {linked,unresolved,limited:false};
}
