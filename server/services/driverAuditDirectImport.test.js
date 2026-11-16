import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {gzipSync,gunzipSync} from 'node:zlib';
import {checkVerifiedAuditPackageTransfer,prepareRemotePreviewPackage} from '../vendor/driver-audits/integration/cloud/remote-preview-package.mjs';
import {prepareDirectAuditBundle} from '../vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import {runDriverAuditSyncTick} from './driverAuditSync.js';
import {archiveBytes} from '../vendor/driver-audits/integration/cloud/repository.mjs';
import {readDriverAuditSeedConfig,runDriverAuditDirectImport} from './driverAuditDirectImport.js';
import {withDriverAuditWriter} from './driverAuditWriter.js';
import {parseDriverAuditSeedArgs,runDriverAuditSeed} from '../scripts/driverAuditSeed.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const capacityBytes=1024*1024;
const at='2026-11-12T00:00:00.000Z';

async function fixture(t,{mode='bootstrap',collectorRevision=42,oversized=false}={}){
  const bundleRoot=await fs.mkdtemp(path.join(os.tmpdir(),'driver-audit-seed-'));
  t.after(()=>fs.rm(bundleRoot,{recursive:true,force:true}));
  const browser=Buffer.from(JSON.stringify({collectorRevision}));
  const generation=sha(browser),reportHash=sha('report-'+collectorRevision),catalogHash=sha('catalog');
  const snapshot={sha256:generation,url:'report-data/snapshot-'+generation+'.json'};
  const values={
    'publication.private.json':Buffer.from(JSON.stringify({head:{reportHash,manifest:snapshot,source:{observedAt:at}},catalog:{sha256:catalogHash}})),
    'identities.private.json':Buffer.from('{}'),
    'maps.private.json':Buffer.from('{}'),
    'gps-index.private.json.gz':gzipSync(Buffer.from('{"streamFiles":{}}')),
    'preview-read-view.private.json.gz':gzipSync(Buffer.from(JSON.stringify({reportHash,generation,catalogHash,browser:snapshot}))),
    'renderer.private.html':Buffer.from('<html></html>'),
    'build.private.json':Buffer.from('{}'),
    'browser-data.private.json.gz':gzipSync(browser),
  };
  const transport={
    async putVerifiedObject(key,bytes){
      await fs.writeFile(path.join(bundleRoot,key),bytes,{mode:0o600});
      return {key,sha256:sha(bytes),verified:true};
    },
  };
  const files={};
  for(const [name,bytes] of Object.entries(values)){
    files[name]=await archiveBytes(transport,bytes,{domain:'previewRuntime',path:name});
  }
  if(oversized){
    const size=8*1024*1024;
    files['browser-data.private.json.gz'].chunks=Array.from({length:17},(_,index)=>({
      offset:index*size,size,sha256:sha('oversized-chunk-'+index),
    }));
  }
  const manifestSha256=sha('manifest-'+collectorRevision),sourceBasis=sha('basis-'+collectorRevision);
  const descriptor=await archiveBytes(transport,Buffer.from(JSON.stringify({
    version:1,files,generation,reportHash,sourceManifestSha256:manifestSha256,
  })),{domain:'previewPackage',path:'descriptor.json'});
  const binding={manifestSha256,generation,reportHash,descriptorSha256:descriptor.sha256};
  const config={
    version:1,mode,bundleRoot,collectorRevision,sourceBasis,manifestSha256,visibleCutoffAt:at,
    pointer:{version:1,generation,reportHash,descriptor},
    closureReceipt:{version:1,status:'verified',...binding,sourceBasis,checkedAt:at,checks:{archive:true,photos:true,reviewHistory:true}},
    restore:{version:1,archive:'matter-report-archive',verified:true,...binding},
  };
  const configPath=path.join(bundleRoot,'seed.json');
  await fs.writeFile(configPath,JSON.stringify(config),{mode:0o600});
  return {config,configPath,blob:path.join(bundleRoot,files['renderer.private.html'].chunks[0].sha256+'.gz')};
}

