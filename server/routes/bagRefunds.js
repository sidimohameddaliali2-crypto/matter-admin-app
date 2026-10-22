import express from 'express';
import mongoose from 'mongoose';
import {protect} from '../middleware/auth.js';
import {effectivePermissions} from '../models/User.js';
import Bag from '../models/Bag.js';
import Customer from '../models/Customer.js';
import BagRefundCase from '../models/BagRefundCase.js';
import {staffName} from '../services/bagOperationsService.js';
import {BAG_DEPOSIT_MINOR,bagReturnSources,refundCandidates,refundEligibility,requireRefundApproval,refundFault} from '../services/bagRefundPolicy.js';

const router=express.Router();
const managers=new Set(['super_admin','admin','manager']);
const operators=new Set([...managers,'store_keeper']);
router.use(protect,(req,res,next)=>{
  res.set('Cache-Control','no-store');
  // A bags permission alone never gives a driver or dispatcher financial access.
  if(!operators.has(req.user.role)||!effectivePermissions(req.user).bags)return res.status(403).json({success:false,message:'Warehouse or management bag access required.'});
  next();
});
const fail=(res,e)=>res.status(e.statusCode||500).json({success:false,message:e.code===11000?'This return is already tracked. Refresh the refund queue.':e.statusCode?e.message:'Refund tracking failed. Refresh and retry.'});
const readBags=()=>Bag.collection.find({},{projection:{bagId:1,assignedTo:1,history:1,lifecycleState:1,location:1,condition:1,isFlagged:1}}).toArray();
const manager=req=>{if(!managers.has(req.user.role))throw refundFault('Management approval access required.',403);};
const text=(value,max=2000)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max;
const eventId=value=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{8,180}$/.test(value);
const view=(record,bags)=>({...record,eligibility:refundEligibility(record,bags)});
router.get('/',async(req,res)=>{
  try{
    const [bags,cases]=await Promise.all([readBags(),BagRefundCase.find({}).sort({createdAt:-1}).lean()]);
    res.json({success:true,data:{amountMinor:BAG_DEPOSIT_MINOR,currency:'AED',canApprove:managers.has(req.user.role),candidates:refundCandidates(bags,cases),cases:cases.map(c=>view(c,bags))}});
  }catch(e){fail(res,e);}
});
router.post('/',async(req,res)=>{
  const {requestId,customerId,note,subscriptionReference,confirmedFinalReturn,confirmedDepositDue,dismiss}=req.body||{};
  try{
    manager(req);
    if(!eventId(requestId)||!text(customerId,160)||!text(note)||(dismiss!=null&&typeof dismiss!=='boolean')||(!dismiss&&(confirmedFinalReturn!==true||confirmedDepositDue!==true))||(subscriptionReference!=null&&typeof subscriptionReference!=='string'))throw refundFault('Confirm the final subscription return and outstanding AED 155 deposit, with review notes.',400);
    const prior=await BagRefundCase.findOne({requestId}).lean();
    if(prior){if(prior.customerId!==customerId||String(prior.createdBy)!==String(req.user._id))throw refundFault('Request ID already used.');return res.json({success:true,data:prior});}
    const [bags,cases,customer]=await Promise.all([readBags(),BagRefundCase.find({}).lean(),Customer.findOne({customerId}).select('customerId').lean()]);
    if(!customer)throw refundFault('Resolve this customer identity before opening a refund case. No customer was created.',400);
    const candidate=refundCandidates(bags,cases).find(c=>c.customerId===customerId);
    if(!candidate?.bags.length)throw refundFault('No untracked physical returns for this customer. Refresh the queue.');
    const action=dismiss?'not_due':'open';
    const data=await BagRefundCase.create({requestId,customerId,customerName:candidate.customerName,subscriptionReference:subscriptionReference?.trim().slice(0,200)||'',endEvidence:note.trim(),status:dismiss?'not_due':'review',active:!dismiss,createdBy:req.user._id,createdByName:staffName(req.user),bags:candidate.bags.map(b=>({recordId:b.recordId,bagId:b.bagId,returnKey:b.returnKey})),history:[{eventId:requestId,action,note:note.trim(),actor:req.user._id,actorName:staffName(req.user),timestamp:new Date()}]});
    res.status(201).json({success:true,data});
  }catch(e){if(e.code===11000)e.statusCode=409;fail(res,e);}
});
router.post('/:id/actions',async(req,res)=>{
  const {action,eventId:requestEvent,version,note}=req.body||{};
  try{
    if(!mongoose.isValidObjectId(req.params.id)||!eventId(requestEvent)||!Number.isInteger(version)||version<1||!text(note))throw refundFault('Provide the case version, stable request ID and action notes.',400);
    if(action!=='inspect')manager(req);
    const record=await BagRefundCase.findById(req.params.id).lean();
    if(!record)throw refundFault('Refund case not found.',404);
    const prior=record.history.find(e=>e.eventId===requestEvent);
    if(prior){if(prior.action!==action||String(prior.actor)!==String(req.user._id))throw refundFault('Request ID used for another action.');return res.json({success:true,data:record,duplicate:true});}
    if(record.version!==version)throw refundFault('This case changed. Refresh before confirming.');
    if(!record.active)throw refundFault('This case is closed and cannot be changed.');
    const bags=await readBags();const eligibility=refundEligibility(record,bags);const now=new Date();
    const set={};const unset={};
    if(action==='inspect'){
      if(record.status!=='review')throw refundFault('Reopen approval before changing inspection evidence.');
      const {returnKey,outcome,confirmed}=req.body;
      const item=eligibility.items.find(i=>i.returnKey===returnKey);
      if(!item?.receiptEventId||confirmed!==true||!['good','damaged'].includes(outcome))throw refundFault('Select a warehouse-received return and confirm its physical inspection.',400);
      const physical=bags.find(b=>String(b._id)===String(item.recordId));
      if(outcome==='good'&&(item.receivedDamaged||(physical?.location==='warehouse'&&(physical.condition==='poor'||physical.isFlagged))))throw refundFault('Damage is recorded for this return. Record a damaged inspection for management review.',400);
      set.inspections=[...(record.inspections||[]).filter(i=>!(String(i.recordId)===String(item.recordId)&&i.receiptEventId===item.receiptEventId)),{recordId:item.recordId,receiptEventId:item.receiptEventId,damageEventId:item.damageEventId||'',outcome,note:note.trim(),actor:req.user._id,timestamp:now}];
    }else if(action==='approve'){
      if(record.status!=='review')throw refundFault('Only a case in review can be approved.');
      if(!eligibility.eligible)throw refundFault(eligibility.blockers.join(' '));
      if(eligibility.damaged&&req.body.acknowledgeDamage!==true)throw refundFault('Acknowledge the damage review. With no deduction policy, the refund remains AED 155.',400);
      set.status='approved';set.approval={fingerprint:eligibility.fingerprint,actor:req.user._id,actorName:staffName(req.user),timestamp:now,note:note.trim()};
    }else if(action==='reopen'){
      if(record.status!=='approved')throw refundFault('Only an approved case can be reopened.');
      set.status='review';unset.approval='';
    }else if(action==='complete'){
      requireRefundApproval(record,bags);
      const completedAt=new Date(req.body.completedAt);
      // The staff date/time control has minute precision; compare approval at
      // that same precision rather than rejecting the approval minute itself.
      const approvalMinute=Math.floor(new Date(record.approval.timestamp).getTime()/60000)*60000;
      if(req.body.confirmed!==true||!Number.isFinite(completedAt.getTime())||completedAt>now||completedAt.getTime()<approvalMinute||(req.body.reference!=null&&typeof req.body.reference!=='string'))throw refundFault('Confirm the refund was completed after approval and enter a valid completion time.',400);
      set.status='completed';set.active=false;set.completion={completedAt,reference:req.body.reference?.trim().slice(0,200)||'',note:note.trim(),recordedBy:req.user._id,recordedByName:staffName(req.user),recordedAt:now};
    }else if(action==='not_due'){
      if(record.status!=='review')throw refundFault('Reopen approval before marking this case not due.');
      set.status='not_due';set.active=false;
    }else if(action==='add_returns'){
      if(record.status!=='review')throw refundFault('Reopen approval before adding returns.');
      const all=await BagRefundCase.find({}).lean();
      const used=new Set(all.flatMap(c=>(c.bags||[]).map(b=>b.returnKey)));
      const additions=bags.flatMap(b=>{const matches=bagReturnSources(b).filter(s=>s.customerId===record.customerId);return matches.length?[matches.at(-1)]:[];}).filter(s=>!used.has(s.returnKey));
      if(!additions.length)throw refundFault('No additional untracked returns.');
      set.bags=[...record.bags,...additions.map(s=>({recordId:s.recordId,bagId:s.bagId,returnKey:s.returnKey}))];
    }else throw refundFault('Unknown refund action.',400);
    const update={$set:set,$inc:{version:1},$push:{history:{eventId:requestEvent,action,note:note.trim(),actor:req.user._id,actorName:staffName(req.user),timestamp:now}}};
    if(Object.keys(unset).length)update.$unset=unset;
    const data=await BagRefundCase.findOneAndUpdate({_id:record._id,version,active:true},update,{new:true,runValidators:true});
    if(!data){const current=await BagRefundCase.findById(record._id).lean();if(current?.history.some(e=>e.eventId===requestEvent&&e.action===action&&String(e.actor)===String(req.user._id)))return res.json({success:true,data:current,duplicate:true});throw refundFault('Another operator changed this case. Refresh before retrying.');}
    req.app.get('io')?.emit('bag-refund:updated',{caseId:String(data._id)});
    res.json({success:true,data,message:action==='complete'?'Completion recorded. This application did not transfer money.':'Refund tracker updated.'});
  }catch(e){if(e.code===11000)e.statusCode=409;fail(res,e);}
});
export default router;
