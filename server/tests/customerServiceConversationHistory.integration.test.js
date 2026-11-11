import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {withConversationHistory,conversationSessions} from '../services/customerServiceConversationHistory.js';
import {createCloudStore} from '../services/customerServiceCloudStore.js';
import {createCloudTransportFromPool} from '../services/customerServiceCloudTransport.js';

const enabled=process.env.CUSTOMER_SERVICE_CLOUD_TEST==='true'&&process.env.CUSTOMER_SERVICE_TEST_ISOLATED==='true';
test('history projects authorized conversations, preserves source records and selects customer content over internal events',{skip:!enabled},async()=>{
 const database='gallabox_history_test_'+randomUUID().replaceAll('-',''),config={host:'127.0.0.1',port:65436,user:'gallabox_test'};
 const admin=new pg.Pool({...config,database:'postgres'});let pool;
 try{
  await admin.query('CREATE DATABASE '+database);pool=new pg.Pool({...config,database});
  await pool.query('CREATE SCHEMA gallabox_private; CREATE TABLE gallabox_private.inbox_record(kind text,id text,body jsonb,PRIMARY KEY(kind,id))');
  const put=async(kind,id,body)=>pool.query('INSERT INTO gallabox_private.inbox_record VALUES($1,$2,$3)',[kind,id,body]);
  await put('serviceconversations','conversation1',{source:'gallabox',lastMessageAt:'2026-11-10T08:00:00Z',sourceMetadata:{private:'never in display'}});
  const msg=(id,body)=>put('servicemessages',id,{conversationId:'conversation1',sentAt:'2026-11-10T07:00:00Z',type:'text',authorType:'customer',...body});
  await msg('customer',{text:'Please change my delivery address'});
  await msg('staff',{sentAt:'2026-11-10T08:00:00Z',authorType:'staff',text:'I will check'});
  await msg('internal',{sentAt:'2026-11-10T09:00:00Z',authorType:'staff',text:'Private internal note',sourceMetadata:{nativeEvent:{kind:'internal_note'}}});
  await msg('reaction',{sentAt:'2026-11-10T10:00:00Z',text:'reaction',sourceMetadata:{nativeContent:{kind:'reaction'}}});
  await put('servicemessages','unrelated',{conversationId:'not-authorized',text:'Unrelated private customer'});
  const issue={_id:'issue1',conversationId:'conversation1',summary:'',categoryIds:[],outcome:'unknown',history:['retained']};
  const before=(await pool.query('SELECT kind,id,body FROM gallabox_private.inbox_record ORDER BY kind,id')).rows;
  const store=createCloudStore({transport:createCloudTransportFromPool(async()=>pool)});
  const projected=await withConversationHistory([issue,{...issue,_id:'sibling'}],{store});
  const sessions=await conversationSessions([{_id:'conversation1'}],projected,{store});assert.equal(new Date(sessions[0].startedAt).toISOString(),'2026-11-10T07:00:00.000Z');assert.equal(sessions[0].startBasis,'first_captured_message');
  assert.equal(projected[0].conversationHistory.preview.text,'Please change my delivery address');assert.equal(projected[0].conversationHistory.messageCount,4);assert.equal(projected[0].conversationHistory.source,'gallabox');assert.equal(projected[1].conversationHistory.conversationId,'conversation1');assert.equal(projected[0].summary,'');assert.equal(projected[0].outcome,'unknown');assert.deepEqual(projected[0].history,['retained']);assert.ok(!JSON.stringify(projected).includes('Private internal note'));assert.ok(!JSON.stringify(projected).includes('Unrelated private'));assert.ok(!JSON.stringify(projected).includes('never in display'));
  await msg('image',{sentAt:'2026-11-10T11:00:00Z',type:'image',text:''});
  const attachment=await withConversationHistory([issue],{store});assert.equal(attachment[0].conversationHistory.preview.type,'image');
  const after=(await pool.query("SELECT kind,id,body FROM gallabox_private.inbox_record WHERE id<>'image' ORDER BY kind,id")).rows;assert.deepEqual(after,before);assert.deepEqual(issue,{_id:'issue1',conversationId:'conversation1',summary:'',categoryIds:[],outcome:'unknown',history:['retained']});
 }finally{await pool?.end();await admin.query('DROP DATABASE IF EXISTS '+database);await admin.end();}
});
