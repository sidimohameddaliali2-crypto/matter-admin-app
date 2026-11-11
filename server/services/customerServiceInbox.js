import {withConversationHistory,conversationSessions} from './customerServiceConversationHistory.js';
import {currentProviderInbox,inboxFilters,verifiedScopedProviderAuthors} from './customerServiceProviderInbox.js';
import {cloudInbox} from './customerServiceCloudStore.js';
import mongoose from 'mongoose';
import Conversation from '../models/ServiceConversation.js';
import Message from '../models/ServiceMessage.js';
import Issue from '../models/ServiceIssue.js';
import Review from '../models/ServiceReview.js';
import Action from '../models/ServiceAction.js';
import {getServiceCapabilities,serviceError,serviceId} from './customerServicePolicy.js';
import {captureRange} from './customerServiceCaptureFormat.js';
import {SERVICE_CATEGORY_IDS} from '../config/customerServiceCategories.js';

const sources=['gallabox','gallabox_history'];
const oid=value=>/^[a-f0-9]{24}$/i.test(String(value||''));
function access(actor,profile){const caps=getServiceCapabilities(actor,profile);if(!caps.view)throw serviceError('Active customer-service membership required.',403);return caps;}
function limit(value,fallback,max){if(value===undefined)return fallback;const n=Number(value);if(!Number.isInteger(n)||n<1||n>max)throw serviceError(`Choose a page size from 1 to ${max}.`,400);return n;}
const encode=(kind,row,field)=>Buffer.from(JSON.stringify({kind,id:String(row._id),at:row[field]?new Date(row[field]).toISOString():null})).toString('base64url');
function cursor(value,kind,field){
 if(!value)return null;
 try{if(typeof value!=='string'||value.length>1000)throw Error();const c=JSON.parse(Buffer.from(value,'base64url').toString());if(c.kind!==kind||!oid(c.id)||c.at!==null&&!Number.isFinite(Date.parse(c.at)))throw Error();const id=new mongoose.Types.ObjectId(c.id);return c.at===null?{[field]:null,_id:{$lt:id}}:{$or:[{[field]:{$lt:new Date(c.at)}},{[field]:new Date(c.at),_id:{$lt:id}},...(field==='lastMessageAt'?[{[field]:null}]:[])]};}catch{throw serviceError('Invalid conversation page cursor.',400);}
}
async function blindIssueIds(actor){return Review.distinct('issueId',{reviewerId:actor._id,sampleType:'calibration','revisions.0':{$exists:false}});}
const blindIssue=issue=>({_id:issue._id,conversationId:issue.conversationId,customerId:issue.customerId,customerName:issue.customerName,sourceRevision:issue.sourceRevision,version:issue.version,summary:'',categoryIds:[],outcome:'unknown',independentCalibration:true});
// Group only a verified native contact within its original account/channel.
// The oldest stored thread ID is a stable view anchor; source documents stay intact.
const contactGroup=[{$sort:{_id:1}},{$group:{_id:{source:'$source',scope:'$scope',contact:{$cond:[{$and:[{$eq:['$source','gallabox']},{$ne:[{$ifNull:['$sourceMetadata.externalContactId',null]},null]}]},'$sourceMetadata.externalContactId','$_id']}},first:{$first:'$$ROOT'},providerStates:{$push:'$sourceMetadata.providerInbox'},threadIds:{$push:'$_id'},customerIds:{$addToSet:'$customerId'},identityConflict:{$max:{$cond:[{$ifNull:['$sourceMetadata.captureIdentityConflict',false]},1,0]}},lastMessageAt:{$max:'$lastMessageAt'}}},{$replaceRoot:{newRoot:{$mergeObjects:['$first',{providerInbox:{$arrayElemAt:[{$sortArray:{input:'$providerStates',sortBy:{observedAt:-1}}},0]},threadIds:'$threadIds',lastMessageAt:'$lastMessageAt',threadCount:{$size:'$threadIds'},groupCustomerIds:'$customerIds',groupIdentityConflict:'$identityConflict'}]}}}];
async function relatedThreads(c){return c.source==='gallabox'&&c.sourceMetadata?.externalContactId?Conversation.find({source:c.source,scope:c.scope,'sourceMetadata.externalContactId':c.sourceMetadata.externalContactId}).sort({_id:1}).lean():[c];}
const awayReply="Thanks so much for reaching out! We're currently outside our working hours (8:00 AM - 5:00 PM) but we'll get back to you first thing once we're back online. Talk soon!";
export function messageDisplay(m){
 // This exact outgoing away template was confirmed by the operator. Never
 // infer automation from a missing staff ID or from similar customer text.
 const automatedReply=m.authorType==='bot'||(m.source==='gallabox'&&m.authorType==='unknown'&&m.externalAuthorId&&m.sourceMetadata?.externalContactId&&m.externalAuthorId!==m.sourceMetadata.externalContactId&&m.type==='text'&&m.text?.replace(/^_|_$/g,'').trim()===awayReply);
 const event=m.sourceMetadata?.systemEvent;
 return {nativeContent:m.sourceMetadata?.nativeContent,direction:m.sourceMetadata?.direction,mediaType:m.sourceMetadata?.media?.type,location:m.sourceMetadata?.location,replyContext:m.sourceMetadata?.replyContext,automatedReply,automationBasis:automatedReply?'recorded_bot_or_confirmed_away_template':undefined,...(m.authorType==='system'?{eventLabel:event?.action==='initiate'?'Conversation started':event?.action==='resolve'?`${event.actorName?event.actorName+' · ':''}Conversation resolved`:event?.action==='re-open'?'Conversation reopened':event?.action==='unassign'?'Assignment removed':event?.action==='generate-summary'?'Summary generated':event?.action==='close'?'Conversation closed':event?.action==='assign'?`Assigned${event.assigneeName?' to '+event.assigneeName:''}`:'Conversation activity',eventAction:event?.action||null}:{} )};
}
export function publicConversation(c){const conflict=Boolean(c.sourceMetadata?.captureIdentityConflict||c.groupIdentityConflict||new Set((c.groupCustomerIds||[]).filter(Boolean)).size>1);return {_id:c._id,source:c.source,scope:c.scope,externalConversationId:c.externalConversationId,customerName:c.sourceMetadata?.captureIdentityConflict?c.sourceMetadata.captureIdentityConflict.sourceName||'':c.customerName||'',customerId:conflict?null:c.customerId||null,identityConflict:conflict,providerInbox:c.providerInbox||c.sourceMetadata?.providerInbox||{status:'unknown',assignment:'unknown'},lastMessageAt:c.lastMessageAt||null,coverageFrom:c.coverageFrom,coverageTo:c.coverageTo,coverageStatus:c.coverageStatus,sourceRevision:c.sourceRevision,historical:c.source==='gallabox_history',groupingUnverified:c.source==='gallabox_history'||c.externalConversationId?.startsWith('unthreaded:')===true};}
export function publicMessage({sourceMetadata,sourceRow,...m}){return {...m,display:messageDisplay({...m,sourceMetadata}),internalNote:m.internalNote===true||sourceMetadata?.nativeEvent?.kind==='internal_note',provenance:{source:m.source,scope:m.scope,externalMessageId:m.externalMessageId,externalConversationId:m.externalConversationId||null,historical:m.source==='gallabox_history',...(sourceMetadata?.history?{workbook:sourceMetadata.history.sourceWorkbook,sheet:sourceMetadata.history.sourceSheet,row:sourceMetadata.history.sourceRow}:{})}};}

