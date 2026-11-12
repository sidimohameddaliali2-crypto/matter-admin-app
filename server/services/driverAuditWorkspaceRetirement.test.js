import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {gzipSync,gunzipSync} from 'node:zlib';
import {pruneDriverAuditWorkspace} from './driverAuditWorkspace.js';
import {prunePreviousDriverAuditCopies} from './driverAuditWorkspaceRetirement.js';
import {driverAuditPackagePointer} from './driverAuditDirectImport.js';
import {checkedAuditPointer} from '../vendor/driver-audits/integration/cloud/audit-replica.mjs';
import {archiveBytes,archiveCatalog,readManifestBytes} from '../vendor/driver-audits/integration/cloud/repository.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value));
const write=(file,bytes)=>fs.writeFile(file,bytes,{mode:0o600});

async function fixture(t){
  const base=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'audit-workspace-retirement-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'work'),receiptRoot=path.join(base,'archive-receipts');
  await fs.mkdir(receiptRoot,{mode:0o700});
  const archived=new Map(),sources=new Map(),attempts=[];
  const transport={
    async putVerifiedObject(key,bytes){archived.set(key,bytes);return {key,sha256:key.slice(0,-3),verified:true};},
    async readObject(key){return [archived.get(key)];},
  };
  const recipe={builderSha256:sha('builder'),rendererSha256:sha('renderer'),journalsSha256:sha('journals'),baselineManifestSha256:sha('baseline')};
  const retirement={transport,sourceBasis:source=>source.basis,readSourceReceipt:async revision=>sources.get(revision),recipe};
  async function add(revision,{archiveMirrors=false}={}){
    const directory=path.join(root,'attempts',String(revision).padStart(8,'0')+'-0000-4000-8000-000000000000');
    const privateRoot=path.join(directory,'server-data'),bundleRoot=path.join(directory,'audit-objects'),saved=path.join(directory,'saved-current');
    for(const subdir of [privateRoot,bundleRoot,saved])await fs.mkdir(subdir,{recursive:true,mode:0o700});
    const browser=json({revision}),reportHash=sha('report'+revision),generation=sha(browser),sourceBasis=sha('basis'+revision);
    const reviews=json({snapshotHash:reportHash,rows:[]});
    const sourceFiles=[['assets/snapshot-'+generation+'.json.gz',browser],['review-snapshots/'+reportHash+'.json.gz',reviews]];
    const entries=[];
    for(const [name,body]of sourceFiles)entries.push(await archiveBytes(transport,gzipSync(body),{domain:'state',path:name}));
    const state={revision,body:JSON.stringify({version:1,basis:sourceBasis,head:{reportHash,manifest:{sha256:generation,url:'report-data/snapshot-'+generation+'.json'}},catalog:await archiveCatalog(transport,entries)})};
    sources.set(revision,state);
    await write(path.join(saved,'collector-state.private.json'),json(state));
    await write(path.join(saved,'current-browser.private.json'),browser);
    await write(path.join(saved,'current-reviews.private.json'),reviews);
    const localFiles={'runtime.private.json':sha(browser),'generated.private.json':sha(reviews)};
    const mirrors=[];
    if(archiveMirrors){
      for(const [kind,verified]of [['archived',true],['unverified',false]]){
        const payload=gzipSync(json({revision,kind})),hash=sha(payload),name='archive-'+hash+'.private.bin',key=hash+'.gz';
        const file=path.join(privateRoot,name);
        localFiles[name]=hash;
        await write(file,payload);
        if(verified){
          archived.set(key,payload);
          await write(path.join(receiptRoot,key+'.json'),json({target:'matter-report-archive',key,sha256:hash,bytes:payload.length,verified:true}));
        }
        mirrors.push({file,payload});
      }
    }
    const manifest=json(localFiles),manifestSha256=sha(manifest);
    await write(path.join(privateRoot,'files.private.json'),manifest);
    await write(path.join(privateRoot,'runtime.private.json'),browser);
    await write(path.join(privateRoot,'generated.private.json'),reviews);
    await write(path.join(privateRoot,'unknown.private.json'),json({preserve:true}));
    await write(path.join(directory,'combined-reviews.private.json'),reviews);
    const ref=await archiveBytes(transport,browser,{domain:'previewRuntime',path:'runtime.private.json'});
    const descriptor=await archiveBytes(transport,json({version:1,generation,reportHash,sourceManifestSha256:manifestSha256,files:{'runtime.private.json':ref}}),{domain:'previewPackage',path:'descriptor.json'});
    for(const chunk of [...descriptor.chunks,...ref.chunks]){
      const key=chunk.sha256+'.gz';
      await write(path.join(bundleRoot,key),archived.get(key));
      await write(path.join(receiptRoot,key+'.json'),json({target:'matter-report-archive',key,sha256:chunk.sha256,bytes:chunk.size,verified:true}));
    }
    const prior=attempts.at(-1)?.accepted;
    const accepted={version:1,basis:sourceBasis,privateRoot,manifestSha256,sourceBasis,collectorRevision:revision,
      baselineRoot:prior?.privateRoot??path.join(base,'baseline'),
      previous:prior?{basis:prior.basis,privateRoot:prior.privateRoot,manifestSha256:prior.manifestSha256}:null};
    const binding={manifestSha256,generation,reportHash,descriptorSha256:descriptor.sha256};
    await write(path.join(directory,'accepted.private.json'),json(accepted));
    const seed={version:1,mode:'sync',bundleRoot,collectorRevision:revision,sourceBasis,manifestSha256,
      visibleCutoffAt:null,pointer:{version:1,generation,reportHash,descriptor},closureReceipt:{version:1,status:'verified',sourceBasis,...binding,
        checkedAt:'2026-11-12T00:00:00.000Z',checks:{archive:true,photos:true,reviewHistory:true}},restore:{version:1,archive:'matter-report-archive',verified:true,...binding}};
    await write(path.join(directory,'direct-seed.private.json'),json(seed));
    const head=checkedAuditPointer(driverAuditPackagePointer(seed));
    const item={directory,privateRoot,bundleRoot,saved,accepted,head,descriptor,ref,browser,reportHash,mirrors};attempts.push(item);return item;
  }
  const prune=options=>pruneDriverAuditWorkspace({root,receiptRoot,retirement,...options});
  async function point(){
    await write(path.join(root,'current.private.json'),json(attempts.at(-1).accepted));
  }
  return {root,receiptRoot,retirement,transport,add,prune,point};
}

