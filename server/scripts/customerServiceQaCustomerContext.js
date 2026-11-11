import mongoose from 'mongoose';
import {randomUUID} from 'node:crypto';
import {ACTION_VERSION} from '../config/customerServiceActions.js';
import {encodeCloudRecord} from '../services/customerServiceCloudStore.js';

// Additive fixtures in the sandbox's own database. These profiles are explicitly
// fictional; they never create a real Matter account or infer a customer match.
export async function ensureQaCustomerContext({pool,caseId,staffId}){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('gallabox_private.inbox')); SELECT set_config('gallabox.workflow_writer','cloud',true);");
  const current=(await client.query('SELECT * FROM gallabox_private.sidebar_qa_case WHERE id=$1 FOR UPDATE',[caseId])).rows[0];
  if(!current||current.customer_context){await client.query('COMMIT');return current?.customer_context||null;}
  const head=(await client.query('SELECT revision FROM gallabox_private.inbox_head WHERE singleton FOR UPDATE')).rows[0],revision=Number(head.revision)+1;let writes=0;
  const priorId=new mongoose.Types.ObjectId(),questionId=new mongoose.Types.ObjectId(),answerId=new mongoose.Types.ObjectId(),requestId=new mongoose.Types.ObjectId();
  const at=new Date(new Date(current.created_at).getTime()-3*86400000),doneAt=new Date(+at+45*60000);
  const names=['Aisha — QA','Omar — QA','Leena — QA','Ravi — QA'],name=names[parseInt(caseId.slice(-2),16)%names.length];
  const profile={source:'qa_fixture',customer:{name,reference:'QA-CUSTOMER-'+caseId.slice(-6).toUpperCase()},subscriptions:[{planName:'Sample 2-meal plan',status:'active'}],previousRequests:[{conversationId:String(priorId),title:'Bag collection',outcome:'Collected',at:doneAt.toISOString()}]};
  const insert=async(kind,body)=>{const r=encodeCloudRecord(kind,body);await client.query('INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES($1,$2,$3,$4,$5,$6)',[r.kind,r.id,r.body,r.payload,r.sha256,revision]);writes++;};
  const base={source:'gallabox',scope:'fixture-account:fixture-channel',sourceMetadata:{synthetic:true,qaFixture:'customer-context'}};
  await client.query('INSERT INTO gallabox_private.sidebar_qa_case(id,topic,detail,order_reference,delivery_date,created_at,customer_context) VALUES($1,$2,$3,$4,$5,$6,$7)',[String(priorId),'tag_bags','bag_not_collected','QA-PRIOR-'+caseId.slice(-6).toUpperCase(),new Date(+at+14400000).toISOString().slice(0,10),at,{...profile,previousRequests:[]}]);
  await insert('serviceconversations',{...base,_id:priorId,externalConversationId:'qa-prior-'+caseId,customerName:name+' · Bag collection',lastMessageAt:doneAt,sourceMetadata:{...base.sourceMetadata,externalContactId:'qa-prior-'+caseId,providerInbox:{status:'resolved',assignment:'assigned',assigneeId:'staff',assigneeType:'user',assigneeName:'Mariolle — demo'}}});
  await insert('servicemessages',{...base,_id:new mongoose.Types.ObjectId(),conversationId:priorId,externalMessageId:'qa-prior-start-'+caseId,authorType:'system',type:'system',sentAt:at,sourceMetadata:{...base.sourceMetadata,systemEvent:{action:'initiate'}}});
  const question='Please collect the empty bag from my previous delivery.';
  await insert('servicemessages',{...base,_id:questionId,conversationId:priorId,externalMessageId:'qa-prior-question-'+caseId,authorType:'customer',type:'text',text:question,sentAt:new Date(+at+60000)});
  await insert('servicemessages',{...base,_id:answerId,conversationId:priorId,externalMessageId:'qa-prior-answer-'+caseId,authorType:'staff',authorId:staffId,externalAuthorId:'staff',authorName:'Mariolle — demo',type:'text',text:'The bag collection is completed in this fictional QA example. The collection record is QA-BAG-'+caseId.slice(-6).toUpperCase()+'.',sentAt:doneAt});
  await insert('servicemessages',{...base,_id:new mongoose.Types.ObjectId(),conversationId:priorId,externalMessageId:'qa-prior-close-'+caseId,authorType:'system',type:'system',sentAt:new Date(+doneAt+60000),sourceMetadata:{...base.sourceMetadata,systemEvent:{action:'resolve',actorName:'Mariolle — demo'}}});
  const classification={kind:'inquiry',topic:'tag_bags',subtopic:'bag_not_collected',group:'Delivery'},ownerId=new mongoose.Types.ObjectId(staffId);
  const open={title:'Bag collection',classification,ownerId,status:'open',currentActionCode:'check',nextAction:{action:'Check the collection',dueAt:doneAt}};
  const resolution={outcomeCode:'collection_completed',outcomeLabel:'Collection completed',outcomeGroup:'fulfilled',definitionVersion:ACTION_VERSION,details:{customerInformed:true},basis:'linked_evidence',evidenceMessageId:String(answerId),evidenceReference:'QA-BAG-'+caseId.slice(-6).toUpperCase(),note:'Fictional collection completed',at:doneAt,actorId:ownerId};
  await insert('servicerequests',{_id:requestId,conversationId:priorId,originMessageId:questionId,originIssueKey:'primary',contextScope:'conversation',evidenceMessageIds:[questionId,answerId],customerName:name,title:'Bag collection',excerpt:question,receivedAt:at,ownerId,assignedAt:at,classification,status:'resolved',workflowDefinitionVersion:ACTION_VERSION,currentActionCode:'complete',topicDetails:{customerInformed:true},resolution,followups:[],exceptions:[],version:2,createdAt:at,updatedAt:doneAt,history:[{event:'work',actorId:ownerId,at,before:null,after:open,reason:'Fictional previous customer request'},{event:'work',actorId:ownerId,at:doneAt,before:open,after:{...open,status:'resolved',currentActionCode:'complete',resolution},reason:'Fictional completed collection'}]});
  await client.query('UPDATE gallabox_private.sidebar_qa_case SET customer_context=$2 WHERE id=$1',[caseId,profile]);
  await client.query('UPDATE gallabox_private.inbox_head SET revision=$1,committed_at=now() WHERE singleton',[revision]);
  await client.query('INSERT INTO gallabox_private.inbox_commit(run_id,revision,records,captured_at) VALUES($1,$2,$3,now())',['qa-context:'+randomUUID(),revision,writes]);
  await client.query('COMMIT');return profile;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
