import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import test from 'node:test';
import dotenv from '../../server/node_modules/dotenv/lib/main.js';
import {openTransferSecrets,sealTransferSecrets} from '../../server/services/driverAuditTransferCodec.js';
import {driverAuditMongoLocationIdentity,runDriverAuditNativeDatabaseCheck} from './driver-audit-native-database-check.mjs';

const commit='a'.repeat(40),targetDatabase='test';
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072});
const recipientPublicKey=publicKey.export({type:'spki',format:'pem'});
const password='fictional-password-DO-NOT-EXPOSE';
const first='mongodb+srv://saved-user:'+password+'@fictional-cluster.example.invalid/test?authSource=admin';
const second='mongodb+srv://api-user:second-'+password+'@fictional-cluster.example.invalid/test?authSource=admin';

async function fixture(t,options={}){
 const appRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'native-database-check-')));t.after(()=>fs.rm(appRoot,{recursive:true,force:true}));
 const server=path.join(appRoot,'server');await fs.mkdir(server,{mode:0o700});await fs.writeFile(path.join(server,'server.js'),'// fictional API\n');
 if(options.baseFile!==undefined)await fs.writeFile(path.join(server,'.env'),options.baseFile,{mode:0o600});
 if(options.localFile!==undefined)await fs.writeFile(path.join(server,'.env.local'),options.localFile,{mode:0o600});
 const env={MONGODB_URI:options.loadEnvUri===undefined?first:options.loadEnvUri};
 const entries=[{name:'matter-delivery-api',pm_id:1,pid:912,pm2_env:{status:'online',pm_cwd:appRoot,pm_exec_path:'/usr/bin/npm',args:['start','--prefix','server'],pm_uptime:123456,MONGODB_URI:options.apiUri===undefined?second:options.apiUri}}];
 const calls={exec:[],loads:[],connect:[],close:0,commands:[],reads:[]};let processReads=0;
 class MongoClient{
  constructor(uri,settings){this.uri=uri;this.settings=settings;calls.connect.push({uri,settings});}
  async connect(){if(options.connect)return options.connect(this.uri);if(options.authFail!==false&&this.uri===first)throw Object.assign(Error('bad auth '+this.uri),{name:'MongoServerError',code:8000,codeName:'AtlasError'});return this;}
  db(name){assert.equal(name,targetDatabase);return{databaseName:name,command:async command=>{calls.commands.push(command);assert(Object.keys(command).every(key=>['hello','dbStats','scale','maxTimeMS'].includes(key)));if(command.hello)return{ok:1,isWritablePrimary:true};if(options.metadataFail)throw Object.assign(Error('secret '+this.uri),{name:'MongoServerError',code:13,codeName:'Unauthorized'});return{ok:1,dataSize:1000,storageSize:2000,indexSize:300,totalSize:2300,objects:42,collections:7};},collection:collection=>({countDocuments:async(filter,settings)=>{assert.deepEqual(filter,{});assert(settings.maxTimeMS>0&&settings.maxTimeMS<=5000);calls.reads.push(collection);assert(['driverAuditNativeFiles','driverAuditNativeChunks'].includes(collection));return collection.endsWith('Files')?5:6;},findOne:async(query,settings)=>{calls.reads.push(collection+':'+query._id);assert.equal(collection,'driverAuditNativeControl');assert(settings?.projection);if(query._id==='authority'){assert.deepEqual(settings.projection,{_id:1});return options.authorityPresent?{_id:'authority'}:null;}assert.equal(query._id,'capacity');return{_id:'capacity',limitBytes:16*1024**3,usedBytes:12345,technicalBytes:100};}})};}
  async close(){calls.close++;if(options.closeError)throw Error('close '+this.uri);}
 }
 const adapters={platform:'linux',env,attemptTimeoutMs:options.attemptTimeoutMs||1000,
  async systemFile(file){assert.equal(file,'/usr/bin/npm');return{realpath:'/usr/lib/node_modules/npm/bin/npm-cli.js',isFile:true,uid:0,mode:0o100644,bytes:100,sha256:'f'.repeat(64)};},
  async exec(file,args){calls.exec.push({file,args});if(file==='git'){if(options.dirty&&args[0]==='diff')throw Object.assign(Error('dirty '+first),{stdout:first});return{stdout:commit+'\n'};}assert.equal(file,'pm2');assert.deepEqual(args,['jlist']);processReads++;if(options.pm2Error)throw Object.assign(Error('pm2 '+first),{stdout:first,stderr:second});if(options.drift&&processReads===2)entries[0].pid++;return{stdout:JSON.stringify(entries)};},
  async load(name){calls.loads.push(name);if(name==='loadEnv.js')return{};if(name==='node_modules/dotenv/lib/main.js')return{default:dotenv};if(name==='node_modules/mongodb/lib/index.js')return{MongoClient};if(name==='services/driverAuditTransferCodec.js')return{sealTransferSecrets};throw Error('Unexpected module '+name);}};
 const run=(extra={})=>runDriverAuditNativeDatabaseCheck({operation:'inspect-database-config',appRoot,expectedSha:commit,recipientPublicKey,...extra},adapters);
 return{appRoot,server,env,entries,calls,adapters,run};
}

