// Synthetic local acceptance cases. This module never contacts a provider.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Request from '../models/ServiceRequest.js';
import Issue from '../models/ServiceIssue.js';
import Review from '../models/ServiceReview.js';
import {REQUEST_TOPICS} from '../config/customerServiceRequests.js';

const oid=key=>createHash('sha256').update('matter-local-qa-v1:'+key).digest('hex').slice(0,24);
const scope='fixture-account:fixture-channel';
const scenarios={
 renewal:['My renewal payment went through, but Monday is still missing from my plan. Please check subscription DEMO-101.','I will check the paid renewal period and confirm whether Monday is active.'],
 plan_change:['Can I move from two to three meals from 12 November? Please confirm the price before changing anything.','I will check the requested plan and effective date. No change is confirmed yet.'],
 pause:['Please pause 12–14 November. Keep my other deliveries and resume on the 15th.','I have asked for those dates to be checked. I will confirm when the pause is applied.'],
 refund:['I cancelled DEMO-104 yesterday. Has the AED 120 refund actually been processed?','Finance approved the request, but processing is still pending. I will follow up for the transaction reference.'],
 meal_selection:['I selected the vegetarian meal for the 12th, but my confirmation shows chicken.','I will check the saved meal selection and the correction options.'],
 delivery_missed:['My 9–12 delivery has not arrived. Please check today’s order DEMO-106.','Delivery is investigating. I will confirm a delivery or an agreed alternative once completed.'],
 delivery_instructions:['From 12 November please use reception at the east entrance. Keep my existing apartment number.','I will check that Delivery received the new entrance instruction for the correct date.'],
 bag_collection:['Please collect two empty bags on my next delivery. Is a collection booked?','I have requested collection. A request alone does not confirm that the bags were collected.'],
 food_quality:['The seal on my lunch was broken when I opened the bag. Please review the attached example.','I have recorded the concern for an authorized review. The finding and any agreed remedy are still pending.'],
 exclusions:['Can you exclude sesame from 12 November? Please confirm feasibility before changing the plan.','I will request an authorized feasibility check. No dietary or safety assurance is confirmed here.'],
 nutrition:['Where can I find the approved protein and calorie information for this meal?','The approved meal information is in your meal guide. This fictional example records where that answer was provided.'],
 discount:['DEMO10 is rejected at checkout. Can you check whether it applies to my renewal?','I will check the offer terms and eligibility. No discount application is confirmed yet.'],
 new_lead:['I am interested in the three-meal plan starting next week. What happens after I sign up?','I will explain the options and follow up on your agreed interest. Signup is not yet confirmed.'],
 returning_lead:['I used Matter before. Can I restart on 15 November with my old plan?','I will check the return options and confirm a resulting subscription if reactivation completes.'],
 billing:['My invoice shows AED 240, but my payment receipt is AED 120. Please check DEMO-115.','I will compare the invoice and payment records. A screenshot alone does not verify the payment.'],
 feedback:['Could you add a way to see next week’s meal choices earlier? Please let me know if there is a response.','Thank you. I have recorded the suggestion and will follow up on the response I promised.'],
 other:['I need help with something on my account, but I am not sure which option to choose.','Could you tell us what happened and what you need help with? I will keep this open while we clarify.'],
};