test('only the previous accepted archive copies are reclaimable under disk pressure',async t=>{
  const f=await fixture(t),previous=await f.add(1,{archiveMirrors:true}),current=await f.add(2);
  await f.point();
  const key=previous.ref.chunks[0].sha256+'.gz';
  const file=path.join(previous.bundleRoot,key);
  const currentFile=path.join(current.bundleRoot,current.ref.chunks[0].sha256+'.gz');
  const head={...current.head,importedAt:'2026-11-12T00:00:00.000Z',transferBytes:16384,objects:2,previous:previous.head};
  const options={root:f.root,receiptRoot:f.receiptRoot,head,stage:null,retentionStatus:'qualified'};
  const reclaim=overrides=>prunePreviousDriverAuditCopies({...options,...overrides});
  for(const override of [
    {retentionStatus:'proof-stale'},
    {stage:{pointer:previous.head}},
    {head:{...options.head,sourceRevision:999}},
    {head:{...options.head,sourceBodySha256:sha('changed')}},
    {head:{...options.head,previous:{...previous.head,reportHash:sha('changed')}}},
  ])assert.equal(await reclaim(override),null);
  const archived=await fs.readFile(file);
  const archiveReceipt=path.join(f.receiptRoot,key+'.json'),savedReceipt=await fs.readFile(archiveReceipt);
  await fs.unlink(archiveReceipt);
  assert.equal(await reclaim(),'proof-unavailable');
  assert.deepEqual(await fs.readFile(file),archived);
  await write(archiveReceipt,savedReceipt);
  const extra=path.join(previous.bundleRoot,sha('unlisted')+'.gz');
  await write(extra,'unlisted');
  const result=await reclaim();
  const [mirror,unverified]=previous.mirrors;
  assert.equal(result.files,2);
  assert.equal(result.bytes,archived.length+mirror.payload.length);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
  await assert.rejects(fs.stat(mirror.file),{code:'ENOENT'});
  assert.deepEqual(await fs.readFile(unverified.file),unverified.payload);
  assert.equal(await fs.readFile(extra,'utf8'),'unlisted');
  assert.deepEqual(await fs.readFile(path.join(previous.privateRoot,'runtime.private.json')),previous.browser);
  assert.deepEqual(await fs.readFile(path.join(previous.saved,'current-browser.private.json')),previous.browser);
  assert.ok(await fs.stat(path.join(previous.bundleRoot,previous.descriptor.chunks[0].sha256+'.gz')));
  assert.ok(await fs.stat(currentFile));
  assert.equal(await reclaim(),null);
  const descriptor=JSON.parse(await readManifestBytes(f.transport,previous.descriptor,{maxBytes:16_384}));
  assert.deepEqual(await readManifestBytes(f.transport,descriptor.files['runtime.private.json'],{maxBytes:16_384}),previous.browser);
  await f.add(3);await f.point();
  assert.equal((await f.prune()).attemptsRetired,1);
});

