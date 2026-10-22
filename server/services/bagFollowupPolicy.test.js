import test from 'node:test';
import assert from 'node:assert/strict';
import {customerBagBalances,bagAccountabilityReport} from './bagFollowupPolicy.js';
const now=new Date('2026-10-22T08:00:00Z');
const bag=(id,extra={})=>({_id:id,bagId:`BAG-${id.padStart(4,'0')}`,quantity:1,location:'customer',lifecycleState:'with_customer',verifiedAt:'2026-10-21T08:00:00Z',assignedTo:{customer:{customerId:'C1',customerName:'Customer'},assignmentTime:'2026-10-21T08:00:00Z'},...extra});
test('exactly two outstanding tags flag a customer and one does not',()=>{
  assert.equal(customerBagBalances([bag('1')],[],[],now)[0].flagged,false);
  const row=customerBagBalances([bag('1'),bag('2')],[],[],now)[0];assert.equal(row.flagged,true);assert.equal(row.flagType,'two_bags');assert.equal(row.reminderDue,true);
});
test('collected bags no longer count toward two-customer-bag flag',()=>{
  const row=customerBagBalances([bag('1'),bag('2',{lifecycleState:'collected',location:'driver'})],[],[],now)[0];assert.equal(row.flagged,false);assert.equal(row.confirmed,1);assert.equal(row.collected,1);
});
test('legacy links flag verification instead of claiming confirmed physical custody',()=>{
  const row=customerBagBalances([bag('1',{lifecycleState:undefined,verifiedAt:null}),bag('2',{lifecycleState:undefined,verifiedAt:null})],[],[],now)[0];assert.equal(row.flagged,true);assert.equal(row.flagType,'verify_two_bags');assert.equal(row.confirmed,0);assert.equal(row.ambiguous,2);
});
test('duplicate physical tag records and quantity aggregates cannot manufacture a second bag',()=>{
  const row=customerBagBalances([bag('1'),bag('2',{bagId:'BAG-0001',quantity:4})],[],[],now)[0];assert.equal(row.flagged,false);assert.equal(row.outstanding,1);assert.equal(row.ambiguous,1);
});
test('reminders honor saved due times but a custody change immediately requires fresh review',()=>{
  const bags=[bag('1'),bag('2')];const initial=customerBagBalances(bags,[],[],now)[0];
  const saved={customerId:'C1',cycleKey:initial.cycleKey,version:2,status:'awaiting_collection',nextDueAt:'2026-10-23T05:00:00Z',lastContactAt:now};
  assert.equal(customerBagBalances(bags,[saved],[],now)[0].reminderDue,false);
  bags.push(bag('3'));const fresh=customerBagBalances(bags,[saved],[],now)[0];assert.equal(fresh.reminderDue,true);assert.equal(fresh.lastContactAt,null);assert.equal(fresh.previousCycle,true);
});
test('overdue verified returns trigger follow-up even for a single bag without inventing missing deadlines',()=>{
  const b=bag('1');assert.equal(customerBagBalances([b],[],[],now)[0].needsFollowup,false);
  b.assignedTo.expectedReturn='2026-10-22T07:59:59Z';const row=customerBagBalances([b],[],[],now)[0];assert.equal(row.needsFollowup,true);assert.deepEqual(row.overdueBags,['BAG-0001']);
});
test('physical returns resolve tasks without deleting follow-up history or mutating inventory',()=>{
  const history=[{eventId:'h1',note:'Follow-up evidence'}];const saved={customerId:'C1',cycleKey:'old',history,status:'awaiting_collection'};
  const bags=[bag('1',{assignedTo:{},lifecycleState:'received',location:'warehouse'})],before=structuredClone(bags);
  const row=customerBagBalances(bags,[saved],[],now)[0];assert.equal(row.status,'resolved');assert.equal(row.reminderDue,false);assert.equal(row.followup.history.length,1);assert.deepEqual(bags,before);
});
test('accountability reports show current owners, unassigned work, driver-held collections and pending refunds separately',()=>{
  const users=[{_id:'staff',isActive:false,profile:{firstName:'Owner'}},{_id:'driver',profile:{firstName:'Driver'}}];
  const bags=[bag('1'),bag('2'),bag('3',{location:'driver',lifecycleState:'collected',assignedTo:{driver:'driver',customer:{customerId:'C1'}},history:[{eventType:'collect',timestamp:'2026-10-22T06:00:00Z'}]})];
  const cycle=customerBagBalances(bags,[],users,now)[0].cycleKey;const rows=customerBagBalances(bags,[{customerId:'C1',cycleKey:cycle,owner:'staff',status:'escalated'}],users,now);
  const report=bagAccountabilityReport(rows,bags,[{status:'approved',amountMinor:15500},{status:'completed',amountMinor:15500}],users,now);assert.equal(report.twoBagCustomers,1);assert.equal(report.unassigned,1);assert.equal(report.owners[0].escalated,1);assert.deepEqual(report.driverReceipts[0].collectedBags,['BAG-0003']);assert.equal(report.refunds.approvedAmountMinor,15500);
});
