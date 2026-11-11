import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Rule from '../models/ServiceRule.js';
import {cloudWorkflowTransaction} from '../services/customerServiceCloudWorkflow.js';
import {createCloudStore,configureCloudInbox} from '../services/customerServiceCloudStore.js';
import {createCloudTransportFromPool} from '../services/customerServiceCloudTransport.js';
import {readOnlyPreviewStore} from '../scripts/customerServiceLocalReadPreview.js';

const enabled=process.env.CUSTOMER_SERVICE_CLOUD_TEST==='true'&&process.env.CUSTOMER_SERVICE_TEST_ISOLATED==='true';
const database='gallabox_workflow_reads_'+randomUUID().replaceAll('-','');
const config={host:'127.0.0.1',port:65436,user:'gallabox_test'};
let admin,pool,store,otherStore,directReads=0,otherReads=0;
before(async()=>{
 if(!enabled)return;
 admin=new pg.Pool({...config,database:'postgres'});await admin.query('CREATE DATABASE '+database);
 pool=new pg.Pool({...config,database,max:3,connectionTimeoutMillis:700});
 await pool.query(`CREATE SCHEMA gallabox_private;
  CREATE TABLE gallabox_private.inbox_head(singleton boolean PRIMARY KEY,revision bigint,committed_at timestamptz);
  INSERT INTO gallabox_private.inbox_head VALUES(true,1,now());
  CREATE TABLE gallabox_private.inbox_record(kind text,id text,body jsonb,payload text,sha256 text,revision bigint,PRIMARY KEY(kind,id));
  CREATE TABLE gallabox_private.inbox_record_history(kind text,id text,revision bigint,payload text,sha256 text,PRIMARY KEY(kind,id,revision));
  CREATE TABLE gallabox_private.inbox_commit(run_id text,revision bigint,records integer,captured_at timestamptz);`);
 const base=createCloudTransportFromPool(async()=>pool);
 const tracked=async input=>{directReads++;return base(input);};Object.assign(tracked,base);
 const trackedOther=async input=>{otherReads++;return base(input);};Object.assign(trackedOther,base);
 store=createCloudStore({transport:tracked});otherStore=createCloudStore({transport:trackedOther});
 configureCloudInbox({store,workflow:true});
});
after(async()=>{if(!enabled)return;configureCloudInbox(null);await pool?.end();await admin.query('DROP DATABASE IF EXISTS '+database);await admin.end();});
const run=(name,fn)=>test(name,{skip:!enabled},fn);

run('a successful scoped read uses one database round trip and SQL failures clean up before the next write',async()=>{
 const calls=[];
 const transport=createCloudTransportFromPool(async()=>({async connect(){const client=await pool.connect();return {query:sql=>{calls.push(sql);return client.query(sql);},release:()=>client.release()};}}));
 await transport.transaction(async tx=>{
  let before=calls.length;
  assert.equal(await tx.read("SELECT to_json(current_setting('transaction_read_only'));"),'on');
  assert.equal(calls.length-before,1);assert.match(calls.at(-1),/SAVEPOINT.+transaction_read_only=on[\s\S]+ROLLBACK TO SAVEPOINT/s);
  assert.equal(await tx("SELECT to_json(current_setting('transaction_read_only'));"),'off');
  before=calls.length;
  await assert.rejects(tx.read('UPDATE gallabox_private.inbox_head SET revision=999999;'),e=>e.databaseCode==='25006');
  assert.equal(calls.length-before,2,'A failed source statement needs one cleanup round trip');
  assert.equal(await tx("SELECT to_json(current_setting('transaction_read_only'));"),'off');
  before=calls.length;
  await assert.rejects(tx.read("SELECT to_json(repeat('x',20));",{maxBytes:10}),/cloud database unavailable/);
  assert.equal(calls.length-before,1,'A byte-limit rejection must not roll back an already-released savepoint');
 });
});

