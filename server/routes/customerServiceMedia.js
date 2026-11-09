import {cloudInbox} from '../services/customerServiceCloudStore.js';
import express from 'express';
import {protectService as protect} from '../services/customerServiceStaffAuth.js';
import {requireServiceAccess} from '../middleware/serviceAccess.js';
import Message from '../models/ServiceMessage.js';
import {getServiceIssueDetail} from '../services/customerServiceWorkflow.js';
import {getServiceInboxConversation} from '../services/customerServiceInbox.js';
import {loadServiceIssueMedia,loadServiceConversationMedia} from '../services/customerServiceMedia.js';
export function createServiceMediaRouter({fetchImpl = fetch} = {}) {
  const router = express.Router();
  router.use((req,res,next)=>{res.set({'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff'});next();});
  router.get('/issues/:issueId/messages/:messageId/media', protect, requireServiceAccess, async(req,res)=>{
    try {
      if(!/^[a-f0-9]{24}$/i.test(req.params.messageId)) return res.status(400).json({message:'Invalid attachment reference.'});
      const {body,mimeType} = await loadServiceIssueMedia({...req.params,actor:req.user,profile:req.serviceProfile},{getDetail:getServiceIssueDetail,getMessage:id=>cloudInbox()?cloudInbox().store.record('servicemessages',id):Message.findById(id).lean(),fetchImpl});
      res.set({'Content-Type':mimeType,'Content-Disposition':['image/','audio/','video/'].some(prefix=>mimeType.startsWith(prefix))?'inline':'attachment','Content-Security-Policy':"default-src 'none'"}).send(body);
    } catch(e) {res.status(e.statusCode||502).json({success:false,message:e.statusCode ? e.message : 'Attachment could not be loaded. Retry later.'});}
  });
  router.get('/conversations/:conversationId/messages/:messageId/media', protect, requireServiceAccess, async(req,res)=>{
    try {
      if(!/^[a-f0-9]{24}$/i.test(req.params.messageId)) return res.status(400).json({message:'Invalid attachment reference.'});
      const {body,mimeType}=await loadServiceConversationMedia({...req.params,actor:req.user,profile:req.serviceProfile},{getConversation:getServiceInboxConversation,getMessage:id=>cloudInbox()?cloudInbox().store.record('servicemessages',id):Message.findById(id).lean(),fetchImpl});
      res.set({'Content-Type':mimeType,'Content-Disposition':['image/','audio/','video/'].some(prefix=>mimeType.startsWith(prefix))?'inline':'attachment','Content-Security-Policy':"default-src 'none'"}).send(body);
    } catch(e) {res.status(e.statusCode||502).json({success:false,message:e.statusCode?e.message:'Attachment could not be loaded. Retry later.'});}
  });
  return router;
}
export default createServiceMediaRouter();