test('a prepared archive copy inventory resumes only against the same verified pair and receipts',async t=>{
  const f=await fixture(t),previous=await f.add(1,{archiveMirrors:true}),current=await f.add(2);
  await f.point();
  const options={root:f.root,receiptRoot:f.receiptRoot,head:{...current.head,previous:previous.head},stage:null,retentionStatus:'qualified'};
  const proof=path.join(previous.directory,'retired-archive-copies.private.json');
  const file=previous.mirrors[0].file,unlink=fs.unlink;
  const interruption=t.mock.method(fs,'unlink',async target=>{
    if(target===file)throw Error('Fixture interruption');
    return unlink(target);
  });
  try{await assert.rejects(prunePreviousDriverAuditCopies(options),/Fixture interruption/);}
  finally{interruption.mock.restore();}
  assert.equal(JSON.parse(await fs.readFile(proof)).status,'prepared');
  await assert.rejects(fs.stat(path.join(previous.bundleRoot,previous.ref.chunks[0].sha256+'.gz')),{code:'ENOENT'});
  assert.equal(await prunePreviousDriverAuditCopies({...options,stage:{pointer:current.head}}),null);
  const key=sha(previous.mirrors[0].payload)+'.gz',receipt=path.join(f.receiptRoot,key+'.json');
  const original=await fs.readFile(receipt);
  await fs.unlink(receipt);
  await assert.rejects(prunePreviousDriverAuditCopies(options),/restore receipt changed/);
  assert.ok(await fs.stat(file));
  await write(receipt,original);
  assert.equal((await prunePreviousDriverAuditCopies(options)).files,2);
  assert.equal(JSON.parse(await fs.readFile(proof)).status,'retired');
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
});

test('repeated cycles retire known generated data while restoring the archived package and keeping protected candidates',async t=>{
  const f=await fixture(t),retired=[];
  for(let revision=1;revision<=6;revision++){
    const item=await f.add(revision);retired.push(item);await f.point();
    await f.prune({protectedManifests:[retired[0].accepted.manifestSha256]});
  }
  for(const item of retired.slice(1,4)){
    const receipt=path.join(item.directory,'retired-workspace.private.json');
    const proof=JSON.parse(await fs.readFile(receipt));
    assert.equal(proof.status,'retired');
    assert.ok((await fs.stat(receipt)).size<4096);
    const inventory=await fs.readFile(path.join(item.directory,proof.inventoryFile));
    assert.equal(sha(inventory),proof.inventoryCompressedSha256);
    assert.equal(sha(gunzipSync(inventory)),proof.inventorySha256);
    assert.deepEqual(await fs.readdir(item.privateRoot),['unknown.private.json']);
    assert.deepEqual(await fs.readdir(item.bundleRoot),[]);
    assert.deepEqual(await fs.readdir(item.saved),[]);
    const descriptor=JSON.parse(await readManifestBytes(f.transport,item.descriptor,{maxBytes:16_384}));
    const restored=await readManifestBytes(f.transport,descriptor.files['runtime.private.json'],{maxBytes:16_384});
    assert.deepEqual(restored,item.browser);
  }
  for(const item of [retired[0],...retired.slice(-2)])assert.equal((await fs.stat(path.join(item.privateRoot,'runtime.private.json'))).isFile(),true);
  assert.equal((await f.prune({protectedManifests:[retired[0].accepted.manifestSha256]})).attemptsRetired,0);
});

