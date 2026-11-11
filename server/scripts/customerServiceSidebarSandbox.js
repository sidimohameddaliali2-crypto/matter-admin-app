// Fictional, loopback-only practice harness. Never mounted by the normal app.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import {encodeCloudRecord,decodeCloudRecord} from '../services/customerServiceCloudStore.js';
import {REQUEST_TOPIC_TAGS} from '../config/customerServiceTopicTags.js';
import {PRACTICE_REQUESTS} from './customerServicePracticeRequests.js';
import {ensureQaCustomerContext} from './customerServiceQaCustomerContext.js';

const problem=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
const today=()=>new Date(Date.now()+14400000).toISOString().slice(0,10);
const oid=value=>{if(!/^[a-f0-9]{24}$/.test(String(value||'')))throw problem('Choose a practice conversation.');return String(value);};
export function validatePracticeCompletion({input,practice,events,messages}){
 if(input.outcomeCode!=='day_credit_applied')return;
 if(!practice||practice.topic!=='tag_delivery'||practice.detail!=='missed_delivery')throw problem('The linked day-credit example requires a Missed Delivery practice case.');
 const credit=events.find(e=>e.kind==='credit_posted');
 if(!credit)throw problem('The day credit is not posted. Use the QA guide to simulate it, then record the outcome.');
 if(input.details?.creditReference!==credit.body.reference)throw problem('The credit reference must match this conversation’s posted QA credit.');
 if(input.details?.deliveryDate!==practice.delivery_date)throw problem('The credit must cover this practice delivery date.');
 const update=events.find(e=>e.kind==='customer_updated');
 const reply=messages.find(m=>String(m._id)===input.evidenceMessageId&&String(m._id)===update?.body.messageId&&m.authorType==='staff'&&m.sourceMetadata?.qaEvent==='customer_updated');
 if(!reply||new Date(reply.sentAt)<new Date(credit.created_at))throw problem('Link the simulated staff reply sent after this credit was posted. An earlier promise is not completion evidence.');
}

