import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {archiveBytes} from '../vendor/driver-audits/integration/cloud/repository.mjs';
import {collectDriverAuditGarbage,planDriverAuditGarbage} from './driverAuditGarbageCollection.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const writerToken='isolated-driver-audit-writer';

async function fixture(){
  const objects=new Map(),archived=new Map(),control=new Map(),releases=new Map();
  const transport={
    async putVerifiedObject(key,bytes){
      objects.set(key,{_id:key,bytes:Buffer.from(bytes),size:bytes.length});
      archived.set(key,Buffer.from(bytes));
      return {key,sha256:sha(bytes),verified:true};
    },
    async readObject(key,{maxBytes}){
      const bytes=archived.get(key);
      assert.ok(bytes&&bytes.length<=maxBytes,'archive object must exist within its exact byte bound');
      return [bytes];
    },
  };
  async function release(name,revision,files){
    const generation=sha('generation:'+name),reportHash=sha('report:'+name),manifestSha256=sha('manifest:'+name);
    const refs={};
    for(const [file,body] of Object.entries(files)){
      refs[file]=await archiveBytes(transport,Buffer.from(body),{domain:'previewRuntime',path:file});
    }
    const descriptor=await archiveBytes(transport,Buffer.from(JSON.stringify({
      version:1,sourceManifestSha256:manifestSha256,generation,reportHash,files:refs,
    })),{domain:'previewPackage',path:'descriptor.json'});
    const sourceBodySha256=sha('pointer:'+name);
    const head={
      version:1,generation,reportHash,descriptor,sourceRevision:revision,sourceBodySha256,
      directImport:{version:1,collectorRevision:revision,manifestSha256,sourceBasis:sha('basis:'+name)},
      restore:{version:1,verified:true,archive:'matter-report-archive',manifestSha256,generation,reportHash,descriptorSha256:descriptor.sha256},
    };
    releases.set(sourceBodySha256,{_id:sourceBodySha256,head});
    return head;
  }
  const old=await release('old',1,{'shared.json':'shared','old.json':'old','staged.json':'needed for stage'});
  const previous=await release('previous',2,{'previous.json':'previous'});
  const active=await release('active',3,{'shared.json':'shared','active.json':'active'});
  const staged=await release('staged',4,{'staged.json':'needed for stage','staged-extra.json':'staged extra'});
  releases.delete(staged.sourceBodySha256);
  const orphanBytes=Buffer.from('unresolved orphan'),orphanKey=sha(orphanBytes)+'.gz';
  await transport.putVerifiedObject(orphanKey,orphanBytes);
  control.set('head',{_id:'head',head:{...active,previous}});
  control.set('direct-stage',{_id:'direct-stage',pointer:staged});
  control.set('direct-writer',{_id:'direct-writer',token:writerToken});
  const allocations=Object.fromEntries([...objects].map(([key,object])=>[key.slice(0,-3),object.size+1024]));
  control.set('capacity',{_id:'capacity',used:Object.values(allocations).reduce((a,b)=>a+b,0),limit:1024*1024,allocations});
  const tables={driverAuditObjects:objects,driverAuditControl:control,driverAuditReleases:releases};
  let writes=0,transactions=0;
  const db={collection(name){
    const table=tables[name];assert.ok(table);
    return {
      findOne:async filter=>table.get(filter._id)??null,
      find:()=>({toArray:async()=>[...table.values()]}),
      async updateOne(filter,update,{session}){
        assert.ok(session,'collection writes must use one transaction');
        writes++;
        const row=table.get(filter._id);
        if(!row)return {matchedCount:0};
        for(const [key,inc] of Object.entries(update.$inc??{}))row[key]=(row[key]??0)+inc;
        for(const key of Object.keys(update.$unset??{}))delete row.allocations[key.split('.')[1]];
        return {matchedCount:1};
      },
      async deleteOne(filter,{session}){
        assert.ok(session,'object deletes must use one transaction');
        writes++;
        return {deletedCount:table.delete(filter._id)?1:0};
      },
    };
  }};
  const client={startSession:()=>({
    async withTransaction(callback){
      transactions++;
      const backup=Object.fromEntries(Object.entries(tables).map(([key,table])=>[
        key,[...table].map(([id,row])=>[id,{...row,...(row.allocations?{allocations:{...row.allocations}}:{})}]),
      ]));
      try{return await callback();}
      catch(error){for(const [name,rows] of Object.entries(backup)){tables[name].clear();for(const [id,row] of rows)tables[name].set(id,row);}throw error;}
    },
    endSession:async()=>{},
  })};
  const oldKey=sha('old')+'.gz',descriptorKey=old.descriptor.chunks[0].sha256+'.gz';
  return {db,client,archive:transport,objects,control,releases,archived,orphanKey,oldKey,descriptorKey,writes:()=>writes,transactions:()=>transactions};
}

test('GC preflight verifies only archived old objects and protects active, previous, staged and orphaned objects',async()=>{
  const f=await fixture();
  const plan=await planDriverAuditGarbage({db:f.db,archive:f.archive});
  assert.deepEqual(plan.candidates.map(({key})=>key).sort(),[f.oldKey,f.descriptorKey].sort());
  assert.ok(plan.reclaimBytes>0);
  assert.equal(f.writes(),0);
  const before=f.control.get('capacity').used;
  const result=await collectDriverAuditGarbage({db:f.db,client:f.client,archive:f.archive,writerToken,apply:true});
  assert.equal(result.objectsRemoved,2);
  assert.equal(result.bytesReclaimed,plan.reclaimBytes);
  assert.equal(f.control.get('capacity').used,before-plan.reclaimBytes);
  assert.ok(f.objects.has(f.orphanKey));
  assert.ok(f.objects.has(sha('needed for stage')+'.gz'));
  assert.equal(f.releases.size,3);
  assert.equal(f.transactions(),1);
  assert.equal((await planDriverAuditGarbage({db:f.db,archive:f.archive})).candidates.length,0);
});

test('GC refuses missing archive bytes, invalid stage or lost writer token before deletion',async()=>{
  const f=await fixture();
  await assert.rejects(collectDriverAuditGarbage({db:f.db,client:f.client,archive:f.archive,writerToken:'different',apply:true}),/writer/i);
  f.control.set('direct-stage',{_id:'direct-stage'});
  await assert.rejects(planDriverAuditGarbage({db:f.db,archive:f.archive}),/stage/i);
  f.control.delete('direct-stage');
  f.archived.delete(f.oldKey);
  await assert.rejects(collectDriverAuditGarbage({db:f.db,client:f.client,archive:f.archive,writerToken,apply:true}),/archive/i);
  assert.equal(f.writes(),0);
  assert.equal(f.transactions(),0);
});

test('GC aborts when the stage changes between archive verification and the transaction',async()=>{
  const f=await fixture(),start=f.client.startSession;
  f.client.startSession=()=>{
    const session=start(),transact=session.withTransaction;
    session.withTransaction=operation=>{
      f.control.delete('direct-stage');
      return transact(operation);
    };
    return session;
  };
  await assert.rejects(collectDriverAuditGarbage({db:f.db,client:f.client,archive:f.archive,writerToken,apply:true}),/changed after archive verification/);
  assert.ok(f.objects.has(f.oldKey));
  assert.ok(f.objects.has(f.descriptorKey));
  assert.equal(f.writes(),0);
});
