import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import router from './dispatcherLocationReviews.js';
import Customer from '../models/Customer.js';
import Delivery from '../models/Delivery.js';
import Review from '../models/DispatcherLocationReview.js';
import matter from '../services/matterApiService.js';
import {subscriptionLocation} from '../services/dispatcherLocationReviewService.js';
const fixture={customer_id:42,subscription_id:7,customer_type:'new',name:'Fixture customer',customer_addresses:[{id:1,current_delivery_address:true,area:'Marina',building:'Fixture building',coordinates:{lat:25,lng:55}}]};
const actor={_id:'111111111111111111111111',role:'dispatcher',name:'Signed-in dispatcher'};
let source,records,calls,original,jobs;
beforeEach(()=>{source=structuredClone(fixture);jobs=[{type:'Delivery',status:'pending',matterCustomerId:'42',matterSubscriptionId:'7',scheduledTime:new Date(Date.now()+86400000)}];records=[];calls=0;original={get:matter.getSubscription,list:matter.listAllSubscriptions,find:Review.find,one:Review.findOne,create:Review.create,customers:Customer.find,deliveries:Delivery.find};Customer.find=()=>({select(){return this;},lean:async()=>[]});Delivery.find=()=>({select(){return this;},lean:async()=>jobs});matter.getSubscription=async()=>{calls++;return {data:source};};matter.listAllSubscriptions=async()=>[source,{...source,subscription_id:8},{...source,subscription_id:9,customer_id:43,customer_type:'existing'}];Review.findOne=()=>({lean:async()=>records[0]||null});Review.find=()=>({sort(){return this;},limit(){return this;},lean:async()=>records});Review.create=async data=>{const r={...data,timestamp:new Date()};records.push(r);return r;};});
afterEach(()=>{matter.getSubscription=original.get;matter.listAllSubscriptions=original.list;Review.find=original.find;Review.findOne=original.one;Review.create=original.create;Customer.find=original.customers;Delivery.find=original.deliveries;});
const input=()=>({requestId:'11111111-1111-4111-8111-111111111111',revision:subscriptionLocation(fixture).revision,action:'feedback',category:'gps_wrong',issue:'Wrong entrance'});
async function call(method,path,body=input(),extra={}){const layer=router.stack.find(l=>l.route?.path===path&&l.route.methods[method]);const req={params:{id:'7'},query:{},user:actor,body,...extra};const res={code:200,status(n){this.code=n;return this;},json(data){this.body=data;return this;}};await layer.route.stack.at(-1).handle(req,res);return res;}
test('badge counts permanent new customers across subscriptions and omits details until requested',async()=>{const r=await call('get','/');assert.equal(r.body.data.count,1);assert.equal(r.body.data.subscriptions,1);assert.deepEqual(r.body.data.rows,[]);assert.equal(calls,0);});
test('detail reads verified subscription identity, current pin and prior history',async()=>{const r=await call('get','/:id');assert.equal(r.body.data.customerId,'42');assert.deepEqual(r.body.data.pin,{lat:25,lng:55});assert.deepEqual(r.body.data.reviews,[]);});
test('save captures canonical source evidence and server authenticated actor, retry creates one record',async()=>{const body={...input(),actor:'spoofed',snapshot:{pin:'spoofed'}};const r=await call('post','/:id',body);assert.equal(r.code,200);assert.equal(records[0].actor,actor._id);assert.equal(records[0].actorName,'Signed-in dispatcher');assert.deepEqual(records[0].snapshot.pin,{lat:25,lng:55});assert.equal((await call('post','/:id',body)).code,200);assert.equal(records.length,1);assert.equal((await call('post','/:id',{...body,issue:'Different request'})).code,409);});
test('changed pin rejects stale confirmation without storing a review',async()=>{source.customer_addresses[0].coordinates.lat=26;const r=await call('post','/:id',{...input(),action:'confirm',category:'',issue:''});assert.equal(r.code,409);assert.equal(records.length,0);});
test('missing pins prevent confirmation but permit feedback; invalid feedback is rejected',async()=>{source.customer_addresses[0].coordinates=null;const body={...input(),revision:subscriptionLocation(source).revision};assert.equal((await call('post','/:id',{...body,action:'confirm',category:'',issue:''})).code,400);assert.equal((await call('post','/:id',{...body,issue:' '})).code,400);assert.equal((await call('post','/:id',body)).code,200);});
test('upstream failure or wrong identity cannot become a success or false zero count',async()=>{matter.listAllSubscriptions=async()=>{throw new Error('Source down');};assert.equal((await call('get','/')).code,502);source.subscription_id=999;assert.equal((await call('get','/:id')).code,502);assert.equal(records.length,0);});
test('role and effective delivery permissions deny unrelated staff',()=>{const res={code:200,status(n){this.code=n;return this;},json(){return this;},set(){}};let passed=false;router.stack[1].handle({user:{...actor,role:'driver'}},res,()=>{passed=true;});assert.equal(res.code,403);assert.equal(passed,false);res.code=200;router.stack[2].handle({user:{...actor,permissionsConfigured:true,permissions:{deliveries:false}}},res,()=>{passed=true;});assert.equal(res.code,403);assert.equal(passed,false);});


test('list, badge, detail and new reviews exclude customers after their first delivery',async()=>{
 jobs.push({...jobs[0],status:'delivered',scheduledTime:new Date('2026-01-01T03:00:00Z')});
 const list=await call('get','/',input(),{query:{details:'true'}});assert.equal(list.code,200);assert.equal(list.body.data.count,0);assert.deepEqual(list.body.data.rows,[]);
 assert.equal((await call('get','/:id')).code,409);assert.equal((await call('post','/:id')).code,409);assert.equal(records.length,0);
});
test('customers with only a New tag and no upcoming job are absent, while existing review retries stay idempotent',async()=>{
 await call('post','/:id');jobs=[];assert.equal((await call('get','/')).body.data.count,0);assert.equal((await call('post','/:id')).code,200);assert.equal(records.length,1);
});
test('list and badge use identical delivery eligibility before pagination and expose the next delivery',async()=>{
 const r=await call('get','/',input(),{query:{details:'true'}});assert.equal(r.body.data.count,1);assert.equal(r.body.data.rows.length,1);assert.equal(r.body.data.rows[0].subscriptionId,'7');assert.equal(r.body.data.rows[0].nextDeliveryAt,jobs[0].scheduledTime.toISOString());
});
test('unavailable delivery history fails visibly instead of returning a fabricated empty queue',async()=>{
 Delivery.find=()=>({select(){return this;},lean:async()=>{throw new Error('History unavailable');}});assert.equal((await call('get','/')).code,502);
});
