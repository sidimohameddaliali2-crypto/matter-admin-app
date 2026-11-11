import {spawn} from 'node:child_process';
import {open,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';

const PROJECT='trhhjfgfmxofxhnzocks';
const fields=['customerId','firstName','lastName','email','phone','matterCustomerId','matterSubscriptionId','planStartDate','cycleDuration','updatedAt'];
// Deliberately fixed identifiers and projection: this reader cannot run caller SQL.
const SQL=`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH rows AS (SELECT id_ejson, source_json_sha256, batch_sha256, body FROM source_private.test__customers ORDER BY id_ejson LIMIT 10001),
 batches AS (SELECT b.*, (SELECT count(*) FROM source_private.test__customers c WHERE encode(c.batch_sha256,'hex')=b.sha256) stored_count FROM source_private.batch b WHERE namespace='test.customers')
SELECT jsonb_build_object(
 'count',(SELECT count(*) FROM source_private.test__customers),
 'batches',COALESCE((SELECT jsonb_agg(jsonb_build_object('sha256',sha256,'policySha256',policy_sha256,'count',count,'accepted',accepted,'quarantined',quarantined,'storedCount',stored_count)) FROM batches),'[]'::jsonb),
 'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object('idEjson',id_ejson,'sourceHash',encode(source_json_sha256,'hex'),'batchHash',encode(batch_sha256,'hex'),'customer',jsonb_build_object('_id',body->'_id',${fields.map(k=>`'${k}',body->'${k}'`).join(',')}))) FROM rows),'[]'::jsonb));
ROLLBACK;`;

function executePsql({args,env,sql,maxBytes,timeoutMs}){
 return new Promise((resolve,reject)=>{
  const child=spawn('/opt/homebrew/bin/psql',args,{env,stdio:['pipe','pipe','pipe']});
  const chunks=[];let bytes=0,settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(new Error('Database read failed'));}else resolve(value);};
  const timer=setTimeout(()=>finish(true),timeoutMs);
  child.on('error',()=>finish(true));child.stdin.on('error',()=>finish(true));
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes)finish(true);else chunks.push(chunk);});
  // Provider diagnostics can contain private details; drain but never retain them.
  child.stderr.resume();child.on('close',code=>finish(code!==0,Buffer.concat(chunks).toString('utf8')));
  child.stdin.end(sql);
 });
}
function scalar(value){
 if(value===null||value===undefined)return undefined;
 if(typeof value!=='object')return value;
 if('$date'in value){const raw=value.$date;const date=new Date(typeof raw==='object'?Number(raw.$numberLong):raw);if(!Number.isFinite(date.getTime()))throw Error();return date.toISOString();}
 for(const key of ['$numberInt','$numberLong','$numberDouble','$numberDecimal'])if(key in value){const n=Number(value[key]);if(!Number.isFinite(n))throw Error();return n;}
 if(typeof value.$oid==='string')return value.$oid;
 throw Error();
}
const validCount=n=>Number.isSafeInteger(n)&&n>=0;
const validHash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);

