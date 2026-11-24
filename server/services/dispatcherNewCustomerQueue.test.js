import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNewCustomerQueue } from './dispatcherNewCustomerQueue.js';
const now=new Date('2026-11-22T21:00:00Z'); // 23 November in Dubai.
const sub=(id,customer,type='new')=>({subscription_id:id,customer_id:customer,customer_type:type});
const job=(extra={})=>({type:'Delivery',status:'pending',matterCustomerId:'42',matterSubscriptionId:'7',scheduledTime:'2026-11-23T03:00:00Z',...extra});
const queue=(jobs,sources=[sub(7,42)],customers=[])=>buildNewCustomerQueue(sources,customers,jobs,now);
test('New tag alone is insufficient; only scheduled pending first deliveries are included',()=>{
 assert.equal(queue([]).count,0);assert.equal(queue([job()]).count,1);assert.equal(queue([job()], [sub(7,42,'existing')]).count,0);
 for(const extra of [{status:'failed'},{status:'collected'},{type:'Task'},{type:'Collection'},{scheduledTime:'2026-11-22T19:59:59Z'}])assert.equal(queue([job(extra)]).count,0);
});
test('first completed delivery removes customer even with another upcoming job and unchanged New tag',()=>{
 for(const status of ['delivered','completed'])assert.equal(queue([job(),job({status,scheduledTime:'2026-11-01T03:00:00Z',matterSubscriptionId:'old'})]).count,0);
 assert.equal(queue([job(),job({status:'failed',scheduledTime:'2026-11-01T03:00:00Z'})]).count,1);
});
test('collection/task completions cannot stand in for the first meal delivery',()=>{
 assert.equal(queue([job(),job({status:'completed',type:'Task'}),job({status:'collected',type:'Collection'})]).count,1);
});
test('uses Dubai day boundaries and exposes the earliest upcoming delivery',()=>{
 const r=queue([job(),job({scheduledTime:'2026-11-22T20:00:00Z'})]);assert.equal(r.count,1);assert.equal(r.subscriptions[0].nextDeliveryAt,'2026-11-22T20:00:00.000Z');
});
test('explicit permanent customer links exclude earlier delivered legacy jobs across renewals',()=>{
 assert.equal(queue([job(),job({status:'delivered',matterCustomerId:null,matterSubscriptionId:'old',customerId:'C1'})],[sub(7,42)],[{customerId:'C1',matterCustomerId:'42'}]).count,0);
 assert.equal(queue([job(),job({status:'delivered',matterCustomerId:null,matterSubscriptionId:'6'})],[sub(7,42),sub(6,42,'existing')]).count,0);
});
test('permanent identity prevents a different customer or same-name job from affecting eligibility',()=>{
 assert.equal(queue([job({matterCustomerId:'other',customerId:'C1'})],[sub(7,42)],[{customerId:'C1',matterCustomerId:'42'}]).count,0);
 assert.equal(queue([job({matterCustomerId:null,matterSubscriptionId:null,customerName:'Same name'})]).count,0);
});
test('only subscriptions with upcoming jobs appear and unique customers are counted once',()=>{
 const r=queue([job(),job({matterSubscriptionId:'8',scheduledTime:'2026-11-24T03:00:00Z'})],[sub(7,42),sub(8,42),sub(9,42)]);assert.equal(r.count,1);assert.deepEqual(r.subscriptions.map(s=>s.subscription_id),[7,8]);
 assert.equal(queue([job({matterSubscriptionId:null})],[sub(7,42),sub(8,42)]).count,0);
});
