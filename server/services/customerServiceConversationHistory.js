import mongoose from 'mongoose';
import Conversation from '../models/ServiceConversation.js';
import Message from '../models/ServiceMessage.js';
import {cloudInbox,cloudSqlText as lit} from './customerServiceCloudStore.js';

// A read-only projection of already-authorized records. Capture placeholders
// remain intact; a conversation preview does not classify or resolve an issue.
export async function withConversationHistory(issues,{store=cloudInbox()?.store}={}) {
 const ids=[...new Set(issues.map(i=>String(i.conversationId)).filter(Boolean))];
 if(!ids.length)return issues;
 let conversations,counts,previews,events;
 if(store){
  const selected=ids.map(lit).join(','),table='gallabox_private.inbox_record';
  const result=await store.query(`WITH messages AS MATERIALIZED(SELECT id,body FROM ${table} WHERE kind='servicemessages' AND body->>'conversationId' IN (${selected}))
   SELECT jsonb_build_object('conversations',COALESCE((SELECT jsonb_agg(jsonb_build_object('_id',id,'source',body->>'source','lastMessageAt',body->>'lastMessageAt')) FROM ${table} WHERE kind='serviceconversations' AND id IN (${selected})),'[]'),
   'counts',COALESCE((SELECT jsonb_agg(c) FROM(SELECT body->>'conversationId' AS "_id",count(*) AS count,min(body->>'sentAt') AS "firstMessageAt" FROM messages GROUP BY 1)c),'[]'),
   'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('_id',id,'conversationId',body->>'conversationId','sentAt',body->>'sentAt','action',body#>>'{sourceMetadata,systemEvent,action}','actorName',body#>>'{sourceMetadata,systemEvent,actorName}') ORDER BY body->>'sentAt',id) FROM messages WHERE body->>'authorType'='system' AND body#>>'{sourceMetadata,systemEvent,action}' IN ('initiate','resolve','close','re-open')),'[]'),
   'previews',COALESCE((SELECT jsonb_agg(p) FROM(SELECT DISTINCT ON(body->>'conversationId') body->>'conversationId' AS "_id",jsonb_build_object('text',left(body->>'text',240),'type',body->>'type','authorType',body->>'authorType','sentAt',body->>'sentAt') AS message FROM messages WHERE body->>'authorType' IN ('customer','staff') AND COALESCE(body->>'internalNote','false')<>'true' AND COALESCE(body#>>'{sourceMetadata,nativeEvent,kind}','')<>'internal_note' AND COALESCE(body#>>'{sourceMetadata,nativeContent,kind}','')<>'reaction' ORDER BY body->>'conversationId',(body->>'authorType'='customer') DESC,body->>'sentAt' DESC,id DESC)p),'[]'));`);
  ({conversations,counts,previews,events}=result);
 }else{
  const conversationIds=ids.map(id=>new mongoose.Types.ObjectId(id));
  [conversations,counts,previews,events]=await Promise.all([
   Conversation.find({_id:{$in:conversationIds}}).select('_id source lastMessageAt').lean(),
   Message.aggregate([{$match:{conversationId:{$in:conversationIds}}},{$group:{_id:'$conversationId',count:{$sum:1},firstMessageAt:{$min:'$sentAt'}}}]),
   Message.aggregate([{$match:{conversationId:{$in:conversationIds},authorType:{$in:['customer','staff']},internalNote:{$ne:true},'sourceMetadata.nativeEvent.kind':{$ne:'internal_note'},'sourceMetadata.nativeContent.kind':{$ne:'reaction'}}},{$addFields:{customerFirst:{$cond:[{$eq:['$authorType','customer']},1,0]}}},{$sort:{conversationId:1,customerFirst:-1,sentAt:-1,_id:-1}},{$group:{_id:'$conversationId',message:{$first:{text:{$substrCP:[{$ifNull:['$text','']},0,240]},type:'$type',authorType:'$authorType',sentAt:'$sentAt'}}}}]),
   Message.find({conversationId:{$in:conversationIds},authorType:'system','sourceMetadata.systemEvent.action':{$in:['initiate','resolve','close','re-open']}}).sort({sentAt:1,_id:1}).select('_id conversationId sentAt sourceMetadata.systemEvent.action sourceMetadata.systemEvent.actorName').lean().then(rows=>rows.map(m=>({_id:m._id,conversationId:m.conversationId,sentAt:m.sentAt,...m.sourceMetadata.systemEvent})))
  ]);
 }
 const byId=rows=>new Map(rows.map(row=>[String(row._id),row]));
 const context=byId(conversations),totals=byId(counts),last=byId(previews);
 return issues.map(issue=>{
  const timeline=events.filter(e=>String(e.conversationId)===String(issue.conversationId)),started=timeline.find(e=>e.action==='initiate'),latest=timeline.at(-1),closed=latest&&['resolve','close'].includes(latest.action)?latest:null;
  return {...issue,conversationHistory:{conversationId:String(issue.conversationId),source:context.get(String(issue.conversationId))?.source||'',firstMessageAt:totals.get(String(issue.conversationId))?.firstMessageAt||null,startedAt:started?.sentAt||null,closedAt:closed?.sentAt||null,closedBy:closed?.actorName||'',events:timeline,lastMessageAt:context.get(String(issue.conversationId))?.lastMessageAt||null,messageCount:Number(totals.get(String(issue.conversationId))?.count||0),preview:last.get(String(issue.conversationId))?.message||null}};
 });
}

export async function conversationSessions(threads,issues,options={}) {
 const known=new Map(issues.filter(i=>i.conversationHistory).map(i=>[String(i.conversationId),i.conversationHistory]));
 const missing=threads.filter(c=>!known.has(String(c._id)));
 for(const row of await withConversationHistory(missing.map(c=>({_id:c._id,conversationId:c._id})),options))known.set(String(row.conversationId),row.conversationHistory);
 return threads.map(c=>({...known.get(String(c._id)),conversationId:String(c._id),providerStatus:c.sourceMetadata?.providerInbox?.status||'',startedAt:known.get(String(c._id))?.startedAt||c.coverageFrom||known.get(String(c._id))?.firstMessageAt||null,startBasis:known.get(String(c._id))?.startedAt?'source_start_event':'first_captured_message'})).sort((a,b)=>(Date.parse(b.startedAt)||Date.parse(b.lastMessageAt)||0)-(Date.parse(a.startedAt)||Date.parse(a.lastMessageAt)||0));
}
