import {publishCloudInbox,cloudInbox} from './customerServiceCloudStore.js';
import {isServiceStaffReply} from './customerServiceMessageEvidence.js';
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import ServiceConversation from '../models/ServiceConversation.js';
import ServiceMessage from '../models/ServiceMessage.js';
import ServiceIssue from '../models/ServiceIssue.js';
import ServiceReview from '../models/ServiceReview.js';
import ServiceStaffProfile from '../models/ServiceStaffProfile.js';
import ServiceCaptureBatch from '../models/ServiceCaptureBatch.js';
import Customer from '../models/Customer.js';
import ServiceCustomer from '../models/ServiceCustomer.js';
import ServiceSourceContact from '../models/ServiceSourceContact.js';
import { normalizeServiceMessage } from './customerServiceCaptureFormat.js';

export async function ingestServiceBatch({ messages, source='gallabox_export', scope, requestId, from, to, actor }) {
  if (cloudInbox()?.hosted) throw Object.assign(new Error('Source capture runs in Supabase. Local imports are disabled.'), {statusCode:409});
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
      const [batch]=await ServiceCaptureBatch.create([{...key,status:'processing',from,to,createdBy:actor?._id,coverage:{fingerprint,conversationIds:[...new Set(normalized.map(message=>message.externalConversationId))]},counts:{received:normalized.length}}],{session});
      const counts={received:normalized.length,inserted:0,duplicates:0,unlinked:0};
      const affected=new Set();
      const changedTimes=new Map();
      const changed=(conversation,time)=>{
        const cid=String(conversation._id);affected.add(cid);
        if(time) changedTimes.set(cid,[...(changedTimes.get(cid)||[]),time]);
      };
      for(const m of normalized) {
        const externalContactId=m.sourceMetadata?.externalContactId;
        const contact=!m.customerId&&source==='gallabox'&&externalContactId?await ServiceSourceContact.findOne({scope,externalContactId,matchState:'matched'}).session(session).lean():null;
        const directoryId=m.customerId||contact?.customerId;
        let customer=directoryId?await ServiceCustomer.findOne({customerId:directoryId,active:true}).select('customerId name').session(session).lean():null;
        if(!customer&&m.customerId)customer=await Customer.findOne({customerId:m.customerId}).select('customerId firstName lastName').session(session).lean();
        const customerId=customer?.customerId||'';
        const customerName=customer ? customer.name||`${customer.firstName||''} ${customer.lastName||''}`.trim() : m.customerName;
        if(!customer) counts.unlinked++;
        let conversation=await ServiceConversation.findOne({source,scope,externalConversationId:m.externalConversationId}).session(session);
        if(!conversation) [conversation]=await ServiceConversation.create([{source,scope,externalConversationId:m.externalConversationId,customerId,customerName,sourceRevision:1,coverageStatus:'partial'}],{session});
        if(externalContactId){
          const old=conversation.sourceMetadata?.externalContactId;
          if(old&&old!==externalContactId)throw Object.assign(new Error('Conversation has conflicting native contact IDs'),{statusCode:409});
          if(!old){conversation.sourceMetadata={...conversation.sourceMetadata,externalContactId};await conversation.save({session});}
        }
        if(conversation.customerId&&customerId&&conversation.customerId!==customerId) {
          if(source!=='gallabox'||m.customerId||!externalContactId) throw Object.assign(new Error('Conversation has conflicting customer IDs'),{statusCode:409});
          // Native conversation/contact IDs establish the message's source
          // thread, not its Matter customer. Retain the old association for
          // review provenance and expose the conflict rather than blocking
          // source capture or choosing either customer automatically.
          const conflict={savedCustomerId:conversation.customerId,candidateCustomerId:customerId,sourceName:m.customerName||''};
          if(JSON.stringify(conversation.sourceMetadata?.captureIdentityConflict)!==JSON.stringify(conflict)) {
            conversation.sourceMetadata={...conversation.sourceMetadata,captureIdentityConflict:conflict};
            await conversation.save({session});
          }
        }
        if(!conversation.customerId&&customerId) {
          conversation.customerId=customerId;conversation.customerName=customerName;
          await conversation.save({session});
          // Directory identity enrichment does not alter captured evidence or reviews.
          await ServiceIssue.updateMany({conversationId:conversation._id},{$set:{customerId,customerName}},{session});
        }
        const identity={source,scope,externalMessageId:m.externalMessageId};
        const authorId=mapped.get(`${source}:${scope}:${m.externalAuthorId}`)||null;
        const prior=await ServiceMessage.findOne(identity).session(session).lean();
        if(prior) {
          if(externalContactId&&prior.sourceMetadata?.externalContactId&&prior.sourceMetadata.externalContactId!==externalContactId)throw Object.assign(new Error('Source message has conflicting native contact IDs'),{statusCode:409});
          if(String(prior.conversationId)!==String(conversation._id)||prior.text!==m.text||+prior.sentAt!==+m.sentAt||['type','authorType','externalAuthorId','authorName'].some(k=>(prior[k]||'')!==(m[k]||''))) throw Object.assign(new Error('Source message ID conflicts with saved evidence'),{statusCode:409});
          if(externalContactId&&!prior.sourceMetadata?.externalContactId)await ServiceMessage.updateOne({_id:prior._id},{$set:{'sourceMetadata.externalContactId':externalContactId}},{session});
          if(!prior.authorId&&authorId) {
            await ServiceMessage.updateOne({_id:prior._id,authorId:null},{$set:{authorId}},{session});
            if(!m.internalNote){conversation.sourceRevision+=1;await conversation.save({session});changed(conversation,m.sentAt);}
          } else if(prior.authorId&&authorId&&String(prior.authorId)!==String(authorId)) throw Object.assign(new Error('Staff attribution conflicts with existing evidence'),{statusCode:409});
          if(m.internalNote&&(!prior.internalNote||!prior.sourceMetadata?.nativeEvent))await ServiceMessage.updateOne({_id:prior._id},{$set:{internalNote:true,'sourceMetadata.nativeEvent':m.sourceMetadata.nativeEvent}},{session});
          for(const field of ['nativeContent','direction','nativeMessageId'])if(m.sourceMetadata?.[field]&&JSON.stringify(prior.sourceMetadata?.[field])!==JSON.stringify(m.sourceMetadata[field]))await ServiceMessage.updateOne({_id:prior._id},{$set:{['sourceMetadata.'+field]:m.sourceMetadata[field]}},{session});
          if(m.sourceMetadata?.location&&JSON.stringify(prior.sourceMetadata?.location)!==JSON.stringify(m.sourceMetadata.location))await ServiceMessage.updateOne({_id:prior._id},{$set:{'sourceMetadata.location':m.sourceMetadata.location}},{session});
          if(m.sourceMetadata?.replyContext&&JSON.stringify(prior.sourceMetadata?.replyContext)!==JSON.stringify(m.sourceMetadata.replyContext))await ServiceMessage.updateOne({_id:prior._id},{$set:{'sourceMetadata.replyContext':m.sourceMetadata.replyContext}},{session});
          if(m.sourceMetadata?.systemEvent&&JSON.stringify(prior.sourceMetadata?.systemEvent)!==JSON.stringify(m.sourceMetadata.systemEvent))await ServiceMessage.updateOne({_id:prior._id},{$set:{'sourceMetadata.systemEvent':m.sourceMetadata.systemEvent}},{session});
          // Refresh access metadata only; immutable source evidence and review revisions stay intact.
          if(m.sourceMetadata?.media && JSON.stringify(prior.sourceMetadata?.media)!==JSON.stringify(m.sourceMetadata.media)) {
            await ServiceMessage.updateOne({_id:prior._id},{$set:{'sourceMetadata.media':m.sourceMetadata.media,mediaState:'available'}},{session});
          }
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
        const contributors=[...new Set(all.filter(m=>isServiceStaffReply(m)&&m.authorId).map(m=>String(m.authorId)))];
        const unmappedStaff=all.some(m=>isServiceStaffReply(m)&&!m.authorId);
        let issues=await ServiceIssue.find({conversationId}).session(session);
        if(!issues.length) issues=await ServiceIssue.create([{conversationId,episodeKey:'primary',customerId:conversation.customerId||'',customerName:conversation.customerName||'Unknown customer',sourceRevision:conversation.sourceRevision,contributorIds:contributors,boundaryState:'needs_review',sourceMetadata:{unmappedStaff}}],{session});
        for(const issue of issues) {
          if(conversation.customerId) {issue.customerId=conversation.customerId;issue.customerName=conversation.customerName;}
          if(issue.episodeKey!=='primary'&&issue.episodeFrom&&issue.episodeTo) {
            const bounded=all.filter(m=>m.sentAt>=issue.episodeFrom&&m.sentAt<=issue.episodeTo);
            issue.contributorIds=[...new Set(bounded.filter(m=>m.authorId&&isServiceStaffReply(m)).map(m=>String(m.authorId)))];
            issue.sourceMetadata={...issue.sourceMetadata,unmappedStaff:bounded.some(m=>isServiceStaffReply(m)&&!m.authorId)};
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
    await publishCloudInbox();
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
