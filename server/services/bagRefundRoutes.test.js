import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import router from '../routes/bagRefunds.js';
import Bag from '../models/Bag.js';
import Customer from '../models/Customer.js';
import BagRefundCase from '../models/BagRefundCase.js';
import {refundEligibility} from './bagRefundPolicy.js';
const staff={_id:'111111111111111111111111',role:'admin',permissions:{bags:true},permissionsConfigured:true};
const caseId='aaaaaaaaaaaaaaaaaaaaaaaa',bagId='bbbbbbbbbbbbbbbbbbbbbbbb';
const clone=value=>JSON.parse(JSON.stringify(value));
const saved={find:Bag.collection.find,cases:BagRefundCase.find,one:BagRefundCase.findOne,byId:BagRefundCase.findById,create:BagRefundCase.create,update:BagRefundCase.findOneAndUpdate,customer:Customer.findOne};
let bags,cases,commits;
beforeEach(()=>{
  bags=[{_id:bagId,bagId:'BAG-0001',location:'warehouse',condition:'good',history:[{eventId:'collect-1',eventType:'collect',location:'driver',before:{assignedTo:{customer:{customerId:'C1',customerName:'Customer'}}},assignedBy:{user:staff._id},timestamp:'2026-10-22T06:00:00Z'},{eventId:'receive-1',eventType:'receive',location:'warehouse',before:{assignedTo:{customer:{customerId:'C1'}}},assignedBy:{user:staff._id},timestamp:'2026-10-22T07:00:00Z'}]}];
  cases=[];commits=0;
  Bag.collection.find=()=>({toArray:async()=>clone(bags)});
  BagRefundCase.find=()=>({sort(){return this;},lean:async()=>clone(cases)});
  BagRefundCase.findOne=filter=>({lean:async()=>clone(cases.find(c=>Object.entries(filter).every(([k,v])=>c[k]===v))||null)});
  BagRefundCase.findById=id=>({lean:async()=>clone(cases.find(c=>c._id===String(id))||null)});
  BagRefundCase.create=async input=>{const doc=new BagRefundCase(input);const err=doc.validateSync();if(err)throw err;const value={...JSON.parse(JSON.stringify(doc.toObject())),_id:caseId,createdAt:'2026-10-22T06:30:00Z'};cases.push(value);commits++;return value;};
  BagRefundCase.findOneAndUpdate=async(filter,update)=>{const value=cases.find(c=>c._id===String(filter._id)&&c.version===filter.version&&c.active===filter.active);if(!value)return null;Object.assign(value,clone(update.$set));for(const key of Object.keys(update.$unset||{}))delete value[key];value.version++;value.history.push(clone(update.$push.history));commits++;return clone(value);};
  Customer.findOne=()=>({select(){return this;},lean:async()=>({customerId:'C1'})});
});
afterEach(()=>{Bag.collection.find=saved.find;BagRefundCase.find=saved.cases;BagRefundCase.findOne=saved.one;BagRefundCase.findById=saved.byId;BagRefundCase.create=saved.create;BagRefundCase.findOneAndUpdate=saved.update;Customer.findOne=saved.customer;});
const response=()=>({statusCode:200,body:null,set(){return this;},status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}});
async function call(path,body={},user=staff,method='post'){
  const layer=router.stack.find(l=>l.route?.path===path&&l.route.methods[method]);
  const res=response();await layer.route.stack[0].handle({body,user,params:{id:caseId},app:{get:()=>null}},res);return res;
}
const create=()=>call('/',{requestId:'create-case-0001',customerId:'C1',note:'Confirmed final subscription; AED 155 still unpaid',confirmedFinalReturn:true,confirmedDepositDue:true});
const act=(action,extra={},user=staff)=>call('/:id/actions',{action,eventId:`action-${action}-0001`,version:cases[0].version,note:'Verified physical evidence',...extra},user);
async function inspect(){return act('inspect',{returnKey:`${bagId}:collect-1`,outcome:'good',confirmed:true});}
test('staff role guard blocks financial access for drivers and dispatchers even with bags permission',()=>{
  const guard=router.stack.filter(l=>!l.route).at(-1).handle;
  for(const role of ['driver','dispatcher','viewer']){const res=response();let continued=false;guard({user:{...staff,role}},res,()=>continued=true);assert.equal(res.statusCode,403);assert.equal(continued,false);}
});
test('opening is explicit, idempotent, fixed at AED 155, and GET remains read-only',async()=>{
  const missing=await call('/',{requestId:'missing-0001',customerId:'C1',note:'Unconfirmed'});assert.equal(missing.statusCode,400);
  assert.equal((await create()).statusCode,201);assert.equal(cases[0].amountMinor,15500);
  assert.equal((await create()).statusCode,200);assert.equal(cases.length,1);
  const before=commits;const get=await call('/',{},staff,'get');assert.equal(commits,before);assert.equal(get.body.data.cases.length,1);assert.equal(get.body.data.candidates.length,0);
});
test('warehouse can inspect but cannot approve or complete',async()=>{
  await create();const warehouse={...staff,role:'store_keeper'};
  assert.equal((await act('inspect',{returnKey:`${bagId}:collect-1`,outcome:'good',confirmed:true},warehouse)).statusCode,200);
  assert.equal((await act('approve',{},warehouse)).statusCode,403);assert.equal((await act('complete',{},warehouse)).statusCode,403);
});
test('approval blocks unreceived bags and stale versions',async()=>{
  await create();bags[0].history.pop();assert.equal((await act('approve')).statusCode,409);
  assert.equal((await act('inspect',{version:99,returnKey:'wrong',outcome:'good',confirmed:true})).statusCode,409);assert.equal(cases[0].status,'review');
});
test('approved completion is an auditable manual record; retries cannot record it twice',async()=>{
  await create();await inspect();assert.equal((await act('approve')).statusCode,200);
  const completion={confirmed:true,completedAt:new Date().toISOString(),reference:'Internal evidence 123'};
  const result=await act('complete',completion);assert.equal(result.statusCode,200);assert.equal(cases[0].status,'completed');assert.equal(cases[0].active,false);
  const count=commits;assert.equal((await act('complete',completion)).statusCode,200);assert.equal(commits,count);assert.equal(cases[0].history.filter(e=>e.action==='complete').length,1);
  assert.equal((await act('reopen')).statusCode,409);
});
test('new outstanding bags invalidate approval before completion',async()=>{
  await create();await inspect();await act('approve');bags.push({_id:'cccccccccccccccccccccccc',bagId:'BAG-0002',assignedTo:{customer:{customerId:'C1'}},history:[]});
  assert.equal((await act('complete',{confirmed:true,completedAt:new Date().toISOString()})).statusCode,409);assert.equal(cases[0].status,'approved');
});
test('damaged returns require management acknowledgement and retain the full refund',async()=>{
  await create();bags[0].condition='poor';assert.equal((await inspect()).statusCode,400);
  assert.equal((await act('inspect',{returnKey:`${bagId}:collect-1`,outcome:'damaged',confirmed:true})).statusCode,200);
  assert.equal((await act('approve')).statusCode,400);assert.equal((await act('approve',{acknowledgeDamage:true})).statusCode,200);
  assert.equal(refundEligibility(cases[0],bags).amountMinor,15500);
});
test('concurrent approvals commit once and stale alternate actions do not overwrite them',async()=>{
  await create();await inspect();const version=cases[0].version;const count=commits;
  const results=await Promise.all([act('approve',{version,eventId:'concurrent-approve-1'}),act('approve',{version,eventId:'concurrent-approve-2'})]);
  assert.equal(results.filter(r=>r.statusCode===200).length,1);assert.equal(commits,count+1);assert.equal(cases[0].status,'approved');
});
test('regular exchanges can be marked not due, with evidence and no payable case',async()=>{
  const result=await call('/',{requestId:'exchange-0001',customerId:'C1',note:'Daily bag exchange; subscription continuing',dismiss:true});assert.equal(result.statusCode,201);assert.equal(cases[0].status,'not_due');assert.equal(cases[0].active,false);
});
test('schema enforces unique return ownership and one active customer case',()=>{
  const indexes=BagRefundCase.schema.indexes();assert.ok(indexes.some(([keys,options])=>keys['bags.returnKey']===1&&options.unique));assert.ok(indexes.some(([keys,options])=>keys.customerId===1&&options.unique&&options.partialFilterExpression.active===true));
});