function fakeDatabase(){
  const tables=new Map(['driverAuditObjects','driverAuditControl','driverAuditReleases'].map(name=>[name,new Map()]));
  let writes=0,failObjectWrite=false;
  const parts=key=>key.split('.');
  const get=(object,key)=>parts(key).reduce((value,part)=>value?.[part],object);
  const set=(object,key,value)=>{
    const segments=parts(key),last=segments.pop();
    for(const part of segments)object=object[part]??={};
    object[last]=value;
  };
  return {
    writes:()=>writes,
    failNextObjectWrite:()=>{failObjectWrite=true;},
    tables,
    collection(name){
      assert.ok(tables.has(name),'only audit collections may be used');
      const table=tables.get(name);
      return {
        findOne:async filter=>table.get(filter._id)??null,
        async insertOne(row){
          if(table.has(row._id))throw Object.assign(Error('duplicate'),{code:11000});
          table.set(row._id,row);
          return {insertedId:row._id};
        },
        async deleteOne(filter){
          const row=table.get(filter._id);
          if(!row||!Object.entries(filter).every(([key,value])=>get(row,key)===value))return {deletedCount:0};
          table.delete(filter._id);
          return {deletedCount:1};
        },
        async updateOne(filter,update,options){
          writes++;
          if(name==='driverAuditObjects'&&failObjectWrite){
            failObjectWrite=false;
            throw Error('fixture object write failed');
          }
          let current=table.get(filter._id);
          if(!current&&options?.upsert){
            current={_id:filter._id,...update.$setOnInsert};
            table.set(filter._id,current);
          }
          const matches=current&&Object.entries(filter).every(([key,expected])=>{
            const actual=get(current,key);
            if(expected&&typeof expected==='object'&&'$exists' in expected)return (actual!==undefined)===expected.$exists;
            if(expected&&typeof expected==='object'&&'$lte' in expected)return actual<=expected.$lte;
            return actual===expected;
          });
          if(!matches)return {matchedCount:0};
          for(const [key,value] of Object.entries(update.$inc??{}))set(current,key,(get(current,key)??0)+value);
          for(const [key,value] of Object.entries(update.$set??{}))set(current,key,value);
          return {matchedCount:1};
        },
      };
    },
  };
}

test('offline and database preflight validate the exact package without writes',async t=>{
  const {config,configPath}=await fixture(t),db=fakeDatabase();
  assert.deepEqual(await readDriverAuditSeedConfig(configPath),config);
  const local=await runDriverAuditDirectImport({config,capacityBytes});
  const remote=await runDriverAuditDirectImport({config,db,capacityBytes});
  assert.equal(local.status,'ready');
  assert.equal(local.databaseChecked,false);
  assert.equal(remote.databaseChecked,true);
  assert.equal(remote.generation,config.pointer.generation);
  assert.equal(remote.additionalChargeBytes,remote.transferBytes+remote.objects*1024);
  assert.equal(db.writes(),0);
});

test('bootstrap, exact retry and later direct sync preserve bounded previous metadata',async t=>{
  const first=await fixture(t),second=await fixture(t,{mode:'sync',collectorRevision:43});
  const db=fakeDatabase(),run=config=>runDriverAuditDirectImport({config,db,capacityBytes,apply:true});
  assert.equal((await run(first.config)).status,'imported');
  const control=db.tables.get('driverAuditControl');
  const initial=control.get('head').head;
  assert.deepEqual(initial.directImport,{
    version:1,collectorRevision:42,sourceBasis:first.config.sourceBasis,manifestSha256:first.config.manifestSha256,
  });
  assert.equal(initial.visibleCutoffAt,at);
  assert.deepEqual(initial.restore,first.config.restore);
  assert.equal(initial.previous,null);
  const writes=db.writes();
  assert.equal((await run({
    ...first.config,visibleCutoffAt:'2026-11-12T00:00:00Z',
    closureReceipt:{...first.config.closureReceipt,checkedAt:'2026-11-12T01:00:00.000Z'},
  })).status,'unchanged');
  assert.equal(db.writes(),writes);
  assert.equal((await run(second.config)).status,'imported');
  const updated=control.get('head').head;
  assert.equal(updated.previous.generation,initial.generation);
  assert.deepEqual(updated.previous.restore,initial.restore);
  assert.equal(Object.hasOwn(updated.previous,'previous'),false);
  assert.equal((await run(second.config)).status,'unchanged');
  await assert.rejects(run({...first.config,mode:'sync'}),/revision moved backwards/);
  assert.equal(control.get('head').head.generation,updated.generation);
});

