import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import ServiceConversation from '../models/ServiceConversation.js';
import ServiceMessage from '../models/ServiceMessage.js';
import ServiceIssue from '../models/ServiceIssue.js';
import ServiceReview from '../models/ServiceReview.js';
import ServiceStaffProfile from '../models/ServiceStaffProfile.js';
import ServiceCaptureBatch from '../models/ServiceCaptureBatch.js';
import Customer from '../models/Customer.js';
import { normalizeServiceMessage } from './customerServiceCaptureFormat.js';

export async function ingestServiceBatch({ messages, source='gallabox_export', scope, requestId, from, to, actor }) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 500) throw Object.assign(new Error('Provide 1–500 normalized messages'), {statusCode:400});
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9:_-]{8,180}$/.test(requestId)) throw Object.assign(new Error('A stable requestId is required'), {statusCode:400});
  const normalized=messages.map(m=>normalizeServiceMessage(m,{source,scope}));
  if(from&&to&&normalized.some(m=>m.sentAt<new Date(from)||m.sentAt>=new Date(to))) throw Object.assign(new Error('Messages fall outside the declared capture range'),{statusCode:400});
  source=normalized[0].source;scope=normalized[0].scope;
  const fingerprint=createHash('sha256').update(JSON.stringify({normalized,from,to})).digest('hex');
  const sameRequest=batch=>batch.coverage?.fingerprint===fingerprint&&String(batch.createdBy||'')===String(actor?._id||'');
  const identities=new Set();
  for (const m of normalized) {
    if(identities.has(m.externalMessageId)) throw Object.assign(new Error('Duplicate message ID within this batch'),{statusCode:400});
    identities.add(m.externalMessageId);
  }
  const profiles=await ServiceStaffProfile.find({}).lean();
  const mapped=new Map();
  for(const p of profiles) for(const key of p.externalAuthorIds||[]) {
    if(mapped.has(key)&&String(mapped.get(key))!==String(p.userId)) throw Object.assign(new Error('Conflicting staff sender mapping. Supervisor must resolve it.'),{statusCode:409});
    mapped.set(key,p.userId);
  }
  const key={source,scope,requestId};
  const previous=await ServiceCaptureBatch.findOne({requestId}).lean();
  if(previous&&!sameRequest(previous)) throw Object.assign(new Error('Request ID belongs to another payload or actor'),{statusCode:409});
  if(previous?.status==='completed') return {...previous.counts,duplicate:true};
  const session=await mongoose.startSession(); let result;
  try {
    await session.withTransaction(async()=>{
      const existing=await ServiceCaptureBatch.findOne(key).session(session).lean();
      if(existing&&!sameRequest(existing)) throw Object.assign(new Error('Request ID conflict'),{statusCode:409});
      if(existing?.status==='completed') { result={...existing.counts,duplicate:true}; return; }
      if(existing) throw Object.assign(new Error('Import is already being processed'),{statusCode:409});
      const [batch]=await ServiceCaptureBatch.create([{...key,status:'processing',from,to,createdBy:actor?._id,coverage:{fingerprint},counts:{received:normalized.length}}],{session});
      const counts={received:normalized.length,inserted:0,duplicates:0,unlinked:0};
      const affected=new Set();
      const changedTimes=new Map();
      const changed=(conversation,time)=>{
        const cid=String(conversation._id);affected.add(cid);
        if(time) changedTimes.set(cid,[...(changedTimes.get(cid)||[]),time]);
      };
      for(const m of normalized) {
        const customer=m.customerId?await Customer.findOne({customerId:m.customerId}).select('customerId firstName lastName').session(session).lean():null;
        const customerId=customer?.customerId||'';
        const customerName=customer ? `${customer.firstName||''} ${customer.lastName||''}`.trim() : m.customerName;
        if(!customer) counts.unlinked++;
        let conversation=await ServiceConversation.findOne({source,scope,externalConversationId:m.externalConversationId}).session(session);
        if(!conversation) [conversation]=await ServiceConversation.create([{source,scope,externalConversationId:m.externalConversationId,customerId,customerName,sourceRevision:1,coverageStatus:'partial'}],{session});
        if(conversation.customerId&&customerId&&conversation.customerId!==customerId) throw Object.assign(new Error('Conversation has conflicting customer IDs'),{statusCode:409});
        if(!conversation.customerId&&customerId) {
          conversation.customerId=customerId;conversation.customerName=customerName;
          conversation.sourceRevision+=1;await conversation.save({session});changed(conversation);
        }
        const identity={source,scope,externalMessageId:m.externalMessageId};
        const authorId=mapped.get(`${source}:${scope}:${m.externalAuthorId}`)||null;
        const prior=await ServiceMessage.findOne(identity).session(session).lean();
        if(prior) {
          if(String(prior.conversationId)!==String(conversation._id)||prior.text!==m.text||+prior.sentAt!==+m.sentAt||['type','authorType','externalAuthorId','authorName'].some(k=>(prior[k]||'')!==(m[k]||''))) throw Object.assign(new Error('Source message ID conflicts with saved evidence'),{statusCode:409});
          if(!prior.authorId&&authorId) {
            await ServiceMessage.updateOne({_id:prior._id,authorId:null},{$set:{authorId}},{session});
            conversation.sourceRevision+=1;await conversation.save({session});changed(conversation,m.sentAt);
          } else if(prior.authorId&&authorId&&String(prior.authorId)!==String(authorId)) throw Object.assign(new Error('Staff attribution conflicts with existing evidence'),{statusCode:409});
          counts.duplicates++; continue;
        }
        await ServiceMessage.create([{...m,customerId:undefined,customerName:undefined,conversationId:conversation._id,authorId,importId:String(batch._id)}],{session});
        counts.inserted++;
        conversation.sourceRevision+=1;
        if(!conversation.customerId&&customerId) { conversation.customerId=customerId;conversation.customerName=customerName; }
        if(!conversation.lastMessageAt||m.sentAt>conversation.lastMessageAt) conversation.lastMessageAt=m.sentAt;
        await conversation.save({session});changed(conversation,m.sentAt);
      }
      for(const conversationId of affected) {
        const conversation=await ServiceConversation.findById(conversationId).session(session).lean();
        const all=await ServiceMessage.find({conversationId}).session(session).lean();
        const contributors=[...new Set(all.filter(m=>m.authorType==='staff'&&m.authorId).map(m=>String(m.authorId)))];
        const unmappedStaff=all.some(m=>m.authorType==='staff'&&!m.authorId);
        let issues=await ServiceIssue.find({conversationId}).session(session);
        if(!issues.length) issues=await ServiceIssue.create([{conversationId,episodeKey:'primary',customerId:conversation.customerId||'',customerName:conversation.customerName||'Unknown customer',sourceRevision:conversation.sourceRevision,contributorIds:contributors,boundaryState:'needs_review',sourceMetadata:{unmappedStaff}}],{session});
        for(const issue of issues) {
          if(conversation.customerId) {issue.customerId=conversation.customerId;issue.customerName=conversation.customerName;}
          if(issue.episodeKey!=='primary'&&issue.episodeFrom&&issue.episodeTo) {
            const bounded=all.filter(m=>m.sentAt>=issue.episodeFrom&&m.sentAt<=issue.episodeTo);
            issue.contributorIds=[...new Set(bounded.filter(m=>m.authorId&&m.authorType==='staff').map(m=>String(m.authorId)))];
            issue.sourceMetadata={...issue.sourceMetadata,unmappedStaff:bounded.some(m=>m.authorType==='staff'&&!m.authorId)};
            if((changedTimes.get(conversationId)||[]).some(t=>t>=issue.episodeFrom&&t<=issue.episodeTo)) {
              issue.sourceRevision+=1;if(issue.outcome==='resolved') issue.outcome='open';
              const savedReviews=await ServiceReview.find({issueId:issue._id}).session(session);
              for(const r of savedReviews) {
                r.stale=true;
                if(r.sampleType!=='calibration'&&['submitted','awaiting_evidence'].includes(r.status)) {
                  r.assignmentHistory.push({previousReviewerId:r.reviewerId,reviewerId:null,at:new Date(),reason:'Backfilled episode evidence requires fresh allocation'});
                  r.status='pending';r.reviewerId=null;r.leaseUntil=null;
                }
                await r.save({session});
              }
            }
            await issue.save({session});continue;
          }
          issue.sourceRevision=conversation.sourceRevision;issue.contributorIds=contributors;
          issue.sourceMetadata={...issue.sourceMetadata,unmappedStaff};
          // Reopened primary candidates require an explicit fresh span; submitted revisions retain old evidence.
          issue.boundaryState='needs_review';issue.episodeFrom=undefined;issue.episodeTo=undefined;
          if(issue.outcome==='resolved') issue.outcome='open';
          await issue.save({session});
          const reviews=await ServiceReview.find({issueId:issue._id}).session(session);
          if(!reviews.length) await ServiceReview.create([{issueId:issue._id,sampleKey:'primary',sampleType:'baseline',status:'pending',sourceRevision:issue.sourceRevision,policyVersion:'capacity-v1'}],{session});
          for(const review of reviews) {
            if(['submitted','awaiting_evidence'].includes(review.status)) {
              review.stale=true;
              if(review.sampleType!=='calibration') {
                review.assignmentHistory.push({previousReviewerId:review.reviewerId,reviewerId:null,at:new Date(),reason:'New source evidence requires fresh allocation'});
                review.status='pending';review.reviewerId=null;review.leaseUntil=null;
              }
              await review.save({session});
            }
          }
        }
      }
      batch.status='completed';batch.counts=counts;await batch.save({session});result=counts;
    });
    return result;
  } catch(error) {
    if(error.code===11000) {
      const committed=await ServiceCaptureBatch.findOne({requestId}).lean();
      if(committed?.status==='completed'&&sameRequest(committed)) return {...committed.counts,duplicate:true};
      throw Object.assign(new Error('Concurrent capture conflict. Retry with the same requestId.'),{statusCode:409});
    }
    throw error;
  } finally { await session.endSession(); }
}