export async function seedActionQa({root,manifest,pool,source}){
 const stamp=Date.now()-45*60000;
 // Each stable ID is inserted once; retries never replace source content or work.
 const insert=async(kind,body)=>{if(!(await pool.query('SELECT 1 FROM gallabox_private.inbox_record WHERE kind=$1 AND id=$2',[kind,String(body._id)])).rowCount)await source(kind,body);};
 for(const [i,topic]of REQUEST_TOPICS.entries()){
  const conversationId=oid(topic.id),messageId=oid(topic.id+':customer');
  const [question,reply]=scenarios[topic.id];
  await insert('serviceconversations',{_id:conversationId,source:'gallabox',scope,externalConversationId:'qa-v1-'+topic.id,customerName:'QA · '+topic.label,lastMessageAt:new Date(stamp+i*1000+60000),sourceMetadata:{externalContactId:'qa-v1-'+topic.id,providerInbox:{status:'open',assignment:'assigned',assigneeId:'staff',assigneeType:'user',assigneeName:'Mariolle — demo',observedAt:new Date(stamp).toISOString()}}});
  await insert('servicemessages',{_id:messageId,conversationId,source:'gallabox',scope,externalMessageId:'qa-v1-'+topic.id+'-customer',authorType:'customer',text:question,sentAt:new Date(stamp+i*1000),type:'text'});
  await insert('servicemessages',{_id:oid(topic.id+':reply'),conversationId,source:'gallabox',scope,externalMessageId:'qa-v1-'+topic.id+'-reply',externalAuthorId:'staff',authorType:'staff',authorName:'Mariolle — demo',text:reply,sentAt:new Date(stamp+i*1000+60000),type:'text'});
  if(!await Request.exists({_id:oid(topic.id+':issue')}))await Request.create({_id:oid(topic.id+':issue'),conversationId,originMessageId:messageId,evidenceMessageIds:[messageId],excerpt:question,title:topic.label,customerName:'QA · '+topic.label,receivedAt:new Date(stamp+i*1000),ownerId:manifest.users.staff,assignedAt:new Date(stamp),classification:{kind:['food_quality','delivery_missed','billing'].includes(topic.id)?'complaint':'inquiry',topic:topic.id,group:topic.group},nextAction:{action:reply,dueAt:new Date(Date.now()+3600000)},history:[{event:'create',actorId:manifest.users.head,at:new Date(stamp),reason:'Synthetic QA scenario; no operational action performed'}]});
 }
 const formats=[
  {type:'text',text:'*Bold request* _emphasis_ ~correction~ 😊\nPlease keep my unit unchanged. <script>not executable</script>'},
  {type:'text',text:'Long customer context. '.repeat(160)},
  {type:'text',text:'Yes, the same delivery date.',sourceMetadata:{replyContext:{externalMessageId:'qa-format-0',text:'Please keep my unit unchanged.',authorName:'Fictional customer'}}},
  {type:'image',text:'Synthetic image and caption',file:'example.png',mime:'image/png'},
  {type:'audio',text:'Synthetic voice note',file:'voice.wav',mime:'audio/wav'},
  {type:'video',text:'CC0 sample video; not a customer attachment',file:'flower.webm',mime:'video/webm'},
  {type:'document',text:'Synthetic PDF',file:'example.pdf',mime:'application/pdf'},
  {type:'document',text:'Synthetic HTML — download only',file:'example.html',mime:'text/html'},
  {type:'document',text:'Synthetic workbook',file:'example.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
  {type:'location',text:'Fictional shared location',sourceMetadata:{location:{latitude:25,longitude:55,name:'Synthetic test location',address:'Example location — not a customer address'}}},
  {type:'other',text:'',sourceMetadata:{nativeContent:{kind:'contacts',contacts:[{name:'Fictional contact',phones:['+000000000']}]}}},
  {type:'other',text:'',sourceMetadata:{nativeContent:{kind:'template',headerText:'Example template',text:'Please confirm your preferred date.',buttons:['Confirm','Change']}}},
  {type:'other',text:'',sourceMetadata:{nativeContent:{kind:'interactive',text:'Change the date',buttons:['12 November','15 November']}}},
  {type:'other',text:'',sourceMetadata:{nativeContent:{kind:'button',text:'Confirm'}}},
  {type:'other',text:'',sourceMetadata:{nativeContent:{kind:'reaction',emoji:'👍',targetId:'qa-format-0'}}},
  {type:'text',text:'Internal test note — not a customer reply',authorType:'staff',internalNote:true},
  {type:'text',text:'Automated test acknowledgement — not a human answer',authorType:'bot'},
  {type:'other',text:'',authorType:'system',sourceMetadata:{event:{action:'resolve',actorName:'Fictional operator'}}},
  {type:'other',text:'',sourceMetadata:{nativeContent:{kind:'unsupported'}}},
  {type:'text',text:'Public handover test reply',authorType:'staff',externalAuthorId:'staff'},
  {type:'text',text:'Private handover after public reply — must keep Internal note label',authorType:'staff',externalAuthorId:'staff',internalNote:true},
  {type:'other',text:'',authorType:'system',sourceMetadata:{systemEvent:{action:'resolve',actorName:'Fictional operator'}}},
 ];
 const failures=[
  {type:'audio',text:'Expired once — retry should recover',file:'retry.wav',mime:'audio/wav'},
  {type:'image',text:'Corrupt bytes — browser decode error',file:'corrupt.png',mime:'image/png'},
  {type:'document',text:'MIME mismatch — fail closed',file:'mismatch.pdf',mime:'application/pdf'},
  {type:'image',text:'Missing source metadata',mediaState:'missing'},
 ];
 for(const [name,rows]of [['formats',formats],['failures',failures]]){
  const conversationId=oid(name);
  await insert('serviceconversations',{_id:conversationId,source:'gallabox',scope,externalConversationId:'qa-v1-'+name,customerName:'QA · '+(name==='formats'?'Conversation formats':'Attachment recovery'),lastMessageAt:new Date(stamp+rows.length*1000),sourceMetadata:{externalContactId:'qa-v1-'+name,providerInbox:{status:'open',assignment:'unassigned',observedAt:new Date(stamp).toISOString()}}});
  for(const [i,row]of rows.entries()){
   const {file,mime,...body}=row;
   await insert('servicemessages',{_id:oid(name+':'+i),conversationId,source:'gallabox',scope,externalMessageId:'qa-'+name+'-'+i,authorType:'customer',sentAt:new Date(stamp+i*1000),...body,...file?{mediaState:'available',sourceMetadata:{...body.sourceMetadata,media:{url:'https://files.gallabox.com/fixture-account/'+file,mimeType:mime}}}:{}});
  }
 }
 // Independent review and customer-directory journeys need their own records.
 const reviewConversation=oid('review-conversation'),reviewIssue=oid('review-issue'),customerId='matter:local-qa';
 await insert('serviceconversations',{_id:reviewConversation,source:'gallabox',scope,externalConversationId:'qa-review',customerId,customerName:'QA · Independent review',lastMessageAt:new Date(stamp),sourceMetadata:{externalContactId:'qa-review',providerInbox:{status:'resolved',assignment:'assigned',assigneeId:'staff',assigneeType:'user',observedAt:new Date(stamp).toISOString()}}});
 for(const [key,authorType,text]of [['question','customer','Please explain where my invoice is.'],['answer','staff','Your invoice is available in the account billing page. This is a synthetic review example.']])await insert('servicemessages',{_id:oid('review-'+key),conversationId:reviewConversation,source:'gallabox',scope,externalConversationId:'qa-review',externalMessageId:'qa-review-'+key,authorType,...authorType==='staff'?{authorId:manifest.users.staff,externalAuthorId:'staff',authorName:'Mariolle — demo'}:{},type:'text',text,sentAt:new Date(stamp+(authorType==='staff'?60000:0))});
 if(!await Issue.exists({_id:reviewIssue}))await Issue.create({_id:reviewIssue,conversationId:reviewConversation,customerId,customerName:'QA · Independent review',summary:'Synthetic billing answer for independent review',categoryIds:['refund_credit'],contributorIds:[manifest.users.staff],evidenceMessageIds:[oid('review-question'),oid('review-answer')],sourceRevision:1,boundaryState:'confirmed',evidenceState:'available'});
 if(!await Review.exists({_id:oid('review-assignment')}))await Review.create({_id:oid('review-assignment'),issueId:reviewIssue,reviewerId:manifest.users.adrian,status:'assigned',sourceRevision:1,assignedAt:new Date(stamp),allocationReason:'Synthetic independent QA review'});
 const state=(await pool.query("SELECT body FROM gallabox_private.inbox_record WHERE kind='servicecustomerdirectorystates' AND body->>'key'='matter_customer_directory' LIMIT 1")).rows[0]?.body;
 const generation=state?.activeGeneration||'local-qa';
 if(!state)await insert('servicecustomerdirectorystates',{_id:oid('directory'),key:'matter_customer_directory',activeGeneration:generation,status:'ready',sourceObservedAt:new Date(),report:{coverage:'Synthetic local QA only'}});
 await insert('servicecustomers',{_id:oid('customer'),customerId,active:true,generation,name:'QA · Independent review',email:'review@fixture.invalid',subscriptions:[{id:'DEMO-REVIEW',status:'active',plan:{name:'Fictional review plan'}}],source:'synthetic-local-qa',sourceObservedAt:new Date(stamp),sourceCoverage:'Synthetic local QA only'});
}

export function createQaMediaProvider(root){
 let retry=0;
 const wav=Buffer.alloc(44+32000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);for(let i=0;i<16000;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/8000)*1000),44+i*2);
 const pdf=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
 return async url=>{
  const prefix='https://files.gallabox.com/fixture-account/';
  if(!url.startsWith(prefix))return new Response('Only named synthetic local media is available.',{status:404});
  const file=url.slice(prefix.length);
  if(file==='retry.wav'&&retry++===0)return new Response('Synthetic expired source',{status:403});
  const entries={
   'voice.wav':[wav,'audio/wav'],'retry.wav':[wav,'audio/wav'],
   'example.png':[()=>fs.readFileSync(path.join(root,'client/public/images/matter-logo24-dark.png')),'image/png'],
   'flower.webm':[()=>fs.readFileSync(path.join(root,'work/action-flow/media/flower.webm')),'video/webm'],
   'example.pdf':[pdf,'application/pdf'],
   'example.html':['<!doctype html><title>Synthetic attachment</title><p>Download-only test document</p><script>throw Error("must not execute in Matter")</script>','text/html'],
   'example.xlsx':[()=>fs.readFileSync(path.join(root,'work/action-flow/media/example.xlsx')),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
   'corrupt.png':['not image bytes','image/png'],'mismatch.pdf':['not a PDF','text/html'],
  };
  const entry=entries[file];if(!entry)return new Response('Synthetic attachment absent',{status:404});
  try{return new Response(typeof entry[0]==='function'?entry[0]():entry[0],{headers:{'content-type':entry[1]}});}catch{return new Response('Local QA asset missing',{status:404});}
 };
}
