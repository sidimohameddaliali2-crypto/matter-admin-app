import express from 'express';
import { protect } from '../middleware/auth.js';
import { requireServiceAccess } from '../middleware/serviceAccess.js';
import ServiceIssue from '../models/ServiceIssue.js';
import ServiceReview from '../models/ServiceReview.js';
import ServiceAction from '../models/ServiceAction.js';
import Customer from '../models/Customer.js';
import matterApi from '../services/matterApiService.js';
import { ingestServiceBatch } from '../services/customerServiceCapture.js';
import { getServiceSnapshot,summarizeServiceSnapshot,buildServiceWorkbook } from '../services/customerServiceReports.js';
import { captureRange } from '../services/customerServiceCaptureFormat.js';

const router=express.Router();
router.use((req,res,next)=>/^\/(summary|export\.xlsx|import|customers\/[^/]+\/context)\/?$/.test(req.path)?next():next('router'));
router.use(protect,requireServiceAccess);
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.statusCode||400).json({success:false,message:e.statusCode?e.message:'Unable to complete customer service request. Refresh and retry.'});}};
const supervisor=(req,res,next)=>req.serviceCapabilities.supervise?next():res.status(403).json({success:false,message:'Supervisor access required'});
const independent=async(req,res,next)=>{
  try {
    if(await ServiceReview.exists({reviewerId:req.user._id,sampleType:'calibration',status:{$nin:['submitted','skipped']},'revisions.0':{$exists:false}})) return res.status(403).json({success:false,message:'Complete independent calibration before opening comparisons or exports.'});
    next();
  } catch {res.status(503).json({success:false,message:'Unable to verify independent review state'});}
};
const input=req=>({userId:req.user._id,supervise:req.serviceCapabilities.supervise,filters:{from:req.query.from,to:req.query.to,categoryId:req.query.categoryId,q:req.query.q}});
router.get('/summary',independent,wrap(async(req,res)=>res.json({success:true,data:summarizeServiceSnapshot(await getServiceSnapshot(input(req)))})));
router.get('/export.xlsx',supervisor,independent,wrap(async(req,res)=>{
 const file=await buildServiceWorkbook(await getServiceSnapshot(input(req)));
 res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.set('Content-Disposition','attachment; filename="Matter_Customer_Service.xlsx"');res.send(file);
}));
router.post('/import',supervisor,wrap(async(req,res)=>{
 if(!req.body.from||!req.body.to) return res.status(400).json({success:false,message:'Declare the capture date range in Dubai before importing'});
 const range=captureRange({from:req.body.from,to:req.body.to});
 const data=await ingestServiceBatch({...req.body,...range,actor:req.user});res.json({success:true,data});
}));
router.get('/customers/:id/context',wrap(async(req,res)=>{
 const customerId=req.params.id;
 if(!req.serviceCapabilities.supervise) {
   const issues=await ServiceIssue.find({customerId}).select('_id').lean(); const issueIds=issues.map(i=>i._id);
   if(!await ServiceReview.exists({issueId:{$in:issueIds},reviewerId:req.user._id})&&!await ServiceAction.exists({issueId:{$in:issueIds},ownerId:req.user._id})) return res.status(403).json({success:false,message:'Customer access denied'});
 }
 const customer=await Customer.findOne({customerId}).select('customerId firstName lastName matterSubscriptionId matterCustomerId').lean();
 if(!customer) return res.json({success:true,data:{customer:{customerId},subscription:null,sourceState:'not_linked',message:'No linked Matter customer record'}});
 let subscription=null,sourceState='not_linked',message='No linked subscription';
 if(customer.matterSubscriptionId) {
   try {const result=await matterApi.getSubscription(customer.matterSubscriptionId);const raw=result?.data||result;
     subscription={subscriptionId:raw.subscription_id,status:raw.status,startDate:raw.start_date,endDate:raw.end_date,planName:raw.plan?.name||raw.plan_name};sourceState='available';message='Current subscription context; historical status may differ';
   }catch{sourceState='unavailable';message='Subscription context unavailable; no source records were changed';}
 }
 res.json({success:true,data:{customer:{customerId,name:`${customer.firstName||''} ${customer.lastName||''}`.trim()},subscription,sourceState,message,observedAt:new Date().toISOString()}});
}));
export default router;