test('source conflicts, unexpected target heads and insufficient capacity fail before writes',async t=>{
  const first=await fixture(t),second=await fixture(t,{mode:'sync',collectorRevision:43});
  const db=fakeDatabase();
  const run=(config,overrides={})=>runDriverAuditDirectImport({config,db,capacityBytes,apply:true,...overrides});
  await assert.rejects(run(second.config),/bootstrap/i);
  await assert.rejects(run(first.config,{capacityBytes:8}),error=>
    error.code==='AUDIT_CAPACITY'&&error.capacity?.kind==='replica-storage'&&
    error.capacity.availableBytes===8&&error.capacity.requiredBytes>8);
  assert.equal(db.writes(),0);
  const control=db.tables.get('driverAuditControl');
  control.set('head',{head:{sourceRevision:1,sourceBodySha256:sha('hosted')}});
  await assert.rejects(run(first.config),/existing audit head/i);
  await assert.rejects(run(second.config),/existing audit head/i);
  assert.equal(db.writes(),0);
  control.delete('head');
  await run(first.config);
  const writes=db.writes(),sourceBasis=sha('different');
  await assert.rejects(run({...first.config,mode:'sync',sourceBasis,closureReceipt:{...first.config.closureReceipt,sourceBasis}}),/revision conflict/i);
  assert.equal(db.writes(),writes);
});

test('a package beyond the transfer cap reports that limit before checking replica headroom',async t=>{
  const {config}=await fixture(t,{oversized:true});
  const db=fakeDatabase();
  await assert.rejects(runDriverAuditDirectImport({config,db,capacityBytes,apply:true}),error=>
    error.code==='AUDIT_CAPACITY'&&error.capacity?.kind==='import-transfer'&&
    error.capacity.availableBytes===128*1024*1024&&error.capacity.requiredBytes>128*1024*1024);
  assert.equal(db.writes(),0);
});

test('transfer sizing matches the direct package including its descriptor',async t=>{
  const {config}=await fixture(t);
  const privateRoot=await fs.realpath(config.bundleRoot);
  const descriptor=JSON.parse(await fs.readFile(path.join(privateRoot,config.pointer.descriptor.chunks[0].sha256+'.gz')));
  const files={};
  for(const [name,reference] of Object.entries(descriptor.files)){
    await fs.copyFile(path.join(privateRoot,reference.chunks[0].sha256+'.gz'),path.join(privateRoot,name));
    files[name]=reference.sha256;
  }
  const manifest=Buffer.from(JSON.stringify(files));
  await fs.writeFile(path.join(privateRoot,'files.private.json'),manifest,{mode:0o600});
  const validation={ok:true,manifestSha256:sha(manifest)};
  const actual=await prepareRemotePreviewPackage({privateRoot,maxBytes:128*1024*1024,validation,includeRetained:false,
    transport:{async putVerifiedObject(key,bytes){return {key,sha256:sha(bytes),verified:true};}},
    runBatch:async(_limits,operation)=>operation(),
  });
  assert.equal(checkVerifiedAuditPackageTransfer({privateRoot,maxBytes:actual.totalBytes,validation}),actual.totalBytes);
  assert.throws(()=>checkVerifiedAuditPackageTransfer({privateRoot,maxBytes:1,validation}),{
    code:'AUDIT_CAPACITY',capacity:{kind:'import-transfer',availableBytes:1,requiredBytes:actual.totalBytes},
  });
  assert.throws(()=>checkVerifiedAuditPackageTransfer({privateRoot,maxBytes:actual.totalBytes-1,validation}),{
    code:'AUDIT_CAPACITY',capacity:{kind:'import-transfer',availableBytes:actual.totalBytes-1,requiredBytes:actual.totalBytes},
  });
});

