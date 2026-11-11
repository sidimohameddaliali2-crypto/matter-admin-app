import {ACTION_VERSION,TOPIC_ACTIONS} from '../config/customerServiceActions.js';
import {validateWorkAction,applyWorkAction} from './customerServiceActions.js';
import {DEFAULT_METRICS_CALENDAR,summarizeRequestMetrics,measureRequest,suggestRequest,validateMetricsCalendar} from './customerServiceRequestInsights.js';
import {captureRange} from './customerServiceCaptureFormat.js';
import {issueKeyMigrationReady} from './customerServiceIssueMigration.js';
import mongoose from 'mongoose';
import {randomUUID} from 'node:crypto';
import Request from '../models/ServiceRequest.js';
import Rule from '../models/ServiceRule.js';
import Staff from '../models/ServiceStaffProfile.js';
import {context,mutate,eligibleOwner} from './customerServiceWorkflow.js';
import {cloudInbox,cloudSqlText as lit,decodeCloudRecord} from './customerServiceCloudStore.js';
import {readCloudEvidence} from './customerServiceCloudEvidence.js';
import {messageDisplay} from './customerServiceInbox.js';
import {serviceError,serviceId} from './customerServicePolicy.js';
import {REQUEST_TOPICS,REQUEST_RULES,REQUEST_PERMISSIONS} from '../config/customerServiceRequests.js';
import {REQUEST_TOPIC_TAGS,requestWorkflowTopic} from '../config/customerServiceTopicTags.js';
import {requiredText,validDate,classifyRequest,validateResolution,validateRule,requestFlags,businessSeconds} from './customerServiceRequestPolicy.js';
const fail=(m,status=400)=>{throw serviceError(m,status);};
const id=v=>{if(!/^[a-f\d]{24}$/i.test(String(v||'')))fail('Invalid record reference.');return String(v);};
const plain=v=>v?.toObject?v.toObject():v;
const need=(ctx,cap)=>{if(!ctx.capabilities[cap])fail('This operation requires explicit '+cap+' permission.',403);};
const sensitiveTopics=new Set(['refund','food_quality']);
function checkReclassification(ctx,current,next){
 if(sensitiveTopics.has(requestWorkflowTopic(current))&&!sensitiveTopics.has(requestWorkflowTopic(next)))need(ctx,'closeSensitive');
}
const canWork=(ctx,r)=>{if(!ctx.capabilities.assignRequests&&serviceId(r.ownerId)!==serviceId(ctx.actor._id))fail('Only the accountable owner or assignment authority may change this request.',403);};
const cloudOnly=()=>{if(!cloudInbox()?.workflow)fail('Requests require the canonical Supabase workflow.',503);};
async function splitReady(){return Boolean(cloudInbox()?.workflow&&await issueKeyMigrationReady(cloudInbox().store));}
export async function requestDefinitions(){const available=await splitReady();return {topics:REQUEST_TOPIC_TAGS,legacyTopics:REQUEST_TOPICS,topicVersion:'2026-11-10.tags-1',actionVersion:ACTION_VERSION,actions:TOPIC_ACTIONS,rules:await policyDefinitions(),closureBasis:['customer_confirmed','verified_completion','closed_without_response'],nonCustomerTypes:{available:true},issuePicker:{available:true},multipleIssues:{available,reason:available?null:'The reviewed issue-key migration has not been applied to this database.'}};}
export async function policyDefinitions(){const saved=await Rule.find({}).lean();return REQUEST_RULES.map(key=>{const r=saved.find(r=>r._id===key);return r?{...r.definition,id:key,version:r.version}:{id:key,active:false,reason:'Company policy and calendar not confirmed'};});}
async function messages(ids){return readCloudEvidence({_id:{$in:ids.map(id)}});}
async function currentEvidence(records,{limit=2001}={}){
 const explicit=[...new Set(records.flatMap(r=>(r.evidenceMessageIds||[]).map(String)))];
 const conversations=[...new Set(records.filter(r=>r.contextScope==='conversation').map(r=>String(r.conversationId)))];
 const filters=[...(explicit.length?[{_id:{$in:explicit}}]:[]),...(conversations.length?[{conversationId:{$in:conversations}}]:[])];
 const captured=filters.length?await readCloudEvidence(filters.length===1?filters[0]:{$or:filters},{limit}):[];
 const evidence=captured.slice(0,limit-1).map(m=>({...m,display:messageDisplay(m),internalNote:m.internalNote===true||m.sourceMetadata?.nativeEvent?.kind==='internal_note'})),truncated=captured.length===limit;
 const views=records.map(r=>r.contextScope==='conversation'?{...plain(r),evidenceMessageIds:[...new Set([...(r.evidenceMessageIds||[]).map(String),...evidence.filter(m=>String(m.conversationId)===String(r.conversationId)).map(m=>String(m._id))])]}:r);
 return {evidence,views,truncated};
}
async function validateEvidence(r,ids){const rows=await messages(ids);if(rows.length!==new Set(ids).size)fail('Evidence is unavailable.');for(const m of rows){if(serviceId(m.conversationId)===serviceId(r.conversationId))continue;const [a,b]=await Promise.all([cloudInbox().store.record('serviceconversations',r.conversationId),cloudInbox().store.record('serviceconversations',m.conversationId)]);if(!a?.sourceMetadata?.externalContactId||a.source!==b?.source||a.scope!==b.scope||a.sourceMetadata.externalContactId!==b.sourceMetadata?.externalContactId)fail('Evidence must belong to this source customer history.');}return rows;}
async function splitRequest(ctx,session,{recordId,version,...input}){
 need(ctx,'assignRequests');const parent=await Request.findById(id(recordId));if(!parent)fail('Request not found.',404);
 if(parent.version!==version)fail('This request changed. Reload before splitting; your input is retained.',409);
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.splitKey||''))fail('Provide a stable split key for this new issue.');
 const ready=await splitReady();
 if(!ready)fail('Multiple issues are not enabled on this database yet. The reviewed issue-key migration must be approved and applied first; existing requests are unchanged.',503);
 const originIssueKey=`split:${serviceId(parent._id)}:${input.splitKey.toLowerCase()}`;
 if(await Request.exists({originMessageId:parent.originMessageId,originIssueKey}))fail('This explicit split already exists. Reload the issue list.',409);
 const [message]=await validateEvidence(parent,[serviceId(parent.originMessageId)]);if(message.authorType!=='customer')fail('Split from an actual customer source message.');
 const reason=requiredText(input.reason,'Reason for a distinct issue'),title=requiredText(input.title,'Issue title',160),classification=classifyRequest(input.classification);
 if(!['complaint','inquiry'].includes(classification.kind))fail('A split customer issue requires Complaint or Inquiry and one topic.');
 const ownerId=id(input.ownerId);await eligibleOwner(ownerId,session);const now=new Date();
 const child=new mongoose.models.ServiceRequest({conversationId:parent.conversationId,customerName:parent.customerName,originMessageId:parent.originMessageId,originIssueKey,splitParentRequestId:parent._id,evidenceMessageIds:[parent.originMessageId],title,classification,excerpt:(message.text||`[${message.type||'attachment'}]`).slice(0,1000),receivedAt:message.sentAt,ownerId,assignedAt:now,nextAction:{action:requiredText(input.nextAction,'Next action'),dueAt:validDate(input.dueAt,'Next action due time')}});
 child.history.push({event:'split_created',actorId:ctx.actor._id,at:now,reason,parentRequestId:parent._id,originMessageId:parent.originMessageId,originIssueKey,after:{title,classification,ownerId,nextAction:child.nextAction}});
 parent.version++;parent.history.push({event:'split_child',actorId:ctx.actor._id,at:now,reason,childRequestId:child._id,originMessageId:parent.originMessageId,originIssueKey});await parent.save();
 const [created]=await Request.create([plain(child)]);return plain(created);
}
export async function commandRequest({actor,requestId,id:recordId,version,operation,...input}){
 cloudOnly();const creating=operation==='create'||operation==='work'&&!recordId,classificationOnly=operation==='create'&&input.classificationOnly===true;const result=await mutate({actor,requestId,kind:'request.'+operation,payload:{...(creating?{}:{recordId,version}),...input}},async(ctx,session)=>{
  if(operation==='split')return splitRequest(ctx,session,{recordId,version,...input});
  let r,before,conversationContext=null;
  if(creating){
   need(ctx,'assignRequests');
   if(classificationOnly&&(!input.conversationId||!['spam','vendor','non_customer'].includes(input.classification?.kind)))fail('Choose Spam / Vendor for a captured conversation.');
   let message,contextMessages=[];
   if(input.conversationId){
    const sourceConversation=await cloudInbox().store.record('serviceconversations',id(input.conversationId));
    if(!sourceConversation||!['gallabox','gallabox_history'].includes(sourceConversation.source))fail('Captured conversation not found.',404);
    contextMessages=await readCloudEvidence({conversationId:sourceConversation._id});
    message=contextMessages.find(m=>m.authorType==='customer');
    if(!message)fail('No customer request has been captured in this conversation yet.');
    const start=contextMessages.find(m=>m.authorType==='system'&&m.sourceMetadata?.systemEvent?.action==='initiate');
    conversationContext={sourceRevision:sourceConversation.sourceRevision,startedAt:start?.sentAt||sourceConversation.coverageFrom||message.sentAt,startBasis:start?'source_start_event':'first_captured_message'};
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.issueKey||''))fail('Provide a stable key for this conversation issue.');
   }else [message]=await messages([input.messageId]);
   if(!message||message.authorType!=='customer')fail('Start from a captured customer conversation.');
   const existing=await Request.findOne({originMessageId:message._id,$or:[{originIssueKey:'primary'},{originIssueKey:{$exists:false}}]});
   let originIssueKey='primary',splitParent=null;
   if(conversationContext){
    originIssueKey='conversation:'+input.issueKey.toLowerCase();
    if(await Request.exists({conversationId:message.conversationId,originIssueKey}))fail('This conversation issue already exists. Reload the work items.',409);
    if(await Request.exists({originMessageId:message._id})&&!await splitReady())fail('Adding another issue requires the reviewed issue-key migration. Existing conversation history is unchanged.',503);
   }else if(existing){
    if(operation!=='work'||!input.splitParentId)fail('This message already starts a request. Choose the existing issue or explicitly add another problem.',409);
    splitParent=await Request.findById(id(input.splitParentId));if(!splitParent||String(splitParent.originMessageId)!==String(message._id))fail('Choose a parent issue from this source message.');
    if(!await splitReady())fail('Multiple issues are not enabled on this database.',503);
    if(splitParent.version!==input.parentVersion)fail('The original issue changed. Review it before adding another problem.',409);
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.splitKey||''))fail('Provide a stable key for the distinct problem.');
    requiredText(input.splitReason,'Why this is another problem');
    originIssueKey='split:'+String(splitParent._id)+':'+input.splitKey;
    if(await Request.exists({originMessageId:message._id,originIssueKey}))fail('This distinct issue already exists. Reload before adding another.',409);
    splitParent.version++;splitParent.history.push({event:'split_child',actorId:ctx.actor._id,at:new Date(),reason:input.splitReason,originIssueKey});await splitParent.save();
   }
   const conversation=await cloudInbox().store.record('serviceconversations',message.conversationId);
   r=new mongoose.models.ServiceRequest({conversationId:message.conversationId,customerName:conversation?.customerName||'',originMessageId:message._id,originIssueKey,splitParentRequestId:splitParent?._id||null,evidenceMessageIds:[message._id],excerpt:(message.text||`[${message.type||'attachment'}]`).slice(0,1000),receivedAt:message.sentAt});
   if(conversationContext){r.contextScope='conversation';r.conversationContext=conversationContext;r.title=classificationOnly?input.classification.kind==='spam'?'Spam':input.classification.kind==='vendor'?'Vendor':'Spam / Vendor':requiredText(input.title,'Issue summary',160);r.receivedAt=conversationContext.startedAt;r.evidenceMessageIds=contextMessages.filter(m=>['customer','staff'].includes(m.authorType)&&!m.internalNote&&m.sourceMetadata?.nativeEvent?.kind!=='internal_note'&&m.sourceMetadata?.nativeContent?.kind!=='reaction').map(m=>m._id);}
   if(input.title!==undefined&&!classificationOnly)r.title=requiredText(input.title,'Issue title',160);
   if(input.classification!==undefined)r.classification=classifyRequest(input.classification);
   if(input.ownerId&&!classificationOnly){await eligibleOwner(id(input.ownerId),session);r.ownerId=input.ownerId;r.assignedAt=new Date();}
   if(operation==='create'&&!classificationOnly)r.nextAction={action:requiredText(input.nextAction,'Next action'),dueAt:validDate(input.dueAt,'Next action due time')};
  }else{
   r=await Request.findById(id(recordId));if(!r)fail('Request not found.',404);
   if(r.version!==version)fail('This request changed. Reload before saving; your input is retained.',409);
   if(['resolved','non_customer'].includes(r.status)&&!['link_message','read','feedback'].includes(operation)&&!(operation==='work'&&input.reopen===true))fail('This request is closed. Link related customer evidence to reopen it before adding work.',409);
   before=plain(r);if(operation==='approve_exception')need(ctx,'approveExceptions');else if(operation==='read')need(ctx,'view');else canWork(ctx,r);
  }
  const now=new Date(),reason=creating?conversationContext?'Issue registered against captured conversation':'Request registered from source message':input.reason;
  switch(operation){
   case 'create':{
    if(classificationOnly){r.status='non_customer';r.resolution={basis:'staff_classification',outcomeCode:r.classification.kind,outcomeLabel:r.title,outcomeGroup:'non_customer',nonCustomerReason:'Staff selected '+r.title,evidenceMessageId:String(r.originMessageId),at:now,actorId:actor._id};}
    break;
   }
   case 'work':{
    if(input.reopen===true&&!r.ownerId&&input.ownerId){need(ctx,'assignRequests');await eligibleOwner(id(input.ownerId),session);r.ownerId=input.ownerId;r.assignedAt=now;}
    if(!r.ownerId)fail('An authorized person must confirm who handles this issue.');
    if(input.reopen===true&&r.status==='non_customer'){
     const classification=classifyRequest(input.classification);
     if(!['complaint','inquiry'].includes(classification.kind))fail('Reopen an excluded item as Complaint or Inquiry with one topic.');
     checkReclassification(ctx,r.classification,classification);r.classification=classification;
    }
    if(sensitiveTopics.has(requestWorkflowTopic(r.classification))&&TOPIC_ACTIONS[requestWorkflowTopic(r.classification)]?.find(a=>a.code===input.actionCode)?.terminal)need(ctx,'closeSensitive');
    const refs=input.evidenceMessageId?[id(input.evidenceMessageId)]:[];
    const evidence=refs.length?await validateEvidence(r,refs):[];
    if(input.reopen===true){
     if(!['resolved','non_customer'].includes(r.status))fail('This issue is already open.');
     requiredText(input.reopenReason,'Why reopen this issue');
     const [related]=await validateEvidence(r,[id(input.reopenMessageId)]);if(related.authorType!=='customer')fail('Choose the related customer message.');
     if(TOPIC_ACTIONS[requestWorkflowTopic(r.classification)]?.find(a=>a.code===input.actionCode)?.terminal)fail('Reopen with a new next action, not another closure.');
     if(!r.evidenceMessageIds.some(v=>String(v)===String(related._id)))r.evidenceMessageIds.push(related._id);
    }
    const validated=validateWorkAction(r,input,evidence);
    applyWorkAction(r,input,validated,ctx.actor._id,now);
    break;
   }
   case 'feedback':{
    if(!['customer_message','staff_entered'].includes(input.feedback?.source))fail('Choose a customer message or staff-entered feedback.');
    const entry={id:randomUUID(),source:input.feedback.source,recordedBy:actor._id,recordedAt:now};
    if(entry.source==='customer_message'){
     const [m]=await validateEvidence(r,[id(input.feedback.messageId)]);if(m.authorType!=='customer')fail('Feedback evidence must be a customer message.');
     Object.assign(entry,{messageId:serviceId(m._id),sourceMessageSentAt:m.sentAt,sourceMessageType:m.type,sourceMessageRevision:m.sourceRevision??null,text:m.text||'',provenance:'linked_customer_message'});
    }else Object.assign(entry,{text:requiredText(input.feedback.text,'Customer feedback',4000),provenance:'staff_entered_customer_feedback'});
    r.feedback.push(entry);break;
   }
   case 'assign':need(ctx,'assignRequests');requiredText(reason,'Ownership reason');await eligibleOwner(id(input.ownerId),session);r.ownerId=input.ownerId;r.assignedAt=now;r.reassignment=null;break;
   case 'request_transfer':r.reassignment={reason:requiredText(reason,'Reassignment reason'),requestedBy:actor._id,at:now,status:'pending'};break;
   case 'classify':{const classification=classifyRequest(input.classification);checkReclassification(ctx,r.classification,classification);r.classification=classification;break;}
   case 'classify_suggestion':{
    if(!['accept','correct','reject'].includes(input.decision))fail('Choose Accept, Correct or Reject.');
    const {evidence,views}=await currentEvidence([r]);
    const current=suggestRequest(views[0],evidence);
    const suggestion=current.candidates.find(candidate=>candidate.id===input.suggestionId);
    if(!suggestion||input.suggestionVersion!==current.version)fail('Suggestion evidence changed. Reload before deciding.',409);
    requiredText(reason,'Classification decision reason');
    if(input.decision!=='reject'){const classification=classifyRequest(input.decision==='accept'?{kind:suggestion.kind,topic:suggestion.topic}:input.classification);checkReclassification(ctx,r.classification,classification);r.classification=classification;}
    r.history.push({event:'classification_assistance',actorId:actor._id,at:now,reason,decision:input.decision,suggestion:{id:suggestion.id,version:current.version,topic:suggestion.topic,kind:suggestion.kind,evidenceMessageIds:suggestion.evidenceMessageIds},acceptedClassification:input.decision==='reject'?null:r.classification});
    break;
   }
   case 'progress':r.nextAction={action:requiredText(input.action,'Next action'),dueAt:validDate(input.dueAt,'Due time')};r.waitingOn=input.waitingOn?requiredText(input.waitingOn,'Waiting team',100):'';if(r.waitingOn&&!['Delivery','Kitchen','Finance','Technical Support'].includes(r.waitingOn))fail('Choose Delivery, Kitchen, Finance or Technical Support.');r.status=r.waitingOn?'waiting':'open';requiredText(reason,'Progress note');break;
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
    if(r.workflowDefinitionVersion&&!['spam','vendor','non_customer'].includes(r.classification?.kind))fail('Use the topic action form to record this issue outcome.');
    if(sensitiveTopics.has(requestWorkflowTopic(r.classification)))need(ctx,'closeSensitive');
    let validated;
    try{validated=validateResolution(r,input.resolution);}catch(error){if(error.statusCode!==400)throw error;r.version++;r.history.push({event:'closure_rejected',actorId:actor._id,at:now,reason:error.message,attempt:input.resolution});await r.save();return {rejected:error.message};}
    r.resolution={...validated,at:now,actorId:actor._id};r.status=['spam','vendor','non_customer'].includes(r.classification?.kind)?'non_customer':'resolved';r.waitingOn='';break;
   }
   case 'link_message':{
    const [linked]=await validateEvidence(r,[input.messageId]);
    if(input.reopen===true&&['spam','vendor','non_customer'].includes(r.classification?.kind))fail('Use Reopen issue to confirm Complaint or Inquiry and an accountable owner.');
    if(input.reopen===true&&linked.authorType!=='customer')fail('Choose the related customer message to reopen this issue.');
    requiredText(reason,'Relationship reason');if(!r.evidenceMessageIds.some(x=>String(x)===input.messageId))r.evidenceMessageIds.push(input.messageId);
    if(input.reopen===true){if(!r.ownerId)fail('Assign an owner first.');r.status='open';r.waitingOn='';r.nextAction={action:requiredText(input.action,'Next action'),dueAt:validDate(input.dueAt,'Due time')};}break;
   }
   case 'acknowledge':{
    const flags=await flagsFor(r,await policyDefinitions(),now);if(!flags.some(f=>f.id===input.alertId))fail('Alert no longer applies.',409);
    if(!r.acknowledged.some(a=>a.id===input.alertId))r.acknowledged.push({id:input.alertId,actorId:actor._id,at:now,note:requiredText(reason,'Acknowledgement note')});break;
   }
   case 'read':r.localRead=r.localRead.filter(e=>serviceId(e.actorId)!==serviceId(actor._id));r.localRead.push({actorId:actor._id,at:now,lastMessageId:input.messageId||r.evidenceMessageIds.at(-1)});break;
   default:fail('Unknown request command.');
  }
  if(!creating)r.version++;
  r.history.push({event:classificationOnly?'non_customer_classified':operation,actorId:actor._id,at:now,reason:classificationOnly?r.resolution.nonCustomerReason:input.reopen===true?input.reopenReason:reason||'',before:before?{...before,history:undefined}:null,after:{...plain(r),history:undefined}});
  if(creating){const [created]=await Request.create([plain(r)]);return plain(created);}
  await r.save();return plain(r);
 });
 if(result?.rejected)fail(result.rejected);return result;
}
async function flagsFor(r,rules,now){
 // Only explicit linked evidence contributes to this request's response clock.
 if(!rules.some(rule=>rule.active&&rule.id==='response_overdue'))return requestFlags(r,rules,now,null);
 const {evidence,views,truncated}=await currentEvidence([r]);
 const waiting=truncated?null:measureRequest(views[0],evidence,{asOf:now.toISOString()}).episodes.find(episode=>episode.state==='pending');
 return requestFlags(r,rules,now,waiting?{waitingSince:waiting.startedAt,messageId:waiting.customerMessageIds[0]}:null);
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
 if(filters.q)where.push(`position(${lit(String(filters.q).toLowerCase().slice(0,200))} in lower(COALESCE(body->>'excerpt','')||' '||COALESCE(body->>'customerName','')||' '||COALESCE(body->>'title','')))>0`);
 let taskCounts;
 if(queue==='mine'){
  const due="COALESCE((SELECT min(f->>'dueAt') FROM jsonb_array_elements(COALESCE(body->'followups','[]')) f WHERE f->>'status'<>'completed'),body#>>'{nextAction,dueAt}')";
  const conditions={all:'TRUE',today:`(${due})::timestamptz AT TIME ZONE 'Asia/Dubai'>=date_trunc('day',now() AT TIME ZONE 'Asia/Dubai') AND (${due})::timestamptz AT TIME ZONE 'Asia/Dubai'<date_trunc('day',now() AT TIME ZONE 'Asia/Dubai')+interval '1 day'`,overdue:`(${due})::timestamptz<now()`,waiting:"body->>'status'='waiting'",missing:`${due} IS NULL OR COALESCE(body#>>'{nextAction,action}','')=''`};
  taskCounts=await cloudInbox().store.query(`SELECT jsonb_build_object(${Object.entries(conditions).map(([k,v])=>lit(k)+',count(*) FILTER(WHERE '+v+')').join(',')}) FROM gallabox_private.inbox_record WHERE kind='servicerequests' AND ${where.join(' AND ')};`);
  if(filters.task&&filters.task!=='all'){if(!conditions[filters.task])fail('Unknown task filter.');where.push('('+conditions[filters.task]+')');}
 }
 let statusCounts;
 if(filters.status!==undefined&&(queue!=='conversation'||!['open','resolved','non_customer'].includes(filters.status)))fail('Choose an internal conversation-request status.');
 if(filters.requestId!==undefined&&(queue!=='conversation'||!filters.conversationId))fail('An individual request lookup requires its conversation scope.');
 if(filters.originMessageId!==undefined&&(queue!=='conversation'||!filters.conversationId))fail('A source-message request lookup requires its conversation scope.');
 if(queue==='conversation'){
  statusCounts=await cloudInbox().store.query(`SELECT jsonb_build_object('open',count(*) FILTER(WHERE body->>'status' IN ('open','waiting')),'resolved',count(*) FILTER(WHERE body->>'status'='resolved'),'non_customer',count(*) FILTER(WHERE body->>'status'='non_customer')) FROM gallabox_private.inbox_record WHERE kind='servicerequests' ${where.length?'AND '+where.join(' AND '):''};`);
  // A deep link selects its exact record across tabs, while retaining the caller's
  // authorized conversation scope. It must not disappear behind an old page offset.
  if(filters.originMessageId!==undefined)where.push(`body->>'originMessageId'=${lit(id(filters.originMessageId))}`);
  if(filters.requestId!==undefined)where.push(`id=${lit(id(filters.requestId))}`);
  else if(filters.originMessageId===undefined&&filters.status)where.push(filters.status==='open'?"body->>'status' IN ('open','waiting')":`body->>'status'=${lit(filters.status)}`);
 }
 const effectiveOffset=filters.requestId!==undefined||filters.originMessageId!==undefined?0:offset;
 const primaryFirst=filters.originMessageId!==undefined?"CASE WHEN COALESCE(body->>'originIssueKey','primary')='primary' THEN 0 ELSE 1 END,":"";
 const rows=await cloudInbox().store.query(`SELECT COALESCE(jsonb_agg(r),'[]') FROM(SELECT kind,id,payload,sha256 FROM gallabox_private.inbox_record WHERE kind='servicerequests' ${where.length?'AND '+where.join(' AND '):''} ORDER BY ${primaryFirst} body->>'receivedAt',id LIMIT 51 OFFSET ${effectiveOffset}) r;`);
 let suggestedOwnerId=null;
 if(queue==='conversation'&&filters.conversationId){
  suggestedOwnerId=await cloudInbox().store.query(`SELECT d.id FROM gallabox_private.inbox_record c JOIN gallabox_private.staff_directory d ON d.active AND d.account_id=split_part(c.body->>'scope',':',1) AND d.provider_id=c.body#>>'{sourceMetadata,providerInbox,assigneeId}' WHERE c.kind='serviceconversations' AND c.id=${lit(id(filters.conversationId))} AND lower(c.body#>>'{sourceMetadata,providerInbox,assigneeType}')='user' LIMIT 1;`);
  if(suggestedOwnerId){try{await eligibleOwner(suggestedOwnerId,null);}catch{suggestedOwnerId=null;}}
 }
 const rules=await policyDefinitions(),requests=[];for(const row of rows.slice(0,50)){const r=decodeCloudRecord(row),flags=await flagsFor(r,rules,new Date());requests.push({...r,flags,canWork:ctx.capabilities.assignRequests||serviceId(r.ownerId)===serviceId(actor._id),needsHead:!!r.reassignment||r.exceptions?.some(e=>e.status==='pending')||flags.some(f=>!f.acknowledgement||f.escalated)});}
 let candidates=[];
 if(queue==='assignment'){
 const page=await cloudInbox().reader.list({actor:ctx.actor,profile:ctx.profile,filters:{status:'open',assignment:'all',limit:50,cursor:filters.sourceCursor}});
 const ids=page.conversations.map(c=>c.lastMessage?._id).filter(Boolean);
 const linked=ids.length?await cloudInbox().store.query(`SELECT COALESCE(jsonb_agg(e),'[]') FROM gallabox_private.inbox_record r CROSS JOIN LATERAL jsonb_array_elements_text(r.body->'evidenceMessageIds') e WHERE r.kind='servicerequests' AND e IN (${ids.map(lit).join(',')})`):[];
 candidates=page.conversations.filter(c=>c.lastMessage?._id&&!linked.includes(c.lastMessage._id)).map(c=>({candidate:true,conversationId:c._id,originMessageId:c.lastMessage._id,customerName:c.customerName,excerpt:c.lastMessage.text||'['+c.lastMessage.type+']',receivedAt:c.lastMessage.sentAt,providerInbox:c.providerInbox}));
 return {requests:[...requests,...candidates],nextOffset:rows.length>50?offset+50:null,sourceCursor:page.nextCursor,rules,storage:'supabase',scope:'Unassigned requests and new source messages to triage'};
 }
 return {requests:queue==='attention'?requests.filter(r=>r.needsHead):requests,nextOffset:filters.originMessageId!==undefined?null:rows.length>50?effectiveOffset+50:null,rules,storage:'supabase',...(statusCounts?{statusCounts}:{}),...(filters.originMessageId!==undefined?{originMatchesTruncated:rows.length>50}:{}),suggestedOwnerId,taskCounts,scope:queue==='conversation'?'Conversation requests across all dates':'Current requests across all dates'};
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
 const rows=await cloudInbox().store.query(`SELECT coalesce(jsonb_agg(x),'[]') FROM(SELECT f || jsonb_build_object('requestId',r.id,'conversationId',r.body->>'conversationId','customerName',r.body->>'customerName','requestExcerpt',r.body->>'excerpt') x FROM gallabox_private.inbox_record r CROSS JOIN LATERAL (
  SELECT f FROM jsonb_array_elements(COALESCE(r.body->'followups','[]')) f
  UNION ALL
  SELECT jsonb_build_object('id','next-action:'||r.id,'action',r.body#>>'{nextAction,action}','dueAt',r.body#>>'{nextAction,dueAt}','responsibleId',r.body->'ownerId','status',r.body->>'status','source','next_action')
  WHERE r.body->>'status' IN ('open','waiting') AND COALESCE(r.body#>>'{nextAction,action}','')<>''
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(r.body->'followups','[]')) pending WHERE COALESCE(pending->>'status','open')<>'completed')
 ) obligations(f) WHERE ${where.join(' AND ')} ORDER BY f->>'dueAt',r.id,f->>'id' LIMIT 51 OFFSET ${offset}) q;`);
 return {followups:rows.slice(0,50),nextOffset:rows.length>50?offset+50:null,storage:'supabase',scope:'All-date commitments and open issue next steps'};
}

