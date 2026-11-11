import {ObjectId} from 'bson';
import {decodeCloudRecord,cloudSqlText as lit} from './customerServiceCloudStore.js';
// Small local staff-workflow cache only; source messages stay in Postgres.
export const workflowKinds=['serviceissues','servicereviews','serviceactions','servicecommands','servicestaffprofiles','serviceallocationstates','servicecustomers','servicecustomerdirectorystates'];
export function createCloudCacheReader({db,store,startRevision=0}){
 let revision=Number(startRevision),pending=null,initialized=false;
 async function pull(){
  if(!initialized){const saved=await db.collection('servicecloudcachestates').findOne({_id:'hosted'});if(saved&&Number.isSafeInteger(saved.revision))revision=Math.max(revision,saved.revision);initialized=true;}
  const head=await store.head(),to=Number(head.revision);if(to<=revision)return;
  let after='';
  for(;;){
   const rows=await store.query(`SELECT COALESCE(jsonb_agg(r),'[]') FROM (SELECT kind,id,payload,sha256 FROM gallabox_private.inbox_record WHERE revision>${revision} AND revision<=${to} AND kind IN ('serviceissues','servicereviews','serviceconversations') AND kind||':'||id>'${after}' ORDER BY kind,id LIMIT 500) r;`);
   if(!rows.length)break;
   for(const row of rows){const doc=decodeCloudRecord(row),collection=db.collection(row.kind);
    if(row.kind==='serviceconversations'){
     const previous=await collection.findOne({_id:doc._id},{projection:{sourceRevision:1,updatedAt:1}});
     if(previous?.sourceRevision===doc.sourceRevision&&+new Date(previous.updatedAt)===+new Date(doc.updatedAt))continue;
     await collection.replaceOne({_id:doc._id},doc,{upsert:true});
     if(previous?.sourceRevision!==doc.sourceRevision){
      const staff=await store.query(`SELECT COALESCE(jsonb_agg(body),'[]') FROM gallabox_private.inbox_record WHERE kind='servicemessages' AND body->>'conversationId'=${lit(String(doc._id))} AND body->>'authorType'='staff' AND COALESCE(body->>'internalNote','false')<>'true' AND COALESCE(body#>>'{sourceMetadata,nativeContent,kind}','')<>'reaction';`);
      for await(const issue of db.collection('serviceissues').find({conversationId:doc._id})){
       const bounded=issue.episodeKey!=='primary'&&issue.episodeFrom&&issue.episodeTo;
       const relevant=bounded?staff.filter(m=>new Date(m.sentAt)>=issue.episodeFrom&&new Date(m.sentAt)<=issue.episodeTo):staff;
       const contributors=[...new Set(relevant.map(m=>m.authorId).filter(Boolean))].map(id=>new ObjectId(id));
       const changed=issue.sourceRevision!==doc.sourceRevision;
       await db.collection('serviceissues').updateOne({_id:issue._id},{$set:{sourceRevision:doc.sourceRevision,contributorIds:contributors,'sourceMetadata.unmappedStaff':relevant.some(m=>!m.authorId),updatedAt:new Date()}});
       if(changed)await db.collection('servicereviews').updateMany({issueId:issue._id,sourceRevision:{$ne:doc.sourceRevision}},{$set:{stale:true,updatedAt:new Date()}});
      }
     }

    }else await collection.updateOne({_id:doc._id},{$setOnInsert:doc},{upsert:true});
   }
   after=rows.at(-1).kind+':'+rows.at(-1).id;
  }
  revision=to;await db.collection('servicecloudcachestates').updateOne({_id:'hosted'},{$set:{revision,updatedAt:new Date()}},{upsert:true});
 }
 return {refresh(){if(!pending)pending=pull().finally(()=>pending=null);return pending;}};
}
