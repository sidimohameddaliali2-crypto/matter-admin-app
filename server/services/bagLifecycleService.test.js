import test from 'node:test';
import assert from 'node:assert/strict';
import {planBagMovement,executeBagMovement} from './bagLifecycleService.js';
import {auditBagInventory} from './bagInventoryAudit.js';
import {buildBagWorkspace,compareStockCount} from './bagOperationsService.js';
const operator={_id:'warehouse',role:'store_keeper',name:'Warehouse'};
const driver={_id:'driver',role:'driver',name:'Driver'};
const bag=(values={})=>({_id:'b1',bagId:'BAG-0001',status:'available',location:'warehouse',condition:'good',quantity:1,history:[],...values});
const command=(action,values={})=>({action,eventId:'event-1',note:'Physical evidence',...values});
const apply=(b,plan)=>{const after={...b,...plan.set,custodyVersion:(b.custodyVersion||0)+1,history:[...(b.history||[]),plan.event]};for(const key of Object.keys(plan.unset))delete after[key];return after;};

test('legacy stock is never automatically ready; observation needs physical evidence',()=>{
  assert.throws(()=>planBagMovement(bag(),command('release',{inspected:true}),operator),/legacy_unverified/);
  assert.throws(()=>planBagMovement(bag(),command('observe_warehouse'),operator),/physical bag/);
  const p=planBagMovement(bag(),command('observe_warehouse',{inspected:true}),operator);
  assert.equal(p.set.lifecycleState,'received');assert.equal(p.set.status,'maintenance');
});
test('full loop preserves the previous holder, cleaning and separate warehouse receipt',()=>{
  let b=bag();
  const transition=(action,actor,extra={})=>{const p=planBagMovement(b,command(action,{eventId:`${action}:${b.history.length}`,...extra}),actor);b=apply(b,p);};
  transition('observe_warehouse',operator,{inspected:true});transition('release',operator,{inspected:true});
  transition('pack',operator,{driverId:'driver'});assert.equal(b.location,'warehouse');
  transition('accept',driver);assert.equal(b.location,'driver');
  transition('deliver',driver,{deliveryId:'d1',customerId:'c1'});assert.equal(b.location,'customer');
  transition('collect',driver,{customerId:'c1'});assert.equal(b.location,'driver');assert.equal(b.status,'in_use');
  transition('receive',operator);assert.equal(b.lifecycleState,'received');assert.equal(b.lastCustomer.customerId,'c1');assert.equal(b.status,'maintenance');
  assert.equal(b.history.at(-1).before.location,'driver');transition('release',operator,{inspected:true});assert.equal(b.lifecycleState,'ready');
});
test('driver cannot claim warehouse receipt or accept another driver handover',()=>{
  assert.throws(()=>planBagMovement(bag({lifecycleState:'collected'}),command('receive'),driver),/permission/);
  assert.throws(()=>planBagMovement(bag({lifecycleState:'packed',pendingHandover:{driver:'other'}}),command('accept'),driver),/nominated/);
});
test('cleaning and damage cannot be bypassed by release or retirement',()=>{
  assert.throws(()=>planBagMovement(bag({lifecycleState:'received'}),command('release'),operator),/inspection/);
  assert.throws(()=>planBagMovement(bag({lifecycleState:'received',condition:'poor'}),command('release',{inspected:true}),operator),/Damaged/);
  assert.throws(()=>planBagMovement(bag({lifecycleState:'ready'}),command('retire'),operator),/Manager/);
});
test('damage requires evidence and repair returns to cleaning, not available',()=>{
  assert.throws(()=>planBagMovement(bag({lifecycleState:'ready'}),command('quarantine'),operator),/photo/);
  const p=planBagMovement(bag({lifecycleState:'ready'}),command('quarantine',{proofPhotoUrl:'https://example.test/photo.jpg'}),operator);
  assert.equal(p.set.lifecycleState,'quarantined');assert.equal(p.set.condition,'poor');
  const repair=planBagMovement(apply(bag(),p),command('repair',{eventId:'repair',inspected:true}),operator);
  assert.equal(repair.set.lifecycleState,'received');assert.notEqual(repair.set.status,'available');
});
test('transfer does not change custody until receiving driver accepts',()=>{
  const original=bag({lifecycleState:'collected',location:'driver',assignedTo:{driver:'driver'}});
  const offered=apply(original,planBagMovement(original,command('offer_transfer',{driverId:'other'}),driver));
  assert.equal(offered.assignedTo.driver,'driver');
  const received=planBagMovement(offered,command('accept_transfer',{eventId:'transfer-receipt'}),{...driver,_id:'other'});
  assert.equal(received.set.assignedTo.driver,'other');assert.equal(received.set.lifecycleState,undefined);
});
test('stable event retry cannot move a bag twice or reuse another actor/action',()=>{
  const c=command('observe_warehouse',{inspected:true});const original=bag();const committed=apply(original,planBagMovement(original,c,operator));
  assert.deepEqual(planBagMovement(committed,c,operator),{duplicate:true});
  assert.throws(()=>planBagMovement(committed,{...c,action:'release'},operator),/already used/);
  assert.throws(()=>planBagMovement(committed,c,{...operator,_id:'other'}),/already used/);
});
test('stale screen versions fail rather than overwrite a more recent movement',()=>{
  assert.throws(()=>planBagMovement(bag({custodyVersion:3}),command('observe_warehouse',{expectedVersion:2,inspected:true}),operator),/changed/);
});
test('concurrent distinct movements do not overwrite one another',async()=>{
  let current=bag();let commits=0;
  const repo={find:async()=>structuredClone(current),commit:async(read,p)=>{if(commits++)return null;current=apply(current,p);return current;}};
  const outcomes=await Promise.allSettled([executeBagMovement(repo,'BAG-0001',command('observe_warehouse',{inspected:true}),operator),executeBagMovement(repo,'BAG-0001',command('observe_warehouse',{inspected:true,eventId:'another'}),operator)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(current.history.length,1);
});
test('concurrent identical movement retries return one committed receipt',async()=>{
  let current=bag();let commits=0;
  const repo={find:async()=>structuredClone(current),commit:async(read,p)=>{if(commits++)return null;current=apply(current,p);return current;}};
  const results=await Promise.all([1,2].map(()=>executeBagMovement(repo,'BAG-0001',command('observe_warehouse',{inspected:true}),operator)));
  assert.equal(current.history.length,1);assert.equal(results.filter(r=>r.duplicate).length,1);
});
test('unknown scans do not provision inventory',async()=>{
  let writes=0;await assert.rejects(()=>executeBagMovement({find:async()=>null,commit:async()=>writes++},'BAG-9999',command('collect'),driver),/not registered/);assert.equal(writes,0);
});
test('offline evidence cannot overwrite a newer physical handover',()=>{
  const b=bag({lifecycleState:'outbound',location:'driver',assignedTo:{driver:'driver'},verifiedAt:new Date('2026-10-22T10:00:00Z')});
  assert.throws(()=>planBagMovement(b,command('deliver',{customerId:'c1',deliveryId:'d1',occurredAt:'2026-10-21T10:00:00Z'}),driver,new Date('2026-10-22T11:00:00Z')),/predates/);
});
test('stock comparison preserves leading zeros, ignores duplicate scans, and does not mutate stock',()=>{
  const bags=[bag({bagId:'BAG-00001'})],copy=structuredClone(bags);
  const result=compareStockCount(bags,['bag-0001','bag-0001']);
  assert.deepEqual(result.missingCodes,['BAG-00001']);assert.deepEqual(result.unexpectedCodes,['BAG-0001']);assert.equal(result.duplicateScans,1);assert.deepEqual(bags,copy);
});
test('audit and customer balances never turn legacy associations into confirmed holdings',()=>{
  const source={bags:[bag({status:'assigned',assignedTo:{customer:{customerId:'c1',customerName:'Customer'}}})],customers:[{customerId:'c1'}],users:[],deliveries:[],scans:[]};
  const before=structuredClone(source);const view=buildBagWorkspace(source);
  assert.equal(view.customers[0].confirmed,0);assert.equal(view.customers[0].ambiguous,1);assert.equal(view.summary.verifiedRecords,0);assert.deepEqual(source,before);
  assert.ok(auditBagInventory(source).findings.some(f=>f.code==='custody_ambiguous'));
});