export async function metricsCalendar(){const row=await Rule.findById('metrics_calendar').lean();return row?{...row.definition,version:row.version}:{...DEFAULT_METRICS_CALENDAR,version:0};}
export async function configureMetricsCalendar({actor,requestId,calendar,version,reason}){
 cloudOnly();return mutate({actor,requestId,kind:'request.metrics_calendar',payload:{calendar,version,reason}},async ctx=>{need(ctx,'managePolicies');requiredText(reason,'Calendar change reason');const definition=validateMetricsCalendar(calendar),existing=await Rule.findById('metrics_calendar');if((existing?.version||0)!==version)fail('Calendar changed. Reload before saving.',409);const audit={actorId:actor._id,at:new Date(),reason,before:existing?.definition||null,after:definition};if(existing){existing.definition=definition;existing.history.push(audit);existing.version++;await existing.save();return plain(existing);}return plain(await Rule.create({_id:'metrics_calendar',definition,history:[audit]}));});
}
async function insightsFor(records){
 const {evidence,views,truncated}=await currentEvidence(records),selected=evidence.map(m=>String(m._id)),calendar=await metricsCalendar();
 // Conversation context is included on reads, not copied into the durable
 // record. Count both explicit links and conversation scopes so the same reply
 // cannot become an independently attributed answer to sibling issues.
 const table='gallabox_private.inbox_record';
 const useCounts=selected.length?await cloudInbox().store.query(`WITH selected AS(SELECT id,body->>'conversationId' conversation_id FROM ${table} WHERE kind='servicemessages' AND id IN(${selected.map(lit).join(',')})), uses AS(
  SELECT e.message_id,r.id request_id FROM ${table} r CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(r.body->'evidenceMessageIds','[]')) e(message_id) WHERE r.kind='servicerequests' AND e.message_id IN(${selected.map(lit).join(',')})
  UNION
  SELECT m.id,r.id FROM selected m JOIN ${table} r ON r.kind='servicerequests' AND r.body->>'contextScope'='conversation' AND r.body->>'conversationId'=m.conversation_id
 ) SELECT COALESCE(jsonb_object_agg(message_id,n),'{}') FROM(SELECT message_id,count(DISTINCT request_id) n FROM uses GROUP BY message_id) counts;`):{};
 const asOf=new Date().toISOString();return {asOf,calendar,evidenceLimit:2000,evidenceTruncated:truncated,requests:views.map(r=>{
  const metrics=measureRequest(r,evidence,{calendar,asOf,replyUseCounts:useCounts});
  if(r.contextScope==='conversation')metrics.coverage='Current captured conversation and explicitly linked evidence; source history may be incomplete';
  const tag=REQUEST_TOPIC_TAGS.find(t=>t.id===r.classification?.topic);
  return {requestId:String(r._id),conversationId:String(r.conversationId),title:r.title,excerpt:r.excerpt,classification:r.classification||null,topicLabel:tag?.label||REQUEST_TOPICS.find(t=>t.id===r.classification?.topic)?.label||null,issueDetailLabel:tag?.includes.find(d=>d.id===r.classification?.subtopic)?.label||null,outcome:r.resolution?.outcomeLabel||null,outcomeGroup:r.resolution?.outcomeGroup||null,metrics,suggestions:suggestRequest(r,evidence)};
 })};
}
export async function getRequestInsights({actor,requestId}){
 cloudOnly();const ctx=await context(actor,null);need(ctx,'view');const r=await Request.findById(id(requestId)).lean();if(!r)fail('Request not found.',404);return {...await insightsFor([r]),canDecide:!['resolved','non_customer'].includes(r.status)&&(ctx.capabilities.assignRequests||serviceId(r.ownerId)===serviceId(actor._id))};
}
export async function listRequestReport({actor,filters={}}){
 cloudOnly();const ctx=await context(actor,null);need(ctx,'view');const offset=Number(filters.offset||0),limit=Number(filters.limit||10);if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isInteger(limit)||limit<1||limit>20)fail('Invalid report page.');
 const where=["kind='servicerequests'"];if(!ctx.capabilities.supervise&&!ctx.capabilities.assignRequests)where.push(`body->>'ownerId'=${lit(serviceId(actor._id))}`);const range=captureRange(filters);if(range.from)where.push(`(body->>'receivedAt')::timestamptz>=${lit(range.from.toISOString())}::timestamptz AND (body->>'receivedAt')::timestamptz<${lit(range.to.toISOString())}::timestamptz`);if(filters.q)where.push(`position(${lit(String(filters.q).toLowerCase().slice(0,200))} in lower(COALESCE(body->>'excerpt','')||' '||COALESCE(body->>'customerName','')||' '||COALESCE(body->>'title','')))>0`);
 const outcomeExpression="CASE WHEN body->>'status'='non_customer' THEN 'non_customer' WHEN body->>'status'<>'resolved' THEN 'pending' ELSE COALESCE(body#>>'{resolution,outcomeGroup}','legacy_unknown') END";
 const outcomeCounts=await cloudInbox().store.query(`SELECT COALESCE(jsonb_object_agg(outcome,n),'{}') FROM(SELECT ${outcomeExpression} outcome,count(*) n FROM gallabox_private.inbox_record WHERE ${where.join(' AND ')} GROUP BY 1) x;`);
 if(filters.outcomeGroup){if(!['information','fulfilled','not_fulfilled','withdrawn','pending','legacy_unknown','non_customer'].includes(filters.outcomeGroup))fail('Unknown outcome filter.');where.push(outcomeExpression+'='+lit(filters.outcomeGroup));}
 const rows=await cloudInbox().store.query(`SELECT COALESCE(jsonb_agg(r),'[]') FROM(SELECT kind,id,payload,sha256 FROM gallabox_private.inbox_record WHERE ${where.join(' AND ')} ORDER BY body->>'receivedAt' DESC,id LIMIT ${limit+1} OFFSET ${offset}) r;`);
 const result=await insightsFor(rows.slice(0,limit).map(decodeCloudRecord));return {...result,outcomeCounts,scope:ctx.capabilities.supervise||ctx.capabilities.assignRequests?'Authorized team requests, selected received-date range':'My owned requests, selected received-date range',nextOffset:rows.length>limit?offset+limit:null,offset,summary:result.requests.reduce((sum,row)=>{for(const [key,value]of Object.entries(row.metrics.counts))sum[key]=(sum[key]||0)+value;return sum;},{requests:result.requests.length}),performance:summarizeRequestMetrics(result.requests.map(row=>row.metrics)),summaryScope:'This page only; not an all-population total',storage:'supabase'};
}