test('credential-free location identity ignores credentials/options and distinguishes actual host/database targets',()=>{
 const a=driverAuditMongoLocationIdentity(first),b=driverAuditMongoLocationIdentity(second);assert.deepEqual(a,b);assert.match(a.locationSha256,/^[a-f0-9]{64}$/);assert.equal(a.remote,true);assert.equal(a.targetDatabaseMatches,true);
 assert.deepEqual(driverAuditMongoLocationIdentity('mongodb://u:p@b.example.invalid:27017,a.example.invalid/test'),driverAuditMongoLocationIdentity('mongodb://different:creds@a.example.invalid,b.example.invalid:27017/test'));
 assert.notEqual(a.locationSha256,driverAuditMongoLocationIdentity(second.replace('/test?','/other?')).locationSha256);
 assert.equal(driverAuditMongoLocationIdentity('mongodb://localhost/test').remote,false);
 for(const value of [null,'',first+'#secret','https://u:password@foreign.invalid/test','mongodb://x/%2Fsecret','mongodb://x:99999/test'])assert.equal(driverAuditMongoLocationIdentity(value),null);
 assert(!JSON.stringify(a).includes('fictional-cluster'));assert(!JSON.stringify(a).includes(password));
});

test('fresh failing saved config and successful API snapshot are independently reported without exporting credentials',async t=>{
 const f=await fixture(t);const result=await f.run();assert.equal(result.status,'database-config-inspected');assert.equal(result.loadEnvAvailable,false);assert.equal(result.apiPm2SnapshotAvailable,true);assert.equal(result.configurationsEqual,false);assert.equal(result.sameCredentialFreeLocation,true);assert.equal(result.readOnly,true);assert.equal(result.authorityChanged,false);
 const evidence=openTransferSecrets(privateKey,result.capsule);assert.equal(evidence.attempts.loadEnv.available,false);assert.equal(evidence.attempts.loadEnv.error.code,8000);assert.equal(evidence.attempts.loadEnv.error.authenticationRejected,true);assert.equal(evidence.attempts.apiPm2Snapshot.available,true);assert.equal(evidence.attempts.apiPm2Snapshot.metadata.nativeFiles,5);assert.equal(evidence.attempts.apiPm2Snapshot.metadata.nativeChunks,6);assert.equal(evidence.attempts.apiPm2Snapshot.metadata.authorityAbsent,true);assert.equal(evidence.apiPm2Snapshot.currentApiDriverConnectionProven,false);assert.equal(f.calls.connect.length,2);assert.equal(f.calls.close,2);
 for(const data of [JSON.stringify(result),JSON.stringify(evidence)])for(const secret of [first,second,password,'saved-user','api-user','fictional-cluster.example.invalid'])assert(!data.includes(secret));
 const allowed=['version','status','applicationCommit','recipientSha256','evidenceSha256','capsule','loadEnvAvailable','apiPm2SnapshotAvailable','apiEnvironmentAmbiguous','configurationsEqual','sameCredentialFreeLocation','durableMergedAvailable','loadEnvEqualsDurableMerged','readOnly','authorityChanged'];assert(Object.keys(result).every(key=>allowed.includes(key)));
});