export async function readSupabaseCustomerDirectory({env=process.env,executor=executePsql,clock=()=>new Date(),maxRecords=10000,maxBytes=16*1024*1024,timeoutMs=30000}={}){
 try{
  if(!Number.isInteger(maxRecords)||maxRecords<1||maxRecords>10000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error();
  const output=await executeSupabaseDirectorySql({env,executor,sql:SQL,maxBytes,timeoutMs});
  if(typeof output!=='string'||Buffer.byteLength(output)>maxBytes)throw Error();
  const snapshot=JSON.parse(output),{count,rows,batches}=snapshot;
  if(!validCount(count)||count>maxRecords||!Array.isArray(rows)||rows.length!==count||!Array.isArray(batches)||!batches.length)throw Error();
  const batchMap=new Map();let accepted=0;
  for(const b of batches){if(!validHash(b.sha256)||!validHash(b.policySha256)||batchMap.has(b.sha256)||![b.count,b.accepted,b.quarantined,b.storedCount].every(validCount)||b.quarantined!==0||b.count!==b.accepted||b.storedCount!==b.accepted)throw Error();batchMap.set(b.sha256,{...b,seen:0});accepted+=b.accepted;}
  if(accepted!==count)throw Error();
  const ids=new Set(),customerIds=new Set(),customers=[];
  for(const row of rows){
   const id=scalar(JSON.parse(row.idEjson)),sourceId=scalar(row.customer?._id),customerId=scalar(row.customer?.customerId),batch=batchMap.get(row.batchHash);
   if(typeof id!=='string'||!id||id!==sourceId||ids.has(id)||typeof customerId!=='string'||!customerId||customerId.length>140||customerIds.has(customerId)||!validHash(row.sourceHash)||!batch)throw Error();
   ids.add(id);customerIds.add(customerId);batch.seen++;
   const customer={sourceRecordId:id};for(const key of fields){const value=scalar(row.customer[key]);if(value!==undefined)customer[key]=value;}customers.push(customer);
  }
  for(const b of batchMap.values())if(b.seen!==b.accepted)throw Error();
  const observedAt=new Date(clock()).toISOString();
  return{customers,count,observedAt,report:{source:'supabase_customer_collection',provider:'Supabase',projectRef:PROJECT,region:'eu-central-1',sourceNamespace:'test.customers',observedAt,countBefore:count,countAfter:count,uniqueSourceRecords:ids.size,uniqueCustomerIds:customerIds.size,reconciled:true,atomicSnapshot:true,historicalStoredCopy:true,upstreamLiveSyncVerified:false,sourceUpdatedAt:null,batches,limitations:['Read time describes this Supabase snapshot, not a live upstream MongoDB sync.','Source import time is not recorded in the source batch metadata.']}};
 }catch{throw new Error('Supabase customer directory read failed; previous local directory must be retained.');}
}

// Server-only transport. Fixed source readers/writers define their own SQL.
export async function executeSupabaseDirectorySql({env,executor=executePsql,sql,readOnly=true,transactionScoped=false,maxBytes=16*1024*1024,timeoutMs=30000}){
  const path=env.CUSTOMER_SERVICE_SUPABASE_CREDENTIALS_PATH,ca=env.CUSTOMER_SERVICE_SUPABASE_CA_PATH;
  if(typeof path!=='string'||!isAbsolute(path)||typeof ca!=='string'||!isAbsolute(ca))throw Error();
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let credentials;
  try{const metadata=await file.stat();if(!metadata.isFile()||metadata.uid!==process.getuid()||(metadata.mode&0o077)!==0||metadata.size>65536)throw Error();credentials=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
  if(credentials.projectRef!==PROJECT||credentials.actualRegion!=='eu-central-1'||typeof credentials.databasePassword!=='string'||!credentials.databasePassword)throw Error();
  if(!(await stat(ca)).isFile())throw Error();
  // Cloud queries constrain read-only mode to their transaction, not a pooled session.
  if(transactionScoped&&readOnly)sql=`BEGIN READ ONLY;\n${sql}\nCOMMIT;`;
  return await executor({args:['-X','-q','-A','-t','-w','-v','ON_ERROR_STOP=1','-f','-'],sql,maxBytes,timeoutMs,env:{PATH:'/usr/bin:/bin:/opt/homebrew/bin',PGHOST:'aws-1-eu-central-1.pooler.supabase.com',PGPORT:'5432',PGDATABASE:'postgres',PGUSER:`postgres.${PROJECT}`,PGPASSWORD:credentials.databasePassword,PGSSLMODE:'verify-full',PGSSLROOTCERT:ca,PGCONNECT_TIMEOUT:'10',PGOPTIONS:`${transactionScoped?'':`-c default_transaction_read_only=${readOnly?'on':'off'} `}-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000`,LC_ALL:'C'}});
}
