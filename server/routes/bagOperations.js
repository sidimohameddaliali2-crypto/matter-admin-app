import express from 'express';
import mongoose from 'mongoose';
import {randomUUID} from 'node:crypto';
import {protect} from '../middleware/auth.js';
import User,{effectivePermissions} from '../models/User.js';
import Bag from '../models/Bag.js';
import BagReviewCase from '../models/BagReviewCase.js';
import BagStockCount from '../models/BagStockCount.js';
import {loadBagSnapshot,buildBagWorkspace,compareStockCount,staffName} from '../services/bagOperationsService.js';
import {moveBag} from '../services/bagMovementStore.js';
import {normalizeBagId} from '../services/bagInventoryAudit.js';
import {findRegisteredBag} from '../services/bagRecordLookup.js';

const router=express.Router();
const writers=new Set(['super_admin','admin','manager','store_keeper']);
router.use(protect,(req,res,next)=>{res.set('Cache-Control','no-store');next();});
const access=(req,res,next)=>effectivePermissions(req.user).bags?next():res.status(403).json({success:false,message:'Bag permission is required.'});
const writer=(req,res,next)=>writers.has(req.user.role)?access(req,res,next):res.status(403).json({success:false,message:'Warehouse or management access is required.'});
const error=(res,e)=>res.status(e.statusCode||500).json({success:false,message:e.statusCode?e.message:'Bag operation failed. Refresh and retry.'});

