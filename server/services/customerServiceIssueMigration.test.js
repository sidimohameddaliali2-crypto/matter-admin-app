import test from 'node:test';
import assert from 'node:assert/strict';
import {issueKeyIndexState,issueKeyMigrationReady,issueKeyIndexStateSql,applyLocalIssueKeyMigration} from './customerServiceIssueMigration.js';

const origin="(body ->> 'originMessageId'::text)",issue="COALESCE((body ->> 'originIssueKey'::text), 'primary'::text)",predicate="(kind = 'servicerequests'::text)";
const index=keys=>({valid:true,unique:true,attributes:keys.length,keys,predicate});
const old=()=>index([origin]),replacement=()=>index([origin,issue]);
const state=(value={})=>issueKeyIndexState(value);

test('only the exact replacement protects missing legacy issue keys and permits destination activation',async()=>{
 const value={gallabox_request_origin_issue:replacement()};
 assert.deepEqual(state(value),{old:'absent',replacement:'valid'});
 assert.deepEqual(state({gallabox_request_origin:old()}),{old:'valid',replacement:'absent'});
 const store={query:async sql=>{assert.equal(sql,issueKeyIndexStateSql);return value;}};
 assert.equal(await issueKeyMigrationReady(store),true);
 const equivalent={...replacement(),keys:["(( body ->> 'originMessageId'::text ))","COALESCE( (body ->> 'originIssueKey'::text) , 'primary'::text )"]};
 assert.equal(state({gallabox_request_origin_issue:equivalent}).replacement,'valid');
});

test('an extra unique-index key cannot masquerade as protection for one origin and issue key',async()=>{
 const cases=[
  {...replacement(),attributes:3,keys:[origin,issue,'id']},
  {...replacement(),attributes:3},
  {...replacement(),keys:[origin,issue,'id']},
 ];
 for(const candidate of cases){
  assert.equal(state({gallabox_request_origin_issue:candidate}).replacement,'unexpected');
  assert.equal(await issueKeyMigrationReady({query:async()=>({gallabox_request_origin_issue:candidate})}),false);
 }
});

test('wrong key, reversed key order and missing legacy-key coalescing fail closed',()=>{
 for(const keys of [[issue,origin],[origin,"body ->> 'originIssueKey'::text"],["body ->> 'requestId'::text",issue],["body ->> 'origin MessageId'::text",issue],["body ->> 'origin(MessageId)'::text",issue],[origin,"COALESCE(body ->> 'originIssueKey'::text,'different'::text)"]]){
  assert.equal(state({gallabox_request_origin_issue:{...replacement(),keys}}).replacement,'unexpected');
 }
});

test('literal contents are never normalized into a different key, legacy default or predicate',()=>{
 for(const changed of [
  {keys:["body ->> 'originMessage Id'::text",issue]},
  {keys:[origin,"COALESCE(body ->> 'originIssue Key'::text,'primary'::text)"]},
  {keys:[origin,"COALESCE(body ->> 'originIssueKey'::text,'pri mary'::text)"]},
  {predicate:"kind = 'service requests'::text"},
  {predicate:"kind = 'service(requests)'::text"},
 ])assert.equal(state({gallabox_request_origin_issue:{...replacement(),...changed}}).replacement,'unexpected');
});

test('weakened, narrowed or unrelated predicates and invalid/nonunique indexes are rejected',()=>{
 for(const changed of [
  {predicate:null},{predicate:"kind = 'servicerequests'::text OR kind = 'servicereviews'::text"},
  {predicate:"kind = 'servicerequests'::text AND body->>'status'='open'"},{predicate:"kind = 'servicereviews'::text"},
  {valid:false},{unique:false},{valid:'true'},{unique:'true'},
 ])assert.equal(state({gallabox_request_origin_issue:{...replacement(),...changed}}).replacement,'unexpected');
});

test('a differently shaped old index is never accepted as the protection that may be removed',()=>{
 for(const candidate of [index(["body ->> 'requestId'::text"]),index([origin,'id']),{...old(),predicate:"kind = 'servicereviews'::text"},{...old(),valid:false}]){
  assert.equal(state({gallabox_request_origin:candidate}).old,'unexpected');
 }
});

test('missing protection or an interrupted two-index state cannot activate the destination',async()=>{
 for(const value of [{},{gallabox_request_origin:old()},{gallabox_request_origin:old(),gallabox_request_origin_issue:replacement()},{gallabox_request_origin:{...old(),unique:false},gallabox_request_origin_issue:replacement()}]){
  assert.equal(await issueKeyMigrationReady({query:async()=>value}),false);
 }
});

test('the runner refuses nonlocal and nonisolated names before opening any connection',async()=>{
 let connections=0;
 for(const options of [{host:'db.example.invalid',database:'gallabox_migration_test_'+'a'.repeat(32)},{host:'127.0.0.1',database:'postgres'},{host:'127.0.0.1',database:'operational_app'}]){
  await assert.rejects(applyLocalIssueKeyMigration({pool:{options,connect:async()=>{connections++;}},isolated:true,apply:true}),/explicitly isolated/);
 }
 await assert.rejects(applyLocalIssueKeyMigration({pool:{options:{host:'127.0.0.1',database:'gallabox_migration_test_'+'a'.repeat(32)},connect:async()=>{connections++;}},isolated:false,apply:true}),/explicitly isolated/);
 assert.equal(connections,0);
});

test('connected server identity is checked independently of supplied pool settings before any migration',async()=>{
 const name='gallabox_migration_test_'+'a'.repeat(32);
 for(const connection of [{name,address:'198.51.100.1'},{name:'operational_app',address:'127.0.0.1'}]){
  const calls=[];let released=false;
  const pool={options:{host:'127.0.0.1',database:name},connect:async()=>({query:async sql=>{calls.push(sql);return {rows:[connection]};},release:()=>{released=true;}})};
  await assert.rejects(applyLocalIssueKeyMigration({pool,isolated:true,apply:true}),/connected database is not an isolated/);
  assert.equal(released,true);assert.ok(calls.every(sql=>sql.startsWith('SELECT current_database()')||sql==='ROLLBACK'));
 }
});
