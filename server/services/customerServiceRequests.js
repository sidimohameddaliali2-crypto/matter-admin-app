import mongoose from 'mongoose';
import {randomUUID} from 'node:crypto';
import Request from '../models/ServiceRequest.js';
import Rule from '../models/ServiceRule.js';
import Staff from '../models/ServiceStaffProfile.js';
import {context,mutate,eligibleOwner} from './customerServiceWorkflow.js';
import {cloudInbox,cloudSqlText as lit,decodeCloudRecord} from './customerServiceCloudStore.js';
import {readCloudEvidence} from './customerServiceCloudEvidence.js';
import {serviceError,serviceId} from './customerServicePolicy.js';
import {isServiceStaffReply} from './customerServiceMessageEvidence.js';
import {REQUEST_TOPICS,REQUEST_RULES,REQUEST_PERMISSIONS} from '../config/customerServiceRequests.js';
import {requiredText,validDate,classifyRequest,validateResolution,validateRule,requestFlags,businessSeconds} from './customerServiceRequestPolicy.js';
const fail=(m,status=400)=>{throw serviceError(m,status);};
const id=v=>{if(!/^[a-f\d]{24}$/i.test(String(v||'')))fail('Invalid record reference.');return String(v);};
const plain=v=>v?.toObject?v.toObject():v;
const need=(ctx,cap)=>{if(!ctx.capabilities[cap])fail('This operation requires explicit '+cap+' permission.',403);};
const canWork=(ctx,r)=>{if(!ctx.capabilities.assignRequests&&serviceId(r.ownerId)!==serviceId(ctx.actor._id))fail('Only the accountable owner or assignment authority may change this request.',403);};
const cloudOnly=()=>{if(!cloudInbox()?.workflow)fail('Requests require the canonical Supabase workflow.',503);};
export async function requestDefinitions(){return {topics:REQUEST_TOPICS,rules:await policyDefinitions(),closureBasis:['customer_confirmed','verified_completion','closed_without_response']};}
export async function policyDefinitions(){const saved=await Rule.find({}).lean();return REQUEST_RULES.map(key=>{const r=saved.find(r=>r._id===key);return r?{...r.definition,id:key,version:r.version}:{id:key,active:false,reason:'Company policy and calendar not confirmed'};});}
async function messages(ids){return readCloudEvidence({_id:{$in:ids.map(id)}});}
async function validateEvidence(r,ids){const rows=await messages(ids);if(rows.length!==new Set(ids).size)fail('Evidence is unavailable.');for(const m of rows){if(serviceId(m.conversationId)===serviceId(r.conversationId))continue;const [a,b]=await Promise.all([cloudInbox().store.record('serviceconversations',r.conversationId),cloudInbox().store.record('serviceconversations',m.conversationId)]);if(!a?.sourceMetadata?.externalContactId||a.source!==b?.source||a.scope!==b.scope||a.sourceMetadata.externalContactId!==b.sourceMetadata?.externalContactId)fail('Evidence must belong to this source customer history.');}return rows;}
export async function commandRequest({actor,requestId,id:recordId,version,operation,...input}){
 cloudOnly();const result=await mutate({actor,requestId,kind:'request.'+operation,payload:{...(operation==='create'?{}:{recordId,version}),...input}},async(ctx,session)=>{
  let r,before;
  if(operation==='create'){
   need(ctx,'assignRequests');const [message]=await messages([input.messageId]);if(!message||message.authorType!=='customer')fail('Start from an actual customer message.');
   if(await Request.exists({originMessageId:message._id}))fail('This message already starts a request.',409);
   const conversation=await cloudInbox().store.record('serviceconversations',message.conversationId);
   r=new mongoose.models.ServiceRequest({conversationId:message.conversationId,customerName:conversation?.customerName||'',originMessageId:message._id,evidenceMessageIds:[message._id],excerpt:(message.text||`[${message.type||'attachment'}]`).slice(0,1000),receivedAt:message.sentAt});
   if(input.ownerId){await eligibleOwner(id(input.ownerId),session);r.ownerId=input.ownerId;r.assignedAt=new Date();}
   r.nextAction={action:requiredText(input.nextAction,'Next action'),dueAt:validDate(input.dueAt,'Next action due time')};
  }else{
   r=await Request.findById(id(recordId));if(!r)fail('Request not found.',404);
   if(r.version!==version)fail('This request changed. Reload before saving; your input is retained.',409);
   if(['resolved','non_customer'].includes(r.status)&&!['link_message','read'].includes(operation))fail('This request is closed. Link related customer evidence to reopen it before adding work.',409);
   before=plain(r);if(operation==='approve_exception')need(ctx,'approveExceptions');else if(operation==='read')need(ctx,'view');else canWork(ctx,r);
  }
  const now=new Date(),reason=operation==='create'?'Request registered from source message':input.reason;
  switch(operation){
   case 'create':break;
   case 'assign':need(ctx,'assignRequests');requiredText(reason,'Ownership reason');await eligibleOwner(id(input.ownerId),session);r.ownerId=input.ownerId;r.assignedAt=now;r.reassignment=null;break;
   case 'request_transfer':r.reassignment={reason:requiredText(reason,'Reassignment reason'),requestedBy:actor._id,at:now,status:'pending'};break;
   case 'classify':r.classification=classifyRequest(input.classification);break;
   case 'progress':r.nextAction={action:requiredText(input.action,'Next action'),dueAt:validDate(input.dueAt,'Due time')};r.waitingOn=input.waitingOn?requiredText(input.waitingOn,'Waiting team',100):'';if(r.waitingOn&&!['Delivery','Kitchen','Finance'].includes(r.waitingOn))fail('Choose Delivery, Kitchen or Finance.');r.status=r.waitingOn?'waiting':'open';requiredText(reason,'Progress note');break;
   case 'followup':{
    const responsible=id(input.responsibleId||r.ownerId);if(responsible!==serviceId(r.ownerId))need(ctx,'assignRequests');await eligibleOwner(responsible,session);
    const refs=input.evidenceMessageIds||[r.originMessageId];await validateEvidence(r,refs);
    r.followups.push({id:randomUUID(),action:requiredText(input.action,'Follow-up action'),responsibleId:responsible,dueAt:validDate(input.dueAt,'Due time'),status:'open',evidenceMessageIds:refs,createdAt:now});break;
   }
   case 'followup_update':{
    const f=r.followups.find(f=>f.id===input.followupId);if(!f)fail('Follow-up not found.',404);requiredText(reason,'Change reason');
    if(input.responsibleId&&input.responsibleId!==String(f.responsibleId)){need(ctx,'assignRequests');await eligibleOwner(id(input.responsibleId),session);f.responsibleId=input.responsibleId;}
    if(input.dueAt)f.dueAt=validDate(input.dueAt,'Due time');
    if(input.completed){f.completionEvidence=requiredText(input.evidence,'Completion evidence');f.status='completed';f.completedAt=now;}
    r.markModified('followups');break;
   }
   case 'exception':{
    const rules=await policyDefinitions(),rule=rules.find(p=>p.id===input.policyId&&p.active);
    if(!rule||new Date(rule.effectiveAt)>now||!rule.scope.some(x=>x==='all'||x===r.classification?.topic))fail('Choose an active applicable policy.');
    if(!rule.permittedExceptions.includes(input.exceptionType))fail('Exception is not permitted by this policy.');
    r.exceptions.push({id:randomUUID(),policyId:rule.id,policyVersion:rule.version,exceptionType:input.exceptionType,reason:requiredText(reason,'Exception evidence'),at:now,requestedBy:actor._id,status:'pending'});break;
   }
   case 'approve_exception':{
    need(ctx,'approveExceptions');const e=r.exceptions.find(e=>e.id===input.exceptionId);if(!e||e.status!=='pending')fail('Pending exception not found.');
    if(serviceId(e.requestedBy)===serviceId(actor._id))fail('An independent authorized person must decide the exception.',403);
    if(!['approved','rejected','confirmed_breach'].includes(input.decision))fail('Choose an explicit decision.');e.status=input.decision;e.decidedBy=actor._id;e.decidedAt=now;e.decisionReason=requiredText(reason,'Decision evidence');r.markModified('exceptions');break;
   }
   case 'resolve':{
    if(['refund','food_quality'].includes(r.classification?.topic))need(ctx,'closeSensitive');
    let validated;
    try{validated=validateResolution(r,input.resolution);}catch(error){if(error.statusCode!==400)throw error;r.version++;r.history.push({event:'closure_rejected',actorId:actor._id,at:now,reason:error.message,attempt:input.resolution});await r.save();return {rejected:error.message};}
    r.resolution={...validated,at:now,actorId:actor._id};r.status=['spam','vendor'].includes(r.classification?.kind)?'non_customer':'resolved';r.waitingOn='';break;
   }
   case 'link_message':{
    await validateEvidence(r,[input.messageId]);requiredText(reason,'Relationship reason');if(!r.evidenceMessageIds.some(x=>String(x)===input.messageId))r.evidenceMessageIds.push(input.messageId);
    if(input.reopen===true){if(!r.ownerId)fail('Assign an owner first.');r.status='open';r.waitingOn='';r.nextAction={action:requiredText(input.action,'Next action'),dueAt:validDate(input.dueAt,'Due time')};}break;
   }
   case 'acknowledge':{
    const flags=await flagsFor(r,await policyDefinitions(),now);if(!flags.some(f=>f.id===input.alertId))fail('Alert no longer applies.',409);
    if(!r.acknowledged.some(a=>a.id===input.alertId))r.acknowledged.push({id:input.alertId,actorId:actor._id,at:now,note:requiredText(reason,'Acknowledgement note')});break;
   }
   case 'read':r.localRead=r.localRead.filter(e=>serviceId(e.actorId)!==serviceId(actor._id));r.localRead.push({actorId:actor._id,at:now,lastMessageId:input.messageId||r.evidenceMessageIds.at(-1)});break;
   default:fail('Unknown request command.');
  }
  if(operation!=='create')r.version++;
  r.history.push({event:operation,actorId:actor._id,at:now,reason:reason||'',before:before?{...before,history:undefined}:null,after:{...plain(r),history:undefined}});
  if(operation==='create'){const [created]=await Request.create([plain(r)]);return plain(created);}
  await r.save();return plain(r);
 });
 if(result?.rejected)fail(result.rejected);return result;
}
async function flagsFor(r,rules,now){
 // Only explicit linked evidence contributes to this request's response clock.
 if(!rules.some(rule=>rule.active&&rule.id==='response_overdue'))return requestFlags(r,rules,now,null);
 const linked=await messages(r.evidenceMessageIds),customers=linked.filter(m=>m.authorType==='customer').sort((a,b)=>new Date(a.sentAt)-new Date(b.sentAt));let waiting=null;
 for(const m of customers){const subsequent=await readCloudEvidence({conversationId:m.conversationId,sentAt:{$gte:m.sentAt}},{limit:2000});const reply=subsequent.find(isServiceStaffReply);if(!reply&&subsequent.length<2000&&!waiting)waiting=m;}

 return requestFlags(r,rules,now,waiting?{waitingSince:waiting.sentAt,messageId:String(waiting._id)}:null);
}
export async function listRequests({actor,profile,filters={}}){
 cloudOnly();const ctx=await context(actor,null);need(ctx,'view');
 const queue=filters.queue||'mine';if(!['mine','assignment','attention','conversation'].includes(queue))fail('Unknown work queue.');
 const offset=Number(filters.offset||0);if(!Number.isSafeInteger(offset)||offset<0||offset>100000)fail('Invalid page.');
 const where=[];if(queue==='mine')where.push(`body->>'ownerId'=${lit(serviceId(actor._id))}`);
 if(queue==='assignment')where.push("body->>'ownerId' IS NULL AND body->>'status'='open'");
 if(queue==='attention'&&!ctx.capabilities.assignRequests&&!ctx.capabilities.approveExceptions)fail('Head attention requires assignment or exception authority.',403);
 if(filters.conversationId){const cid=id(filters.conversationId);where.push(`body->>'conversationId' IN(SELECT c.id FROM gallabox_private.inbox_record c JOIN gallabox_private.inbox_record a ON a.kind='serviceconversations' AND a.id=${lit(cid)} WHERE c.kind='serviceconversations' AND (c.id=a.id OR (c.body->>'source'=a.body->>'source' AND c.body->>'scope'=a.body->>'scope' AND c.body#>>'{sourceMetadata,externalContactId}'=a.body#>>'{sourceMetadata,externalContactId}')))`);}
 if(queue!=='conversation')where.push("body->>'status' NOT IN ('resolved','non_customer')");
 if(filters.q)where.push(`position(${lit(String(filters.q).toLowerCase().slice(0,200))} in lower(COALESCE(body->>'excerpt','')||' '||COALESCE(body->>'customerName','')))>0`);
 const rows=await cloudInbox().store.query(`SELECT COALESCE(jsonb_agg(r),'[]') FROM(SELECT kind,id,payload,sha256 FROM gallabox_private.inbox_record WHERE kind='servicerequests' ${where.length?'AND '+where.join(' AND '):''} ORDER BY body->>'receivedAt',id LIMIT 51 OFFSET ${offset}) r;`);
 const rules=await policyDefinitions(),requests=[];for(const row of rows.slice(0,50)){const r=decodeCloudRecord(row),flags=await flagsFor(r,rules,new Date());requests.push({...r,flags,canWork:ctx.capabilities.assignRequests||serviceId(r.ownerId)===serviceId(actor._id),needsHead:!!r.reassignment||r.exceptions?.some(e=>e.status==='pending')||flags.some(f=>!f.acknowledgement||f.escalated)});}
 let candidates=[];
 if(queue==='assignment'){
 const page=await cloudInbox().reader.list({actor:ctx.actor,profile:ctx.profile,filters:{status:'open',assignment:'all',limit:50,cursor:filters.sourceCursor}});
 const ids=page.conversations.map(c=>c.lastMessage?._id).filter(Boolean);
 const linked=ids.length?await cloudInbox().store.query(`SELECT COALESCE(jsonb_agg(e),'[]') FROM gallabox_private.inbox_record r CROSS JOIN LATERAL jsonb_array_elements_text(r.body->'evidenceMessageIds') e WHERE r.kind='servicerequests' AND e IN (${ids.map(lit).join(',')})`):[];
 candidates=page.conversations.filter(c=>c.lastMessage?._id&&!linked.includes(c.lastMessage._id)).map(c=>({candidate:true,conversationId:c._id,originMessageId:c.lastMessage._id,customerName:c.customerName,excerpt:c.lastMessage.text||'['+c.lastMessage.type+']',receivedAt:c.lastMessage.sentAt,providerInbox:c.providerInbox}));
 return {requests:[...requests,...candidates],nextOffset:rows.length>50?offset+50:null,sourceCursor:page.nextCursor,rules,storage:'supabase',scope:'Unassigned requests and new source messages to triage'};
 }
 return {requests:queue==='attention'?requests.filter(r=>r.needsHead):requests,nextOffset:rows.length>50?offset+50:null,rules,storage:'supabase',scope:'Current requests across all dates'};
}
export async function configureRequestRule({actor,requestId,rule,version}){
 cloudOnly();return mutate({actor,requestId,kind:'request.policy',payload:{rule,version}},async ctx=>{need(ctx,'managePolicies');const definition=validateRule(rule),existing=await Rule.findById(rule.id);if(existing&&existing.version!==version)fail('Policy changed.',409);const history={actorId:actor._id,at:new Date(),before:existing?.definition||null,after:definition};if(existing){existing.history.push(history);existing.definition=definition;existing.version++;await existing.save();return plain(existing);}return plain(await Rule.create({_id:rule.id,definition,history:[history]}));});
}
export async function configureRequestGrants({actor,requestId,userId,grants,reason}){
 cloudOnly();return mutate({actor,requestId,kind:'request.grants',payload:{userId,grants,reason}},async(ctx,session)=>{need(ctx,'supervise');if(!Array.isArray(grants)||grants.some(g=>!REQUEST_PERMISSIONS.includes(g)))fail('Unknown permission.');requiredText(reason,'Permission reason');await eligibleOwner(id(userId),session);const staff=await Staff.findOne({userId});staff.history.push({actorId:actor._id,at:new Date(),before:{grants:staff.grants},after:{grants},reason});staff.grants=grants;await staff.save();return plain(staff);});
}

