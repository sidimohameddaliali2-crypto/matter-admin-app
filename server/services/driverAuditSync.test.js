import assert from 'node:assert/strict';
import test from 'node:test';
import {runDriverAuditSyncTick} from './driverAuditSync.js';

const basis=char=>char.repeat(64);
const source=(revision,id)=>({revision,basis:basis(id),observedAt:'2026-11-11T17:40:00.000Z'});
const candidate=(revision,id)=>({collectorRevision:revision,sourceBasis:basis(id),privateRoot:'/private/pinned'});
const active=(revision,id)=>({directImport:{version:1,collectorRevision:revision,sourceBasis:basis(id)},visibleCutoffAt:'2026-11-11T17:30:00.000Z'});
const fixture=({head=active(1,'a'),initial=source(2,'b'),later=source(3,'c'),pinned,fail}={})=>{
 const events=[];
 let reads=0;
 const deps={async readSource(){return reads++?later:initial;},async readHead(){return head;},
  async getCandidate(){return pinned;},async build(selected){events.push(['build',selected.revision]);return candidate(selected.revision,selected.basis[0]);},
  async apply(saved){events.push(['apply',saved.collectorRevision]);if(fail)throw fail;head=active(saved.collectorRevision,saved.sourceBasis[0]);},
  async status(value){events.push(['status',value]);}};
 return {deps,events};
};

test('a complete pinned generation is activated even when a newer saved capture arrives',async()=>{
 const {deps,events}=fixture();
 await runDriverAuditSyncTick(deps);
 assert.deepEqual(events.filter(([type])=>type!=='status'),[['build',2],['apply',2]]);
 assert.equal(events.at(-1)[1].status,'pending');
 assert.equal(events.at(-1)[1].pending,true);
});

test('retry applies an already verified candidate before rebuilding from the newest source',async()=>{
 const {deps,events}=fixture({initial:source(3,'c'),pinned:candidate(2,'b')});
 await runDriverAuditSyncTick(deps);
 assert.deepEqual(events.filter(([type])=>type!=='status'),[['apply',2]]);
});

test('capacity failure retains active cutoff and produces a visible pending state',async()=>{
 const capacity={kind:'build-disk',availableBytes:100,requiredBytes:200};
 const {deps,events}=fixture({fail:Object.assign(Error('Capacity exceeded'),{code:'AUDIT_CAPACITY',capacity})});
 await assert.rejects(runDriverAuditSyncTick(deps),{code:'AUDIT_CAPACITY'});
 assert.equal(events.at(-1)[1].status,'capacity-blocked');
 assert.equal(events.at(-1)[1].visibleCutoffAt,active(1,'a').visibleCutoffAt);
 assert.deepEqual(events.at(-1)[1].capacity,capacity);
});

test('sync readiness belongs to the generation actually visible to staff',async()=>{
 const {readDriverAuditSyncStatus}=await import('./driverAuditSyncStatus.js');
 const checkedAt='2026-11-11T18:00:00.000Z';
 const db={collection:()=>({findOne:async()=>({checkedAt,activeGeneration:basis('a'),status:'ready',pending:false})})};
 const clock=()=>Date.parse(checkedAt)+1000;
 assert.equal((await readDriverAuditSyncStatus(db,basis('b'),clock)).status,'pending');
 assert.equal((await readDriverAuditSyncStatus(db,basis('a'),clock)).status,'ready');
 assert.equal((await readDriverAuditSyncStatus(db,basis('a'),()=>clock()+31*60_000)).status,'failed');
});

test('staff see the cause of a current capacity failure without internal measurements',async()=>{
 const {readDriverAuditSyncStatus}=await import('./driverAuditSyncStatus.js');
 const checkedAt='2026-11-11T18:00:00.000Z';
 const saved={checkedAt,status:'capacity-blocked',pending:true,errorCode:'AUDIT_CAPACITY',
  capacity:{kind:'build-disk',availableBytes:100,requiredBytes:200}};
 const db={collection:()=>({findOne:async()=>saved})};
 const clock=()=>Date.parse(checkedAt)+1000;
 const current=await readDriverAuditSyncStatus(db,basis('a'),clock);
 assert.equal(current.capacityReason,'build-disk');
 assert.equal(Object.hasOwn(current,'capacity'),false);
 assert.equal((await readDriverAuditSyncStatus(db,basis('a'),()=>clock()+31*60_000)).capacityReason,undefined);
 saved.capacity.kind='unknown';
 assert.equal((await readDriverAuditSyncStatus(db,basis('a'),clock)).capacityReason,undefined);
});
