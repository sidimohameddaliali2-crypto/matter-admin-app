import {encodeCloudRecord} from '../services/customerServiceCloudStore.js';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import pg from 'pg';import {EJSON,ObjectId} from 'bson';
import {createHostedCapture} from '../services/customerServiceHostedCapture.js';
const enabled=process.env.CUSTOMER_SERVICE_CLOUD_TEST==='true';const dbName='gallabox_hosted_fixture_'+Date.now();let pool,admin,db;
const env={CUSTOMER_SERVICE_GALLABOX_ACCOUNT_ID:'account',CUSTOMER_SERVICE_GALLABOX_CHANNEL_ID:'channel',CUSTOMER_SERVICE_GALLABOX_API_KEY:'fixture',CUSTOMER_SERVICE_GALLABOX_API_SECRET:'fixture'};
const conv={id:'source-thread',accountId:'account',channelId:'channel',contactId:'contact',status:'OPEN',contact:{name:'Fictional contact'},updatedAt:'2026-11-08T01:00:00Z'};
let messageText='Realistic fictional question',fail=false,extraMessages=[];
const fake=async(url,options)=>{assert.equal(options.method,'GET');if(url.includes('/conversations?'))return Response.json([conv]);if(url.endsWith('/users'))return Response.json([{id:'staff-1',name:'Verified fixture staff',accounts:[{accountId:'account'}]}]);if(fail)throw Error('Fixture outage');return Response.json(Number(new URL(url).searchParams.get('page'))>1?[]:[{id:'source-message',accountId:'account',channelId:'channel',contactId:'contact',conversationId:conv.id,sender:'contact',whatsapp:{time:'2026-11-08T01:00:00Z',type:'text',text:{body:messageText},from:'971500000000'}},...extraMessages]);};
test.before(async()=>{if(!enabled)return;admin=new pg.Pool({host:'127.0.0.1',port:65436,user:'gallabox_test',database:'postgres'});await admin.query(`CREATE DATABASE ${dbName}`);pool=new pg.Pool({host:'127.0.0.1',port:65436,user:'gallabox_test',database:dbName});await pool.query("DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;");await pool.query(fs.readFileSync(new URL('../migrations/20261107_gallabox_inbox.sql',import.meta.url),'utf8'));await pool.query(fs.readFileSync(new URL('../../supabase/migrations/20261107204719_gallabox_hosted_capture.sql',import.meta.url),'utf8').replace(/^CREATE EXTENSION.*\n/gm,''));await pool.query(fs.readFileSync(new URL('../../supabase/migrations/20261107205504_gallabox_worker_ownership.sql',import.meta.url),'utf8'));await pool.query(fs.readFileSync(new URL('../../supabase/migrations/20261107205838_gallabox_service_metrics.sql',import.meta.url),'utf8'));for(const migration of ['20261107213039_gallabox_reply_metrics_cache.sql','20261107215245_gallabox_working_hours_metrics.sql','20261107221358_gallabox_cloud_workflow.sql','20261107231821_gallabox_staff_login_links.sql','20261107233132_gallabox_message_time_index.sql'])await pool.query(fs.readFileSync(new URL('../../supabase/migrations/'+migration,import.meta.url),'utf8'));await pool.query("INSERT INTO gallabox_private.inbox_head(singleton,origin) VALUES(true,'fixture'); INSERT INTO gallabox_private.worker_control(singleton,enabled,writer_mode,token_hash) VALUES(true,true,'cloud','fixture'); INSERT INTO gallabox_private.worker_scope(scope,channel_id) VALUES('account:channel','channel');");db={query:async(s,p)=>(await pool.query(s,p)).rows,transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(async(s,p)=>(await c.query(s,p)).rows);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};});
test.after(async()=>{if(!enabled)return;await pool.end();await admin.query(`DROP DATABASE ${dbName}`);await admin.end();});
test('cloud-only capture creates native records, preserves IDs and deduplicates after restart',{skip:!enabled},async()=>{
 const worker=createHostedCapture({db,envs:[env],fetchImpl:fake});let r=await worker.run();assert.equal(r.error,null);assert.equal(r.inserted,1);assert.ok(r.providerReads>0);const staff=await db.query('SELECT display_name,active FROM gallabox_private.staff_directory');assert.deepEqual(staff,[{display_name:'Verified fixture staff',active:true}]);
 const rows=await db.query("SELECT payload FROM gallabox_private.inbox_record WHERE kind='servicemessages'");assert.equal(rows.length,1);const m=EJSON.parse(rows[0].payload);assert.ok(m._id instanceof ObjectId);assert.equal(m.externalMessageId,'source-message');assert.equal(m.text,messageText);
 await db.query("UPDATE gallabox_private.worker_job SET pending=true,page=1,page_hashes='[]';");r=await createHostedCapture({db,envs:[env],fetchImpl:fake}).run();assert.equal(r.inserted,0);assert.ok(r.duplicates>0);assert.equal((await db.query("SELECT count(*)::int n FROM gallabox_private.inbox_record WHERE kind='servicemessages'"))[0].n,1);
});
test('conflicting provider evidence and outages retain checkpoints and every saved review',{skip:!enabled},async()=>{
 const before=await db.query("SELECT payload FROM gallabox_private.inbox_record WHERE kind='servicereviews'");assert.equal(before.length,1);
 await db.query("UPDATE gallabox_private.worker_job SET pending=true,page=1,page_hashes='[]',retry_at=now();");messageText='Changed conflicting text';let r=await createHostedCapture({db,envs:[env],fetchImpl:fake}).run();assert.ok(r.error);assert.equal((await db.query("SELECT body->>'text' text FROM gallabox_private.inbox_record WHERE kind='servicemessages'"))[0].text,'Realistic fictional question');
 assert.deepEqual(await db.query("SELECT payload FROM gallabox_private.inbox_record WHERE kind='servicereviews'"),before);
 fail=true;await db.query("UPDATE gallabox_private.worker_job SET retry_at=now();");r=await createHostedCapture({db,envs:[env],fetchImpl:fake}).run();assert.ok(r.error);assert.ok((await db.query('SELECT * FROM gallabox_private.worker_job')).every(j=>j.page===1&&j.pending));
 fail=false;messageText='Realistic fictional question';await db.query("UPDATE gallabox_private.worker_job SET retry_at=now();");r=await createHostedCapture({db,envs:[env],fetchImpl:fake}).run();assert.equal(r.error,null);
});
test('new source evidence marks cloud reviews stale without changing saved judgments',{skip:!enabled},async()=>{
 const before=(await db.query("SELECT payload FROM gallabox_private.inbox_record WHERE kind='servicereviews'"))[0];const review=EJSON.parse(before.payload);review.revisions=[{note:'Keep this review history',at:new Date()}];const encoded=encodeCloudRecord('servicereviews',review);await db.query("UPDATE gallabox_private.inbox_record SET body=$1,payload=$2,sha256=$3 WHERE kind='servicereviews'",[encoded.body,encoded.payload,encoded.sha256]);
 extraMessages=Array.from({length:3},(_,i)=>({id:'incoming-'+i,accountId:'account',channelId:'channel',contactId:'contact',conversationId:conv.id,sender:'contact',whatsapp:{time:'2026-11-08T01:0'+(i+1)+':00Z',type:'text',text:{body:'Additional question '+i},from:'971500000000'}}));
 await db.query("UPDATE gallabox_private.worker_job SET pending=true,page=1,page_hashes='[]',retry_at=now()");const result=await createHostedCapture({db,envs:[env],fetchImpl:fake}).run();assert.equal(result.error,null);assert.equal(result.inserted,3);assert.equal((await db.query('SELECT count(*)::int n FROM gallabox_private.message_time'))[0].n,4);
 const saved=EJSON.parse((await db.query("SELECT payload FROM gallabox_private.inbox_record WHERE kind='servicereviews'"))[0].payload);assert.equal(saved.stale,true);assert.deepEqual(saved.revisions,review.revisions);assert.deepEqual(saved.assignmentHistory,review.assignmentHistory);extraMessages=[];
});
test('disabled capture does not read the provider; active lease prevents overlap',{skip:!enabled},async()=>{
 await db.query("UPDATE gallabox_private.worker_control SET lease_until=now()+interval '1 minute'");assert.equal((await createHostedCapture({db,envs:[env],fetchImpl:()=>{throw Error('must not read')}}).run()).skipped,true);
 await db.query("UPDATE gallabox_private.worker_control SET enabled=false,lease_until=NULL");assert.equal((await createHostedCapture({db,envs:[env],fetchImpl:()=>{throw Error('must not read')}}).run()).skipped,true);
});

