import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

const migration=new URL('../../supabase/migrations/20261109120000_gallabox_request_issue_keys.sql',import.meta.url);
const allowedDatabase=/^gallabox_(?:app_review|migration_test)_[a-f0-9]{32}$/;
const localHosts=new Set(['127.0.0.1','::1']);
export const issueKeyIndexStateSql=`SELECT COALESCE(jsonb_object_agg(c.relname,jsonb_build_object(
 'valid',i.indisvalid,'unique',i.indisunique,'attributes',i.indnatts,
 'predicate',pg_get_expr(i.indpred,i.indrelid),
 'keys',ARRAY(SELECT pg_get_indexdef(c.oid,n,true) FROM generate_series(1,i.indnkeyatts) n)
)),'{}'::jsonb) AS state FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
WHERE c.oid IN(to_regclass('gallabox_private.gallabox_request_origin'),to_regclass('gallabox_private.gallabox_request_origin_issue'));`;
// Ignore display whitespace/parentheses only outside quoted SQL values. A field
// named "origin MessageId" must not compare equal to "originMessageId".
const normalize=value=>(String(value).match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[^'"]+/g)||[]).map(part=>/^["']/.test(part)?part:part.replace(/[\s()]/g,'')).join('');
const origin="body ->> 'originMessageId'::text",issue="COALESCE(body ->> 'originIssueKey'::text,'primary'::text)";
const expected=(index,keys)=>index?.valid===true&&index.unique===true&&index.attributes===keys.length&&Array.isArray(index.keys)&&index.keys.length===keys.length&&index.keys.every((key,n)=>normalize(key)===normalize(keys[n]))&&normalize(index.predicate)===normalize("kind = 'servicerequests'::text");
export function issueKeyIndexState(state={}){
 const old=state.gallabox_request_origin,replacement=state.gallabox_request_origin_issue;
 return {old:old?expected(old,[origin])?'valid':'unexpected':'absent',replacement:replacement?expected(replacement,[origin,issue])?'valid':'unexpected':'absent'};
}
export async function issueKeyMigrationReady(store){
 const state=issueKeyIndexState(await store.query(issueKeyIndexStateSql));
 return state.old==='absent'&&state.replacement==='valid';
}

// Data-only signatures include every private table, not just request counts.
// Receipts contain hashes/counts; no customer payloads or credentials are logged.
export async function privateTableSignatures(client){
 const tables=await client.query("SELECT tablename FROM pg_tables WHERE schemaname='gallabox_private' ORDER BY tablename");
 const result={};
 for(const {tablename}of tables.rows){
  if(!/^[a-z_]+$/.test(tablename))throw Error('Unexpected private table name.');
  const rows=await client.query(`SELECT to_jsonb(r)::text AS value FROM gallabox_private."${tablename}" r ORDER BY to_jsonb(r)::text`);
  const hash=createHash('sha256');for(const {value}of rows.rows)hash.update(value+'\n');
  result[tablename]={count:rows.rowCount,sha256:hash.digest('hex')};
 }
 return result;
}

// This runner intentionally cannot target the hosted database or a regular app
// database. Live rollout is a separate decision; no automatic startup migration.
export async function applyLocalIssueKeyMigration({pool,isolated=false,apply=false}){
 if(!isolated||!localHosts.has(pool.options.host)||!allowedDatabase.test(pool.options.database))throw Error('Issue-key verification requires an explicitly isolated loopback review database.');
 const client=await pool.connect();
 try{
  const {rows:[connection]}=await client.query('SELECT current_database() AS name,host(inet_server_addr()) AS address');
  if(!allowedDatabase.test(connection.name)||!localHosts.has(connection.address))throw Error('The connected database is not an isolated local review.');
  await client.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; SELECT pg_advisory_xact_lock(hashtext('gallabox_private.inbox')); LOCK TABLE gallabox_private.inbox_record IN ACCESS EXCLUSIVE MODE;");
  const before=await privateTableSignatures(client);
  const {rows:[{state:rawState}]}=await client.query(issueKeyIndexStateSql),state=issueKeyIndexState(rawState);
  const old=state.old!=='absent',replacement=state.replacement!=='absent';
  if(state.replacement==='unexpected'||state.old==='unexpected')throw Error('Unexpected issue-key index definition; retain the current protection for review.');
  if(!replacement&&!old)throw Error('The expected single-origin protection is missing.');
  const duplicates=await client.query("SELECT count(*)::integer AS count FROM (SELECT 1 FROM gallabox_private.inbox_record WHERE kind='servicerequests' GROUP BY body->>'originMessageId',COALESCE(body->>'originIssueKey','primary') HAVING count(*)>1) conflicts");
  if(duplicates.rows[0].count)throw Error('Existing issue-key conflicts require review; no records were changed.');
  let status=replacement&&!old?'already_applied':'ready';
  if(apply&&status!=='already_applied'){
   if(replacement)throw Error('Both issue indexes exist; review the interrupted migration before proceeding.');
   const sql=(await fs.readFile(migration,'utf8')).replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
   await client.query(sql);status='applied';
  }
  const after=await privateTableSignatures(client);
  if(JSON.stringify(after)!==JSON.stringify(before))throw Error('Private table preservation verification failed.');
  await client.query('COMMIT');
  return {local:true,status,dataUnchanged:true,tables:after};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
