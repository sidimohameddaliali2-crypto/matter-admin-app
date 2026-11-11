import {createHash,randomUUID} from 'node:crypto';
import {EJSON,ObjectId} from 'bson';
import {listGallaboxConversations,readGallaboxMessagePage} from './customerServiceGallabox.js';
import {normalizeServiceMessage} from './customerServiceCaptureFormat.js';
const schema='gallabox_private';
const hash=x=>createHash('sha256').update(x).digest('hex');
const stableId=(kind,...parts)=>new ObjectId(hash(JSON.stringify([kind,...parts])).slice(0,24));
const encode=(kind,doc)=>{const payload=EJSON.stringify(doc,{relaxed:false});return {kind,id:String(doc._id),body:JSON.parse(JSON.stringify(doc)),payload,sha256:hash(payload)};};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createHostedCapture({db,envs,fetchImpl=fetch,clock=()=>new Date()}){
 const metrics={providerReads:0,inserted:0,duplicates:0,pages:0};
 const providerFetch=async(url,options)=>{if(options?.method!=='GET')throw Error('Provider writes are prohibited');metrics.providerReads++;return fetchImpl(url,options);};
 const record=async(tx,kind,where,params)=>{const rows=await tx(`SELECT payload FROM ${schema}.inbox_record WHERE kind=$1 AND ${where} LIMIT 1`,[kind,...params]);return rows[0]?EJSON.parse(rows[0].payload):null;};
 async function write(fn){return db.transaction(async tx=>{
  await tx("SELECT set_config('gallabox.capture_writer','hosted',true)");
  await tx("SELECT pg_advisory_xact_lock(hashtext('gallabox_private.inbox'))");
  const [control]=await tx(`SELECT enabled,writer_mode FROM ${schema}.worker_control WHERE singleton`);
  if(!control?.enabled||control.writer_mode!=='cloud')throw Error('Cloud capture is disabled');
  const [head]=await tx(`SELECT revision FROM ${schema}.inbox_head WHERE singleton FOR UPDATE`);if(!head)throw Error('Verified archive required');
  let revision=Number(head.revision);const now=clock();let changed=0;
  const put=async(kind,doc)=>{
   const r=encode(kind,doc),old=await tx(`SELECT sha256 FROM ${schema}.inbox_record WHERE kind=$1 AND id=$2`,[kind,r.id]);
   if(old[0]?.sha256===r.sha256)return;revision++;
   await tx(`INSERT INTO ${schema}.inbox_record_history(kind,id,revision,payload,sha256) SELECT kind,id,revision,payload,sha256 FROM ${schema}.inbox_record WHERE kind=$1 AND id=$2`,[kind,r.id]);
   await tx(`INSERT INTO ${schema}.inbox_record(kind,id,body,payload,sha256,revision) VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,payload=excluded.payload,sha256=excluded.sha256,revision=excluded.revision`,[kind,r.id,JSON.stringify(r.body),r.payload,r.sha256,revision]);changed++;
  };
  const result=await fn({tx,put,now});
  if(changed){await tx(`UPDATE ${schema}.inbox_head SET revision=$1,captured_at=$2,committed_at=now() WHERE singleton`,[revision,now]);await tx(`INSERT INTO ${schema}.inbox_commit(run_id,revision,records,captured_at) VALUES($1,$2,$3,$4)`,['hosted:'+randomUUID(),revision,changed,now]);}
  return result;
 });}
 async function conversation(tx,scope,externalId,name,contactId){
  const old=await record(tx,'serviceconversations',"body->>'source'='gallabox' AND body->>'scope'=$2 AND body->>'externalConversationId'=$3",[scope,externalId]);
  if(old){if(old.sourceMetadata?.externalContactId&&old.sourceMetadata.externalContactId!==contactId)throw Error('Native conversation contact conflict');return old;}
  const contact=await record(tx,'servicesourcecontacts',"body->>'scope'=$2 AND body->>'externalContactId'=$3",[scope,contactId]);
  return {_id:stableId('conversation',scope,externalId),source:'gallabox',scope,externalConversationId:externalId,customerName:name||'',customerId:contact?.matchState==='matched'?contact.customerId:null,sourceRevision:1,coverageStatus:'partial',sourceMetadata:{externalContactId:contactId},createdAt:clock(),updatedAt:clock()};
 }
 async function discover(env){
  const scope=`${env.CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID}:${env.CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID}`;
  const {conversations}=await listGallaboxConversations({env,fetchImpl:providerFetch,includeOpen:true});
  await write(async({tx,put,now})=>{
   const current=new Map();for(const c of [...conversations].sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0)))if(!current.has(c.contactId))current.set(c.contactId,c);
   for(const c of current.values()){
    const anchor=await conversation(tx,scope,c.id,c.name,c.contactId);
    const related=await tx(`SELECT payload FROM ${schema}.inbox_record WHERE kind='serviceconversations' AND body->>'source'='gallabox' AND body->>'scope'=$1 AND body#>>'{sourceMetadata,externalContactId}'=$2`,[scope,c.contactId]);
    const docs=new Map(related.map(r=>{const d=EJSON.parse(r.payload);return[String(d._id),d]}));docs.set(String(anchor._id),anchor);
    for(const d of docs.values()){
     const old=d.sourceMetadata?.providerInbox,{observedAt,...state}=old||{};
     if(!same(state,c.providerInbox)){d.sourceMetadata={...d.sourceMetadata,providerInbox:{...c.providerInbox,observedAt:now.toISOString()}};d.updatedAt=now;await put('serviceconversations',d);}
    }
    for(const lane of ['live','history'])await tx(`INSERT INTO ${schema}.worker_job(scope,contact_id,lane,conversation,provider_updated_at) VALUES($1,$2,$3,$4::jsonb,$5)
    ON CONFLICT(scope,contact_id,lane) DO UPDATE SET conversation=excluded.conversation,
     pending=CASE WHEN worker_job.provider_updated_at IS DISTINCT FROM excluded.provider_updated_at OR (NOT worker_job.pending AND worker_job.last_success_at<now()-interval '30 minutes') THEN true ELSE worker_job.pending END,
     page=CASE WHEN $3='live' AND worker_job.provider_updated_at IS DISTINCT FROM excluded.provider_updated_at OR NOT worker_job.pending AND (worker_job.provider_updated_at IS DISTINCT FROM excluded.provider_updated_at OR worker_job.last_success_at<now()-interval '30 minutes') THEN 1 ELSE worker_job.page END,
     page_hashes=CASE WHEN $3='live' AND worker_job.provider_updated_at IS DISTINCT FROM excluded.provider_updated_at OR NOT worker_job.pending AND (worker_job.provider_updated_at IS DISTINCT FROM excluded.provider_updated_at OR worker_job.last_success_at<now()-interval '30 minutes') THEN '[]'::jsonb ELSE worker_job.page_hashes END,
     provider_updated_at=excluded.provider_updated_at`,[scope,c.contactId,lane,JSON.stringify({...c,allContactConversations:true}),c.updatedAt]);
   }
   await tx(`UPDATE ${schema}.worker_scope SET last_discovery_at=$2,next_discovery_at=$2::timestamptz+interval '30 seconds',error=NULL,recent_count=$3,open_count=$4 WHERE scope=$1`,[scope,now,conversations.length,conversations.filter(c=>c.providerInbox.status==='open').length]);
  });
 }
 async function captureJob(job,env){
  const page=await readGallaboxMessagePage({conversation:{...job.conversation,allContactConversations:true},page:job.page,pageSize:job.page_size,env,fetchImpl:providerFetch});
  const pageHash=hash(JSON.stringify([...page.ids].sort()));if(!page.exhausted&&job.page_hashes.includes(pageHash))throw Error('Provider repeated a history page');
  const normalized=page.messages.map(m=>normalizeServiceMessage(m,{source:page.source,scope:page.scope}));
  let inserted=0,duplicates=0;
  await write(async({tx,put,now})=>{
   if(page.staffDirectory?.length){
    const account=page.scope.split(':')[0],ids=page.staffDirectory.map(u=>u.id);
    for(const u of page.staffDirectory){if(typeof u.name!=='string'||!u.name.trim())continue;await tx(`INSERT INTO ${schema}.staff_directory(id,account_id,provider_id,display_name,email,active,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,provider_id) DO UPDATE SET display_name=excluded.display_name,email=excluded.email,active=excluded.active,observed_at=excluded.observed_at`,[hash('gallabox-staff:'+account+':'+u.id).slice(0,24),account,u.id,u.name,u.email||null,u.active,now]);}
    await tx(`UPDATE ${schema}.staff_directory SET active=false,observed_at=$3 WHERE account_id=$1 AND NOT(provider_id=ANY($2::text[]))`,[account,ids,now]);
   }
   const touched=new Map();
   for(const raw of page.rawMessages||page.messages){
    await tx(`INSERT INTO ${schema}.provider_message(scope,external_id,sha256,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,[page.scope,raw.id||raw.externalMessageId,hash(JSON.stringify(raw)),JSON.stringify(raw)]);
   }
   for(let i=0;i<normalized.length;i++){
    const m=normalized[i];
    const old=await record(tx,'servicemessages',"body->>'source'='gallabox' AND body->>'scope'=$2 AND body->>'externalMessageId'=$3",[page.scope,m.externalMessageId]);
    const c=await conversation(tx,page.scope,m.externalConversationId,m.customerName,m.sourceMetadata?.externalContactId);
    if(old){
     // Retain saved author display names when a provider profile is renamed.
     const fields=['externalConversationId','externalAuthorId','authorType','text','type'];
     if(fields.some(k=>(old[k]||'')!==(m[k]||''))||+new Date(old.sentAt)!==+m.sentAt||String(old.conversationId)!==String(c._id))throw Error('Saved message conflicts with provider evidence');
     const enriched={...old.sourceMetadata,...m.sourceMetadata};
     if(!same(enriched,old.sourceMetadata)){old.sourceMetadata=enriched;old.updatedAt=now;await put('servicemessages',old);}
     duplicates++;continue;
    }
    const authors=await tx(`SELECT body->>'userId' AS id FROM ${schema}.inbox_record WHERE kind='servicestaffprofiles' AND body->'externalAuthorIds' ? $1`,[`${page.source}:${page.scope}:${m.externalAuthorId}`]);
    const doc={...m,sourceMetadata:{...m.sourceMetadata,capture:{lane:job.lane,capturedAt:now.toISOString(),worker:'supabase'}},_id:stableId('message',page.scope,m.externalMessageId),conversationId:c._id,authorId:authors.length===1?new ObjectId(authors[0].id):null,createdAt:now,updatedAt:now,importId:'hosted'};
    delete doc.customerId;delete doc.customerName;await put('servicemessages',doc);inserted++;
    c.lastMessageAt=new Date(Math.max(+new Date(c.lastMessageAt||0),+m.sentAt));c.coverageFrom=c.coverageFrom?new Date(Math.min(+new Date(c.coverageFrom),+m.sentAt)):m.sentAt;c.coverageTo=c.lastMessageAt;c.sourceRevision=(c.sourceRevision||1)+1;c.updatedAt=now;
    await put('serviceconversations',c);touched.set(String(c._id),c);
   }
   // Existing human reviews and classifications are immutable to capture. A
   // separate source revision exposes stale evidence without deleting judgments.
   for(const c of touched.values()){
    const issue=await record(tx,'serviceissues',"body->>'conversationId'=$2",[String(c._id)]);
    if(issue){
     const sourceStaff=await tx(`SELECT payload FROM ${schema}.inbox_record WHERE kind='servicemessages' AND body->>'conversationId'=$1 AND body->>'authorType'='staff' AND COALESCE(body->>'internalNote','false')<>'true' AND COALESCE(body#>>'{sourceMetadata,nativeContent,kind}','')<>'reaction'`,[String(c._id)]);
     const allStaff=sourceStaff.map(r=>EJSON.parse(r.payload));
     const siblings=await tx(`SELECT payload FROM ${schema}.inbox_record WHERE kind='serviceissues' AND body->>'conversationId'=$1`,[String(c._id)]);
     for(const row of siblings){const saved=EJSON.parse(row.payload);const bounded=saved.episodeKey!=='primary'&&saved.episodeFrom&&saved.episodeTo;const staff=bounded?allStaff.filter(m=>m.sentAt>=saved.episodeFrom&&m.sentAt<=saved.episodeTo):allStaff;
      saved.sourceRevision=c.sourceRevision;saved.contributorIds=[...new Set(staff.map(m=>String(m.authorId||'')).filter(Boolean))].map(id=>new ObjectId(id));saved.sourceMetadata={...saved.sourceMetadata,unmappedStaff:staff.some(m=>!m.authorId)};saved.updatedAt=now;await put('serviceissues',saved);
      const reviews=await tx(`SELECT payload FROM ${schema}.inbox_record WHERE kind='servicereviews' AND body->>'issueId'=$1`,[String(saved._id)]);
      for(const row of reviews){const review=EJSON.parse(row.payload);if(review.sourceRevision!==c.sourceRevision){review.stale=true;review.updatedAt=now;await put('servicereviews',review);}}
     }
    }
    if(!issue){
     const staff=await tx(`SELECT body FROM ${schema}.inbox_record WHERE kind='servicemessages' AND body->>'conversationId'=$1 AND body->>'authorType'='staff' AND COALESCE(body->>'internalNote','false')<>'true' AND COALESCE(body#>>'{sourceMetadata,nativeContent,kind}','')<>'reaction'`,[String(c._id)]);
     const contributorIds=[...new Set(staff.map(r=>r.body.authorId).filter(Boolean))].map(id=>new ObjectId(id));
     const id=stableId('issue',String(c._id));await put('serviceissues',{_id:id,conversationId:c._id,episodeKey:'primary',customerId:c.customerId,customerName:c.customerName,categoryIds:[],summary:'',outcome:'unknown',sourceRevision:c.sourceRevision,version:1,contributorIds,sourceMetadata:{unmappedStaff:staff.some(r=>!r.body.authorId)},evidenceMessageIds:[],boundaryState:'needs_review',evidenceState:'partial',priority:'normal',createdAt:now,updatedAt:now});
     await put('servicereviews',{_id:stableId('review',String(id)),issueId:id,sampleKey:'primary',sampleType:'baseline',reviewerId:null,status:'pending',sourceRevision:c.sourceRevision,version:1,stale:false,draft:{},revisions:[],assignmentHistory:[],skippedBy:[],excludedReviewerIds:[],correctionRequests:[],createdAt:now,updatedAt:now});
    }
   }
   const done=page.exhausted||(job.lane==='live'&&normalized.length>0&&inserted===0);
   await tx(`UPDATE ${schema}.worker_job SET page=$4,pending=$5,page_hashes=$6::jsonb,last_success_at=$7,retry_at=$7,failures=0,error=NULL WHERE scope=$1 AND contact_id=$2 AND lane=$3`,[job.scope,job.contact_id,job.lane,done?job.page:job.page+1,!done,JSON.stringify([...job.page_hashes,pageHash]),now]);
  });metrics.inserted+=inserted;metrics.duplicates+=duplicates;metrics.pages++;
 }
 return {async run({budgetMs=35000}={}){
  const started=clock(),id=randomUUID();Object.assign(metrics,{providerReads:0,inserted:0,duplicates:0,pages:0});
  const lease=await db.query(`UPDATE ${schema}.worker_control SET lease_token=$1,lease_until=now()+interval '100 seconds',last_started_at=now() WHERE singleton AND enabled AND writer_mode='cloud' AND (lease_until IS NULL OR lease_until<now()) RETURNING singleton`,[id]);
  if(!lease.length)return {skipped:true};
  await db.query(`INSERT INTO ${schema}.worker_run(id,outcome) VALUES($1,'running')`,[id]);let failure=null;
  try{
   for(const env of envs){
    const scope=`${env.CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID}:${env.CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID}`;
    const [state]=await db.query(`SELECT * FROM ${schema}.worker_scope WHERE scope=$1`,[scope]);
    if(state&&new Date(state.next_discovery_at)<=clock())try{await discover(env);}catch{failure='Discovery failed; checkpoint retained';await db.query(`UPDATE ${schema}.worker_scope SET error=$2,next_discovery_at=now()+interval '1 minute' WHERE scope=$1`,[scope,failure]);}
   }
   // Live lanes precede historical work, bounded per invocation.
   for(let slot=0;slot<12;slot++){
    const lane=slot<4?'live':'history';
    if(+clock()-+started>budgetMs)break;
    const [job]=await db.query(`SELECT * FROM ${schema}.worker_job WHERE pending AND lane=$1 AND retry_at<=now() ORDER BY CASE WHEN lane='live' THEN provider_updated_at END DESC NULLS LAST,last_success_at NULLS FIRST,retry_at LIMIT 1`,[lane]);if(!job)continue;
    const env=envs.find(e=>`${e.CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID}:${e.CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID}`===job.scope);if(!env)throw Error('Unauthorized worker scope');
    try{await captureJob(job,env);}catch{failure='Capture page failed; checkpoint retained';await db.query(`UPDATE ${schema}.worker_job SET failures=failures+1,error=$4,retry_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(failures,7)))::int) WHERE scope=$1 AND contact_id=$2 AND lane=$3`,[job.scope,job.contact_id,job.lane,failure]);}
   }
  }catch{failure='Capture interrupted; durable checkpoints retained';}
  const duration=+clock()-+started;
  await db.query(`UPDATE ${schema}.worker_run SET completed_at=now(),outcome=$2,provider_reads=$3,inserted=$4,duplicates=$5,pages=$6,duration_ms=$7,error=$8 WHERE id=$1`,[id,failure?'partial':'success',metrics.providerReads,metrics.inserted,metrics.duplicates,metrics.pages,duration,failure]);
  await db.query(`UPDATE ${schema}.worker_control SET lease_token=NULL,lease_until=NULL,last_success_at=CASE WHEN $2::text IS NULL THEN now() ELSE last_success_at END,last_error=$2,runs=runs+1,provider_reads=provider_reads+$3,inserted_messages=inserted_messages+$4 WHERE singleton AND lease_token=$1`,[id,failure,metrics.providerReads,metrics.inserted]);
  return {id,...metrics,durationMs:duration,error:failure};
 }};
}
