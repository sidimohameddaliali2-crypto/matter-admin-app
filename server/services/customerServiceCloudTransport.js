import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {executeSupabaseDirectorySql} from './customerServiceSupabaseDirectory.js';

// Reuse a small server-only pool. Opening a new TLS process for every five-second
// inbox poll made the cloud preview unnecessarily slow. Never expose this config.
export function createCloudTransport(env){
 let ready;
 const pool=()=>ready ||= (async()=>{
  const config=await executeSupabaseDirectorySql({env,sql:'',transactionScoped:true,executor:async request=>request.env});
  const value=new pg.Pool({host:config.PGHOST,port:Number(config.PGPORT),database:config.PGDATABASE,user:config.PGUSER,password:config.PGPASSWORD,ssl:{ca:await readFile(config.PGSSLROOTCERT,'utf8'),rejectUnauthorized:true},max:3,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,allowExitOnIdle:true,statement_timeout:90000,query_timeout:120000,application_name:'matter_local_gallabox'});
  value.on('error',()=>{}); // Idle socket failures are retried by the next request.
  return value;
 })();
 return createCloudTransportFromPool(pool);
}

export function createCloudTransportFromPool(pool){
 async function use(fn){let client,failed=false;try{client=await(await pool()).connect();return await fn(client);}catch(error){failed=true;const failure=Error('Gallabox cloud database unavailable; local work is retained for retry');failure.databaseCode=error.code;throw failure;}finally{client?.release(failed);}}
 const transport=async({sql,readOnly=true,maxBytes=16*1024*1024,timeoutMs=15000})=>use(async client=>{
  const response=await client.query(readOnly?`BEGIN READ ONLY; SET LOCAL statement_timeout=${Math.min(90000,Math.max(15000,Number(timeoutMs)||15000))};\n${sql}\n;\nCOMMIT;`:sql);
  const results=Array.isArray(response)?response:[response];
  const row=results.findLast(result=>result.rows?.length)?.rows[0];
  const output=row?JSON.stringify(Object.values(row)[0]):'';
  if(Buffer.byteLength(output)>maxBytes)throw Error('Cloud response exceeds limit');
  return output;
 });
 transport.stageRecords=async(runId,rows)=>use(async client=>{
  await client.query('BEGIN READ WRITE');
  await client.query(`INSERT INTO gallabox_private.inbox_staging(run_id,kind,id,body,payload,sha256)
   SELECT $1,kind,id,body,payload,sha256 FROM jsonb_to_recordset($2::jsonb)
   AS r(kind text,id text,body jsonb,payload text,sha256 text)`,[runId,JSON.stringify(rows)]);
  await client.query('COMMIT');
 });
 transport.transaction=async operation=>{
  const client=await(await pool()).connect();
  try{await client.query('BEGIN READ WRITE');
   const result=await operation(async sql=>{const response=await client.query(sql);const results=Array.isArray(response)?response:[response];const row=results.findLast(r=>r.rows?.length)?.rows[0];return row?Object.values(row)[0]:null;});
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 };
 transport.close=async()=>{await(await pool()).end();};
 return transport;
}