test('oversized package preparation reports the transfer limit before any archive reads',async t=>{
  const {config}=await fixture(t);
  const privateRoot=await fs.realpath(config.bundleRoot);
  const descriptor=JSON.parse(await fs.readFile(path.join(privateRoot,config.pointer.descriptor.chunks[0].sha256+'.gz')));
  for(const [name,reference] of Object.entries(descriptor.files)){
    await fs.copyFile(path.join(privateRoot,reference.chunks[0].sha256+'.gz'),path.join(privateRoot,name));
  }
  const deferred=Buffer.alloc(64*1024*1024);
  const deferredNames=['deferred-history.private.gz','deferred-gps.private.gz'];
  for(const name of deferredNames)await fs.writeFile(path.join(privateRoot,name),deferred,{mode:0o600});
  const viewFile=path.join(privateRoot,'preview-read-view.private.json.gz');
  const view=JSON.parse(gunzipSync(await fs.readFile(viewFile)));
  view.deferredQueryFiles={history:deferredNames[0],gps:deferredNames[1]};
  await fs.writeFile(viewFile,gzipSync(JSON.stringify(view)));
  const files={};
  for(const name of [...Object.keys(descriptor.files),...deferredNames])files[name]=sha(await fs.readFile(path.join(privateRoot,name)));
  const manifest=Buffer.from(JSON.stringify(files));
  await fs.writeFile(path.join(privateRoot,'files.private.json'),manifest,{mode:0o600});
  const statuses=[];
  const candidate={collectorRevision:43,sourceBasis:sha('new evidence'),privateRoot};
  const bundleRoot=path.join(privateRoot,'audit-objects');
  await assert.rejects(runDriverAuditSyncTick({
    readHead:async()=>({directImport:{version:1,collectorRevision:42,sourceBasis:sha('previous evidence')}}),
    readSource:async()=>({revision:43,basis:candidate.sourceBasis}),
    getCandidate:async()=>candidate,
    build:async()=>assert.fail('Expected the pinned candidate'),
    apply:async()=>prepareDirectAuditBundle({privateRoot,bundleRoot,validation:{ok:true,manifestSha256:sha(manifest)},
      archive:{verify:async()=>assert.fail('No archive reads before the capacity check')},mode:'sync'}),
    status:async value=>statuses.push(value),
  }),{code:'AUDIT_CAPACITY'});
  assert.equal(statuses.at(-1).status,'capacity-blocked');
  assert.equal(statuses.at(-1).capacity.kind,'import-transfer');
  assert.equal(statuses.at(-1).capacity.availableBytes,128*1024*1024);
  assert.ok(statuses.at(-1).capacity.requiredBytes>128*1024*1024);
  assert.deepEqual(await fs.readdir(bundleRoot),[]);
});

test('writer lock and unresolved stage protect interruption and exact retry',async t=>{
  const first=await fixture(t),second=await fixture(t,{collectorRevision:43});
  const db=fakeDatabase(),control=db.tables.get('driverAuditControl');
  const run=config=>runDriverAuditDirectImport({config,db,capacityBytes,apply:true});
  control.set('direct-writer',{_id:'direct-writer',token:'existing'});
  await assert.rejects(run(first.config),{code:'AUDIT_WRITER_BUSY'});
  assert.equal(control.get('direct-writer').token,'existing');
  control.delete('direct-writer');
  db.failNextObjectWrite();
  await assert.rejects(run(first.config),/package verification or database readback/i);
  assert.equal(control.get('head'),undefined);
  assert.equal(control.get('direct-writer'),undefined);
  assert.equal(control.get('direct-stage').pointer.generation,first.config.pointer.generation);
  await assert.rejects(run(second.config),/unresolved.*stage/i);
  assert.equal(control.get('direct-stage').pointer.generation,first.config.pointer.generation);
  assert.equal((await run(first.config)).status,'imported');
  assert.equal(control.get('direct-stage'),undefined);
  assert.equal(control.get('direct-writer'),undefined);
});

