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
  let pending=Promise.resolve(),accepting=true;
  try{await client.query('BEGIN READ WRITE');
   // Queue an entire scoped read together. Concurrent source reads must not
   // interleave savepoints or put a subsequent workflow write in read-only mode.
   let nextRead=0;
   const enqueue=run=>{if(!accepting)return Promise.reject(Error('Cloud transaction is closed'));const result=pending.then(run);pending=result.catch(()=>{});return result;};
   const value=response=>{const results=Array.isArray(response)?response:[response],row=results.findLast(r=>r.rows?.length)?.rows[0];return row?Object.values(row)[0]:null;};
   const tx=sql=>enqueue(async()=>value(await client.query(sql)));
   tx.read=(sql,{maxBytes=16*1024*1024,timeoutMs=15000}={})=>enqueue(async()=>{
    const savepoint='gallabox_source_read_'+(++nextRead);
    let restored=false;
    try{
     // Match ordinary pooled reads: all successful statements use one round
     // trip. A SQL error stops the batch before cleanup, handled below.
     const response=await client.query(`SAVEPOINT ${savepoint};
SET LOCAL transaction_read_only=on;SET LOCAL statement_timeout=${Math.min(90000,Math.max(15000,Number(timeoutMs)||15000))};
${sql}
;
ROLLBACK TO SAVEPOINT ${savepoint};RELEASE SAVEPOINT ${savepoint};`);
     restored=true;
     const output=JSON.stringify(value(response));
     if(Buffer.byteLength(output)>maxBytes)throw Error('Cloud response exceeds limit');
     return JSON.parse(output);
    }catch(error){const failure=Error('Gallabox cloud database unavailable; local work is retained for retry');failure.databaseCode=error.code;throw failure;}
    finally{
     // Rolling back this read savepoint restores transaction settings, even
     // after earlier workflow writes, without discarding those writes.
     if(!restored)await client.query('ROLLBACK TO SAVEPOINT '+savepoint+';RELEASE SAVEPOINT '+savepoint);
    }
   });
   const result=await operation(tx);
   accepting=false;await pending;
   await client.query('COMMIT');return result;
  }catch(error){accepting=false;await pending;await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 };
 transport.close=async()=>{await(await pool()).end();};
 return transport;
}
