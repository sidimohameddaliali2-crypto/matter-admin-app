import XLSX from 'xlsx';
import ServiceIssue from '../models/ServiceIssue.js';
import ServiceReview from '../models/ServiceReview.js';
import ServiceAction from '../models/ServiceAction.js';
import { SERVICE_TAXONOMY_VERSION } from '../config/customerServiceCategories.js';
import ServiceMessage from '../models/ServiceMessage.js';
import ServiceStaffProfile from '../models/ServiceStaffProfile.js';
import ServiceCaptureBatch from '../models/ServiceCaptureBatch.js';
import { captureRange, safeSheetText } from './customerServiceCaptureFormat.js';

const id=v=>String(v?._id||v||'');
export async function getServiceSnapshot({userId,supervise,filters={}}) {
  const range=captureRange(filters);
  let filter={};
  if(filters.categoryId) filter.categoryIds=String(filters.categoryId);
  if(filters.q) {
    const escaped=String(filters.q).slice(0,200).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    filter.$or=['customerName','customerId','summary'].map(key=>({[key]:{$regex:escaped,$options:'i'}}));
  }
  if(range.from) {
    const conversations=await ServiceMessage.distinct('conversationId',{sentAt:{$gte:range.from,$lt:range.to}});
    if(conversations.length>10000) throw Object.assign(new Error('Narrow the report date range'),{statusCode:422});
    filter.$and=[{$or:[{episodeFrom:{$lt:range.to},episodeTo:{$gte:range.from}},{episodeFrom:null,conversationId:{$in:conversations}}]}];
  }
  if(!supervise) {
    const ownReviews=await ServiceReview.find({reviewerId:userId}).select('issueId').limit(10001).lean();
    const ownActions=await ServiceAction.find({ownerId:userId}).select('issueId').limit(10001).lean();
    filter._id={$in:[...ownReviews,...ownActions].map(r=>r.issueId)};
  }
  const issues=await ServiceIssue.find(filter).sort({updatedAt:-1}).limit(5001).lean();
  if(issues.length>5000) throw Object.assign(new Error('Report exceeds 5000 issues; narrow the date range'),{statusCode:422});
  const issueIds=issues.map(x=>x._id);
  const [reviews,actions,profiles,capture]=await Promise.all([
    ServiceReview.find({issueId:{$in:issueIds},...(!supervise?{reviewerId:userId}:{})}).lean(),
    ServiceAction.find({issueId:{$in:issueIds},...(!supervise?{ownerId:userId}:{})}).lean(),
    ServiceStaffProfile.find(supervise?{enabled:true}:{userId}).populate('userId','profile.firstName profile.lastName isActive').lean(),
    supervise?ServiceCaptureBatch.findOne({status:'completed'}).sort({createdAt:-1}).lean():null,
  ]);
  return {issues,reviews,actions,profiles,capture,asOf:new Date().toISOString(),filters};
}
export function summarizeServiceSnapshot(snapshot) {
  const {issues,reviews,actions,profiles,capture,asOf}=snapshot;
  const open=actions.filter(a=>a.status!=='completed');
  const overdue=a=>[a.dueAt,a.promisedDueAt].filter(Boolean).some(d=>new Date(d)<new Date(asOf));
  const workload=profiles.map(p=>{
    const user=p.userId;const own=reviews.filter(r=>id(r.reviewerId)===id(user));
    const name=p.displayName||`${user?.profile?.firstName||''} ${user?.profile?.lastName||''}`.trim()||'Staff';
    return {userId:id(user),displayName:name,availableMinutes:p.availableMinutes||0,assigned:own.length,
      reviewed:own.filter(r=>r.status==='submitted').length,remaining:own.filter(r=>r.status!=='submitted'&&r.status!=='skipped').length,
      openActions:open.filter(a=>id(a.ownerId)===id(user)).length,overdueActions:open.filter(a=>id(a.ownerId)===id(user)&&overdue(a)).length};
  });
  const latest=r=>r.revisions?.[r.revisions.length-1]||{};
  const quality={};
  for(const sample of ['baseline','targeted']) {
    const assessed=reviews.filter(r=>r.sampleType===sample&&r.status==='submitted'&&!r.stale&&!latest(r).provisional&&['good','needs_work'].includes(latest(r).verdict));
    quality[sample]={assessed:assessed.length,good:assessed.filter(r=>latest(r).verdict==='good').length,needsWork:assessed.filter(r=>latest(r).verdict==='needs_work').length};
  }
  return {asOf,reviewWorkload:workload,actions:{open:open.length,overdue:open.filter(overdue).length,unassigned:open.filter(a=>!a.ownerId).length},
    quality,coverage:{eligible:issues.length,reviewed:new Set(reviews.filter(r=>r.status==='submitted').map(r=>id(r.issueId))).size,insufficient:reviews.filter(r=>latest(r).verdict==='insufficient').length,provisional:reviews.filter(r=>latest(r).provisional).length,stale:reviews.filter(r=>r.stale).length},
    capture:{lastSuccessAt:capture?.createdAt||null,from:capture?.from||null,to:capture?.to||null,status:capture?'Dated import; live coverage not verified':'No capture yet'}};
}
const clean=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='string'?safeSheetText(v):v??''])));
export async function buildServiceWorkbook(snapshot) {
  const {issues,reviews,actions}=snapshot;const report=summarizeServiceSnapshot(snapshot);
  const issueMap=new Map(issues.map(i=>[id(i),i]));
  const conversations=[...new Set(issues.map(i=>id(i.conversationId)))];
  const messages=await ServiceMessage.find({conversationId:{$in:conversations}}).sort({sentAt:1,_id:1}).limit(50001).lean();
  if(messages.length>50000) throw Object.assign(new Error('Export exceeds 50000 messages; narrow the date range'),{statusCode:422});
  const book=XLSX.utils.book_new();
  const sheets={
    Summary:[{Metric:'Generated at',Value:report.asOf},{Metric:'Display timezone',Value:'Asia/Dubai; source timestamps exported as UTC ISO instants'},{Metric:'Taxonomy version',Value:SERVICE_TAXONOMY_VERSION},{Metric:'Scope',Value:snapshot.filters?.from?`${snapshot.filters.from} to ${snapshot.filters.to}`:'All captured dates'},{Metric:'Unique issues',Value:issues.length},{Metric:'Reviewed issues',Value:report.coverage.reviewed},{Metric:'Open actions',Value:report.actions.open},{Metric:'Overdue actions',Value:report.actions.overdue},{Metric:'Unassigned actions',Value:report.actions.unassigned},{Metric:'Capture',Value:report.capture.status}],
    Problems:issues.map(i=>({Issue:id(i),Customer:i.customerName,CustomerID:i.customerId,Categories:(i.categoryIds||[]).join('; '),Outcome:i.outcome,Summary:i.summary,OpenActions:actions.filter(a=>id(a.issueId)===id(i)&&a.status!=='completed').length})),
    Customers:[...new Map(issues.map(i=>[i.customerId||id(i),{CustomerID:i.customerId,Customer:i.customerName}])).values()],
    'Customer chats':messages.map(m=>({MessageID:m.externalMessageId,ConversationID:m.externalConversationId,SentAt:new Date(m.sentAt).toISOString(),Author:m.authorName,AuthorType:m.authorType,Type:m.type,Text:m.text,MediaState:m.mediaState})),
    'Review evidence':reviews.map(r=>({Review:id(r),Issue:id(r.issueId),Customer:issueMap.get(id(r.issueId))?.customerName,Reviewer:id(r.reviewerId),Status:r.status,Verdict:r.revisions?.at(-1)?.verdict,Stale:!!r.stale,Summary:r.revisions?.at(-1)?.summary})),
  };
  for(const [name,rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(clean(rows.length?rows:[{Status:'No records in this scope'}])),name);
  book.Workbook={Sheets:book.SheetNames.map((name,i)=>({name,Hidden:i<4?0:1}))};
  return XLSX.write(book,{type:'buffer',bookType:'xlsx'});
}