test('the actual declared deployment npm wrapper is accepted with its exact trusted executable and arguments',async t=>{
 const f=await fixture(t);f.entries[0].pm2_env.pm_exec_path='/usr/bin/npm';f.entries[0].pm2_env.args=['start','--prefix','server'];const result=await f.run();assert.equal(result.status,'database-config-inspected');assert.equal(result.apiPm2SnapshotAvailable,true);
});

test('npm wrappers with different arguments, executables, writable binaries or non-system npm-cli targets are rejected',async t=>{
 for(const mutate of [f=>f.entries[0].pm2_env.args=['start'],f=>f.entries[0].pm2_env.args=['start','--prefix','other'],f=>f.entries[0].pm2_env.pm_exec_path='/tmp/npm',f=>f.adapters.systemFile=async()=>({realpath:'/tmp/npm/bin/npm-cli.js',isFile:true,uid:0,mode:0o100644,bytes:100,sha256:'f'.repeat(64)}),f=>f.adapters.systemFile=async()=>({realpath:'/usr/lib/node_modules/npm/bin/npm-cli.js',isFile:true,uid:0,mode:0o100666,bytes:100,sha256:'f'.repeat(64)}),f=>f.adapters.systemFile=async()=>({realpath:'/usr/lib/node_modules/npm/bin/npm-cli.js',isFile:true,uid:1000,mode:0o100644,bytes:100,sha256:'f'.repeat(64)})]){const f=await fixture(t);mutate(f);await assert.rejects(f.run());assert.equal(f.calls.connect.length,0);}
});

test('equal direct/nested values use two fresh read-only probes and never select a replacement connection',async t=>{
 const f=await fixture(t,{apiUri:first,authFail:false});f.entries[0].pm2_env.env={MONGODB_URI:first};const r=await f.run();assert.equal(r.configurationsEqual,true);assert.equal(r.loadEnvAvailable,true);assert.equal(r.apiPm2SnapshotAvailable,true);assert.equal(f.calls.connect.length,2);assert.equal(f.calls.close,2);assert.equal(f.calls.commands.filter(c=>c.hello).length,2);assert.equal(f.calls.commands.filter(c=>c.dbStats).length,2);assert.equal(f.env.MONGODB_URI,first);assert(f.calls.exec.every(c=>c.file==='git'||c.file==='pm2'));assert(!f.calls.exec.some(c=>c.args.includes('save')||c.args.includes('restart')));
});

test('the unique nested API snapshot is accepted; conflicting snapshots are sealed and never probed',async t=>{
 const f=await fixture(t);delete f.entries[0].pm2_env.MONGODB_URI;f.entries[0].pm2_env.env={MONGODB_URI:second};assert.equal((await f.run()).apiPm2SnapshotAvailable,true);
 f.calls.connect.length=0;f.entries[0].pm2_env.MONGODB_URI=first;const r=await f.run();const e=openTransferSecrets(privateKey,r.capsule);assert.equal(r.apiEnvironmentAmbiguous,true);assert.equal(r.apiPm2SnapshotAvailable,false);assert.equal(r.configurationsEqual,null);assert.equal(f.calls.connect.length,1);assert.equal(e.apiPm2Snapshot.ambiguous,true);assert.equal(e.attempts.apiPm2Snapshot.attempted,false);
});

test('a missing or wrong-database URI never causes a different database to be read',async t=>{
 const f=await fixture(t,{loadEnvUri:'',apiUri:second.replace('/test?','/other?')});const r=await f.run();assert.equal(r.loadEnvAvailable,false);assert.equal(r.apiPm2SnapshotAvailable,false);assert.equal(f.calls.connect.length,0);const e=openTransferSecrets(privateKey,r.capsule);assert.equal(e.attempts.apiPm2Snapshot.error.code,'TARGET_DATABASE_MISMATCH');assert.equal(f.calls.reads.length,0);
});

