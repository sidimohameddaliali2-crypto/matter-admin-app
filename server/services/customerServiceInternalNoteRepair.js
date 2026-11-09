import mongoose from'mongoose';
import Message from'../models/ServiceMessage.js';
import Issue from'../models/ServiceIssue.js';
import{isServiceStaffReply}from'./customerServiceMessageEvidence.js';
// Only classification and derived contributor fields change; messages' source
// evidence, issue revisions, reviews and submitted judgments remain untouched.
export async function repairInternalNoteClassification(){
 const notes=await Message.find({source:'gallabox','sourceMetadata.nativeEvent.kind':'internal_note'}).select('_id conversationId').lean();
 const conversationIds=[...new Set(notes.map(m=>String(m.conversationId)))];let issuesUpdated=0;
 const session=await mongoose.startSession();
 try{await session.withTransaction(async()=>{
  issuesUpdated=0;await Message.updateMany({_id:{$in:notes.map(m=>m._id)}},{$set:{internalNote:true}},{session,timestamps:false});
  for(const conversationId of conversationIds){
   const [messages,issues]=await Promise.all([Message.find({conversationId}).session(session).lean(),Issue.find({conversationId}).session(session).lean()]);
   for(const issue of issues){const span=issue.episodeKey!=='primary'&&issue.episodeFrom&&issue.episodeTo?messages.filter(m=>m.sentAt>=issue.episodeFrom&&m.sentAt<=issue.episodeTo):messages;
    const contributorIds=[...new Set(span.filter(m=>isServiceStaffReply(m)&&m.authorId).map(m=>String(m.authorId)))],unmappedStaff=span.some(m=>isServiceStaffReply(m)&&!m.authorId);
    if(JSON.stringify(contributorIds.slice().sort())!==JSON.stringify((issue.contributorIds||[]).map(String).sort())||issue.sourceMetadata?.unmappedStaff!==unmappedStaff){await Issue.updateOne({_id:issue._id,sourceRevision:issue.sourceRevision},{$set:{contributorIds,'sourceMetadata.unmappedStaff':unmappedStaff}},{session,timestamps:false});issuesUpdated++;}
   }
  }
 });return{notes:notes.length,conversations:conversationIds.length,issuesUpdated};}finally{await session.endSession();}
}
