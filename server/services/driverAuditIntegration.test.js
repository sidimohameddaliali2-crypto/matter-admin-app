import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createDriverAuditIntegration} from './driverAuditIntegration.js';
import {archiveBytes} from '../vendor/driver-audits/integration/cloud/repository.mjs';

test('the API document and exact evidence aliases reach the canonical audit handler after authorization',async()=>{
 const origin='https://app.example.invalid';
 const seen=[];
 const coordinator=async(req,res)=>{seen.push(req.url);res.end('ok');};
 coordinator.status=()=>({status:'ready',active:{generation:'a'.repeat(64)}});
 coordinator.poll=async()=>{};
 const handler=createDriverAuditIntegration({
  env:{DRIVER_AUDIT_ENABLED:'1',DRIVER_AUDIT_ORIGIN:origin},
  dependencies:{
   auth:{authenticate:async cookie=>{if(cookie!=='staff')throw Object.assign(Error('Sign in'),{status:401});}},
   state:{},archive:{readObject:async()=>assert.fail('Route matching must not read archive data')},store:{},createCoordinator:()=>coordinator,
  },
 });
 const request=async(url,cookie)=>{
  let status=200;
  await handler({method:'GET',url,headers:{host:new URL(origin).host,cookie}},{
   setHeader(){},writeHead(value){status=value;},end(){},
  },()=>assert.fail('Expected the audit handler'));
  return status;
 };
 const hash='a'.repeat(64),snapshot=`/report-data/snapshot-${hash}.json?generation=${hash}`,font=`/report-assets/font-${hash}.woff2`;
 const document='/api/reporting/view?screen=reports&tab=mirror';
 assert.equal(await request(document),401);
 assert.equal(await request(document,'staff'),200);
 assert.equal(await request('/api/reporting'+snapshot,'staff'),200);
 assert.equal(await request('/api/reporting'+font,'staff'),200);
 assert.equal(await request('/api/reporting/report-assets/private.json','staff'),200);
 assert.deepEqual(seen,['/?screen=reports&tab=mirror',snapshot,font,'/api/reporting/report-assets/private.json']);
});

