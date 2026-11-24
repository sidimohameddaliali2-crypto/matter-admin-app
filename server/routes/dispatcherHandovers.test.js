import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import router from './dispatcherHandovers.js';
import Bag from '../models/Bag.js';
import User from '../models/User.js';
const driver='222222222222222222222222',staff='111111111111111111111111';
const root=n=>`handover:${String(n).padStart(8,'0')}-1111-4111-8111-111111111111:${staff}:${driver}`;
const events=(n,count)=>Array.from({length:count},(_,i)=>{const eventId=`${root(n)}:b${i}`;return [{bagId:`BAG-${n}-${i}`,event:{eventType:'pack',eventId,timestamp:new Date('2026-11-23T03:00:00Z'),assignedBy:{user:staff,name:'Fixture dispatcher'},assignedTo:{driver}}},{bagId:`BAG-${n}-${i}`,event:{eventType:'accept',eventId:`accept-${n}-${i}`,timestamp:new Date('2026-11-23T04:00:00Z'),assignedBy:{user:driver},before:{pendingHandover:{eventId}}}}];}).flat();
let aggregate,find,groups,pipeline;
beforeEach(()=>{aggregate=Bag.aggregate;find=User.find;groups=[];Bag.aggregate=p=>{pipeline=p;return {allowDiskUse:async enabled=>{assert.equal(enabled,true);return groups;}};};User.find=()=>({select(){return this;},lean:async()=>[{_id:driver,name:'Fixture driver'}]});});
afterEach(()=>{Bag.aggregate=aggregate;User.find=find;});
const read=async()=>{const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};await router.stack.find(l=>l.route?.path==='/'&&l.route.methods.get).route.stack.at(-1).handle({},res);return res;};
test('history cutoff includes complete 500-bag receipts beyond 5,000 movement events',async()=>{
 groups=Array.from({length:6},(_,n)=>({_id:root(n),events:events(n,500)}));
 const r=await read();assert.equal(r.code,200);assert.equal(r.body.data.receipts.length,6);
 for(const receipt of r.body.data.receipts){assert.equal(receipt.preparedCount,500);assert.equal(receipt.acceptedCount,500);assert.equal(receipt.pendingCount,0);assert.equal(receipt.status,'accepted');}
 const grouped=pipeline.findIndex(s=>s.$group),limited=pipeline.findIndex(s=>s.$limit);assert.ok(grouped>=0&&limited>grouped,'Only limit after grouping all receipt evidence');assert.equal(r.body.data.truncated,false);
});
test('history bounds receipt count without splitting the final included receipt',async()=>{
 groups=Array.from({length:101},(_,n)=>({_id:root(n),events:events(n,n===99?500:1)}));
 const r=await read();assert.equal(r.code,200);assert.equal(r.body.data.receipts.length,100);assert.equal(r.body.data.truncated,true);assert.equal(r.body.data.receipts.find(x=>x.id===root(99)).preparedCount,500);assert.equal(r.body.data.receipts.some(x=>x.id===root(100)),false);
});
test('empty handover history remains empty',async()=>{const r=await read();assert.equal(r.code,200);assert.deepEqual(r.body.data.receipts,[]);assert.equal(r.body.data.truncated,false);});
