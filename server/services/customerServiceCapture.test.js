import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServiceMessage, safeSheetText, verifyCaptureSignature, captureRange } from './customerServiceCaptureFormat.js';
import { createHmac } from 'node:crypto';

const row = { externalMessageId:'m1', externalConversationId:'c1', customerId:'CUST-1', customerName:'Example', authorType:'customer', authorName:'Example', sentAt:'2026-11-06T06:00:00Z', text:'My code fails', type:'text' };
test('capture preserves stable source identity and exact customer text', () => {
 const m=normalizeServiceMessage(row,{source:'gallabox_export',scope:'matter'});
 assert.equal(m.externalMessageId,'m1'); assert.equal(m.text,row.text); assert.equal(m.sentAt.toISOString(),'2026-11-06T06:00:00.000Z');
});
test('capture refuses missing IDs and ambiguous local dates',()=>{
 assert.throws(()=>normalizeServiceMessage({...row,externalMessageId:''},{scope:'matter'}),/ID/);
 assert.throws(()=>normalizeServiceMessage({...row,sentAt:'6/11/2026 10:00'},{scope:'matter'}),/timestamp/);
});
test('sender names cannot grant staff identity and absent audio stays unavailable',()=>{
 const m=normalizeServiceMessage({...row,type:'audio',authorType:'staff',authorId:'untrusted',text:''},{scope:'matter'});
 assert.equal(m.authorId,null); assert.equal(m.mediaState,'unavailable');
});
test('formula-looking text remains literal in exports',()=>{
 for(const v of ['=HYPERLINK("x")','+1','-1','@SUM(1)','\t=1']) assert.ok(safeSheetText(v).startsWith("'"));
 assert.equal(safeSheetText('ordinary quote'),'ordinary quote');
});
test('capture signature uses raw bytes and rejects wrong length and replayed content',()=>{
 const raw=Buffer.from('{"messages":[]}'); const sig=createHmac('sha256','fixture').update(raw).digest('base64');
 assert.equal(verifyCaptureSignature(raw,sig,'fixture'),true);
 assert.equal(verifyCaptureSignature(raw,'x','fixture'),false);
 assert.equal(verifyCaptureSignature(Buffer.from('{}'),sig,'fixture'),false);
 assert.equal(verifyCaptureSignature(raw,sig,''),false);
});
test('date filter is Dubai day and rejects bad ranges',()=>{
 const r=captureRange({from:'2026-11-06',to:'2026-11-06'});
 assert.equal(r.from.toISOString(),'2026-11-05T20:00:00.000Z'); assert.equal(r.to.toISOString(),'2026-11-06T20:00:00.000Z');
 assert.throws(()=>captureRange({from:'2026-11-07',to:'2026-11-06'}),/range/);
});
test('native contact identity is retained only for native source and validated',()=>{
 const raw={...row,sourceMetadata:{externalContactId:'contact-fixture'}};
 assert.equal(normalizeServiceMessage(raw,{source:'gallabox',scope:'account:channel'}).sourceMetadata.externalContactId,'contact-fixture');
 assert.equal(normalizeServiceMessage(raw,{source:'fixture',scope:'isolated'}).sourceMetadata,undefined);
 assert.throws(()=>normalizeServiceMessage({...raw,sourceMetadata:{externalContactId:'invalid contact'}},{source:'gallabox',scope:'account:channel'}),/contact/i);
});
test('internal-note boolean is derived only from verified native event metadata',()=>{
 const base={externalMessageId:'note',externalConversationId:'thread',sentAt:'2026-11-06T00:00:00Z',type:'other',authorType:'staff'};
 assert.equal(normalizeServiceMessage({...base,internalNote:true},{source:'gallabox',scope:'a:b'}).internalNote,false);
 assert.equal(normalizeServiceMessage({...base,sourceMetadata:{nativeEvent:{kind:'internal_note',timestampBasis:'createdAt'}}},{source:'gallabox',scope:'a:b'}).internalNote,true);
 assert.equal(normalizeServiceMessage({...base,sourceMetadata:{nativeEvent:{kind:'internal_note',timestampBasis:'createdAt'}}},{source:'gallabox_history',scope:'book'}).internalNote,false);
});
