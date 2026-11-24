import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,createPublicKey} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {pathToFileURL} from 'node:url';

const exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const targetDatabase='test';
const check=(condition)=>{if(!condition)throw Error('Diagnostic guard failed');};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const errorClasses=new Set(['MongoServerError','MongoNetworkError','MongoNetworkTimeoutError',
 'MongoServerSelectionError','MongoParseError','MongoInvalidArgumentError']);
const networkCodes=new Set(['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNABORTED',
 'DIAGNOSTIC_TIMEOUT','MISSING_CONFIGURATION','INVALID_CONFIGURATION','AMBIGUOUS_CONFIGURATION','TARGET_DATABASE_MISMATCH']);

// This identity deliberately excludes usernames, passwords and all URI options.
// Only its hash leaves this function; even the sealed evidence has no raw hosts.
export function driverAuditMongoLocationIdentity(uri){
 if(typeof uri!=='string'||!uri.length||uri.length>8192||/[\x00-\x20\x7f#]/.test(uri))return null;
 const match=/^(mongodb(?:\+srv)?):\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?[^#]*)?$/.exec(uri);
 if(!match)return null;
 const authority=match[2].slice(match[2].lastIndexOf('@')+1),hosts=[];
 for(const item of authority.split(',')){
  const parsed=/^(\[[a-fA-F0-9:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::([0-9]{1,5}))?$/.exec(item);
  if(!parsed||parsed[1].includes('..')||(parsed[2]&&(Number(parsed[2])<1||Number(parsed[2])>65535)))return null;
  if(match[1]==='mongodb+srv'&&(parsed[2]||authority.includes(',')||parsed[1].startsWith('[')))return null;
  const hostname=parsed[1].toLowerCase();hosts.push({hostname,port:match[1]==='mongodb+srv'?null:Number(parsed[2]||27017)});
 }
 if(!hosts.length||hosts.length>16)return null;
 let database;try{database=decodeURIComponent(match[3]||'test');}catch{return null;}
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(database))return null;
 hosts.sort((a,b)=>a.hostname.localeCompare(b.hostname)||(a.port||0)-(b.port||0));
 const identity={version:1,scheme:match[1],hosts,database};
 return{locationSha256:hash(JSON.stringify(identity)),targetDatabaseSha256:hash(database),
  targetDatabaseMatches:database===targetDatabase,
  remote:!hosts.every(({hostname})=>['localhost','127.0.0.1','[::1]'].includes(hostname))};
}

function recipient(value){
 check(typeof value==='string'&&value.length<=8192&&!value.includes('PRIVATE KEY')
  &&/^-----BEGIN (?:RSA )?PUBLIC KEY-----[\s\S]+-----END (?:RSA )?PUBLIC KEY-----\s*$/.test(value));
 const key=createPublicKey(value);check(key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails.modulusLength>=3072);
 return key;
}

function safeError(error){
 const code=integer(error?.code)&&error.code<=2147483647?error.code:networkCodes.has(error?.code)?error.code:null;
 return{class:errorClasses.has(error?.name)?error.name:'Error',code,
  authenticationRejected:code===18||(code===8000&&/bad auth|authentication failed|auth failed/i.test(String(error?.message||'')))};
}

function configuration(uri){
 const present=typeof uri==='string'&&uri.length>0,identity=driverAuditMongoLocationIdentity(uri);
 return{present,valid:identity!==null,...(identity||{})};
}

const environmentLimit=256*1024;
const environmentStat=info=>({dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,
 ctimeMs:info.ctimeMs,mode:info.mode,uid:info.uid,gid:info.gid});

// Match the installed dotenv parser's assignment grammar only to count Mongo
// definitions. Values always come from dotenv.parse, never from this counter.
function mongoDefinitions(bytes){
 const line=/(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
 return[...bytes.toString().replace(/\r\n?/mg,'\n').matchAll(line)].filter(match=>match[1]==='MONGODB_URI').length;
}

async function ownedEnvironmentFile(file,parse){
 let before;
 try{before=await fs.lstat(file);}catch(error){if(error.code!=='ENOENT')throw error;return{present:false,pin:null,uri:undefined,mongoKeyPresent:false,definitions:0};}
 check(before.isFile()&&!before.isSymbolicLink()&&before.uid===process.getuid()
  &&!(before.mode&0o022)&&before.size<=environmentLimit);
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const opened=await handle.stat();check(isDeepStrictEqual(environmentStat(before),environmentStat(opened)));
  const bytes=Buffer.alloc(opened.size);let offset=0;
  while(offset<bytes.length){const part=await handle.read(bytes,offset,bytes.length-offset,offset);check(part.bytesRead>0);offset+=part.bytesRead;}
  check((await handle.read(Buffer.alloc(1),0,1,offset)).bytesRead===0);
  const after=await handle.stat(),pathAfter=await fs.lstat(file);
  check(isDeepStrictEqual(environmentStat(opened),environmentStat(after))
   &&isDeepStrictEqual(environmentStat(opened),environmentStat(pathAfter))&&await fs.realpath(file)===file);
  const parsed=parse(bytes);check(parsed&&typeof parsed==='object'&&!Array.isArray(parsed));
  const mongoKeyPresent=Object.hasOwn(parsed,'MONGODB_URI');check(!mongoKeyPresent||typeof parsed.MONGODB_URI==='string');
  return{present:true,pin:{...environmentStat(opened),sha256:hash(bytes)},uri:mongoKeyPresent?parsed.MONGODB_URI:undefined,
   mongoKeyPresent,definitions:mongoDefinitions(bytes)};
 }finally{await handle.close();}
}

async function durableEnvironment(server,parse){
 const base=await ownedEnvironmentFile(path.join(server,'.env'),parse),local=await ownedEnvironmentFile(path.join(server,'.env.local'),parse);
 return{base,local,uri:local.mongoKeyPresent?local.uri:base.uri};
}

function durableFileMetadata(value,apiStartedAt){
 const modified=value.present?value.pin.mtimeMs:null;
 return{present:value.present,ownerPrivate:value.present?!(value.pin.mode&0o077):null,
  bytes:value.present?value.pin.size:0,mongoKeyPresent:value.mongoKeyPresent,mongoKeyDefinitions:value.definitions,
  duplicateMongoKeyDefinitions:Math.max(0,value.definitions-1),
  modifiedAt:modified===null?null:new Date(modified).toISOString(),
  modifiedAfterApiStart:modified===null||apiStartedAt===null?null:modified>apiStartedAt};
}

async function systemFileIdentity(file){
 const realpath=await fs.realpath(file),before=await fs.lstat(realpath);
 check(before.isFile()&&before.size>0&&before.size<=64*1024);
 const handle=await fs.open(realpath,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const opened=await handle.stat();check(opened.isFile()&&opened.dev===before.dev&&opened.ino===before.ino
   &&opened.size===before.size&&opened.uid===before.uid&&opened.mode===before.mode);
  const bytes=await handle.readFile();check(bytes.length===opened.size&&await fs.realpath(file)===realpath);
  return{realpath,isFile:true,uid:opened.uid,mode:opened.mode,bytes:opened.size,sha256:hash(bytes)};
 }finally{await handle.close();}
}

async function apiSnapshot(entries,appRoot,systemFile){
 check(Array.isArray(entries)&&entries.length<=512);
 const matching=entries.filter(row=>row?.name==='matter-delivery-api');check(matching.length===1);
 const api=matching[0],settings=api.pm2_env;
 check(integer(api.pm_id)&&Number.isSafeInteger(api.pid)&&api.pid>0&&settings?.status==='online'
  &&settings.pm_cwd===appRoot&&isDeepStrictEqual(settings.args,['start','--prefix','server']));
 const npm=await systemFile('/usr/bin/npm');
 check(npm?.isFile===true&&npm.uid===0&&!(npm.mode&0o022)&&integer(npm.bytes)&&npm.bytes>0&&npm.bytes<=64*1024
  &&/^[a-f0-9]{64}$/.test(npm.sha256||'')
  &&/^\/usr\/(?:share\/nodejs|(?:local\/)?lib\/node_modules)\/npm\/bin\/npm-cli\.js$/.test(npm.realpath||'')
  &&['/usr/bin/npm',npm.realpath].includes(settings.pm_exec_path));
 const values=[settings.MONGODB_URI,settings.env?.MONGODB_URI].filter(value=>value!==undefined&&value!==null);
 check(values.every(value=>typeof value==='string'&&value.length<=8192));
 const distinct=[...new Set(values.filter(Boolean))],ambiguous=distinct.length>1;
 return{uri:distinct.length===1?distinct[0]:null,ambiguous,present:distinct.length>0,
  registration:{id:api.pm_id,pid:api.pid,startedAt:integer(settings.pm_uptime)?settings.pm_uptime:null,
   launchContract:'npm-start-prefix-server',executableIdentitySha256:hash(JSON.stringify([npm.realpath,npm.sha256])),
   executablePathSha256:hash(settings.pm_exec_path)},
  sources:{direct:typeof settings.MONGODB_URI==='string'&&settings.MONGODB_URI.length>0,
   nested:typeof settings.env?.MONGODB_URI==='string'&&settings.env.MONGODB_URI.length>0}};
}

async function freshProbe({uri,ambiguous=false,MongoClient,timeoutMs}){
 const startedAt=new Date().toISOString(),config=configuration(uri);
 const result={startedAt,completedAt:null,attempted:false,connected:false,hello:false,available:false,
  connectionClosed:true,configuration:config,metadata:null,error:null};
 let client,active=true,timer;
 const requireActive=()=>{if(!active)throw Object.assign(Error('Diagnostic deadline reached'),{code:'DIAGNOSTIC_TIMEOUT'});};
 try{
  if(ambiguous)throw Object.assign(Error('Ambiguous diagnostic configuration'),{code:'AMBIGUOUS_CONFIGURATION'});
  if(!config.present)throw Object.assign(Error('Missing diagnostic configuration'),{code:'MISSING_CONFIGURATION'});
  if(!config.valid)throw Object.assign(Error('Invalid diagnostic configuration'),{code:'INVALID_CONFIGURATION'});
  if(!config.targetDatabaseMatches)throw Object.assign(Error('Wrong diagnostic database'),{code:'TARGET_DATABASE_MISMATCH'});
  client=new MongoClient(uri,{maxPoolSize:1,minPoolSize:0,serverSelectionTimeoutMS:5000,
   connectTimeoutMS:5000,socketTimeoutMS:5000,retryReads:false,retryWrites:false,
   appName:'driver-reports-readonly-database-check',monitorCommands:false});result.attempted=true;
  const work=(async()=>{
   await client.connect();requireActive();result.connected=true;
   const db=client.db(targetDatabase);check(db.databaseName===targetDatabase);
   const hello=await db.command({hello:1},{maxTimeMS:5000});requireActive();check(hello?.ok===1);result.hello=true;
   const stats=await db.command({dbStats:1,scale:1,maxTimeMS:5000});requireActive();check(stats?.ok===1);
   const nativeFiles=await db.collection('driverAuditNativeFiles').countDocuments({},{maxTimeMS:5000});requireActive();
   const nativeChunks=await db.collection('driverAuditNativeChunks').countDocuments({},{maxTimeMS:5000});requireActive();
   const capacity=await db.collection('driverAuditNativeControl').findOne({_id:'capacity'},
    {projection:{_id:1,limitBytes:1,usedBytes:1,technicalBytes:1},maxTimeMS:5000});requireActive();
   const authority=await db.collection('driverAuditNativeControl').findOne({_id:'authority'},
    {projection:{_id:1},maxTimeMS:5000});requireActive();
   check(integer(nativeFiles)&&integer(nativeChunks));
   const dbStats={};for(const name of ['dataSize','storageSize','indexSize','totalSize','objects','collections']){
    check(stats[name]===undefined||integer(stats[name]));if(stats[name]!==undefined)dbStats[name]=stats[name];
   }
   let nativeCapacity=null;if(capacity){check(integer(capacity.limitBytes)&&integer(capacity.usedBytes)
    &&(capacity.technicalBytes===undefined||integer(capacity.technicalBytes)));
    nativeCapacity={limitBytes:capacity.limitBytes,usedBytes:capacity.usedBytes,technicalBytes:capacity.technicalBytes??0};}
   return{targetDatabaseSha256:hash(targetDatabase),dbStats,nativeFiles,nativeChunks,nativeCapacity,authorityAbsent:authority===null};
  })();
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;reject(Object.assign(Error('Diagnostic deadline reached'),{code:'DIAGNOSTIC_TIMEOUT'}));},timeoutMs);});
  result.metadata=await Promise.race([work,deadline]);requireActive();result.available=true;
 }catch(error){result.error=safeError(error);}
 finally{
  active=false;clearTimeout(timer);
  if(client){let closeTimer;try{await Promise.race([Promise.resolve(client.close()),new Promise((_,reject)=>{
   closeTimer=setTimeout(()=>reject(Error('Close deadline reached')),2000);})]);}catch{result.connectionClosed=false;}finally{clearTimeout(closeTimer);}}
  result.completedAt=new Date().toISOString();
 }
 return result;
}

