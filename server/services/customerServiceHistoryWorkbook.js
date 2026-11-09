import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';

const digest = value => createHash('sha256').update(value).digest('hex');
const commentText = cell => (cell?.c || []).map(c => c.t || '').join('\n');
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function parseHistoryTimestamp(value) {
  const match = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4}), (\d{2}:\d{2}:\d{2}) Dubai$/.exec(value);
  if (!match || !months.includes(match[2])) throw new Error('Unsupported historical timestamp');
  const iso = `${match[3]}-${String(months.indexOf(match[2])+1).padStart(2,'0')}-${match[1]}T${match[4]}+04:00`;
  const parsed = new Date(iso);
  if (!Number.isFinite(+parsed) || new Date(+parsed+14400000).toISOString().slice(0,19) !== iso.slice(0,19)) throw new Error('Invalid historical timestamp');
  return parsed.toISOString();
}

// This workbook is a curated review, not the native message export. Preserve its
// source observations without inferring account, contact, sender or conversation.
export function extractHistoryWorkbook(bytes) {
  const workbook = XLSX.read(bytes, { type:'buffer' });
  const sheet = workbook.Sheets['Customer chats'];
  if (!sheet || sheet.A4?.v !== 'Customer' || sheet.D4?.v !== 'Message 1') throw new Error('Unsupported historical workbook layout');
  const workbookSha256 = digest(bytes);
  const data = XLSX.utils.sheet_to_json(workbook.Sheets.Data || {}, {header:1});
  const header = data.findIndex(row => row.includes('Source message ID') && row.includes('Conversation ID'));
  const openingMappings = new Map();
  if (header >= 0) {
    const h = data[header];
    for (const row of data.slice(header+1)) {
      const id = row[h.indexOf('Source message ID')], conversation = row[h.indexOf('Conversation ID')];
      if (typeof id !== 'string' || typeof conversation !== 'string' || !id || !conversation) continue;
      const ids = openingMappings.get(id) || new Set(); ids.add(conversation); openingMappings.set(id, ids);
    }
  }
  const records = new Map(), rejected = [], transcripts = [];
  let displayedMessageCells=0;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let r=4;r<=range.e.r;r++) {
    const customerCell=sheet[XLSX.utils.encode_cell({r,c:0})];
    if (!customerCell?.v) continue;
    const rowMessages=[];
    for (let c=3;c<=range.e.c;c++) {
      const address=XLSX.utils.encode_cell({r,c}), cell=sheet[address];
      if (!cell || cell.v == null || cell.v === '') continue;
      displayedMessageCells++;
      const comments=commentText(cell);
      const id=/^Message ([a-zA-Z0-9_-]{1,180})(?:\n|$)/.exec(comments)?.[1];
      const source=/\n([^\n]+\.xlsx); ([^\n]+) row (\d+)/.exec(comments);
      const status=/\nSource status: ([^\n]+)/.exec(comments)?.[1] || '';
      const provenance={sheet:'Customer chats',cell:address,sourceWorkbook:source?.[1]||'',sourceSheet:source?.[2]||'',sourceRow:source?Number(source[3]):null,sourceStatus:status};
      if (!id || !source) { rejected.push({cell:address,reason:'missing_source_identity'}); continue; }
      const [time,authorLabel,...body]=String(cell.v).split('\n');
      let sentAt;try {sentAt=parseHistoryTimestamp(time);}catch {rejected.push({cell:address,reason:'invalid_source_timestamp'});continue;}
      const text=body.join('\n');
      const media=/^\[(Image|Document|Video|Audio|Location|Reaction|Sticker|Unsupported|Contacts|Interactive) — content not available in export\]$/.exec(text);
      const type=media?(['image','document','video','audio','location'].includes(media[1].toLowerCase())?media[1].toLowerCase():'other'):'text';
      const authorType=authorLabel==='Customer'?'customer':/^Staff(?: \(not delivered\))?$/.test(authorLabel)?'staff':'unknown';
      const observation={sentAt,authorType,authorLabel,type,text,sourceStatus:status};
      const existing=records.get(id)||{externalMessageId:id,observations:[],provenance:[]};
      if(!existing.observations.some(value=>JSON.stringify(value)===JSON.stringify(observation)))existing.observations.push(observation);
      existing.provenance.push(provenance);records.set(id,existing);rowMessages.push(id);
    }
    transcripts.push({sourceRow:r+1,customerLabel:String(customerCell.v),category:String(sheet[XLSX.utils.encode_cell({r,c:1})]?.v||''),reportedOutcome:String(sheet[XLSX.utils.encode_cell({r,c:2})]?.v||''),messageIds:rowMessages});
  }
  const messages=[...records.values()].map(record=>({...record,conversationIdsFromOpeningEvidence:[...(openingMappings.get(record.externalMessageId)||[])],conflicted:record.observations.length!==1}));
  const dates=messages.flatMap(m=>m.observations.map(o=>o.sentAt)).sort();
  return {version:1,workbookSha256,messages,transcripts,rejected,report:{
    displayedMessageCells,uniqueSourceMessageIds:messages.length,repeatedDisplayCells:displayedMessageCells-rejected.length-messages.length,
    rejectedCells:rejected.length,conflictingMessageIds:messages.filter(m=>m.conflicted).length,transcriptRows:transcripts.length,
    messagesWithUniqueOpeningConversationEvidence:messages.filter(m=>m.conversationIdsFromOpeningEvidence.length===1).length,
    messagesWithoutOpeningConversationEvidence:messages.filter(m=>!m.conversationIdsFromOpeningEvidence.length).length,
    firstMessageAt:dates[0]||null,lastMessageAt:dates.at(-1)||null,
    importReady:false,coverage:'curated_partial',
    limitations:['Curated problem transcripts overlap and do not establish complete three-month message history.','Opening-message conversation mappings cannot be applied to later messages.','Account, channel and sender IDs require the original native message export.','Displayed author labels are retained without assigning staff users.','Media contents and omitted private links are not recoverable from this workbook.','Conflicting observations are retained and require source reconciliation.'],
  }};
}

