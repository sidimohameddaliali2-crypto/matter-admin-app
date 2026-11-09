import {cloudInbox} from '../services/customerServiceCloudStore.js';
import {getGallaboxSyncStatus} from '../services/customerServiceGallaboxSync.js';
import express from 'express';
import {protectService as protect} from '../services/customerServiceStaffAuth.js';
import {requireServiceAccess} from '../middleware/serviceAccess.js';
import {checkGallaboxConnection,listGallaboxConversations,readGallaboxConversation} from '../services/customerServiceGallabox.js';
import {ingestServiceBatch} from '../services/customerServiceCapture.js';
import ServiceCaptureBatch from '../models/ServiceCaptureBatch.js';
import ServiceMessage from '../models/ServiceMessage.js';
export function createGallaboxRouter({env=process.env,fetchImpl=fetch}={}){
 const router=express.Router();const provider={env,fetchImpl};
 router.use(protect,requireServiceAccess);
 router.use((req,res,next)=>{res.set('Cache-Control','no-store');return req.serviceCapabilities.supervise?next():res.status(403).json({success:false,message:'Supervisor access required'});});
 const endpoint=handler=>async(req,res)=>{try{res.json({success:true,data:await handler(req)});}catch(error){res.status(error.statusCode||503).json({success:false,message:error.statusCode?error.message:'Gallabox capture was not confirmed. Reload and retry.'});}};
 router.get('/sync',endpoint(async()=>{
  if(cloudInbox()?.hosted)return cloudInbox().store.query(`SELECT jsonb_build_object('hosted',true,'enabled',c.enabled,'inserted',c.inserted_messages,'lastSuccessAt',c.last_success_at,'error',c.last_error,'pending',(SELECT count(*) FROM gallabox_private.worker_job WHERE pending),'failed',(SELECT count(*) FROM gallabox_private.worker_job WHERE error IS NOT NULL),'historyCompleted',(SELECT count(*) FROM gallabox_private.worker_job WHERE lane='history' AND NOT pending),'historyQueued',(SELECT count(*) FROM gallabox_private.worker_job WHERE lane='history')) FROM gallabox_private.worker_control c WHERE singleton;`);
  return {...await getGallaboxSyncStatus({env}),history:await ServiceCaptureBatch.findOne({source:'gallabox_history',status:'partial'}).select('counts coverage createdAt').sort({createdAt:-1}).lean()};
 }));
 router.post('/check',endpoint(()=>checkGallaboxConnection(provider)));
 router.get('/conversations',endpoint(()=>listGallaboxConversations(provider)));
 router.post('/capture',endpoint(async req=>{
  if(cloudInbox()?.hosted)throw Object.assign(new Error('Automatic capture runs in Supabase.'),{statusCode:409});
  if(typeof req.body?.requestId!=='string'||!/^[a-zA-Z0-9:_-]{8,180}$/.test(req.body.requestId))throw Object.assign(new Error('A stable capture request ID is required.'),{statusCode:400});
  if(typeof req.body?.conversationId!=='string'||req.body.conversationId.length>180)throw Object.assign(new Error('Select a Gallabox conversation.'),{statusCode:400});
  // A lost response must replay its committed receipt, not refetch a moving
  // provider window and reinterpret the original command as new evidence.
  const prior=await ServiceCaptureBatch.findOne({requestId:req.body.requestId}).lean();
  if(prior){
   const account=env.CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID?.trim();
   const channel=env.CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID?.trim();
   const same=account&&prior.source==='gallabox'&&String(prior.createdBy)===String(req.user._id)
    &&(channel?prior.scope===`${account}:${channel}`:prior.scope.startsWith(`${account}:`))
    &&prior.coverage?.conversationIds?.length===1&&prior.coverage.conversationIds[0]===req.body.conversationId;
   if(!same||prior.status!=='completed')throw Object.assign(new Error('Capture request conflicts with saved work. Reload before starting a new capture.'),{statusCode:409});
   return {...prior.counts,duplicate:true,coverage:'partial',message:'Previously saved recent capture confirmed. Full history and media contents remain unverified.'};
  }
  const batch=await readGallaboxConversation({...provider,conversationId:req.body.conversationId});
  if(!batch.messages.length)return {received:0,inserted:0,duplicates:0,coverage:'partial',message:'No messages for this conversation in the returned window. No capture was saved.'};
  // Profile labels are current, not historical message fields. Preserve the
  // captured label when stable sender/message identity matches. The importer
  // still rejects changed text, timestamps, type, conversation or attribution.
  const saved=await ServiceMessage.find({source:batch.source,scope:batch.scope,externalMessageId:{$in:batch.messages.map(m=>m.externalMessageId)}}).lean();
  const byId=new Map(saved.map(m=>[m.externalMessageId,m]));
  for(const message of batch.messages){const original=byId.get(message.externalMessageId);if(original&&original.externalConversationId===message.externalConversationId&&original.externalAuthorId===message.externalAuthorId&&original.authorType===message.authorType)message.authorName=original.authorName;}
  const counts=await ingestServiceBatch({source:batch.source,scope:batch.scope,messages:batch.messages,requestId:req.body.requestId,actor:req.user});
  return {...counts,coverage:batch.coverage,message:batch.message};
 }));
 return router;
}
export default createGallaboxRouter();