// This operation reads configurations and metadata only. It never replaces an
// environment value, saves PM2 state, imports models, or changes native authority.
export async function runDriverAuditNativeDatabaseCheck({operation,appRoot,expectedSha,recipientPublicKey},adapters={}){
 let phase='input';const execute=adapters.exec||exec,env=adapters.env||process.env;
 try{
  check(operation==='inspect-database-config');const key=recipient(recipientPublicKey);
  check(typeof appRoot==='string'&&path.isAbsolute(appRoot)&&path.resolve(appRoot)===appRoot
   &&await fs.realpath(appRoot)===appRoot&&/^[a-f0-9]{40}$/.test(expectedSha||''));
  const server=path.join(appRoot,'server');check(await fs.realpath(server)===server);
  const checkout=async()=>{
   check((adapters.platform||process.platform)==='linux'
    &&(await execute('git',['rev-parse','HEAD'],{cwd:appRoot,timeout:5000,maxBuffer:4096})).stdout.trim()===expectedSha);
   await execute('git',['diff','--quiet',expectedSha,'--','server/loadEnv.js','server/server.js',
    'server/package.json','server/package-lock.json','server/services/driverAuditTransferCodec.js'],
    {cwd:appRoot,timeout:5000,maxBuffer:4096});
  };
  phase='checkout';await checkout();
  const load=adapters.load||(name=>import(pathToFileURL(path.join(server,name)).href));
  phase='durable-files';const dotenv=await load('node_modules/dotenv/lib/main.js');
  const parse=dotenv.default?.parse||dotenv.parse;check(typeof parse==='function');
  const durable=await durableEnvironment(server,parse);
  phase='environment';await load('loadEnv.js');const effectiveUri=env.MONGODB_URI;
  phase='processes';const processes=async()=>JSON.parse((await execute('pm2',['jlist'],{cwd:appRoot,timeout:5000,maxBuffer:8*1024*1024})).stdout);
  const snapshot=await apiSnapshot(await processes(),appRoot,adapters.systemFile||systemFileIdentity);
  check(await fs.realpath(path.join(server,'server.js'))===path.join(server,'server.js'));
  const {MongoClient}=await load('node_modules/mongodb/lib/index.js');check(typeof MongoClient==='function');
  const timeoutMs=adapters.attemptTimeoutMs??20000;check(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=20000);
  phase='read-only-probes';
  const loadEnv=await freshProbe({uri:effectiveUri,MongoClient,timeoutMs});
  const apiPm2Snapshot=await freshProbe({uri:snapshot.uri,ambiguous:snapshot.ambiguous,MongoClient,timeoutMs});
  const durableMerged=await freshProbe({uri:durable.uri,MongoClient,timeoutMs});
  phase='recheck';await checkout();const after=await apiSnapshot(await processes(),appRoot,adapters.systemFile||systemFileIdentity);
  check(isDeepStrictEqual(snapshot,after)&&env.MONGODB_URI===effectiveUri);
  const durableAfter=await durableEnvironment(server,parse);
  check(isDeepStrictEqual(durable.base.pin,durableAfter.base.pin)&&isDeepStrictEqual(durable.local.pin,durableAfter.local.pin));
  const current=configuration(effectiveUri),api=configuration(snapshot.uri);
  const configurationsEqual=snapshot.ambiguous||!current.present||!api.present?null:effectiveUri===snapshot.uri;
  const sameCredentialFreeLocation=snapshot.ambiguous||!current.valid||!api.valid?null:current.locationSha256===api.locationSha256;
  const loadEnvEqualsDurableMerged=typeof effectiveUri==='string'&&typeof durable.uri==='string'?effectiveUri===durable.uri:null;
  const evidence={version:1,kind:'read-only-native-database-config-diagnostic',applicationCommit:expectedSha,
   checkedAt:new Date().toISOString(),targetDatabaseSha256:hash(targetDatabase),
   loadEnv:{...current,selection:'actual-loadEnv-effective-value'},
   apiPm2Snapshot:{...api,ambiguous:snapshot.ambiguous,registration:snapshot.registration,sources:snapshot.sources,
    selection:'pm2-launch-environment-snapshot',currentApiDriverConnectionProven:false},
   durableMerged:{...configuration(durable.uri),selection:'physical-dotenv-base-then-local',inheritedEnvironmentIgnored:true,
    currentApiDriverConnectionProven:false,physicalConfigIntegrityRechecked:true,
    files:{base:durableFileMetadata(durable.base,snapshot.registration.startedAt),local:durableFileMetadata(durable.local,snapshot.registration.startedAt)},
    mongoKeyDefinitions:durable.base.definitions+durable.local.definitions,
    duplicateMongoKeyDefinitions:Math.max(0,durable.base.definitions+durable.local.definitions-1)},
   comparison:{configurationsEqual,sameCredentialFreeLocation,loadEnvEqualsDurableMerged},attempts:{loadEnv,apiPm2Snapshot,durableMerged},
   readOnly:true,authorityChanged:false,credentialsExported:false,uriValuesExported:false};
  const evidenceBytes=Buffer.from(JSON.stringify(evidence));check(evidenceBytes.length<=32*1024);
  const {sealTransferSecrets}=await load('services/driverAuditTransferCodec.js');
  const capsule=sealTransferSecrets(key,evidence);
  return{version:1,status:'database-config-inspected',applicationCommit:expectedSha,
   loadEnvAvailable:loadEnv.available,apiPm2SnapshotAvailable:apiPm2Snapshot.available,
   durableMergedAvailable:durableMerged.available,loadEnvEqualsDurableMerged,
   apiEnvironmentAmbiguous:snapshot.ambiguous,configurationsEqual,sameCredentialFreeLocation,
   recipientSha256:hash(recipientPublicKey),evidenceSha256:hash(evidenceBytes),capsule,readOnly:true,authorityChanged:false};
 }catch{throw Object.assign(Error('Database configuration diagnostic stopped'),{phase});}
}
