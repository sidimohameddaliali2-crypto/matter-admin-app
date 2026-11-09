import {createHash,randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import {createCloudTransport} from './customerServiceCloudTransport.js';
export const cloudKinds=Object.freeze(['servicerequests','servicerules','servicemessages','serviceconversations','serviceissues','servicereviews','serviceactions','servicecommands','servicestaffprofiles','serviceallocationstates','servicecapturebatches','servicegallaboxsyncs','servicesourcecontacts','servicecustomers','servicecustomerdirectorystates']);
const EJSON=mongoose.mongo.BSON.EJSON;
const hash=value=>createHash('sha256').update(value).digest('hex');
// E literals escape both SQL delimiters and backslashes, independently of
// standard_conforming_strings. A constant lets Postgres use partial indexes;
// convert_from(hex) is STABLE and forced full archive scans on access checks.
export const cloudSqlText=value=>{const text=String(value);if(text.includes('\0'))throw Error('SQL text cannot contain NUL');return "E'"+text.replace(/\\/g,'\\\\').replace(/'/g,"''")+"'";};
export function encodeCloudRecord(kind,doc){
 if(!cloudKinds.includes(kind)||!doc?._id)throw Error('Invalid cloud record kind or ID');
 const payload=EJSON.stringify(doc,{relaxed:false});return {kind,id:String(doc._id),body:JSON.parse(JSON.stringify(doc)),payload,sha256:hash(payload)};
}
export function decodeCloudRecord(row){if(!cloudKinds.includes(row.kind)||hash(row.payload)!==row.sha256)throw Error('Cloud record integrity failure');const doc=EJSON.parse(row.payload);if(String(doc._id)!==row.id)throw Error('Cloud record identity mismatch');return doc;}
export function createCloudStore({env,transport=createCloudTransport(env)}){
 const query=async(sql,{write=false,maxBytes=16*1024*1024,timeoutMs=60000}={})=>{const raw=await transport({env,sql,readOnly:!write,transactionScoped:true,maxBytes,timeoutMs});return raw.trim()?JSON.parse(raw):null;};
 return {
  query,
  transaction:operation=>transport.transaction(operation),
  close:()=>transport.close?.(),
  async head(){return query(`SELECT row_to_json(h) FROM gallabox_private.inbox_head h WHERE singleton;`);},
  async stage(runId,rows){
   if(!rows.length)return;for(const row of rows)decodeCloudRecord(row);
   if(transport.stageRecords)return transport.stageRecords(runId,rows);
   const field=value=>String(value).replace(/\\/g,'\\\\').replace(/\t/g,'\\t').replace(/\n/g,'\\n').replace(/\r/g,'\\r');
   const lines=rows.map(r=>[runId,r.kind,r.id,JSON.stringify(r.body),r.payload,r.sha256].map(field).join('\t')).join('\n');
   await query('BEGIN READ WRITE;\nCOPY gallabox_private.inbox_staging(run_id,kind,id,body,payload,sha256) FROM STDIN;\n'+lines+'\n\\.\nCOMMIT;\n',{write:true});
  },
  async commit({runId,origin,expectedRevision,capturedAt,count,checkpointKey}){
   if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Number.isSafeInteger(count)||count<0)throw Error('Invalid cloud commit');
   const run=cloudSqlText(runId),source=cloudSqlText(origin),at=cloudSqlText(new Date(capturedAt).toISOString());
   return query(`BEGIN READ WRITE;
SET LOCAL statement_timeout=90000;
DO $commit$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('gallabox_private.inbox'));
 IF EXISTS(SELECT 1 FROM gallabox_private.inbox_commit WHERE run_id=${run}) THEN RETURN; END IF;
 INSERT INTO gallabox_private.inbox_head(singleton,origin) VALUES(true,${source}) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM gallabox_private.inbox_head WHERE singleton AND origin=${source} AND revision=${expectedRevision}) THEN RAISE EXCEPTION 'Cloud revision/origin conflict'; END IF;
 IF (SELECT count(*) FROM gallabox_private.inbox_staging WHERE run_id=${run}) <> ${count} THEN RAISE EXCEPTION 'Incomplete staged commit'; END IF;
 INSERT INTO gallabox_private.inbox_record_history(kind,id,revision,payload,sha256)
 SELECT old.kind,old.id,old.revision,old.payload,old.sha256 FROM gallabox_private.inbox_record old JOIN gallabox_private.inbox_staging next USING(kind,id) WHERE next.run_id=${run} AND old.sha256<>next.sha256 AND old.kind IN ('servicemessages','serviceconversations','serviceissues','servicereviews','serviceactions','servicecommands','servicestaffprofiles');
 INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision)
 SELECT kind,id,body,payload,sha256,${expectedRevision+1} FROM gallabox_private.inbox_staging WHERE run_id=${run}
 ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,payload=excluded.payload,sha256=excluded.sha256,revision=excluded.revision WHERE inbox_record.sha256<>excluded.sha256;
 UPDATE gallabox_private.inbox_head SET revision=${expectedRevision+1},captured_at=${at}::timestamptz,committed_at=now() WHERE singleton;
 INSERT INTO gallabox_private.inbox_commit(run_id,revision,records,captured_at) VALUES(${run},${expectedRevision+1},${count},${at}::timestamptz);
 ${checkpointKey?`INSERT INTO gallabox_private.client_checkpoint(id,published_at) VALUES(${cloudSqlText(checkpointKey)},${at}::timestamptz) ON CONFLICT(id) DO UPDATE SET published_at=excluded.published_at;`:''}
 DELETE FROM gallabox_private.inbox_staging WHERE run_id=${run};
END $commit$;
COMMIT;
SELECT row_to_json(c) FROM gallabox_private.inbox_commit c WHERE run_id=${run};`,{write:true,timeoutMs:120000});
  },
  async record(kind,id){if(!cloudKinds.includes(kind))throw Error('Invalid collection');return query(`SELECT body FROM gallabox_private.inbox_record WHERE kind=${cloudSqlText(kind)} AND id=${cloudSqlText(id)};`);},
  async archivePage(kind,after='',size=500){if(!cloudKinds.includes(kind)||!Number.isInteger(size)||size<1||size>1000)throw Error('Invalid archive page');return await query(`SELECT COALESCE(json_agg(r),'[]'::json) FROM (SELECT kind,id,payload,sha256 FROM gallabox_private.inbox_record WHERE kind=${cloudSqlText(kind)} AND id>${cloudSqlText(after)} ORDER BY id LIMIT ${size}) r;`)||[];},
 };
}
// Mongo is the existing transactional worker cache. Supabase is the durable
// published store; no success is reported by callers until publication succeeds.
export function createCloudPublisher({db,store,origin,intervalMs=2000,onError=()=>{},kinds=cloudKinds,concurrent=false,checkpointKey=null}){
 if(concurrent&&kinds.some(k=>['servicemessages','serviceconversations','servicecapturebatches','servicegallaboxsyncs','servicesourcecontacts'].includes(k)))throw Error('Concurrent publication cannot own source records');
 let inFlight=null,timer,stopped=false,watermark=null,revision=null,pendingCommit=null,pendingHashes=null;const publishedHashes=new Map();
 const acknowledge=()=>{for(const [key,value] of pendingHashes||[])publishedHashes.set(key,value);pendingHashes=null;};
 async function publish({full=false}={}){
  if(pendingCommit){if(concurrent)pendingCommit.expectedRevision=Number((await store.head()).revision);const receipt=await store.commit(pendingCommit);revision=Number(receipt.revision);watermark=new Date(pendingCommit.capturedAt);acknowledge();pendingCommit=null;}
  const head=await store.head();if(head&&head.origin!==origin)throw Error('Cloud origin does not match this worker');
  if(!concurrent&&revision!==null&&Number(head?.revision||0)!==revision)throw Error('Cloud revision changed outside this worker; restore before writing');
  revision=Number(head?.revision||0);
  const checkpoint=checkpointKey&&!watermark?await store.query(`SELECT published_at FROM gallabox_private.client_checkpoint WHERE id=${cloudSqlText(checkpointKey)};`):null;
  const from=full?null:watermark||(checkpointKey?(checkpoint?new Date(checkpoint):null):(head?.captured_at?new Date(head.captured_at):null)),capturedAt=new Date(),runId=randomUUID();let count=0;const nextHashes=new Map();
  const session=db.client.startSession({snapshot:true});
  try{
   for(const kind of kinds){let batch=[];
    const filter=from&&kind!=='servicecustomerdirectorystates'?{$or:[{updatedAt:{$gte:new Date(from.getTime()-10000)}},{updatedAt:{$exists:false}}]}:{};
    for await(const doc of db.collection(kind).find(filter,{session}).sort(from?{updatedAt:1,_id:1}:{_id:1})){
     const row=encodeCloudRecord(kind,doc),key=kind+':'+row.id;if(publishedHashes.get(key)===row.sha256)continue;nextHashes.set(key,row.sha256);batch.push(row);if(batch.length===5000){await store.stage(runId,batch);count+=batch.length;batch=[];}
    }
    if(batch.length){await store.stage(runId,batch);count+=batch.length;}
   }
  }finally{await session.endSession();}
  if(!count&&head){watermark=capturedAt;return {revision,records:0};}
  pendingHashes=nextHashes;pendingCommit={runId,origin,expectedRevision:revision,capturedAt,count,...(checkpointKey?{checkpointKey}:{})};
  const receipt=await store.commit(pendingCommit);acknowledge();pendingCommit=null;
  revision=Number(receipt.revision);watermark=capturedAt;return receipt;
 }
 return {
  flush(options){const pending=(inFlight||Promise.resolve()).catch(()=>{}).then(()=>publish(options));inFlight=pending;pending.finally(()=>{if(inFlight===pending)inFlight=null;}).catch(()=>{});return pending;},
  start(){stopped=false;const tick=async()=>{try{await this.flush();}catch(e){onError(e);}finally{if(!stopped)timer=setTimeout(tick,intervalMs);}};timer=setTimeout(tick,intervalMs);},
  async stop(){stopped=true;clearTimeout(timer);await inFlight;},
 };
}
let runtime=null;
export function configureCloudInbox(value){runtime=value;}
export const cloudInbox=()=>runtime;
export async function publishCloudInbox(){if(runtime)await runtime.publisher.flush();}

// Recovery target must be an empty service cache. No existing cache is replaced.
export async function restoreCloudCache({db,store}){
 for(const kind of cloudKinds)if(await db.collection(kind).countDocuments({},{limit:1}))throw Error('Recovery requires an empty service cache');
 const before=await store.head();if(!before)throw Error('Cloud inbox has not been published');
 const counts={};
 for(const kind of cloudKinds){let after='',count=0;
  while(true){const rows=await store.archivePage(kind,after);if(!rows.length)break;const docs=rows.map(decodeCloudRecord);await db.collection(kind).insertMany(docs,{ordered:true});count+=docs.length;after=rows.at(-1).id;}
  counts[kind]=count;
 }
 const after=await store.head();if(after.revision!==before.revision)throw Error('Cloud changed during recovery; retry into a fresh cache');
 return {revision:before.revision,counts};
}