test('ambiguous or mismatched managed API registration stops before any database attempt',async t=>{
 for(const mutation of [f=>f.entries.push(structuredClone(f.entries[0])),f=>f.entries[0].pm2_env.status='stopped',f=>f.entries[0].pid=0,f=>f.entries[0].pm2_env.pm_cwd=f.server,f=>f.entries[0].pm2_env.pm_exec_path='/unrelated/server.js']){const f=await fixture(t);mutation(f);await assert.rejects(f.run(),/Database configuration diagnostic stopped/);assert.equal(f.calls.connect.length,0);}
});

test('invalid recipient/operation/platform and dirty checkouts fail before probing and cannot leak exec secrets',async t=>{
 const f=await fixture(t);await assert.rejects(f.run({recipientPublicKey:'not a key'}));await assert.rejects(f.run({operation:'apply-database-config'}));assert.equal(f.calls.exec.length,0);const dirty=await fixture(t,{dirty:true});await assert.rejects(dirty.run(),error=>{assert(!error.message.includes(password));assert(!JSON.stringify(error).includes(first));return true;});assert.equal(dirty.calls.connect.length,0);
});

test('process or effective-environment drift prevents returning a stale diagnostic capsule',async t=>{
 const f=await fixture(t,{drift:true});await assert.rejects(f.run(),/Database configuration diagnostic stopped/);assert.equal(f.calls.close,2);
});

test('metadata permission failure is distinct from failed authentication; authority presence remains a boolean',async t=>{
 const f=await fixture(t,{authFail:false,metadataFail:true});const r=await f.run();const e=openTransferSecrets(privateKey,r.capsule);assert.equal(r.loadEnvAvailable,false);assert.equal(e.attempts.loadEnv.connected,true);assert.equal(e.attempts.loadEnv.error.code,13);assert.equal(e.attempts.loadEnv.error.authenticationRejected,false);
 const present=await fixture(t,{authFail:false,authorityPresent:true});const pe=openTransferSecrets(privateKey,(await present.run()).capsule);assert.equal(pe.attempts.loadEnv.metadata.authorityAbsent,false);assert(!JSON.stringify(pe).includes('writeFence'));
});

test('deadline closes the fresh client and a late connect cannot begin further reads',async t=>{
 let release;const held=new Promise(resolve=>{release=resolve;});const f=await fixture(t,{attemptTimeoutMs:10,connect:async()=>held});const result=await f.run();assert.equal(result.loadEnvAvailable,false);assert.equal(result.apiPm2SnapshotAvailable,false);assert.equal(f.calls.close,2);assert.equal(f.calls.commands.length,0);release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.commands.length,0);const e=openTransferSecrets(privateKey,result.capsule);assert.equal(e.attempts.loadEnv.error.code,'DIAGNOSTIC_TIMEOUT');
});

test('arbitrary database, process and close error messages never appear in the result or sealed evidence',async t=>{
 const f=await fixture(t,{connect:async()=>{throw Object.assign(Error(first+' '+password),{name:first,code:18,codeName:second});},closeError:true});const r=await f.run();const e=openTransferSecrets(privateKey,r.capsule);for(const bytes of [JSON.stringify(r),JSON.stringify(e)])assert(!bytes.includes(password));assert.equal(e.attempts.loadEnv.error.class,'Error');assert.equal(e.attempts.loadEnv.error.code,18);
 const bad=await fixture(t,{pm2Error:true});await assert.rejects(bad.run(),error=>!String(error.stack).includes(password)&&!JSON.stringify(error).includes(first));
});