test('retirement preserves local inputs when the exact source restore cannot be verified',async t=>{
  const f=await fixture(t),old=await f.add(1);
  await f.add(2);await f.add(3);await f.point();
  const status=await f.prune({retirement:{...f.retirement,readSourceReceipt:async()=>({revision:999,body:'{}'})}});
  assert.equal(status.retirementDeferred,1);
  assert.equal((await fs.stat(path.join(old.saved,'current-browser.private.json'))).isFile(),true);
  await assert.rejects(fs.stat(path.join(old.directory,'retired-workspace.private.json')),{code:'ENOENT'});
});

test('retirement requires the exact archived runtime receipts before deleting generated files',async t=>{
  const f=await fixture(t),old=await f.add(1);
  await f.add(2);await f.add(3);await f.point();
  await fs.unlink(path.join(f.receiptRoot,old.ref.chunks[0].sha256+'.gz.json'));
  await f.prune();
  assert.equal((await fs.stat(path.join(old.privateRoot,'runtime.private.json'))).isFile(),true);
  await assert.rejects(fs.stat(path.join(old.directory,'retired-workspace.private.json')),{code:'ENOENT'});
});

test('retirement records proof before unlinking and resumes an interrupted deletion without re-reading sources',async t=>{
  const f=await fixture(t),old=await f.add(1);
  await f.add(2);await f.add(3);await f.point();
  const receipt=path.join(old.directory,'retired-workspace.private.json'),unlink=fs.unlink;
  let removes=0;
  const mocked=t.mock.method(fs,'unlink',async file=>{
    if(file.startsWith(old.directory)&&++removes===2)throw Error('Fixture interruption');
    return unlink(file);
  });
  try{await assert.rejects(f.prune(),/Fixture interruption/);}finally{mocked.mock.restore();}
  assert.equal(JSON.parse(await fs.readFile(receipt)).status,'prepared');
  await assert.rejects(fs.stat(path.join(old.saved,'collector-state.private.json')),{code:'ENOENT'});
  assert.equal((await fs.stat(path.join(old.saved,'current-browser.private.json'))).isFile(),true);
  await f.prune({retirement:{...f.retirement,readSourceReceipt:async()=>assert.fail('Prepared receipt must resume locally')}});
  assert.equal(JSON.parse(await fs.readFile(receipt)).status,'retired');
  assert.deepEqual(await fs.readdir(old.saved),[]);
});