// Synthetic groups are connected components of overlapping curated transcript
// rows. They are explicitly NOT native Gallabox conversations or customer links.
export function prepareIsolatedHistoryBatches(extraction) {
  const parents=new Map(extraction.messages.map(m=>[m.externalMessageId,m.externalMessageId]));
  function root(id){let at=id;while(parents.get(at)!==at)at=parents.get(at);while(parents.get(id)!==id){const next=parents.get(id);parents.set(id,at);id=next;}return at;}
  function join(a,b){a=root(a);b=root(b);if(a!==b)parents.set(a<b?b:a,a<b?a:b);}
  for(const row of extraction.transcripts)for(const id of row.messageIds.slice(1))join(row.messageIds[0],id);
  const labels=new Map();
  for(const row of extraction.transcripts){if(!row.messageIds.length)continue;const group=root(row.messageIds[0]);const names=labels.get(group)||new Set();names.add(row.customerLabel);labels.set(group,names);}
  const messages=extraction.messages.filter(m=>!m.conflicted).map(record=>{
    const observation=record.observations[0],group=root(record.externalMessageId),names=[...(labels.get(group)||[])];
    return {externalMessageId:record.externalMessageId,externalConversationId:`history:${group}`,
      customerName:names.length===1?names[0]:'Historical transcript — identity requires review',customerId:'',
      externalAuthorId:'',authorName:observation.authorLabel,authorType:observation.authorType,
      sentAt:observation.sentAt,type:observation.type,text:observation.text,sourceRow:record.provenance[0].sourceRow,sourceMetadata:{history:{workbookSha256:extraction.workbookSha256,...record.provenance[0]}}};
  }).sort((a,b)=>a.externalConversationId.localeCompare(b.externalConversationId)||a.sentAt.localeCompare(b.sentAt)||a.externalMessageId.localeCompare(b.externalMessageId));
  const scope=`workbook:${extraction.workbookSha256}`;
  const batches=[];
  for(let start=0;start<messages.length;start+=500){const chunk=messages.slice(start,start+500);batches.push({source:'gallabox_history',scope,requestId:`history:${digest(JSON.stringify({scope,messages:chunk}))}`,messages:chunk});}
  return {batches,report:{...extraction.report,isolatedMessages:messages.length,quarantinedMessageIds:extraction.messages.filter(m=>m.conflicted).map(m=>m.externalMessageId),syntheticTranscriptGroups:new Set(messages.map(m=>m.externalConversationId)).size,batchCount:batches.length,identityStrategy:'Isolated workbook scope and synthetic overlapping-transcript groups; native message IDs retained. Not deduplicated against live Gallabox because canonical scope/conversation and original text are unverified.'}};
}