test('an active audit serves status and review writes during a slow import, then reports failure without losing the report',async t=>{
 let release,reads=0,polls=0,now=100000;
 const held=new Promise(resolve=>release=resolve);
 const env={DRIVER_AUDIT_ENABLED:'1',DRIVER_AUDIT_IMPORT_ENABLED:'1'};
 const coordinator=async(req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({savedReport:true,method:req.method}));};
 coordinator.status=()=>({status:'ready',active:{generation:'a'.repeat(64)}});
 coordinator.poll=async()=>{polls++;};
 const handler=createDriverAuditIntegration({env,dependencies:{clock:()=>now,auth:{authenticate:async()=>({})},state:{read:async()=>{reads++;await held;throw Error('source unavailable');}},archive:{readObject:async()=>{throw Error('must not read');}},store:{},budget:{reserve:async()=>({allowed:true}),settle:async()=>({settled:true})},createCoordinator:()=>coordinator}});
 const server=createServer((req,res)=>handler(req,res,()=>{res.writeHead(404);res.end();}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{release();await new Promise(resolve=>server.close(resolve));});
 env.DRIVER_AUDIT_ORIGIN='http://127.0.0.1:'+server.address().port;
 const call=(path,method='GET')=>fetch(env.DRIVER_AUDIT_ORIGIN+path,{method,signal:AbortSignal.timeout(2000)});
 const status=await call('/api/reporting/status');assert.equal(status.status,200);assert.equal(status.headers.get('x-audit-import-status'),'checking');assert.equal(reads,1);
 const saved=await call('/api/reporting/reviews','POST');assert.deepEqual(await saved.json(),{savedReport:true,method:'POST'});assert.equal(reads,1);assert.equal(polls,0);
 assert.equal((await call('/api/reporting/status')).status,200);assert.equal(reads,1);
 release();for(let i=0;i<100&&!polls;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(polls>=1);
 const failed=await call('/api/reporting/status');assert.equal(failed.status,200);assert.equal(failed.headers.get('x-audit-import-status'),'failed');assert.equal((await failed.json()).savedReport,true);assert.equal(reads,1);
 now+=61000;await call('/api/reporting/photo/image');await call('/api/reporting/reviews','POST');assert.equal(reads,1,'assets and review writes do not start transfers');
 await call('/api/reporting/status');assert.equal(reads,2,'next due status check retries');
});

async function retainedPackage(){
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const browser=Buffer.from('{}'),generation=hash(browser),reportHash=hash('report'),catalogHash=hash('catalog');
 const snapshot={sha256:generation,url:`report-data/snapshot-${generation}.json`};
 const values={
  'publication.private.json':Buffer.from(JSON.stringify({head:{reportHash,manifest:snapshot},catalog:{sha256:catalogHash}})),
  'identities.private.json':Buffer.from('{}'),
  'maps.private.json':Buffer.from('{}'),
  'gps-index.private.json.gz':gzipSync(Buffer.from('{"streamFiles":{}}')),
  'preview-read-view.private.json.gz':gzipSync(Buffer.from(JSON.stringify({reportHash,generation,catalogHash,browser:snapshot}))),
  'renderer.private.html':Buffer.from('<html></html>'),
  'build.private.json':Buffer.from('{}'),
  'browser-data.private.json.gz':gzipSync(browser),
 };
 const objects=new Map(),files={};
 const transport={async putVerifiedObject(key,bytes){objects.set(key,bytes);return {verified:true,sha256:hash(bytes)};}};
 for(const [name,bytes] of Object.entries(values))files[name]=await archiveBytes(transport,bytes,{domain:'previewRuntime',path:name});
 const descriptor=await archiveBytes(transport,Buffer.from(JSON.stringify({version:1,files,generation,reportHash,sourceManifestSha256:hash('source')})),{domain:'previewPackage',path:'descriptor.json'});
 const pointer={generation,reportHash,directImport:{version:1},restore:{verified:true,archive:'matter-report-archive',descriptorSha256:descriptor.sha256,generation,reportHash}};
 return {objects,descriptor,pointer};
}

async function integrationOptions({store,archive,budget,state={}}){
 let options;
 const coordinator=async(_req,res)=>res.end();
 coordinator.status=()=>({status:'ready',active:{generation:'a'.repeat(64)}});
 coordinator.poll=async()=>{};
 const handler=createDriverAuditIntegration({
  env:{DRIVER_AUDIT_ENABLED:'1',DRIVER_AUDIT_ORIGIN:'https://app.example.invalid'},
  dependencies:{auth:{authenticate:async()=>({})},state,store,archive,budget,
   createCoordinator:value=>{options=value;return coordinator;},
   createRuntime:value=>value,
  },
 });
 await handler({method:'GET',url:'/api/reporting/reviews',headers:{host:'app.example.invalid'}},{setHeader(){},end(){}},()=>assert.fail('Expected audit route'));
 return options;
}

test('loading the Mongo audit package never admits or reads external storage',async()=>{
 const fixture=await retainedPackage();
 let reads=0,peak=0;
 const options=await integrationOptions({
  store:{async readObject(key){
   reads++;peak=Math.max(peak,reads);
   try{await new Promise(resolve=>setImmediate(resolve));return [fixture.objects.get(key)];}
   finally{reads--;}
  }},
  archive:{readObject:async()=>assert.fail('Mongo package must stay local')},
  state:{read:async()=>assert.fail('Local reads must not create a budget reservation')},
 });
 const loaded=await options.loadPackage(fixture);
 assert.equal(loaded.generation,fixture.pointer.generation);
 assert.equal(peak,4);
 const runtime=options.createRuntime({packageOverride:loaded,automaticFeed:false});
 assert.equal(runtime.remoteReadsBudgeted,true);
});

test('verified restore fallback and runtime share one admitted and coalesced archive reader',async()=>{
 const fixture=await retainedPackage();
 let reads=0,reservations=0,settlements=0;
 const descriptorKey=fixture.descriptor.chunks[0].sha256+'.gz';
 const options=await integrationOptions({
  store:{readObject:async key=>{if(key===descriptorKey)throw Object.assign(Error('Missing'),{code:'AUDIT_OBJECT_MISSING'});return [fixture.objects.get(key)];}},
  archive:{readObject:async key=>{reads++;return [fixture.objects.get(key)];}},
  budget:{reserve:async()=>{reservations++;return {allowed:true};},settle:async()=>{settlements++;return {settled:true};}},
 });
 const loaded=await options.loadPackage(fixture);
 assert.equal(reservations,1,'restore must reserve before external data is read');
 const runtime=options.createRuntime({packageOverride:loaded,automaticFeed:false});
 assert.equal(runtime.remoteReadsBudgeted,true);
 await Promise.all(Array.from({length:3},()=>runtime.transportOverride.readObject(descriptorKey,{maxBytes:fixture.descriptor.size})));
 assert.equal(reads,1,'runtime shares the already verified restore cache');
 assert.equal(reservations,1);
 assert.equal(settlements,1);
});

test('restore fallback keeps denied external reads behind the allowance',async()=>{
 const fixture=await retainedPackage();
 let reservations=0;
 const options=await integrationOptions({
  store:{readObject:async()=>{throw Object.assign(Error('Missing'),{code:'AUDIT_OBJECT_MISSING'});}},
  archive:{readObject:async()=>assert.fail('Denied allowance must prevent external read')},
  budget:{reserve:async()=>{reservations++;return {allowed:false};},settle:async()=>assert.fail('Denied read has no settlement')},
 });
 await assert.rejects(options.loadPackage(fixture),{code:'AUDIT_BUDGET'});
 assert.equal(reservations,1);
});

test('restore only falls back for a missing object with its exact verified generation',async()=>{
 const fixture=await retainedPackage();
 const localFailure=Object.assign(Error('Corrupt'),{code:'AUDIT_OBJECT_CORRUPT'});
 let failure=localFailure;
 const options=await integrationOptions({
  store:{readObject:async()=>{throw failure;}},
  archive:{readObject:async()=>assert.fail('Corruption must not use external fallback')},
  budget:{reserve:async()=>assert.fail('Corruption must not reserve external allowance')},
 });
 await assert.rejects(options.loadPackage(fixture),error=>error===localFailure);
 failure=Object.assign(Error('Missing'),{code:'AUDIT_OBJECT_MISSING'});
 const mismatch={...fixture,pointer:{...fixture.pointer,restore:{...fixture.pointer.restore,generation:'b'.repeat(64)}}};
 await assert.rejects(options.loadPackage(mismatch),error=>error===failure);
});

test('restore does not expose fetched bytes when allowance settlement is uncertain',async()=>{
 const fixture=await retainedPackage();
 let reads=0,settlements=0;
 const options=await integrationOptions({
  store:{readObject:async()=>{throw Object.assign(Error('Missing'),{code:'AUDIT_OBJECT_MISSING'});}},
  archive:{readObject:async key=>{reads++;return [fixture.objects.get(key)];}},
  budget:{reserve:async()=>({allowed:true}),settle:async()=>{settlements++;return {settled:false};}},
 });
 await assert.rejects(options.loadPackage(fixture),{code:'AUDIT_BUDGET'});
 await assert.rejects(options.loadPackage(fixture),{code:'AUDIT_BUDGET'});
 assert.equal(reads,2,'unsettled data must not enter the shared cache');
 assert.equal(settlements,2);
});

test('audit authentication is reused only for the same verified request', async () => {
 const origin='https://app.example.invalid';
 let runtime, checks=0;
 const auth={
  async authenticate(cookie){
   checks++;
   if(cookie!=='staff')throw Object.assign(new Error('Sign in'),{status:401});
   return {actor:{id:'staff'},csrf:'fixture'};
  },
 };
 const coordinator=async(req,res)=>{
  const first=await runtime.authOverride.authenticate(req.headers.cookie,req);
  const second=await runtime.authOverride.authenticate(req.headers.cookie,req);
  assert.equal(first,second);
  await assert.rejects(runtime.authOverride.authenticate('other',req),{status:401});
  res.end();
 };
 coordinator.status=()=>({status:'ready',active:{generation:'a'.repeat(64)}});
 coordinator.poll=async()=>{};
 const handler=createDriverAuditIntegration({
  env:{DRIVER_AUDIT_ENABLED:'1',DRIVER_AUDIT_ORIGIN:origin},
  dependencies:{
   auth,state:{},archive:{readObject:async()=>assert.fail('No archive reads expected')},store:{},createRuntime:options=>options,
   createCoordinator:options=>{runtime=options.createRuntime({packageOverride:{}});return coordinator;},
  },
 });
 const request={method:'GET',url:'/api/reporting/view',headers:{host:'app.example.invalid',cookie:'staff'}};
 await handler(request,{setHeader(){},end(){},writeHead(){assert.fail('Unexpected rejection');}},()=>assert.fail('Expected audit route'));
 assert.equal(checks,2,'one verified check and one deliberate different-cookie check');
 await runtime.authOverride.authenticate('staff',request);
 assert.equal(checks,3,'verification is removed after dispatch');
 await handler({...request,url:'/api/reporting/view',headers:{host:'app.example.invalid'}},{
  writeHead(status){assert.equal(status,401);},end(){},
 },()=>assert.fail('Expected audit route'));
 assert.equal(checks,4,'signed-out request is checked separately');
});
