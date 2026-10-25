import express from 'express';
import Bag from '../models/Bag.js';
import User,{effectivePermissions} from '../models/User.js';
import {protect} from '../middleware/auth.js';
import legacyBagMovements from '../middleware/legacyBagMovements.js';
import {bagIdAliases} from '../services/bagInventoryAudit.js';

const router=express.Router();
router.use(protect,legacyBagMovements);
// Compatibility reads for existing driver scanners and operational pages.
// All inventory mutations are handled by the audited movement adapter above.
router.get('/',async(req,res)=>{
  if(req.user.role!=='driver'&&!effectivePermissions(req.user).bags)return res.status(403).json({success:false,message:'Bag permission required.'});
  try{
    const page=Math.max(1,Number.parseInt(req.query.page,10)||1);
    const limit=Math.min(10000,Math.max(1,Number.parseInt(req.query.limit,10)||50));
    const query={};
    if(req.query.status&&req.query.status!=='all')query.status=req.query.status;
    if(req.query.location)query.location=req.query.location;
    if(req.query.isFlagged==='true')query.isFlagged=true;
    if(req.query.bagType)query.bagType=req.query.bagType;
    if(req.query.driverId)query['assignedTo.driver']=req.query.driverId;
    if(req.user.role==='driver'){
      if(typeof req.query.search!=='string'||!req.query.search.trim())return res.status(400).json({success:false,message:'Scan an exact bag ID.'});
      query.bagId={$in:bagIdAliases(req.query.search)};
    }else if(typeof req.query.search==='string'&&req.query.search.trim()){
      const term=req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      query.$or=[{bagId:{$regex:term,$options:'i'}},{'assignedTo.customer.customerName':{$regex:term,$options:'i'}}];
    }
    const [count,data]=await Promise.all([Bag.countDocuments(query),Bag.find(query).sort({createdAt:-1}).skip((page-1)*limit).limit(limit).populate('assignedTo.driver','profile.firstName profile.lastName name').lean()]);
    res.json({success:true,count,data,pagination:{page,limit,totalPages:Math.ceil(count/limit)}});
  }catch(e){res.status(400).json({success:false,message:'Unable to load bag records. Check the filters.'});}
});
router.get('/assignable-drivers',async(req,res)=>{
  if(!effectivePermissions(req.user).bags)return res.status(403).json({success:false,message:'Bag permission required.'});
  try{const users=await User.find({role:'driver',isActive:true}).select('profile.firstName profile.lastName name').lean();res.json({success:true,data:users.map(u=>({_id:u._id,name:[u.profile?.firstName,u.profile?.lastName].filter(Boolean).join(' ')||u.name||'Driver'}))});}
  catch(e){res.status(500).json({success:false,message:'Unable to load receiving drivers.'});}
});
router.patch('/:id/update-flag',async(req,res)=>{
  if(!['admin','super_admin','store_keeper','manager'].includes(req.user.role)||!effectivePermissions(req.user).bags)return res.status(403).json({success:false,message:'Warehouse access required.'});
  const reason=req.body?.flagReason;
  if(typeof reason!=='string'||!reason.trim()||reason.length>2000)return res.status(400).json({success:false,message:'Provide an exception reason up to 2,000 characters.'});
  try{const data=await Bag.findByIdAndUpdate(req.params.id,{$set:{isFlagged:true,flagReason:reason.trim(),flaggedAt:new Date()}},{new:true,runValidators:true});if(!data)return res.status(404).json({success:false,message:'Bag not found.'});res.json({success:true,data});}
  catch(e){res.status(400).json({success:false,message:'Unable to flag this bag.'});}
});
export default router;
