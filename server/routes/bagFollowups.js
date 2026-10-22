import express from 'express';
import mongoose from 'mongoose';
import {protect} from '../middleware/auth.js';
import User,{effectivePermissions} from '../models/User.js';
import Bag from '../models/Bag.js';
import BagFollowup from '../models/BagFollowup.js';
import BagRefundCase from '../models/BagRefundCase.js';
import {customerBagBalances,bagAccountabilityReport} from '../services/bagFollowupPolicy.js';
import {staffName} from '../services/bagOperationsService.js';
const router=express.Router(),roles=new Set(['admin','super_admin','manager','store_keeper']);
router.use(protect,(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(!roles.has(req.user.role)||!effectivePermissions(req.user).bags)return res.status(403).json({success:false,message:'Warehouse or management bag access required.'});
  next();
});
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const error=(res,e)=>res.status(e.code===11000?409:e.statusCode||500).json({success:false,message:e.code===11000?'A follow-up was already created. Refresh before retrying.':e.statusCode?e.message:'Unable to update bag follow-ups. Refresh and retry.'});
const readBags=()=>Bag.collection.find({},{projection:{bagId:1,lifecycleState:1,location:1,quantity:1,verifiedAt:1,assignedTo:1,currentDelivery:1,history:1}}).toArray();
const readUsers=()=>User.find({}).select('profile name role isActive permissions permissionsConfigured').lean();
router.get('/',async(req,res)=>{
  try{
    const [bags,followups,users,refunds]=await Promise.all([readBags(),BagFollowup.find({}).lean(),readUsers(),BagRefundCase.find({status:{$in:['review','approved']}}).select('status amountMinor').lean()]);
    const rows=customerBagBalances(bags,followups,users);
    res.json({success:true,data:{rows:rows.filter(r=>r.outstanding||r.collected||r.followup),report:bagAccountabilityReport(rows,bags,refunds,users),owners:users.filter(u=>u.isActive&&roles.has(u.role)&&effectivePermissions(u).bags).map(u=>({_id:String(u._id),name:staffName(u)}))}});
  }catch(e){error(res,e);}
});
router.post('/',async(req,res)=>{
  const {customerId,cycleKey,version,eventId,ownerId,status,nextDueAt,note,contactChannel,confirmedContact}=req.body||{};
  try{
    const due=nextDueAt?new Date(nextDueAt):null;
    if(typeof customerId!=='string'||!customerId||customerId.length>160||typeof cycleKey!=='string'||!/^[a-f0-9]{64}$/.test(cycleKey)||!Number.isInteger(version)||version<0||typeof eventId!=='string'||!/^[a-zA-Z0-9:_-]{8,180}$/.test(eventId)||!['open','contacted','awaiting_collection','escalated'].includes(status)||typeof note!=='string'||!note.trim()||note.length>2000||(ownerId&&!mongoose.isValidObjectId(ownerId)))throw fail('Provide customer, current version, owner, follow-up state and evidence notes.',400);
    if(!due||!Number.isFinite(due.getTime()))throw fail('Choose the next internal reminder date and time.',400);
    if(contactChannel&&!['phone','whatsapp','email'].includes(contactChannel))throw fail('Invalid contact channel.',400);
    if((contactChannel&&confirmedContact!==true)||(status==='contacted'&&!contactChannel))throw fail('Confirm actual customer contact and its channel before recording it.',400);
    const prior=await BagFollowup.findOne({customerId}).lean();
    const duplicate=prior?.history.find(h=>h.eventId===eventId);
    if(duplicate){if(String(duplicate.actor)!==String(req.user._id))throw fail('Request ID was used by another operator.');return res.json({success:true,data:prior,duplicate:true});}
    if((prior?.version||0)!==version)throw fail('Another operator changed this follow-up. Refresh first.');
    const bags=await readBags();const row=customerBagBalances(bags,prior?[prior]:[]).find(r=>r.customerId===customerId);
    if(!row?.outstanding)throw fail('No outstanding customer bags remain. The reminder is resolved by physical returns.');
    if(row.cycleKey!==cycleKey)throw fail('Bag custody changed. Refresh the outstanding bag list first.');
    if(ownerId){const owner=await User.findById(ownerId).select('role isActive permissions permissionsConfigured');if(!owner?.isActive||!roles.has(owner.role)||!effectivePermissions(owner).bags)throw fail('Choose an active bag operations owner.',400);}
    const now=new Date(),values={customerId,customerName:row.customerName,cycleKey,owner:ownerId||null,status,nextDueAt:due,note:note.trim(),lastContactAt:contactChannel?now:prior?.cycleKey===cycleKey?prior.lastContactAt||null:null};
    const entry={eventId,cycleKey,action:contactChannel?'contact_logged':'followup_updated',status,note:note.trim(),owner:ownerId||null,nextDueAt:due,channel:contactChannel||'',actor:req.user._id,actorName:staffName(req.user),timestamp:now,bagIds:row.outstandingBagIds};
    let data;
    if(!prior)data=await BagFollowup.create({...values,version:1,history:[entry]});
    else data=await BagFollowup.findOneAndUpdate({_id:prior._id,version},{$set:values,$inc:{version:1},$push:{history:entry}},{new:true,runValidators:true});
    if(!data){const current=await BagFollowup.findOne({customerId}).lean();if(current?.history.some(h=>h.eventId===eventId&&String(h.actor)===String(req.user._id)))return res.json({success:true,data:current,duplicate:true});throw fail('Concurrent follow-up update. Refresh before retrying.');}
    res.json({success:true,data,message:'Internal reminder saved. No message was sent to the customer.'});
  }catch(e){error(res,e);}
});
export default router;