export async function installSidebarSandbox({app,pool,manifest,manifestPath,root,tokens}){
 if(process.env.CUSTOMER_SERVICE_TEST_ISOLATED!=='true'||manifest.fictional!==true||!/^gallabox_action_preview_[a-f0-9]{32}$/.test(manifest.database))throw Error('Sidebar sandbox requires its own fictional fixture database.');
 const port=Number(process.env.CUSTOMER_SERVICE_PREVIEW_PORT||51160),origin=`http://127.0.0.1:${port}`;
 app.use((req,res,next)=>{
  const navigation=req.method==='GET'&&(req.headers['sec-fetch-mode']==='navigate'||req.headers['sec-fetch-dest']==='document');
  if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'&&!navigation)return res.status(403).json({success:false,message:'This QA playground is restricted to its own localhost origin.'});
  if(req.path==='/api/customer-service/me'){
   const send=res.json.bind(res);res.json=body=>{if(body?.success&&body.data?.capabilities)body.data.capabilities.sidebarSandbox=true;return send(body);};
  }
  next();
 });
 await pool.query(`CREATE TABLE IF NOT EXISTS gallabox_private.sidebar_qa_case(id text PRIMARY KEY, topic text NOT NULL, detail text NOT NULL, order_reference text NOT NULL, delivery_date text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS gallabox_private.sidebar_qa_event(id text PRIMARY KEY, case_id text NOT NULL REFERENCES gallabox_private.sidebar_qa_case(id), kind text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_id,kind));
 ALTER TABLE gallabox_private.sidebar_qa_case ADD COLUMN IF NOT EXISTS customer_context jsonb;`);
 for(const row of (await pool.query('SELECT id FROM gallabox_private.sidebar_qa_case WHERE customer_context IS NULL')).rows)await ensureQaCustomerContext({pool,caseId:row.id,staffId:manifest.users.staff});
 const source=async(client,kind,body)=>{const row=encodeCloudRecord(kind,body);await client.query('INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES($1,$2,$3,$4,$5,1)',[row.kind,row.id,row.body,row.payload,row.sha256]);};
 async function createCase(topicId,detailId){
  const topic=REQUEST_TOPIC_TAGS.find(t=>t.id===topicId),detail=topic?.includes.find(d=>d.id===detailId);
  if(!detail)throw problem('Choose a configured topic and detail.');
  const cid=new mongoose.Types.ObjectId(),id=String(cid),date=today(),reference='QA-'+id.slice(-6).toUpperCase(),at=new Date();
  const question=PRACTICE_REQUESTS[detail.id];if(!question)throw problem('This reason needs a matching QA scenario.');
  const text=question+` Reference ${reference}, service date ${date}.`;
  const client=await pool.connect();try{
   await client.query('BEGIN');
   await client.query('INSERT INTO gallabox_private.sidebar_qa_case(id,topic,detail,order_reference,delivery_date) VALUES($1,$2,$3,$4,$5)',[id,topic.id,detail.id,reference,date]);
   const base={source:'gallabox',scope:'fixture-account:fixture-channel',sourceMetadata:{synthetic:true}};
   await source(client,'serviceconversations',{...base,_id:cid,externalConversationId:'sidebar-qa-'+id,customerName:'QA · '+detail.label+' · '+id.slice(-4),lastMessageAt:at,sourceMetadata:{synthetic:true,externalContactId:'sidebar-qa-'+id,providerInbox:{status:'open',assignment:'assigned',assigneeId:'staff',assigneeType:'user',assigneeName:'Mariolle — demo'}}});
   await source(client,'servicemessages',{...base,_id:new mongoose.Types.ObjectId(),conversationId:cid,externalMessageId:'sidebar-start-'+id,authorType:'system',type:'system',sentAt:new Date(+at-60000),sourceMetadata:{synthetic:true,systemEvent:{action:'initiate'}}});
   await source(client,'servicemessages',{...base,_id:new mongoose.Types.ObjectId(),conversationId:cid,externalMessageId:'sidebar-question-'+id,authorType:'customer',type:'text',text,sentAt:at});
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await ensureQaCustomerContext({pool,caseId:id,staffId:manifest.users.staff});
  return {conversationId:id,topic:topic.id,detail:detail.id};
 }
 async function state(id){
  if(!id)return {topics:REQUEST_TOPIC_TAGS,practice:null,events:[]};
  const practice=(await pool.query('SELECT * FROM gallabox_private.sidebar_qa_case WHERE id=$1',[oid(id)])).rows[0]||null;
  const events=practice?(await pool.query('SELECT * FROM gallabox_private.sidebar_qa_event WHERE case_id=$1 ORDER BY created_at',[id])).rows:[];
  return {topics:REQUEST_TOPIC_TAGS,practice,events};
 }
 const endpoint=fn=>async(req,res)=>{try{await app.get('customerServiceAuth').authenticate(req.headers.authorization);res.json({success:true,data:await fn(req)});}catch(error){res.status(error.statusCode||503).json({success:false,message:error.statusCode?error.message:'The local QA action failed. Your saved practice work is retained.'});}};
 app.get('/api/customer-service/sandbox/state',endpoint(req=>state(req.query.conversationId)));
 app.post('/api/customer-service/sandbox/cases',endpoint(req=>createCase(req.body.topic,req.body.detail)));
 app.post('/api/customer-service/sandbox/events',endpoint(async req=>{
  const id=oid(req.body.conversationId),kind=req.body.kind;
  if(!['delivery_acknowledged','credit_posted','customer_updated','customer_followup'].includes(kind))throw problem('Unknown QA event.');
  const {practice}=await state(id);if(!practice)throw problem('Choose a practice case first.');
  const client=await pool.connect();try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[id]);
   const existing=(await client.query('SELECT * FROM gallabox_private.sidebar_qa_event WHERE case_id=$1 AND kind=$2',[id,kind])).rows[0];
   if(existing){await client.query('COMMIT');return existing;}
   if(kind==='customer_updated'&&!(await client.query("SELECT 1 FROM gallabox_private.sidebar_qa_event WHERE case_id=$1 AND kind='credit_posted'",[id])).rowCount)throw problem('Simulate the posted credit before recording its completion reply.');
   const at=new Date(),eventId=randomUUID(),body={synthetic:true,...(kind==='credit_posted'?{reference:'QA-CREDIT-'+id.slice(-6).toUpperCase(),days:1,serviceDate:practice.delivery_date}:{}),...(kind==='delivery_acknowledged'?{team:'Delivery',acknowledgement:'QA Delivery acknowledged the handoff'}:{})};
   if(['customer_updated','customer_followup'].includes(kind)){
    const mid=new mongoose.Types.ObjectId();body.messageId=String(mid);
    await source(client,'servicemessages',{_id:mid,conversationId:new mongoose.Types.ObjectId(id),source:'gallabox',scope:'fixture-account:fixture-channel',externalMessageId:'sidebar-event-'+eventId,authorType:kind==='customer_updated'?'staff':'customer',...(kind==='customer_updated'?{authorId:manifest.users.staff,externalAuthorId:'staff',authorName:'Mariolle — demo'}:{}),type:'text',text:kind==='customer_updated'?`A one-day credit for ${practice.delivery_date} is posted in this fictional QA case. Reference ${'QA-CREDIT-'+id.slice(-6).toUpperCase()}.`:'Thank you. I have a further question about this same order; please reopen and check it.',sentAt:at,sourceMetadata:{synthetic:true,qaEvent:kind}});
   }
   await client.query('INSERT INTO gallabox_private.sidebar_qa_event(id,case_id,kind,body,created_at) VALUES($1,$2,$3,$4,$5)',[eventId,id,kind,body,at]);
   await client.query('COMMIT');return {id:eventId,case_id:id,kind,body,created_at:at};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }));
 // This checker is additional QA evidence enforcement; normal action validation,
 // ownership, stale-version checks and idempotent command handling still run.
 app.use('/api/customer-service',async(req,res,next)=>{
  if(req.method!=='POST'||!/^\/(work-items|requests\/[a-f0-9]{24}\/commands)$/.test(req.path)||req.body.outcomeCode!=='day_credit_applied')return next();
  try{
   await app.get('customerServiceAuth').authenticate(req.headers.authorization);
   let cid=req.body.conversationId;
   if(!cid){const record=(await pool.query("SELECT body FROM gallabox_private.inbox_record WHERE kind='servicerequests' AND id=$1",[req.path.split('/')[2]])).rows[0];cid=record?.body.conversationId;}
   const {practice,events}=await state(cid);
   const rows=(await pool.query("SELECT kind,id,payload,sha256 FROM gallabox_private.inbox_record WHERE kind='servicemessages' AND body->>'conversationId'=$1",[cid])).rows;
   validatePracticeCompletion({input:req.body,practice,events,messages:rows.map(decodeCloudRecord)});next();
  }catch(error){res.status(error.statusCode||503).json({success:false,message:error.statusCode?error.message:'QA evidence could not be verified. Your draft is retained.'});}
 });
 if(!manifest.sidebarSandboxDefault){const topic=REQUEST_TOPIC_TAGS.find(t=>t.label==='Delivery Issues'),detail=topic.includes.find(d=>d.label==='Missed Delivery');manifest.sidebarSandboxDefault=(await createCase(topic.id,detail.id)).conversationId;await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600});}
 const bootstrap=()=>{const entry=tokens.get('head');return `<script>localStorage.setItem('token',${JSON.stringify(entry.token)});localStorage.setItem('user',${JSON.stringify(JSON.stringify(entry.user))});</script>`;};
 app.get(['/','/local-review'],async(req,res)=>{try{const latest=(await pool.query('SELECT id FROM gallabox_private.sidebar_qa_case ORDER BY created_at DESC LIMIT 1')).rows[0]?.id||manifest.sidebarSandboxDefault;res.set('Cache-Control','no-store').type('html').send(`<!doctype html><title>Matter QA playground</title>${bootstrap()}<script>location.replace(${JSON.stringify('/customer-service/chats?period=all&status=open&assignment=all&conversation='+latest)});</script>`);}catch{res.status(503).send('The local QA database is unavailable. Saved practice work is retained.');}});
 app.get('/customer-service/*',async(req,res,next)=>{try{const html=await fs.readFile(path.join(root,'client/build/index.html'),'utf8');res.set('Cache-Control','no-store').type('html').send(html.replace('<head>','<head>'+bootstrap()));}catch(error){next(error);}});
}