run('three parallel workflow saves use the three-client pool without starving their source reads',async()=>{
 directReads=0;
 const results=await Promise.all(Array.from({length:3},(_,n)=>cloudWorkflowTransaction(async()=>{
  const id='parallel-'+n;
  await Rule.create({_id:id,definition:{before:true}});
  const [source,head]=await Promise.all([store.record('servicerules',id),store.head()]);
  assert.equal(source.definition.before,true,'A source read sees this transaction\'s own pending state');assert.ok(head.revision);
  await Rule.updateOne({_id:id},{$set:{'definition.after':true}});
  return id;
 })));
 assert.equal(results.length,3);assert.equal(directReads,0,'Workflow source reads never request another client');
 for(const id of results)assert.equal((await Rule.findById(id).lean()).definition.after,true);
});

run('source reads remain database-enforced read-only and restore the outer writable transaction',async()=>{
 await cloudWorkflowTransaction(async()=>{
  await Rule.create({_id:'readonly-scope',definition:{before:true}});
  assert.equal(await store.query("SELECT to_json(current_setting('transaction_read_only'));"),'on');
  await assert.rejects(store.query('UPDATE gallabox_private.inbox_head SET revision=999999;'),e=>e.databaseCode==='25006');
  await Rule.updateOne({_id:'readonly-scope'},{$set:{'definition.after':true}});
 });
 assert.equal((await Rule.findById('readonly-scope').lean()).definition.after,true);
 assert.notEqual((await store.head()).revision,999999);
 await assert.rejects(store.query('UPDATE gallabox_private.inbox_head SET revision=999999;'),e=>e.databaseCode==='25006');
});

run('read response limits abort and roll back the whole failed workflow',async()=>{
 const revision=(await store.head()).revision;
 await assert.rejects(cloudWorkflowTransaction(async()=>{
  await Rule.create({_id:'too-large',definition:{before:true}});
  await store.query("SELECT to_json(repeat('x',100));",{maxBytes:10});
 }),/cloud database unavailable/);
 assert.equal(await Rule.findById('too-large').lean(),null);assert.equal((await store.head()).revision,revision);
});

run('a failed parallel source read drains its sibling before rolling back and releasing the client',async()=>{
 await assert.rejects(cloudWorkflowTransaction(async()=>{
  await Rule.create({_id:'parallel-failure',definition:{pending:true}});
  await Promise.all([store.query('UPDATE gallabox_private.inbox_head SET revision=999999;'),store.query('SELECT to_json(1);')]);
 }),e=>e.databaseCode==='25006');
 assert.equal(await Rule.findById('parallel-failure').lean(),null);
 await cloudWorkflowTransaction(async()=>{await Rule.create({_id:'after-parallel-failure',definition:{saved:true}});assert.ok(await store.record('servicerules','after-parallel-failure'));});
 assert.equal((await Rule.findById('after-parallel-failure').lean()).definition.saved,true);
});

run('read contexts do not cross stores or survive completion, failure or detached continuations',async()=>{
 otherReads=0;
 await cloudWorkflowTransaction(async()=>{
  await Rule.create({_id:'cross-store',definition:{before:true}});
  assert.ok(await store.record('servicerules','cross-store'));
  assert.equal(await otherStore.record('servicerules','cross-store'),null,'Another store keeps its own committed snapshot');
 });
 assert.equal(otherReads,1);
 let release,detached;const gate=new Promise(resolve=>{release=resolve;});
 await cloudWorkflowTransaction(async()=>{detached=(async()=>{await gate;return store.query('SELECT to_json(7);');})();});
 directReads=0;release();assert.equal(await detached,7);assert.equal(directReads,1,'A detached continuation obtains a fresh read-only client');
 await assert.rejects(cloudWorkflowTransaction(async()=>{await store.query('SELECT to_json(1);');throw Error('Deliberate workflow failure');}),/Deliberate/);
 directReads=0;assert.equal(await store.query('SELECT to_json(8);'),8);assert.equal(directReads,1);
 const preview=readOnlyPreviewStore(store);await assert.rejects(preview.transaction(()=>{}),e=>e.statusCode===403);assert.equal(await preview.query("SELECT to_json(current_setting('transaction_read_only'));"),'on');
});