test('reply metrics group bursts, exclude automation/internal notes, and use the agreed 8–5 Dubai schedule',{skip:!enabled},async()=>{
 const [{body:original}]=await db.query("SELECT body FROM gallabox_private.inbox_record WHERE kind='servicemessages'");
 await db.transaction(async tx=>{await tx("SELECT set_config('gallabox.capture_writer','hosted',true)");
 for(const [i,extra] of [
  {authorType:'customer',sentAt:'2026-11-08T01:01:00Z'},
  {authorType:'bot',sentAt:'2026-11-08T01:02:00Z'},
  {authorType:'staff',internalNote:true,sentAt:'2026-11-08T01:03:00Z'},
  {authorType:'staff',externalAuthorId:'agent',authorName:'Fictional agent',sentAt:'2026-11-08T06:00:00Z'},
 ].entries()){const body={...original,...extra,_id:String(i).padStart(24,'f'),externalMessageId:'metric-'+i};const r=encodeCloudRecord('servicemessages',body);await tx("INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES('servicemessages',$1,$2::jsonb,$3,$4,1)",[body._id,JSON.stringify(body),r.payload,r.sha256]);}
 });
 const turns=await db.query('SELECT * FROM gallabox_private.reply_turns');assert.equal(turns.length,1);assert.equal(turns[0].customer_messages,5);assert.equal(turns[0].elapsed_seconds,18000);assert.equal(turns[0].agent_id,'agent');
 const [business]=await db.query("SELECT gallabox_private.business_seconds('2026-11-08T01:00:00Z','2026-11-08T06:00:00Z') seconds");assert.equal(business.seconds,7200);
 const [weekday]=await db.query("SELECT gallabox_private.business_seconds('2026-11-09T03:30:00Z','2026-11-09T05:00:00Z') seconds");assert.equal(weekday.seconds,3600);
 await assert.rejects(pool.query('BEGIN; SET LOCAL ROLE anon; SELECT * FROM gallabox_private.reply_turns; COMMIT;'));await pool.query('ROLLBACK');
});

