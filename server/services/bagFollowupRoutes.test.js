import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/bagFollowups.js';
import Bag from '../models/Bag.js';
import User from '../models/User.js';
import BagFollowup from '../models/BagFollowup.js';
import BagRefundCase from '../models/BagRefundCase.js';
import {customerBagBalances} from './bagFollowupPolicy.js';
const actor={_id:'111111111111111111111111',role:'admin',isActive:true,permissionsConfigured:true,permissions:{bags:true},profile:{firstName:'Owner'}};
const saved={bags:Bag.collection.find,users:User.find,user:User.findById,find:BagFollowup.find,one:BagFollowup.findOne,create:BagFollowup.create,update:BagFollowup.findOneAndUpdate,refunds:BagRefundCase.find};
const clone=v=>JSON.parse(JSON.stringify(v));let bags,rows,writes;
beforeEach(()=>{
  bags=['1','2'].map(i=>({_id:i,bagId:`BAG-000${i}`,quantity:1,lifecycleState:'with_customer',location:'customer',verifiedAt:'2026-10-22T06:00:00Z',assignedTo:{customer:{customerId:'C1',customerName:'Customer'}}}));rows=[];writes=0;
  Bag.collection.find=()=>({toArray:async()=>clone(bags)});
  User.find=()=>({select(){return this;},lean:async()=>[actor]});User.findById=()=>({select:async()=>actor});
  BagFollowup.find=()=>({lean:async()=>clone(rows)});BagFollowup.findOne=({customerId})=>({lean:async()=>clone(rows.find(r=>r.customerId===customerId)||null)});
  BagFollowup.create=async data=>{rows.push({...clone(data),_id:'row1'});writes++;return clone(rows[0]);};
  BagFollowup.findOneAndUpdate=async(filter,update)=>{const row=rows.find(r=>r._id===filter._id&&r.version===filter.version);if(!row)return null;Object.assign(row,clone(update.$set));row.version++;row.history.push(clone(update.$push.history));writes++;return clone(row);};
  BagRefundCase.find=()=>({select(){return this;},lean:async()=>[]});
});
afterEach(()=>{Bag.collection.find=saved.bags;User.find=saved.users;User.findById=saved.user;BagFollowup.find=saved.find;BagFollowup.findOne=saved.one;BagFollowup.create=saved.create;BagFollowup.findOneAndUpdate=saved.update;BagRefundCase.find=saved.refunds;});
const response=()=>({statusCode:200,set(){return this;},status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}});
const command=(extra={})=>({customerId:'C1',cycleKey:customerBagBalances(bags)[0].cycleKey,eventId:'followup-request-1',version:rows[0]?.version||0,ownerId:actor._id,status:'awaiting_collection',nextDueAt:'2026-10-23T05:00:00Z',note:'Check next collection and reconcile customer bags',...extra});
async function call(method,body={}){const res=response();await router.stack.find(l=>l.route?.methods[method]).route.stack[0].handle({user:actor,body},res);return res;}
test('queue reads remain side-effect free and reject non-operational roles',async()=>{
  const result=await call('get');assert.equal(result.body.data.report.twoBagCustomers,1);assert.equal(writes,0);
  const guard=router.stack.filter(l=>!l.route).at(-1).handle;for(const role of ['driver','dispatcher','viewer']){const res=response();guard({user:{...actor,role}},res,()=>assert.fail('unauthorized'));assert.equal(res.statusCode,403);}
});
test('saving an internal reminder records ownership without changing bags',async()=>{
  const before=clone(bags);assert.equal((await call('post',command())).statusCode,200);assert.equal(rows[0].owner,actor._id);assert.equal(rows[0].history[0].actorName,'Owner');assert.deepEqual(bags,before);
  assert.equal((await call('post',command())).body.duplicate,true);assert.equal(writes,1);
});
test('stale custody and stale follow-up versions cannot overwrite current work',async()=>{
  const original=command();bags[1].lifecycleState='collected';bags[1].location='driver';assert.equal((await call('post',original)).statusCode,409);
  await call('post',command());assert.equal((await call('post',command({version:0,eventId:'another-request'}))).statusCode,409);
});
test('recorded customer contact requires actual-contact confirmation and channel',async()=>{
  assert.equal((await call('post',command({status:'contacted'}))).statusCode,400);
  assert.equal((await call('post',command({status:'contacted',contactChannel:'phone',confirmedContact:false}))).statusCode,400);
  assert.equal((await call('post',command({status:'contacted',contactChannel:'phone',confirmedContact:true}))).statusCode,200);assert.equal(rows[0].history[0].action,'contact_logged');
});
test('resolved custody cannot be manually reflagged or treated as awaiting customer collection',async()=>{
  const body=command();for(const bag of bags)bag.assignedTo={};assert.equal((await call('post',body)).statusCode,409);assert.equal(writes,0);
});
test('inactive or unauthorized follow-up owners are rejected',async()=>{
  User.findById=()=>({select:async()=>({...actor,isActive:false})});assert.equal((await call('post',command())).statusCode,400);assert.equal(writes,0);
});
