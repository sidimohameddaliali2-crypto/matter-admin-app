import fs from 'node:fs/promises';
import path from 'node:path';
import {protectService} from './customerServiceStaffAuth.js';
import {cloudSqlText as lit} from './customerServiceCloudStore.js';
export async function canonicalArrival(store,scope,messageId){
 const rows=await store.query(`SELECT COALESCE(jsonb_agg(x),'[]') FROM (SELECT r.body->>'sentAt' AS provider_at,r.body->>'type' AS type,r.body->>'authorType' AS author_type,(SELECT min(first_captured_at) FROM gallabox_private.provider_message pm WHERE pm.scope=${lit(scope)} AND pm.external_id=${lit(messageId)}) AS captured_at FROM gallabox_private.inbox_record r WHERE r.kind='servicemessages' AND r.body->>'source'='gallabox' AND r.body->>'scope'=${lit(scope)} AND r.body->>'externalMessageId'=${lit(messageId)}) x;`);
 return rows.length===1&&rows[0].author_type==='customer'?rows[0]:null;
}
export function installArrivalObservations(app,{directory,store}){
 if(!directory)return;
 let reserved=0;const accepted=new Set(),pending=new Set();
 app.post('/api/customer-service/arrival-observations',protectService,async(req,res)=>{
  const v=req.body;
  if(!v||v.version!==1||typeof v.messageId!=='string'||v.messageId.length>256||typeof v.scope!=='string'||v.scope.length>256||![v.visibleAt,v.observationStartedAt].every(x=>typeof x==='string'&&Number.isFinite(Date.parse(x))))return res.sendStatus(400);
  const key=JSON.stringify([String(req.user._id),v.scope,v.messageId,v.observationStartedAt]);
  if(accepted.has(key))return res.sendStatus(204);
  if(pending.has(key))return res.sendStatus(503);
  if(reserved>=1000)return res.sendStatus(429);
  reserved++;pending.add(key);let saved=false;
  try{
   const source=await canonicalArrival(store,v.scope,v.messageId),visible=Date.parse(v.visibleAt),started=Date.parse(v.observationStartedAt),received=Date.now();
   if(!source)return res.sendStatus(422);
   const captured=Date.parse(source.captured_at),provider=Date.parse(source.provider_at);
   if(!Number.isFinite(captured)||!Number.isFinite(provider)||captured<started||visible<started||visible>received+60000||received-visible>900000)return res.sendStatus(422);
   const record={version:2,messageId:v.messageId,scope:v.scope,providerAt:source.provider_at,capturedAt:source.captured_at,visibleAt:v.visibleAt,observationStartedAt:v.observationStartedAt,captureDelayMs:captured-provider,captureToVisibleMs:visible-captured,totalDelayMs:visible-provider,type:source.type,receivedAt:new Date(received).toISOString(),actorId:String(req.user._id),evidence:'Authenticated browser viewport observation correlated with canonical provider ID and database capture timestamp; browser/provider clock skew uncorrected'};
   await fs.mkdir(directory,{recursive:true,mode:0o700});
   await fs.appendFile(path.join(directory,'arrival-observations.private.jsonl'),JSON.stringify(record)+'\n',{mode:0o600});
   accepted.add(key);saved=true;res.sendStatus(204);
  }catch{res.sendStatus(503);}finally{pending.delete(key);if(!saved)reserved--;}
 });
}