// Source browsing is an explicit service-member capability, separate from review
// assignment. No review documents or another reviewer's judgments are returned.
export async function listServiceConversations({actor,profile,filters={}}){
 if(cloudInbox())return cloudInbox().reader.list({actor,profile,filters});
 access(actor,profile);const size=limit(filters.limit,50,100),blind=await blindIssueIds(actor),blindSet=new Set(blind.map(serviceId));
 const source=filters.source||'native';if(!['all','native','history'].includes(source))throw serviceError('Choose native, history or all captured conversations.',400);
 const inbox=inboxFilters(filters);
 const query={source:source==='all'?{$in:sources}:source==='native'?'gallabox':'gallabox_history'},conditions=[];
 if(filters.q){if(typeof filters.q!=='string'||filters.q.length>200)throw serviceError('Search is limited to 200 characters.',400);const q=filters.q.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');conditions.push({$or:[{customerName:{$regex:q,$options:'i'}},{customerId:{$regex:q,$options:'i'}},{externalConversationId:{$regex:q,$options:'i'}}]});}
 if(inbox.status!=='all')query['providerInbox.status']=inbox.status==='unknown'?{$in:['unknown',null]}:inbox.status;
 const authors=verifiedScopedProviderAuthors(actor,profile);
 if(inbox.assignment==='mine')conditions.push({$expr:{$and:[{$in:[{$concat:['gallabox:','$scope',':',{$ifNull:['$providerInbox.assigneeId','']}]},authors]},{$eq:[{$toLower:{$ifNull:['$providerInbox.assigneeType','']}},'user']}]}});
 else if(inbox.assignment!=='all')query['providerInbox.assignment']=inbox.assignment==='unknown'?{$in:['unknown',null]}:inbox.assignment;
 try{const range=!inbox.backlog&&(filters.from||filters.to)?captureRange({from:filters.from||'1900-01-01',to:filters.to||'9999-12-31'}):{};if(Object.keys(range).length)query.lastMessageAt={...(filters.from?{$gte:range.from}:{}),...(filters.to?{$lt:range.to}:{})};}catch{throw serviceError('Provide a valid Dubai date range.',400);}
 if(filters.categoryId){if(!SERVICE_CATEGORY_IDS.includes(filters.categoryId))throw serviceError('Choose a known category.',400);const hiddenConversations=await Issue.distinct('conversationId',{_id:{$in:blind}});const ids=await Issue.distinct('conversationId',{categoryIds:filters.categoryId});query.threadIds={$in:ids,$nin:hiddenConversations};}
 const matchingQuery={...query,...(conditions.length?{$and:[...conditions]}:{})};
 const boundary=cursor(filters.cursor,'conversations','lastMessageAt');if(boundary)conditions.push(boundary);if(conditions.length)query.$and=conditions;
 const counts=await Conversation.aggregate([{$match:{source:query.source}},...contactGroup,{$match:matchingQuery},{$count:'total'}]);
 const rows=await Conversation.aggregate([{$match:{source:query.source}},...contactGroup,{$match:query},{$sort:{lastMessageAt:-1,_id:-1}},{$limit:size+1}]),hasMore=rows.length>size,page=rows.slice(0,size),ids=page.flatMap(c=>c.threadIds);
 const [issues,last]=await Promise.all([Issue.find({conversationId:{$in:ids}}).sort({_id:1}).select('_id conversationId summary categoryIds outcome').lean(),Message.aggregate([{$match:{conversationId:{$in:ids},authorType:{$ne:'system'}}},{$sort:{sentAt:-1,_id:-1}},{$group:{_id:'$conversationId',message:{$first:{text:'$text',type:'$type',authorType:'$authorType',sentAt:'$sentAt'}}}}])]);
 const conversations=page.map(c=>{const members=new Set(c.threadIds.map(serviceId)),own=issues.filter(i=>members.has(serviceId(i.conversationId))),hidden=own.some(i=>blindSet.has(serviceId(i._id))),primary=own[0];return {...publicConversation(c),threadCount:c.threadCount,groupingUnverified:c.source==='gallabox_history',issueId:primary?._id||null,summary:hidden?'':primary?.summary||'',categoryIds:hidden?[]:[...new Set(own.flatMap(i=>i.categoryIds||[]))],independentCalibration:hidden,lastMessage:last.filter(m=>members.has(serviceId(m._id))).sort((a,b)=>new Date(b.message.sentAt)-new Date(a.message.sentAt))[0]?.message||null};});
 return {matchedCount:counts[0]?.total||0,countBasis:'captured_contact_channel_groups',providerPopulationComplete:false,mineIdentityAvailable:inbox.assignment==='mine'?authors.length>0:null,...(inbox.assignment==='mine'&&!authors.length?{queueUnavailableReason:'No active verified Gallabox identity is linked to this staff login.'}:{}),conversations,hasMore,nextCursor:hasMore?encode('conversations',page.at(-1),'lastMessageAt'):null};
}
export async function getServiceInboxConversation({actor,profile,conversationId}){
 if(cloudInbox())return cloudInbox().reader.conversation({actor,profile,conversationId});
 access(actor,profile);if(!oid(conversationId))throw serviceError('Invalid conversation ID.',400);const c=await Conversation.findOne({_id:conversationId,source:{$in:sources}}).lean();if(!c)throw serviceError('Conversation not found.',404);return publicConversation(c);
}
export async function getServiceConversationDetail({actor,profile,conversationId,filters={}}){
 if(cloudInbox())return cloudInbox().reader.detail({actor,profile,conversationId,filters});
 const caps=access(actor,profile);if(!oid(conversationId))throw serviceError('Invalid conversation ID.',400);
 const c=await Conversation.findOne({_id:conversationId,source:{$in:sources}}).lean();if(!c)throw serviceError('Conversation not found.',404);
 const threads=await relatedThreads(c),ids=threads.map(t=>t._id);
 const size=limit(filters.limit,100,200),boundary=cursor(filters.cursor,`messages:${conversationId}`,'sentAt'),query={conversationId:{$in:ids},...(boundary?{$and:[boundary]}:{})};
 const [rows,issues,blind]=await Promise.all([Message.find(query).sort({sentAt:-1,_id:-1}).limit(size+1).select('-sourceRow').lean(),Issue.find({conversationId:{$in:ids}}).sort({_id:1}).select('-sourceMetadata').lean(),blindIssueIds(actor)]),blindSet=new Set(blind.map(serviceId)),independentCalibration=issues.some(i=>blindSet.has(serviceId(i._id)));
 const [actions,ownedReviews]=await Promise.all([independentCalibration?[]:Action.find({issueId:{$in:issues.map(i=>i._id)},...(caps.supervise?{}:{ownerId:actor._id})}).sort({createdAt:1,_id:1}).lean(),Review.distinct('issueId',{issueId:{$in:issues.map(i=>i._id)},reviewerId:actor._id})]);const owned=new Set([...ownedReviews,...actions.filter(a=>serviceId(a.ownerId)===serviceId(actor._id)).map(a=>a.issueId)].map(serviceId)),hasMore=rows.length>size,page=rows.slice(0,size);
 const historyIssues=await withConversationHistory(issues);
 const sessions=await conversationSessions(threads,historyIssues);
 return {sessions,conversation:{...publicConversation({...c,providerInbox:currentProviderInbox(threads),groupCustomerIds:threads.map(t=>t.customerId),groupIdentityConflict:threads.some(t=>t.sourceMetadata?.captureIdentityConflict)}),threadCount:threads.length,historyAnchorId:threads[0]._id},messages:[...page].reverse().map(publicMessage),issues:historyIssues.map(i=>({...independentCalibration?blindIssue(i):i,conversationHistory:i.conversationHistory,canCreateAction:!independentCalibration&&(caps.supervise||owned.has(serviceId(i._id)))})),actions,independentCalibration,hasMore,nextCursor:hasMore?encode(`messages:${conversationId}`,page.at(-1),'sentAt'):null};
}