// The Follow-ups page reads the same embedded obligations edited in the inbox.
export async function listRequestFollowups({actor,filters={}}){
 cloudOnly();const ctx=await context(actor,null);need(ctx,'view');
 const offset=Number(filters.offset||0);if(!Number.isSafeInteger(offset)||offset<0||offset>100000)fail('Invalid page.');
 const queue=filters.queue||'mine';if(!['mine','team','overdue','unassigned'].includes(queue))fail('Unknown follow-up queue.');
 const where=["r.kind='servicerequests'"];
 if(queue==='mine'||!ctx.capabilities.assignRequests)where.push(`f->>'responsibleId'=${lit(serviceId(actor._id))}`);
 if(queue==='overdue')where.push("f->>'status'<>'completed' AND (f->>'dueAt')::timestamptz<now()");
 if(queue==='unassigned')where.push("f->>'responsibleId' IS NULL AND f->>'status'<>'completed'");
 if(filters.q)where.push(`position(${lit(String(filters.q).toLowerCase().slice(0,200))} in lower(coalesce(r.body->>'customerName','')||' '||coalesce(f->>'action','')))>0`);
 const rows=await cloudInbox().store.query(`SELECT coalesce(jsonb_agg(x),'[]') FROM(SELECT f || jsonb_build_object('requestId',r.id,'conversationId',r.body->>'conversationId','customerName',r.body->>'customerName','requestExcerpt',r.body->>'excerpt') x FROM gallabox_private.inbox_record r CROSS JOIN LATERAL jsonb_array_elements(r.body->'followups') f WHERE ${where.join(' AND ')} ORDER BY f->>'dueAt',r.id,f->>'id' LIMIT 51 OFFSET ${offset}) q;`);
 return {followups:rows.slice(0,50),nextOffset:rows.length>50?offset+50:null,storage:'supabase',scope:'All-date commitments'};
}
