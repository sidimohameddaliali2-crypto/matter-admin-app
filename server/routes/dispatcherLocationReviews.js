import express from 'express';
import { protect, dispatcher } from '../middleware/auth.js';
import { effectivePermissions } from '../models/User.js';
import Customer from '../models/Customer.js';
import Delivery from '../models/Delivery.js';
import { loadNewCustomerQueue } from '../services/dispatcherNewCustomerQueue.js';
import Review from '../models/DispatcherLocationReview.js';
import matterApiService from '../services/matterApiService.js';
import { boundedMap } from '../services/boundedMap.js';
import { subscriptionLocation, validateLocationReview } from '../services/dispatcherLocationReviewService.js';
const router=express.Router();
router.use(protect,dispatcher,(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(!effectivePermissions(req.user).deliveries)return res.status(403).json({success:false,message:'Delivery permission is required.'});
  next();
});
const fail=(res,e)=>res.status(e.status||502).json({success:false,message:e.status?e.message:'Could not load the current subscription location. Please retry.'});
const queue = () => loadNewCustomerQueue({matter:matterApiService,Customer,Delivery});
async function current(id, eligible) {
  if(!/^\d+$/.test(id)){const e=new Error('Invalid subscription ID.');e.status=400;throw e;}
  const result=await matterApiService.getSubscription(id), s=result?.data;
  if(!s||String(s.subscription_id)!==id||s.customer_id==null)throw new Error('Subscription identity could not be verified.');
  if(String(s.customer_type||'').trim().toLowerCase()!=='new'){const e=new Error('This customer is no longer marked New. Refresh the list.');e.status=409;throw e;}
  const pending = (eligible || await queue()).subscriptions.find(candidate => String(candidate.subscription_id) === id && String(candidate.customer_id) === String(s.customer_id));
  if (!pending) { const e=new Error('This customer is no longer awaiting a first delivery with an upcoming delivery. Refresh the list.');e.status=409;throw e; }
  return {...subscriptionLocation(s),nextDeliveryAt:pending.nextDeliveryAt};
}
async function withHistory(data) {return {...data,reviews:await Review.find({customerId:data.customerId}).sort({timestamp:-1,_id:-1}).limit(50).lean()};}
router.get('/',async(req,res)=>{
 try{
  const page=Number(req.query.page||1);if(!Number.isInteger(page)||page<1)return res.status(400).json({success:false,message:'Invalid page.'});
  const eligible=await queue();
  const {subscriptions,count}=eligible;
  const selected=subscriptions.slice((page-1)*20,page*20);
  const rows=req.query.details==='true'?await boundedMap(selected,4,async s=>{try{return await current(String(s.subscription_id),eligible);}catch{return {customerId:String(s.customer_id),subscriptionId:String(s.subscription_id),customerName:s.name||'Unnamed customer',unavailable:true};}}):[];
  res.json({success:true,data:{count,rows,page,pages:Math.ceil(subscriptions.length/20),subscriptions:subscriptions.length}});
 }catch(e){fail(res,e);}
});
router.get('/:id',async(req,res)=>{try{res.json({success:true,data:await withHistory(await current(req.params.id))});}catch(e){fail(res,e);}});
router.post('/:id',async(req,res)=>{
 try{
  const invalid=validateLocationReview(req.body);if(invalid)return res.status(400).json({success:false,message:invalid});
  const {requestId,action,revision}=req.body, category=action==='feedback'?req.body.category:'', issue=action==='feedback'?req.body.issue.trim():'';
  const previous=await Review.findOne({requestId}).lean();
  const same=r=>String(r.actor)===String(req.user._id)&&r.subscriptionId===req.params.id&&r.action===action&&r.category===category&&r.issue===issue&&r.revision===revision;
  if(previous){if(!same(previous))return res.status(409).json({success:false,message:'This request ID has already been used for a different review.'});return res.json({success:true,data:{review:previous}});}
  const data=await current(req.params.id);
  if(data.revision!==revision)return res.status(409).json({success:false,message:'The saved location changed. Reopen this customer and review the current location.'});
  if(action==='confirm'&&(!data.pin||!data.location))return res.status(400).json({success:false,message:'A saved location and GPS pin are required before confirmation.'});
  let review;
  try{review=await Review.create({requestId,customerId:data.customerId,subscriptionId:data.subscriptionId,actor:req.user._id,actorName:[req.user.profile?.firstName,req.user.profile?.lastName].filter(Boolean).join(' ')||req.user.name||req.user.email||'Dispatcher',action,category,issue,revision,snapshot:data.snapshot});}
  catch(e){if(e.code!==11000)throw e;review=await Review.findOne({requestId}).lean();if(!review||!same(review))return res.status(409).json({success:false,message:'This request ID has already been used.'});}
  res.json({success:true,data:{review}});
 }catch(e){if(e.name==='ValidationError')return res.status(400).json({success:false,message:'The review could not be validated.'});fail(res,e);}
});
export default router;