test('crashed locks recover only on the same boot after the exact owner PID has exited',async()=>{
  const db=fakeDatabase(),control=db.tables.get('driverAuditControl');
  const owner={_id:'direct-writer',token:'old-writer',identity:'same-boot',pid:99};
  control.set(owner._id,owner);
  const operation=async token=>assert.equal(control.get(owner._id).token,token);
  await assert.rejects(withDriverAuditWriter(db,operation,{identify:async()=>'other-boot',hasExited:()=>true}),{code:'AUDIT_WRITER_BUSY'});
  await assert.rejects(withDriverAuditWriter(db,operation,{identify:async()=>'same-boot',hasExited:()=>false}),{code:'AUDIT_WRITER_BUSY'});
  assert.equal(control.get(owner._id),owner);
  await withDriverAuditWriter(db,operation,{identify:async()=>'same-boot',hasExited:pid=>pid===owner.pid});
  assert.equal(control.has(owner._id),false);
});

test('unbound receipts, altered package bytes and exposed or linked inputs are rejected',async t=>{
  const {config,configPath,blob}=await fixture(t),db=fakeDatabase();
  const run=value=>runDriverAuditDirectImport({config:value,db,capacityBytes,apply:true});
  await assert.rejects(run({...config,closureReceipt:{...config.closureReceipt,checks:{archive:true,photos:false,reviewHistory:true}}}),/closure/i);
  await assert.rejects(run({...config,restore:{...config.restore,descriptorSha256:sha('other')}}),/restore/i);
  await assert.rejects(run({...config,visibleCutoffAt:'2026-11-12T01:00:00.000Z'}),/cutoff/i);
  await assert.rejects(run({...config,visibleCutoffAt:null}),/cutoff/i);
  const manifestSha256=sha('other manifest');
  await assert.rejects(run({...config,manifestSha256,restore:{...config.restore,manifestSha256},closureReceipt:{...config.closureReceipt,manifestSha256}}),/descriptor.*manifest/i);
  await fs.chmod(configPath,0o644);
  await assert.rejects(readDriverAuditSeedConfig(configPath),/owner-only/i);
  await fs.chmod(configPath,0o600);
  const bytes=await fs.readFile(blob);
  await fs.writeFile(blob,Buffer.alloc(bytes.length,1));
  await assert.rejects(run(config),/package.*verification/i);
  await fs.writeFile(blob,bytes);
  await fs.rename(blob,blob+'.original');
  await fs.symlink(blob+'.original',blob);
  await assert.rejects(run(config),/package.*verification/i);
  assert.equal(db.writes(),0);
});

test('CLI defaults to preflight and uses only the existing configured database',async t=>{
  const {configPath}=await fixture(t),db=fakeDatabase();
  assert.deepEqual(parseDriverAuditSeedArgs(['--config',configPath]),{configPath,apply:false});
  assert.deepEqual(parseDriverAuditSeedArgs(['--config',configPath,'--apply']),{configPath,apply:true});
  assert.throws(()=>parseDriverAuditSeedArgs(['--config',configPath,'--apply','--apply']),/usage/i);
  let connects=0,closed=0;
  const connect=async uri=>{
    assert.equal(uri,'existing-mongo');
    connects++;
    return {db,close:async()=>{closed++;}};
  };
  const env={MONGODB_URI:'existing-mongo',DRIVER_AUDIT_CAPACITY_BYTES:'8',DRIVER_AUDIT_DEPLOY_CAPACITY_BYTES:String(capacityBytes)};
  const output=await runDriverAuditSeed({args:['--config',configPath],env,connect});
  assert.equal(output.status,'ready');
  assert.equal(output.capacityBytes,capacityBytes);
  assert.equal(db.writes(),0);
  await assert.rejects(runDriverAuditSeed({args:['--config',configPath,'--apply'],env:{...env,DRIVER_AUDIT_IMPORT_ENABLED:'1'},connect}),/automatic imports/i);
  await assert.rejects(runDriverAuditSeed({args:['--config',configPath,'--apply'],env:{DRIVER_AUDIT_CAPACITY_BYTES:String(capacityBytes)},connect}),/existing app database/i);
  assert.equal(connects,1);
  assert.equal(closed,1);
  assert.equal((await runDriverAuditSeed({args:['--config',configPath,'--apply'],env,connect})).status,'imported');
  assert.equal(connects,2);
  assert.equal(closed,2);
});