test('durable base/local dotenv merge is probed once independently of the bad inherited URI without exporting file hashes',async t=>{
 const f=await fixture(t,{baseFile:'MONGODB_URI="'+second+'"\nUNRELATED=keep\n',localFile:'OTHER=unchanged\n'});const r=await f.run();assert.equal(r.loadEnvAvailable,false);assert.equal(r.durableMergedAvailable,true);assert.equal(r.loadEnvEqualsDurableMerged,false);assert.equal(f.calls.connect.length,3);assert.equal(f.env.MONGODB_URI,first);const e=openTransferSecrets(privateKey,r.capsule);assert.equal(e.attempts.durableMerged.available,true);assert.equal(e.durableMerged.inheritedEnvironmentIgnored,true);assert.equal(e.durableMerged.currentApiDriverConnectionProven,false);assert.equal(e.durableMerged.physicalConfigIntegrityRechecked,true);assert.equal(e.durableMerged.files.base.mongoKeyPresent,true);assert.equal(e.durableMerged.files.local.mongoKeyPresent,false);assert.equal(e.durableMerged.files.base.modifiedAfterApiStart,true);
 const privateHashes=[await fs.readFile(path.join(f.server,'.env')),await fs.readFile(path.join(f.server,'.env.local'))];for(const data of [JSON.stringify(r),JSON.stringify(e)]){for(const secret of [password,first,second,'fictional-cluster.example.invalid'])assert(!data.includes(secret));for(const b of privateHashes)assert(!data.includes((await import('node:crypto')).createHash('sha256').update(b).digest('hex')));}
});

test('real dotenv loadEnv precedence retains inherited values unless the local file explicitly overrides them',async t=>{
 for(const localOverrides of [false,true]){const f=await fixture(t,{baseFile:'MONGODB_URI="'+second+'"\n',localFile:localOverrides?'MONGODB_URI="'+second+'"\n':'OTHER=keep\n'});const old=f.adapters.load;f.adapters.load=async name=>{if(name==='loadEnv.js'){dotenv.config({path:path.join(f.server,'.env'),processEnv:f.env});dotenv.config({path:path.join(f.server,'.env.local'),override:true,processEnv:f.env});return{};}return old(name);};const r=await f.run();assert.equal(r.durableMergedAvailable,true);assert.equal(r.loadEnvAvailable,localOverrides);assert.equal(r.loadEnvEqualsDurableMerged,localOverrides);}
});

test('exact dotenv precedence/counting honors multiline quoted values and local overrides, without trying backups',async t=>{
 const base='MONGODB_URI="'+first+'"\nMONGODB_URI="'+second+'"\nMULTI="line1\nMONGODB_URI=not-a-key\nline2"\n';const local='export MONGODB_URI: '+first+'\nMONGODB_URI="'+second+'"\n';const f=await fixture(t,{baseFile:base,localFile:local});await fs.writeFile(path.join(f.server,'.env.backup'),'MONGODB_URI=mongodb://foreign.invalid/test\n',{mode:0o600});const e=openTransferSecrets(privateKey,(await f.run()).capsule);assert.equal(e.durableMerged.files.base.mongoKeyDefinitions,2);assert.equal(e.durableMerged.files.base.duplicateMongoKeyDefinitions,1);assert.equal(e.durableMerged.files.local.mongoKeyDefinitions,2);assert.equal(e.durableMerged.files.local.duplicateMongoKeyDefinitions,1);assert.equal(e.durableMerged.mongoKeyDefinitions,4);assert.equal(e.durableMerged.duplicateMongoKeyDefinitions,3);assert.equal(e.attempts.durableMerged.available,true);assert.equal(f.calls.connect.length,3);assert.equal(f.calls.connect.at(-1).uri,second);
});

test('durable file bytes, identity or mtime drift blocks a stale result and leaves every file unchanged by the operator',async t=>{
 for(const kind of ['bytes','mtime','new-local']){const options={baseFile:'MONGODB_URI="'+second+'"\n'};const f=await fixture(t,options);let changed=false;options.connect=async()=>{if(changed)return;changed=true;if(kind==='bytes')await fs.writeFile(path.join(f.server,'.env'),'MONGODB_URI="'+first+'"\n');else if(kind==='mtime'){const now=new Date(Date.now()+10000);await fs.utimes(path.join(f.server,'.env'),now,now);}else await fs.writeFile(path.join(f.server,'.env.local'),'OTHER=new\n',{mode:0o600});};await assert.rejects(f.run(),error=>error.phase==='recheck'&&!String(error.stack).includes(password));assert.equal(f.calls.close,3);}
});

