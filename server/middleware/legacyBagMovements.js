import mongoose from 'mongoose';
import Bag from '../models/Bag.js';
import {effectivePermissions} from '../models/User.js';
import {moveBag} from '../services/bagMovementStore.js';
import {legacyBagReturn} from '../services/deliveryBagMovements.js';
import {findRegisteredBag} from '../services/bagRecordLookup.js';

// Old clients are kept compatible, but cannot bypass custody/history or delete
// physical assets. Reads never provision stock or backfill customer addresses.
export default async function legacyBagMovements(req,res,next){
  if(req.method==='GET')return next();
  const path=req.path.toLowerCase().replace(/\/+$/,'')||'/';
  const isReturn=(req.method==='POST'&&path==='/return')||(req.method==='PATCH'&&/^\/[^/]+\/return$/.test(path));
  const isAssign=req.method==='PATCH'&&/^\/[^/]+\/assign$/.test(path);
  const isReassign=req.method==='PATCH'&&path==='/reassign';
  const isDamage=req.method==='PATCH'&&/^\/[^/]+\/mark-damaged$/.test(path);
  const isBulk=req.method==='POST'&&path==='/assign/bulk';
  if(req.method==='DELETE'||/\/(override-quantity|unflag)$/.test(path)||(req.method==='POST'&&['/','/bulk'].includes(path)))return res.status(409).json({success:false,message:'Use Bag Operations for registration, physical reconciliation, repair or retirement. Inventory history cannot be deleted or quantity-overridden.'});
  if(!isReturn&&!isAssign&&!isReassign&&!isDamage&&!isBulk)return next();
  if(req.user.role!=='driver'&&!effectivePermissions(req.user).bags)return res.status(403).json({success:false,message:'Bag permission required.'});
  try{
    const lookup=async identifier=>mongoose.isValidObjectId(identifier)?Bag.findById(identifier).lean():findRegisteredBag(Bag.collection,identifier);
    if(isBulk){
      if(!Array.isArray(req.body.bagIds)||!req.body.bagIds.length||req.body.bagIds.length>500)return res.status(400).json({success:false,message:'Provide 1–500 bag IDs.'});
      const successes=[],failures=[];
      for(const identifier of req.body.bagIds){try{const bag=await lookup(identifier);if(!bag)throw new Error('Unregistered bag');await moveBag(bag.bagId,{action:'pack',driverId:req.body.driverId,note:req.body.notes||'Outbound manifest prepared',eventId:`pack:${bag._id}:${bag.custodyVersion||0}:${req.body.driverId}`},req.user);successes.push({bagId:bag.bagId,_id:bag._id});}catch(e){failures.push({bagId:identifier,reason:e.message});}}
      return res.json({success:!failures.length,data:{successes,failures,assignedCount:successes.length,failedCount:failures.length},message:'Prepared handovers require driver acceptance.'});
    }
    let identifier=isReturn&&req.method==='POST'?(req.body.bagId||req.body.bagQRCode):isReassign?req.body.bagId:decodeURIComponent(path.split('/')[1]);
    const bag=await lookup(identifier);
    if(!bag)return res.status(404).json({success:false,message:'Unregistered bag. Open an inventory review.'});
    let result;
    if(isReturn)result=await legacyBagReturn(bag.bagId,req.body,req.user);
    else if(isReassign)result=await moveBag(bag.bagId,{action:'deliver',physicalScan:true,deliveryId:req.body.deliveryId,customerId:req.body.customerId,eventId:`delivery:${req.body.deliveryId}:deliver:${bag.bagId}`,note:'Physical customer handover'},req.user);
    else if(isAssign)result=await moveBag(bag.bagId,{action:'pack',driverId:req.body.driverId,note:req.body.notes||'Outbound handover prepared',eventId:req.body.eventId||`pack:${bag._id}:${bag.custodyVersion||0}:${req.body.driverId}`},req.user);
    else result=await moveBag(bag.bagId,{action:'quarantine',proofPhotoUrl:req.body.proofPhotoUrl,note:req.body.description||'Damage recorded at warehouse',eventId:req.body.eventId||`damage:${bag._id}:${bag.custodyVersion||0}`},req.user);
    req.app.get('io')?.emit('bag:updated',{bagId:bag.bagId});
    return res.json({success:true,data:result.bag,message:req.user.role==='driver'?'Bag recorded in driver custody. Warehouse receipt is still required.':'Physical movement recorded.'});
  }catch(e){return res.status(e.statusCode||400).json({success:false,message:e.message||'Bag movement failed.'});}
}