test('working time pauses overnight; closure prevents a later session replying to a closed turn',{skip:!enabled},async()=>{
 for(const [start,end,expected] of [['2026-11-08T13:30:00Z','2026-11-09T04:10:00Z',600],['2026-11-08T12:55:00Z','2026-11-09T04:10:00Z',900],['2026-11-08T14:00:00Z','2026-11-08T15:00:00Z',0]])assert.equal((await db.query('SELECT gallabox_private.business_seconds($1,$2) seconds',[start,end]))[0].seconds,expected);
 const before=await db.query("SELECT payload FROM gallabox_private.inbox_record WHERE kind='servicereviews'");
 await db.transaction(async tx=>{await tx("SELECT set_config('gallabox.capture_writer','hosted',true)");
 for(const [i,extra] of [
 {authorType:'customer',text:'Thanks',sentAt:'2026-11-08T07:00:00Z'},
 {authorType:'system',sourceMetadata:{systemEvent:{action:'resolve'}},sentAt:'2026-11-08T07:01:00Z'},
 {authorType:'system',sourceMetadata:{systemEvent:{action:'re-open'}},sentAt:'2026-11-09T04:00:00Z'},
 {authorType:'customer',text:'New question',sentAt:'2026-11-09T04:01:00Z'},
 {authorType:'staff',sentAt:'2026-11-09T04:11:00Z'}].entries()){
 const body={_id:String(i).padStart(24,'e'),source:'gallabox',conversationId:'closure-fixture',...extra};const r=encodeCloudRecord('servicemessages',body);await tx("INSERT INTO gallabox_private.inbox_record(kind,id,body,payload,sha256,revision) VALUES('servicemessages',$1,$2::jsonb,$3,$4,1)",[body._id,JSON.stringify(body),r.payload,r.sha256]);}
 });
 const turns=await db.query("SELECT * FROM gallabox_private.reply_turns WHERE conversation_id='closure-fixture' ORDER BY started_at");assert.equal(turns.length,2);assert.equal(turns[0].replied_at,null);assert.ok(turns[0].closed_at);assert.equal(turns[1].elapsed_seconds,600);assert.deepEqual(await db.query("SELECT payload FROM gallabox_private.inbox_record WHERE kind='servicereviews'"),before);
 await db.query('REFRESH MATERIALIZED VIEW gallabox_private.reply_turn_metrics; REFRESH MATERIALIZED VIEW gallabox_private.history_coverage');
 assert.equal((await db.query("SELECT business_seconds FROM gallabox_private.reply_turn_metrics WHERE conversation_id='closure-fixture' AND replied_at IS NOT NULL"))[0].business_seconds,600);
});