test('retirement persists directory deletions before marking the proof complete',async t=>{
  const f=await fixture(t),old=await f.add(1);
  await f.add(2);await f.add(3);await f.point();
  const proof=path.join(old.directory,'retired-workspace.private.json');
  const events=[];
  const open=fs.open,rename=fs.rename,unlink=fs.unlink;
  t.mock.method(fs,'open',async(file,...options)=>{
    const handle=await open(file,...options);
    if(file===old.directory||file.startsWith(old.directory+path.sep)){
      const sync=handle.sync.bind(handle);
      handle.sync=async()=>{await sync();events.push(['sync',file]);};
    }
    return handle;
  });
  t.mock.method(fs,'rename',async(from,to)=>{
    if(to===proof)events.push(['publish',JSON.parse(await fs.readFile(from)).status]);
    return rename(from,to);
  });
  t.mock.method(fs,'unlink',async file=>{
    await unlink(file);
    if(file.startsWith(old.directory+path.sep))events.push(['unlink',path.dirname(file)]);
  });

  await f.prune();
  const completed=events.findIndex(([event,status])=>event==='publish'&&status==='retired');
  assert.ok(completed>=0);
  for(const directory of [old.directory,old.privateRoot,old.bundleRoot,old.saved]){
    const removed=events.findLastIndex(([event,target])=>event==='unlink'&&target===directory);
    const persisted=events.slice(0,completed).findLastIndex(([event,target])=>event==='sync'&&target===directory);
    assert.ok(removed>=0&&persisted>removed,'The directory change must reach disk before retirement is marked complete');
  }
  assert.deepEqual(events.slice(completed+1),[['sync',proof],['sync',old.directory]]);
});

async function abandonedFixture(t){
  const f=await fixture(t),orphan=await f.add(1),previous=await f.add(2),current=await f.add(3);
  await f.point();
  for(const file of ['accepted.private.json','direct-seed.private.json'])await fs.unlink(path.join(orphan.directory,file));
  const savedState=JSON.parse(await fs.readFile(path.join(orphan.saved,'collector-state.private.json')));
  const manifest=await fs.readFile(path.join(orphan.privateRoot,'files.private.json'));
  const reviews=await fs.readFile(path.join(orphan.saved,'current-reviews.private.json'));
  await write(path.join(orphan.directory,'receipt.private.json'),json({version:1,root:orphan.privateRoot,manifestSha256:sha(manifest),
    baseline:{path:previous.privateRoot,manifestSha256:previous.accepted.manifestSha256},
    canonical:{reviewsPath:path.join(orphan.saved,'current-reviews.private.json'),reviewsSha256:sha(reviews),
      browserSha256:sha(orphan.browser),head:JSON.parse(savedState.body).head}}));
  await write(path.join(f.root,'status.private.json'),json({status:'ready',id:path.basename(current.directory)}));
  return {f,orphan,previous,current};
}

test('abandoned workspace dry run and cleanup verify archived inputs and keep unknown or protected files',async t=>{
  const {f,orphan,previous,current}=await abandonedFixture(t);
  const cache=path.join(f.root,'archive-cache','a'.repeat(64)+'.gz');
  await fs.mkdir(path.dirname(cache));await write(cache,'cached');
  const options={abandoned:'plan',protectedManifests:[current.accepted.manifestSha256],maxCacheBytes:0};
  const plan=await f.prune(options);
  assert.equal(plan.abandoned.attempts,1);
  assert.ok(plan.abandoned.bytes>0);
  assert.deepEqual(await fs.readFile(path.join(orphan.privateRoot,'runtime.private.json')),orphan.browser);
  assert.equal(await fs.readFile(cache,'utf8'),'cached');
  const result=await f.prune({...options,abandoned:'apply'});
  assert.equal(result.abandoned.attempts,plan.abandoned.attempts);
  assert.equal(result.abandoned.bytes,plan.abandoned.bytes);
  assert.deepEqual(await fs.readdir(orphan.saved),[]);
  assert.deepEqual(await fs.readdir(orphan.privateRoot),['files.private.json','unknown.private.json']);
  assert.deepEqual(await fs.readFile(path.join(previous.privateRoot,'runtime.private.json')),previous.browser);
  assert.deepEqual(await fs.readFile(path.join(current.privateRoot,'runtime.private.json')),current.browser);
  const proof=JSON.parse(await fs.readFile(path.join(orphan.directory,'abandoned-workspace.private.json')));
  assert.equal(proof.source.revision,1);
  assert.equal(proof.scope,'source-and-rebuild');
  assert.equal(proof.baseline.manifestSha256,previous.accepted.manifestSha256);
  assert.equal(proof.status,'retired');
  assert.equal((await f.prune({...options,abandoned:'apply'})).abandoned.attempts,0);
});

