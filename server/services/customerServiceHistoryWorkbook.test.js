import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { extractHistoryWorkbook,parseHistoryTimestamp } from './customerServiceHistoryWorkbook.js';
function fixture({conflict=false}={}){
 const sheet=XLSX.utils.aoa_to_sheet([[],[],[],['Customer','Category','Outcome','Message 1'],['P-1','','','08 Aug 2026, 01:02:03 Dubai\nCustomer\nHello'],['P-1','','',`08 Aug 2026, 01:02:03 Dubai\nCustomer\n${conflict?'Changed':'Hello'}`]]);
 for(const address of ['D5','D6'])sheet[address].c=[{a:'Source',t:'Message native-id\noriginal.xlsx; worksheet row 7\nSource status: received'}];
 const data=XLSX.utils.aoa_to_sheet([['Source message ID','Conversation ID'],['native-id','conversation-id']]);
 return XLSX.write({SheetNames:['Customer chats','Data'],Sheets:{'Customer chats':sheet,Data:data}},{type:'buffer',bookType:'xlsx'});
}
test('deduplicates repeated displayed evidence while preserving every provenance and explicit mapping',()=>{
 const result=extractHistoryWorkbook(fixture());assert.equal(result.messages.length,1);assert.equal(result.messages[0].provenance.length,2);assert.equal(result.report.repeatedDisplayCells,1);assert.equal(result.report.importReady,false);assert.deepEqual(result.messages[0].conversationIdsFromOpeningEvidence,['conversation-id']);assert.equal(result.messages[0].observations[0].sentAt,'2026-08-07T21:02:03.000Z');assert.equal(result.messages[0].externalAuthorId,undefined);
});
test('retains conflicting observations instead of choosing one',()=>{const result=extractHistoryWorkbook(fixture({conflict:true}));assert.equal(result.report.conflictingMessageIds,1);assert.equal(result.messages[0].observations.length,2);});
test('rejects invalid calendar and ambiguous timezone dates',()=>{assert.throws(()=>parseHistoryTimestamp('31 Feb 2026, 00:00:00 Dubai'));assert.throws(()=>parseHistoryTimestamp('08 Aug 2026, 01:02:03'));});

test('isolated capture deduplicates transcript overlap and quarantines conflicts',async()=>{
 const {prepareIsolatedHistoryBatches}=await import('./customerServiceHistoryWorkbook.js');
 const result=prepareIsolatedHistoryBatches(extractHistoryWorkbook(fixture()));
 assert.equal(result.batches.length,1);assert.equal(result.batches[0].messages.length,1);
 assert.equal(result.batches[0].source,'gallabox_history');assert.equal(result.batches[0].messages[0].externalConversationId,'history:native-id');
 assert.equal(prepareIsolatedHistoryBatches(extractHistoryWorkbook(fixture({conflict:true}))).batches.length,0);
 assert.deepEqual(prepareIsolatedHistoryBatches(extractHistoryWorkbook(fixture())),result);
});

test('capture normalization preserves bounded source provenance without accepting unrelated fields',async()=>{
 const {prepareIsolatedHistoryBatches}=await import('./customerServiceHistoryWorkbook.js');
 const {normalizeServiceMessage}=await import('./customerServiceCaptureFormat.js');
 const batch=prepareIsolatedHistoryBatches(extractHistoryWorkbook(fixture())).batches[0];
 const raw=batch.messages[0];raw.sourceMetadata.history.secret='must disappear';
 const normalized=normalizeServiceMessage(raw,batch);
 assert.equal(normalized.sourceMetadata.history.cell,'D5');assert.equal(normalized.sourceMetadata.history.sourceRow,7);
 assert.equal(normalized.sourceMetadata.history.secret,undefined);
 assert.equal(normalizeServiceMessage(raw,{...batch,source:'gallabox'}).sourceMetadata,undefined);
 assert.throws(()=>normalizeServiceMessage({...raw,sourceMetadata:{history:{...raw.sourceMetadata.history,sourceRow:-1}}},batch));
});