test('a symlink, writable or oversized durable environment is rejected before any fresh Mongo attempt',async t=>{
 for(const kind of ['symlink','writable','oversized']){const f=await fixture(t);const file=path.join(f.server,'.env');if(kind==='symlink'){const outside=path.join(f.appRoot,'unrelated');await fs.writeFile(outside,'MONGODB_URI="'+second+'"\n',{mode:0o600});await fs.symlink(outside,file);}else{await fs.writeFile(file,kind==='oversized'?Buffer.alloc(256*1024+1):'MONGODB_URI="'+second+'"\n',{mode:0o600});if(kind==='writable')await fs.chmod(file,0o666);}await assert.rejects(f.run());assert.equal(f.calls.connect.length,0);}
});

test('absent files, empty local URI and bad durable auth cannot select a different arbitrary configuration',async t=>{
 const absent=await fixture(t);const ae=openTransferSecrets(privateKey,(await absent.run()).capsule);assert.equal(ae.durableMerged.files.base.present,false);assert.equal(ae.durableMerged.files.local.present,false);assert.equal(ae.attempts.durableMerged.attempted,false);
 const empty=await fixture(t,{baseFile:'MONGODB_URI="'+second+'"\n',localFile:'MONGODB_URI=""\n'});const ee=openTransferSecrets(privateKey,(await empty.run()).capsule);assert.equal(ee.durableMerged.files.local.mongoKeyPresent,true);assert.equal(ee.attempts.durableMerged.attempted,false);assert.equal(empty.calls.connect.length,2);
 const bad=await fixture(t,{baseFile:'MONGODB_URI="'+first+'"\n'});delete bad.entries[0].pm2_env.MONGODB_URI;const br=await bad.run();assert.equal(br.durableMergedAvailable,false);assert.equal(br.loadEnvEqualsDurableMerged,true);assert.equal(bad.calls.connect.length,2);assert(bad.calls.connect.every(c=>c.uri===first));
});

test('real isolated Mongo rejects inherited credentials while the exact durable dotenv URI remains read-only', {skip:!process.env.MONGO_TEST_URI},async t=>{
 const {MongoClient}=await import('../../server/node_modules/mongodb/lib/index.js');const parsed=new URL(process.env.MONGO_TEST_URI);assert(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname));const uri='mongodb://'+parsed.host+'/test?directConnection=true',bad='mongodb://fictional-user:'+password+'@'+parsed.host+'/test?authSource=test&directConnection=true';const client=new MongoClient(uri,{serverSelectionTimeoutMS:3000});await client.connect();t.after(()=>client.close());const db=client.db('test'),before=await db.command({dbStats:1});const f=await fixture(t,{loadEnvUri:bad,baseFile:'MONGODB_URI="'+uri+'"\n',localFile:'OTHER=keep\n'});delete f.entries[0].pm2_env.MONGODB_URI;const previousLoad=f.adapters.load;f.adapters.load=async name=>name==='node_modules/mongodb/lib/index.js'?{MongoClient}:previousLoad(name);const r=await f.run();const e=openTransferSecrets(privateKey,r.capsule),after=await db.command({dbStats:1});assert.equal(r.loadEnvAvailable,false);assert.equal(r.durableMergedAvailable,true);assert.equal(r.loadEnvEqualsDurableMerged,false);assert.equal(e.attempts.loadEnv.error.code,18);assert.equal(e.attempts.durableMerged.available,true);for(const key of ['collections','objects','dataSize','storageSize'])assert.equal(after[key],before[key]);for(const data of [JSON.stringify(r),JSON.stringify(e)]){assert(!data.includes(uri));assert(!data.includes(bad));assert(!data.includes(password));assert(!data.includes(parsed.host));}
});

test('the reviewed bridge selects only the new database-check operator for its explicit diagnostic operation',async()=>{
 const workflow=await fs.readFile(new URL('../workflows/driver-audit-native-handoff.yml',import.meta.url),'utf8'),bridge=await fs.readFile(new URL('./driver-audit-native-handoff.mjs',import.meta.url),'utf8');assert(workflow.includes('- inspect-database-config'));assert.match(workflow,/inspect-database-config\) operator=database-check/);assert(bridge.includes('runDriverAuditNativeDatabaseCheck'));assert(bridge.includes("'inspect-database-config'"));
});
