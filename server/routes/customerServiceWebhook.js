import express from 'express';
import { ingestServiceBatch } from '../services/customerServiceCapture.js';
import { verifyCaptureSignature,captureRange } from '../services/customerServiceCaptureFormat.js';

const router=express.Router();
// This is an explicit normalized adapter contract, not an assumed native Gallabox payload.
router.post('/normalized',async(req,res)=>{
  if(process.env.CUSTOMER_SERVICE_CAPTURE_ENABLED!=='true') return res.status(503).json({success:false,message:'Continuous capture is disabled'});
  if(!verifyCaptureSignature(req.rawBody,req.headers['x-matter-capture-signature'],process.env.CUSTOMER_SERVICE_CAPTURE_SECRET)) return res.status(401).json({success:false,message:'Invalid source signature'});
  try {
    const range=captureRange({from:req.body.from,to:req.body.to});
    const result=await ingestServiceBatch({...req.body,...range,actor:null});
    // Success only after durable evidence commits. Same requestId is retry-safe.
    res.json({success:true,data:result});
  } catch(e) {
    res.status(e.statusCode||400).json({success:false,message:'Capture was not committed. Verify the normalized payload and retry with the same requestId.'});
  }
});
export default router;