test('abandoned workspace preserves live, staged and unverified candidates',async t=>{
  const {f,orphan}=await abandonedFixture(t);
  const source=path.join(orphan.saved,'current-browser.private.json');
  assert.equal((await f.prune({abandoned:'apply',protectedManifests:[orphan.accepted.manifestSha256]})).abandoned.attempts,0);
  await write(path.join(f.root,'status.private.json'),json({status:'building',id:path.basename(orphan.directory)}));
  assert.equal((await f.prune({abandoned:'apply'})).abandoned.attempts,0);
  await write(path.join(f.root,'status.private.json'),json({status:'ready',id:'ffffffff-0000-4000-8000-000000000000'}));
  await write(source,Buffer.from('unverified'));
  const result=await f.prune({abandoned:'apply'});
  assert.equal(result.abandoned.attempts,0);
  assert.equal(result.retirementDeferred,1);
  assert.equal(await fs.readFile(source,'utf8'),'unverified');
  assert.deepEqual(await fs.readFile(path.join(orphan.privateRoot,'runtime.private.json')),orphan.browser);
  assert.ok((await fs.readdir(orphan.bundleRoot)).length);
  await assert.rejects(fs.stat(path.join(orphan.directory,'abandoned-workspace.private.json')),{code:'ENOENT'});
});

test('malformed or unavailable abandoned proofs defer without blocking another build and can retry',async t=>{
  const {f,orphan}=await abandonedFixture(t);
  const file=path.join(orphan.privateRoot,'files.private.json'),manifest=await fs.readFile(file);
  await write(file,'{"interrupted":');
  assert.equal((await f.prune({abandoned:'apply'})).retirementDeferred,1);
  await write(file,manifest);
  const unavailable=await f.prune({abandoned:'apply',retirement:{...f.retirement,readSourceReceipt:async()=>{throw Error('Archive temporarily unavailable');}}});
  assert.equal(unavailable.retirementDeferred,1);
  assert.equal(unavailable.abandoned.attempts,0);
  assert.ok((await fs.readdir(orphan.bundleRoot)).length);
  assert.equal((await f.prune({abandoned:'apply'})).abandoned.attempts,1);
});

test('verified abandoned copies can be removed without deleting unique outputs of an unavailable baseline',async t=>{
  const {f,orphan,previous}=await abandonedFixture(t);
  const manifest=path.join(previous.privateRoot,'files.private.json');
  await write(manifest,json({changed:true}));
  const result=await f.prune({abandoned:'apply'});
  assert.equal(result.abandoned.attempts,1);
  assert.deepEqual(await fs.readdir(orphan.saved),[]);
  assert.deepEqual(await fs.readFile(path.join(orphan.privateRoot,'runtime.private.json')),orphan.browser);
  const proof=JSON.parse(await fs.readFile(path.join(orphan.directory,'abandoned-workspace.private.json')));
  assert.equal(proof.scope,'copies-only');
  assert.equal(proof.baseline,null);
});

test('abandoned workspace resumes a durable inventory after unlink interruption',async t=>{
  const {f,orphan}=await abandonedFixture(t),unlink=fs.unlink;
  const proof=path.join(orphan.directory,'abandoned-workspace.private.json');
  let removes=0;
  const mocked=t.mock.method(fs,'unlink',async file=>{
    if(file.startsWith(orphan.directory)&&++removes===2)throw Error('Fixture interrupted orphan');
    return unlink(file);
  });
  try{await assert.rejects(f.prune({abandoned:'apply'}),/Fixture interrupted orphan/);}finally{mocked.mock.restore();}
  assert.equal(JSON.parse(await fs.readFile(proof)).status,'prepared');
  await f.prune({abandoned:'apply',retirement:{...f.retirement,readSourceReceipt:async()=>assert.fail('Prepared inventory must resume locally')}});
  assert.equal(JSON.parse(await fs.readFile(proof)).status,'retired');
  assert.deepEqual(await fs.readdir(orphan.saved),[]);
});