router.get('/',access,async(req,res)=>{
  try{
    const snapshot=await loadBagSnapshot(mongoose.connection.db);
    const reviews=await BagReviewCase.find({}).lean();
    const data=buildBagWorkspace(snapshot,reviews);
    data.canOperate=writers.has(req.user.role);
    data.canRetire=['super_admin','admin','manager'].includes(req.user.role);
    data.reviewers=snapshot.users.filter(u=>u.isActive&&writers.has(u.role)&&effectivePermissions(u).bags).map(u=>({_id:String(u._id),name:staffName(u)}));
    data.drivers=snapshot.users.filter(u=>u.isActive&&u.role==='driver').map(u=>({_id:String(u._id),name:staffName(u)}));
    data.stockCounts=await BagStockCount.find({}).sort({submittedAt:-1}).limit(20).select('-scannedCodes -expectedCodes').lean();
    res.json({success:true,data});
  }catch(e){error(res,e);}
});
router.get('/pending',async(req,res)=>{
  if(req.user.role!=='driver')return res.status(403).json({success:false,message:'Driver access required.'});
  try{const data=await Bag.find({'pendingHandover.driver':req.user._id}).select('bagId lifecycleState pendingHandover custodyVersion').lean();res.json({success:true,data});}catch(e){error(res,e);}
});
router.get('/bags/:id',access,async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({success:false,message:'Invalid bag record.'});
  try{const data=await Bag.collection.findOne({_id:new mongoose.Types.ObjectId(req.params.id)});if(!data)return res.status(404).json({success:false,message:'Bag not found.'});res.json({success:true,data});}catch(e){error(res,e);}
});
router.post('/register',writer,async(req,res)=>{
  const bagId=normalizeBagId(req.body?.bagId);
  if(!/^BAG-\d{4,}$/.test(bagId))return res.status(400).json({success:false,message:'Use an unused ID such as BAG-0001. Preserve existing tag numbering.'});
  try{
    if(await findRegisteredBag(Bag.collection,bagId))return res.status(409).json({success:false,message:'That bag label is already registered.'});
    const data=new Bag({bagId,status:'maintenance',location:'warehouse',lifecycleState:'received',custodyVersion:1,quantity:1,condition:'good',verifiedAt:new Date()});
    data.$locals.historyEntryOverride={eventId:randomUUID(),eventType:'register',lifecycleState:'received',status:'maintenance',location:'warehouse',assignedBy:{user:req.user._id,name:staffName(req.user)},notes:'Registered physical stock; cleaning and inspection required.',timestamp:new Date()};
    await data.save();
    res.status(201).json({success:true,data});
  }catch(e){if(e.code===11000)return res.status(409).json({success:false,message:'That bag ID is already registered.'});error(res,e);}
});
router.post('/movements',async(req,res)=>{
  const {bagId,action,eventId,note,expectedVersion,driverId,deliveryId,customerId,proofPhotoUrl,inspected,occurredAt}=req.body||{};
  if(!normalizeBagId(bagId)||typeof action!=='string'||typeof eventId!=='string'||eventId.length>200||typeof note!=='string'||note.length>2000||(expectedVersion!=null&&(!Number.isInteger(expectedVersion)||expectedVersion<0)))return res.status(400).json({success:false,message:'Provide bag ID, action, stable event ID, version and note.'});
  if(req.user.role!=='driver'&&(!writers.has(req.user.role)||!effectivePermissions(req.user).bags))return res.status(403).json({success:false,message:'Bag movement access denied.'});
  for(const id of [driverId,deliveryId])if(id&&!mongoose.isValidObjectId(id))return res.status(400).json({success:false,message:'Invalid driver or delivery ID.'});
  if(proofPhotoUrl&&(typeof proofPhotoUrl!=='string'||proofPhotoUrl.length>2000||!/^https?:\/\//i.test(proofPhotoUrl)))return res.status(400).json({success:false,message:'Provide a valid uploaded proof-photo URL.'});
  try{
    const result=await moveBag(bagId,{action,eventId,note,expectedVersion,driverId,deliveryId,customerId,proofPhotoUrl,inspected,occurredAt},req.user);
    req.app.get('io')?.emit('bag:updated',{bagId:result.bag.bagId});
    res.json({success:true,data:{bagId:result.bag.bagId,lifecycleState:result.bag.lifecycleState,custodyVersion:result.bag.custodyVersion,duplicate:result.duplicate}});
  }catch(e){error(res,e);}
});
router.put('/reviews',writer,async(req,res)=>{
  const {recordId,status,assignedTo,note,version}=req.body||{};
  if(!mongoose.isValidObjectId(recordId)||!['open','in_review','awaiting_evidence','ready_for_correction'].includes(status)||typeof note!=='string'||!note.trim()||note.length>2000||!Number.isInteger(version)||version<0||(assignedTo&&!mongoose.isValidObjectId(assignedTo)))return res.status(400).json({success:false,message:'Choose a review state and enter evidence notes.'});
  try{
    if(!await Bag.exists({_id:recordId}))return res.status(404).json({success:false,message:'Bag no longer exists.'});
    if(assignedTo){const user=await User.findById(assignedTo);if(!user?.isActive||!writers.has(user.role)||!effectivePermissions(user).bags)return res.status(400).json({success:false,message:'Select an active bag reviewer.'});}
    const subjectKey=`bag:${recordId}`,values={status,assignedTo:assignedTo||null,note:note.trim()},entry={status,note:note.trim(),actor:req.user._id,timestamp:new Date()};
    const data=version===0?await BagReviewCase.create({subjectKey,...values,version:1,history:[entry]}):await BagReviewCase.findOneAndUpdate({subjectKey,version},{$set:values,$inc:{version:1},$push:{history:entry}},{new:true,runValidators:true});
    if(!data)return res.status(409).json({success:false,message:'Another reviewer changed the case. Refresh before saving.'});
    res.json({success:true,data,message:'Review saved; no stock or custody was changed.'});
  }catch(e){if(e.code===11000)return res.status(409).json({success:false,message:'Case already changed. Refresh before saving.'});error(res,e);}
});
router.post('/stock-counts',writer,async(req,res)=>{
  const {requestId,scannedCodes,note,capturedAt,confirmed}=req.body||{};
  const time=new Date(capturedAt);
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)||confirmed!==true||typeof note!=='string'||note.length>2000||!Number.isFinite(time.getTime())||time.getTime()>Date.now()+60000||Date.now()-time.getTime()>86400000)return res.status(400).json({success:false,message:'Confirm a physical count captured in the last 24 hours.'});
  try{
    const prior=await BagStockCount.findOne({requestId}).lean();
    if(prior){if(String(prior.submittedBy)!==String(req.user._id))return res.status(409).json({success:false,message:'Submission ID is in use.'});return res.json({success:true,data:prior});}
    const bags=await Bag.collection.find({},{projection:{bagId:1,status:1,location:1,isActive:1}}).toArray();
    let comparison;try{comparison=compareStockCount(bags,scannedCodes);}catch(e){return res.status(400).json({success:false,message:e.message});}
    const data=await BagStockCount.create({requestId,submittedBy:req.user._id,capturedAt:time,note:note.trim(),...comparison});
    res.status(201).json({success:true,data,message:'Physical count submitted. Inventory has not been overwritten.'});
  }catch(e){if(e.code===11000)return res.status(409).json({success:false,message:'Count already submitted. Refresh to see it.'});error(res,e);}
});
export default router;
