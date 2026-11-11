import * as XLSX from 'xlsx';
import {createHash} from 'node:crypto';
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(value);
// Conversation exports supply contact seeds for a scoped native read, not proof
// of message completeness. A seed's id remains an actual source conversation ID.
export function extractHistoryContactSeeds(bytes,{accountId,channelId}={}) {
 if(!validId(accountId)||!validId(channelId))throw new Error('Explicit account and channel required');
 const workbook=XLSX.read(bytes,{type:'buffer'});
 const required=['conversationId','accountId','channelId','contactId','contactName','updatedAt'];
 const sheets=workbook.SheetNames.filter(name=>{const rows=XLSX.utils.sheet_to_json(workbook.Sheets[name],{header:1});return required.every(h=>rows[0]?.includes(h));});
 if(sheets.length!==1)throw new Error('Expected exactly one native conversation export sheet');
 const rows=XLSX.utils.sheet_to_json(workbook.Sheets[sheets[0]],{defval:''});
 const report={sourceRows:rows.length,scopeMatchedRows:0,unrelatedScopeRows:0,missingScopeRows:0,missingIdentityRows:0,conflictingConversationIds:0,conflictingRows:0,duplicateConversationRows:0,uniqueConversations:0,uniqueContactSeeds:0};
 const candidates=new Map(),conflicts=new Set();
 for(const row of rows){
  if(!validId(row.accountId)||!validId(row.channelId)){report.missingScopeRows++;continue;}
  if(row.accountId!==accountId||row.channelId!==channelId){report.unrelatedScopeRows++;continue;}
  report.scopeMatchedRows++;
  if(!validId(row.conversationId)||!validId(row.contactId)){report.missingIdentityRows++;continue;}
  const prior=candidates.get(row.conversationId);
  if(prior){report.duplicateConversationRows++;if(prior.contactId!==row.contactId)conflicts.add(row.conversationId);}
  else candidates.set(row.conversationId,row);
 }
 report.conflictingConversationIds=conflicts.size;
 report.conflictingRows=rows.filter(r=>r.accountId===accountId&&r.channelId===channelId&&conflicts.has(r.conversationId)).length;
 const byContact=new Map();
 for(const row of candidates.values()){
  if(conflicts.has(row.conversationId))continue;
  report.uniqueConversations++;
  const seed={id:row.conversationId,channelId:row.channelId,contactId:row.contactId,email:typeof row.email==='string'?row.email.slice(0,320):'',phone:typeof row.phone==='string'||typeof row.phone==='number'?String(row.phone).slice(0,80):'',name:typeof row.contactName==='string'?row.contactName.slice(0,200):'',updatedAt:typeof row.updatedAt==='string'&&Number.isFinite(Date.parse(row.updatedAt))?new Date(row.updatedAt).toISOString():null};
  const list=byContact.get(seed.contactId)||[];list.push(seed);byContact.set(seed.contactId,list);
 }
 const seeds=[...byContact.values()].map(list=>{
  list.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')||a.id.localeCompare(b.id));
  return {...list[0],conversationIds:list.map(seed=>seed.id).sort()};
 }).sort((a,b)=>a.contactId.localeCompare(b.contactId));
 report.uniqueContactSeeds=seeds.length;
 return {seeds,report,workbookSha256:createHash('sha256').update(bytes).digest('hex'),sourceSheet:sheets[0]};
}
