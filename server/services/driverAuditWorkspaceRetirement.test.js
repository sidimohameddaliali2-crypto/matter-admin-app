import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {gzipSync,gunzipSync} from 'node:zlib';
import {pruneDriverAuditWorkspace} from './driverAuditWorkspace.js';
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
  async function add(revision){
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
    const manifest=json({'runtime.private.json':sha(browser),'generated.private.json':sha(reviews)}),manifestSha256=sha(manifest);
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
    const accepted={privateRoot,manifestSha256,sourceBasis,collectorRevision:revision};
    const binding={manifestSha256,generation,reportHash,descriptorSha256:descriptor.sha256};
    await write(path.join(directory,'accepted.private.json'),json(accepted));
    await write(path.join(directory,'direct-seed.private.json'),json({version:1,mode:'sync',bundleRoot,collectorRevision:revision,sourceBasis,manifestSha256,
      visibleCutoffAt:null,pointer:{version:1,generation,reportHash,descriptor},closureReceipt:{version:1,status:'verified',sourceBasis,...binding,
        checkedAt:'2026-11-12T00:00:00.000Z',checks:{archive:true,photos:true,reviewHistory:true}},restore:{version:1,archive:'matter-report-archive',verified:true,...binding}}));
    const item={directory,privateRoot,bundleRoot,saved,accepted,descriptor,ref,browser,reportHash};attempts.push(item);return item;
  }
  const prune=options=>pruneDriverAuditWorkspace({root,receiptRoot,retirement,...options});
  async function point(){
    const current=attempts.at(-1),previous=attempts.at(-2);
    await write(path.join(root,'current.private.json'),json({...current.accepted,previous:previous?.accepted,baselineRoot:previous?.privateRoot}));
  }
  return {root,receiptRoot,retirement,transport,add,prune,point};
}

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
