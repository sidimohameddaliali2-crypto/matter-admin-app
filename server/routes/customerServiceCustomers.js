import {cloudInbox} from '../services/customerServiceCloudStore.js';
import {readCloudEvidence} from '../services/customerServiceCloudEvidence.js';
import express from 'express';
import {protectService as protect} from '../services/customerServiceStaffAuth.js';
import {requireServiceAccess} from '../middleware/serviceAccess.js';
import Customer from '../models/ServiceCustomer.js';
import Conversation from '../models/ServiceConversation.js';
import DirectoryState from '../models/ServiceCustomerDirectoryState.js';
import SourceContact from '../models/ServiceSourceContact.js';
import Message from '../models/ServiceMessage.js';
import {readValidatedNativeSenderProof,scopedSenderProofCoversConversation} from '../services/customerServiceIdentity.js';
import {getScopedServiceIssues} from '../services/customerServiceWorkflow.js';

const router=express.Router();
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const subscriptions=rows=>(rows||[]).map(s=>({subscriptionId:s.id||s.subscriptionId||'',status:s.status||'',planName:s.plan?.name||s.planName||'',startDate:s.start||s.startDate||'',endDate:s.end||s.endDate||''}));
const fields=c=>({key:c.customerId,customerId:c.customerId,name:c.name||'Name not recorded',email:c.email||'',phone:c.phone||'',subscriptions:subscriptions(c.subscriptions),source:c.source,sourceObservedAt:c.sourceObservedAt});
function query(req){
 const view=req.query.view||'customers';if(!['customers','unmatched'].includes(view))throw fail('Use customers or unmatched view.');
 const number=(v,fallback,max)=>{if(v===undefined)return fallback;if(typeof v!=='string'||!/^\d+$/.test(v)||Number(v)<1||Number(v)>max)throw fail('Invalid customer directory page.');return Number(v);};
 if(req.query.q!==undefined&&(typeof req.query.q!=='string'||req.query.q.length>200))throw fail('Search must contain at most 200 characters.');
 for(const key of ['from','to','categoryId'])if(req.query[key]!==undefined&&(typeof req.query[key]!=='string'||req.query[key].length>100))throw fail('Invalid directory filter.');
 return {view,page:number(req.query.page,1,100000),pageSize:number(req.query.pageSize,50,100),q:(req.query.q||'').trim(),filters:Object.fromEntries(['from','to','categoryId'].filter(k=>req.query[k]).map(k=>[k,req.query[k]]))};
}
async function sourceSnapshot(){
 const manifest=await DirectoryState.findOne({key:'matter_customer_directory'}).lean();
 const saved=Boolean(manifest?.activeGeneration&&manifest?.lastSuccessfulAt);
 const live=manifest?.report?.automaticRefresh?.remoteDatabase===true;
 const partial=manifest?.status==='partial';
 const sources=Object.fromEntries(Object.entries(manifest?.report?.sources||{}).map(([name,value])=>[name,{state:value.state,observedAt:value.observedAt,lastAttemptAt:value.lastAttemptAt}]));
 const nutritionLive=manifest?.report?.automaticRefresh?.nutritionAdmin===true;
 const nutritionAvailable=nutritionLive&&sources.nutritionAdmin?.state==='available';
 let message='Customer sync unavailable';
 if(saved){
  if(!partial&&manifest.status!=='ready')message='Sync failed · showing saved data';
  else if(sources.nutritionDatabase?.state==='available'&&manifest?.report?.nutritionDatabaseRead?.supabaseMirror?.verified===true)message=partial?'Live customers · history unavailable':'Live customer database';
  else if(sources.nutritionDatabase?.state==='unavailable')message='Customer database unavailable · showing saved data';
  else if(sources.supabase?.state==='available')message=manifest?.report?.apiRead?.supabaseMirror?.verified===true?'Live subscriptions · saved customer history':'Supabase connected · stored customer data';
  else if(sources.supabase?.state==='unavailable')message='Supabase unavailable · showing saved data';
  else if(nutritionAvailable){
   if(sources.remoteDatabase?.state==='unavailable')message='Customers synced · delivery database unavailable';
   else if(sources.remoteDatabase?.state==='snapshot')message='Customers synced · delivery snapshot';
   else message=live&&sources.remoteDatabase?.state==='available'?'Live sync':'Customers synced';
  }else message=partial?'API updated · database unavailable':live?'Live sync':'Saved customer directory';
 }
 return {base:{active:true,generation:manifest?.activeGeneration||'__no_committed_generation__'},source:{state:saved?(partial?'partial':manifest.status==='ready'?'available':'stale'):'unavailable',coverage:manifest?.report?.coverage||'unknown',message,observedAt:manifest?.sourceObservedAt||manifest?.lastSuccessfulAt||null,remoteObservedAt:manifest?.report?.remoteDatabaseObservedAt||manifest?.report?.remoteSnapshotObservedAt||null,apiObservedAt:manifest?.report?.apiObservedAt||null,nutritionObservedAt:manifest?.report?.nutritionObservedAt||null,automaticSupabaseSync:manifest?.report?.automaticRefresh?.supabase===true,supabaseObservedAt:manifest?.report?.supabaseObservedAt||null,automaticRemoteSync:live,automaticNutritionSync:nutritionLive,sources}};
}
function nativeContactReferences(c){
 const metadata=c?.sourceMetadata;
 if(c?.source==='gallabox_history'){
  if(metadata?.historySourceIdentityState==='verified_same_customer'){
   const refs=metadata.historySourceIdentities;
   return Array.isArray(refs)&&refs.length>1&&refs.every(ref=>ref.sourceRevision===c.sourceRevision&&ref.scope&&ref.externalContactId)?refs.map(({scope,externalContactId})=>({scope,externalContactId})):[];
  }
  const history=metadata?.historySourceIdentity;
  return history?.sourceRevision===c.sourceRevision&&history.scope&&history.externalContactId?[{scope:history.scope,externalContactId:history.externalContactId}]:[];
 }
 return c?.source==='gallabox'&&metadata?.externalContactId?[{scope:c.scope,externalContactId:metadata.externalContactId}]:[];
}
const nativeContactReference=c=>{const refs=nativeContactReferences(c);return refs.length===1?refs[0]:null;};
async function sourceContacts(conversations){
 const pairs=conversations.flatMap(nativeContactReferences);
 if(!pairs.length)return new Map();
 const rows=await SourceContact.find({$or:pairs}).lean();
 for(const contact of rows.filter(c=>c.matchState==='reviewed_scoped')){
  const proof=await readValidatedNativeSenderProof(contact);contact.verifiedConversationIds=[];if(!proof)continue;
  for(const c of conversations){const refs=nativeContactReferences(c);if(!refs.some(r=>r.scope===contact.scope&&r.externalContactId===contact.externalContactId))continue;
   const messages=c.source==='gallabox_history'?(cloudInbox()?await readCloudEvidence({conversationId:c._id,source:'gallabox_history'}):await Message.find({conversationId:c._id,source:'gallabox_history'}).lean()):[];
   if(scopedSenderProofCoversConversation(c,proof,messages))contact.verifiedConversationIds.push(String(c._id));
  }
 }
 return new Map(rows.map(c=>[JSON.stringify([c.scope,c.externalContactId]),c]));
}
const contactFor=(conversation,contacts)=>{const ref=nativeContactReference(conversation);return ref?contacts.get(JSON.stringify([ref.scope,ref.externalContactId])):undefined;};
function matchState(customerId,issues,byConversation,contacts){
 if(!issues.length)return 'no_linked_conversations';
 const records=issues.flatMap(i=>{const refs=nativeContactReferences(byConversation.get(String(i.conversationId)));return refs.length?refs.map(ref=>{const c=contacts.get(JSON.stringify([ref.scope,ref.externalContactId]));return c?.matchState==='reviewed_scoped'&&c.verifiedConversationIds?.includes(String(i.conversationId))?{...c,matchState:'matched'}:c;}):[undefined];});
 if(records.some(c=>c&&c.matchState!=='matched'))return records.find(c=>c&&c.matchState!=='matched').matchState;
 return records.every(c=>c?.matchState==='matched'&&c.customerId===customerId)?'matched':'linked_identity_unverified';
}
async function scoped(req,filters={},options={}){
 return {issues:await getScopedServiceIssues({actor:req.user,profile:req.serviceProfile,filters,...options})};
}
async function currentSource(snapshot){const latest=await sourceSnapshot();if(latest.base.generation!==snapshot.base.generation)throw fail('The customer directory refreshed during this request. Reload to view the current snapshot.',409);return latest.source;}
const wrap=fn=>async(req,res,next)=>{try{await fn(req,res,next);}catch(e){res.status(e.statusCode||503).json({success:false,message:e.statusCode?e.message:'Customer directory could not be loaded. Retry when the saved source is available.'});}};
router.use((req,res,next)=>{res.set({'Cache-Control':'private, no-store','Pragma':'no-cache'});next();});
router.get('/customers',protect,requireServiceAccess,wrap(async(req,res)=>{
 const {view,page,pageSize,q,filters}=query(req);
 const snapshot=await sourceSnapshot();
 const {issues}=await scoped(req,filters,{referencesOnly:true});
 const linkedIds=[...new Set(issues.map(i=>i.customerId).filter(Boolean))];
 const conversations=await Conversation.find({_id:{$in:[...new Set(issues.map(i=>String(i.conversationId)))]}}).select('source scope customerId customerName sourceMetadata sourceRevision externalConversationId lastMessageAt').lean();
 const byConversation=new Map(conversations.map(c=>[String(c._id),c]));
 const contacts=await sourceContacts(conversations);
 const groups=new Map();
 for(const issue of issues){
  const c=byConversation.get(String(issue.conversationId));if(!c||issue.customerId||c.customerId)continue;
  const contact=nativeContactReference(c)?.externalContactId||null;
  const key=JSON.stringify([c.source,c.scope,contact?'contact':'conversation',contact||String(c._id)]);
  const sourceContact=contactFor(c,contacts);
  if(!groups.has(key))groups.set(key,{key,customerId:'',name:sourceContact?.name||c.customerName||issue.customerName||'Name not recorded',email:sourceContact?.email||'',phone:sourceContact?.phone||'',subscriptions:[],issues:[],source:c.source,sourceObservedAt:sourceContact?.observedAt||null,matchState:sourceContact?.matchState||'unmatched',conversationIds:new Set()});
  const group=groups.get(key);group.issues.push(issue);group.conversationIds.add(String(c._id));
 }
 const allGroups=[...groups.values()];
 const base={...snapshot.base,...(!req.serviceCapabilities.supervise?{customerId:{$in:linkedIds}}:{})};
 const directoryCustomers=await Customer.countDocuments(base);
 const counts={directoryCustomers,linkedCustomers:await Customer.countDocuments({...base,customerId:{$in:linkedIds}}),unmatchedContacts:groups.size,unmatchedConversations:new Set(allGroups.flatMap(g=>[...g.conversationIds])).size};
 let records,total;
 if(view==='unmatched'){
  const selected=allGroups.filter(g=>!q||[g.name,g.email,g.phone,...g.issues.map(i=>i.summary||'')].join(' ').toLowerCase().includes(q.toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name)||a.key.localeCompare(b.key));total=selected.length;
  const actualPage=Math.min(page,Math.max(1,Math.ceil(total/pageSize)));const selectedGroups=selected.slice((actualPage-1)*pageSize,actualPage*pageSize);
  const details=await getScopedServiceIssues({actor:req.user,profile:req.serviceProfile,filters,issueIds:selectedGroups.flatMap(g=>g.issues.map(i=>i._id))});const detailMap=new Map(details.map(i=>[String(i._id),i]));
  records=selectedGroups.map(({conversationIds,...record})=>({...record,issues:record.issues.map(i=>detailMap.get(String(i._id))).filter(Boolean)}));
  return res.json({success:true,data:{records,total,page:actualPage,pageSize,counts,source:await currentSource(snapshot)}});
 }
 const filter={...base};if(filters.categoryId||filters.from||filters.to)filter.customerId={$in:linkedIds};
 if(q){const literal=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');filter.$or=['name','email','phone','customerId'].map(k=>({[k]:{$regex:literal,$options:'i'}}));}
 total=await Customer.countDocuments(filter);const actualPage=Math.min(page,Math.max(1,Math.ceil(total/pageSize)));
 const customers=await Customer.find(filter).sort({name:1,customerId:1}).skip((actualPage-1)*pageSize).limit(pageSize).lean();
 const details=await getScopedServiceIssues({actor:req.user,profile:req.serviceProfile,filters,issueIds:issues.filter(i=>customers.some(c=>c.customerId===i.customerId)).map(i=>i._id)});
 records=customers.map(c=>({...fields(c),issues:details.filter(i=>i.customerId===c.customerId),matchState:matchState(c.customerId,issues.filter(i=>i.customerId===c.customerId),byConversation,contacts)}));
 res.json({success:true,data:{records,total,page:actualPage,pageSize,counts,source:await currentSource(snapshot)}});
}));
router.get('/customers/:id/context',protect,requireServiceAccess,wrap(async(req,res,next)=>{
 if(typeof req.params.id!=='string'||req.params.id.length>160)throw fail('Invalid customer ID.');
 // Check scope before the customer lookup so reviewers cannot enumerate IDs.
 const {filters}=query(req);const {issues:related}=await scoped(req,filters,{customerId:req.params.id});
 if(!req.serviceCapabilities.supervise&&!related.length)throw fail('Only your assigned customer records are available.',403);
 const snapshot=await sourceSnapshot();
 const customer=await Customer.findOne({customerId:req.params.id,...snapshot.base}).lean();if(!customer)return next('router');
 const conversations=await Conversation.find({_id:{$in:related.map(i=>i.conversationId)}}).select('source scope customerId sourceMetadata sourceRevision').lean();
 const contacts=await sourceContacts(conversations);
 const source=await currentSource(snapshot);res.json({success:true,data:{customer:{customerId:customer.customerId,name:customer.name,email:customer.email,phone:customer.phone},subscriptions:subscriptions(customer.subscriptions),issues:related,source:{...source,observedAt:customer.sourceObservedAt||source.observedAt},sourceState:source.state,observedAt:customer.sourceObservedAt,matchState:matchState(customer.customerId,related,new Map(conversations.map(c=>[String(c._id),c])),contacts)}});
}));
export default router;
