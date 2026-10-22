import test from 'node:test';
import assert from 'node:assert/strict';
import {bagReturnSources,refundCandidates,refundEligibility,requireRefundApproval,BAG_DEPOSIT_MINOR} from './bagRefundPolicy.js';
const customer={customerId:'C1',customerName:'Sample Customer'};
const collect=(eventId='collect-1')=>({eventId,eventType:'collect',location:'driver',assignedBy:{user:'driver'},before:{assignedTo:{customer}},assignedTo:{customer},timestamp:new Date('2026-10-22T09:00:00Z')});
const receive=(eventId='receive-1')=>({eventId,eventType:'receive',location:'warehouse',assignedBy:{user:'warehouse'},before:{assignedTo:{customer}},timestamp:new Date('2026-10-22T10:00:00Z')});
const bag=(history=[collect(),receive()])=>({_id:'b1',bagId:'BAG-00001',history});
const refund=()=>({customerId:'C1',endEvidence:'Final subscription confirmed; deposit unpaid',amountMinor:BAG_DEPOSIT_MINOR,status:'review',active:true,createdAt:new Date('2026-10-22T09:30:00Z'),bags:[{recordId:'b1',bagId:'BAG-00001',returnKey:'b1:collect-1'}],inspections:[{recordId:'b1',receiptEventId:'receive-1',outcome:'good',note:'Physical inspection',timestamp:new Date('2026-10-22T10:10:00Z')}]});
test('driver collection creates a review candidate without proving warehouse receipt',()=>{
  const b=bag([collect()]);b.assignedTo={customer};
  const before=structuredClone(b);const queue=refundCandidates([b],[]);
  assert.equal(queue.length,1);assert.equal(queue[0].amountMinor,15500);assert.equal(queue[0].bags[0].bagId,'BAG-00001');
  const check=refundEligibility(refund(),[b]);assert.equal(check.eligible,false);assert.equal(check.stage,'awaiting_warehouse');assert.deepEqual(b,before);
});
test('warehouse receipt keeps the collection return key and cannot create a duplicate case',()=>{
  const source=bagReturnSources(bag());assert.equal(source.length,1);assert.equal(source[0].returnKey,'b1:collect-1');assert.equal(source[0].receiptEventId,'receive-1');
  for(const status of ['review','completed','not_due'])assert.equal(refundCandidates([bag()],[{...refund(),status,active:status==='review'}]).length,0);
});
test('legacy returned status and anonymous history never manufacture refund evidence',()=>{
  const b=bag([{status:'available',location:'warehouse'}, {...receive(),eventId:undefined}, {...collect(),assignedBy:undefined}]);
  assert.equal(refundCandidates([b],[]).length,0);assert.equal(refundEligibility(refund(),[b]).eligible,false);
});
test('every returned bag needs warehouse receipt and its matching inspection',()=>{
  const c=refund();c.inspections[0].receiptEventId='old-return';assert.equal(refundEligibility(c,[bag()]).stage,'awaiting_inspection');
  c.inspections=refund().inspections;assert.equal(refundEligibility(c,[bag()]).eligible,true);
  c.bags.push({recordId:'b2',bagId:'BAG-00002',returnKey:'b2:collect-2'});assert.equal(refundEligibility(c,[bag()]).eligible,false);
});
test('unreturned customer associations, including legacy bags, block refund approval',()=>{
  const check=refundEligibility(refund(),[bag(),{_id:'b2',bagId:'BAG-00002',assignedTo:{customer}}]);
  assert.equal(check.eligible,false);assert.match(check.blockers.join(' '),/BAG-00002/);
});
test('damage does not cause an invented deduction or prevent a reviewed full refund',()=>{
  const c=refund();c.inspections[0].outcome='damaged';const check=refundEligibility(c,[bag()]);
  assert.equal(check.eligible,true);assert.equal(check.damaged,true);assert.equal(check.amountMinor,15500);
});
test('completion requires approval of the exact evidence, not merely approved status',()=>{
  const c=refund();assert.throws(()=>requireRefundApproval(c,[bag()]),/approval/);
  c.status='approved';c.approval={fingerprint:refundEligibility(c,[bag()]).fingerprint};assert.equal(requireRefundApproval(c,[bag()]).eligible,true);
  c.inspections[0].note='Revised finding';assert.throws(()=>requireRefundApproval(c,[bag()]),/approval/);
});
test('repeated return cycles get new keys while old exchanges do not multiply candidates',()=>{
  const b=bag([collect(),receive(),{eventType:'deliver'},collect('collect-2'),receive('receive-2')]);
  const queue=refundCandidates([b],[{...refund(),status:'completed',active:false}]);
  assert.equal(queue.length,1);assert.equal(queue[0].bags.length,1);assert.equal(queue[0].bags[0].returnKey,'b1:collect-2');
});
test('active customers cannot open another case; new returns invalidate existing eligibility until linked',()=>{
  const c=refund();const b2={...bag([collect('collect-2'),receive('receive-2')]),_id:'b2',bagId:'BAG-00002'};
  assert.equal(refundCandidates([bag(),b2],[c]).length,0);
  const check=refundEligibility(c,[bag(),b2]);assert.equal(check.eligible,false);assert.match(check.blockers.join(' '),/newer return/);
});
test('cross-customer receipt cannot settle another customer return',()=>{
  const different={...receive(),before:{assignedTo:{customer:{customerId:'C2'}}}};
  const check=refundEligibility(refund(),[bag([collect(),different])]);assert.equal(check.eligible,false);
});
test('new damage evidence after approval needs a fresh inspection; later issuance does not rewrite the old return',()=>{
  const c=refund(),b=bag();c.status='approved';c.approval={fingerprint:refundEligibility(c,[b]).fingerprint};
  b.history.push({eventId:'quarantine-1',eventType:'quarantine',assignedBy:{user:'warehouse'}});
  assert.equal(refundEligibility(c,[b]).stage,'awaiting_inspection');assert.throws(()=>requireRefundApproval(c,[b]),/inspection/);
  c.inspections[0].damageEventId='quarantine-1';c.inspections[0].outcome='damaged';assert.equal(refundEligibility(c,[b]).eligible,true);assert.throws(()=>requireRefundApproval(c,[b]),/approval/);
  b.history.push({eventType:'pack'},{eventId:'quarantine-2',eventType:'quarantine',assignedBy:{user:'warehouse'}});
  assert.equal(bagReturnSources(b)[0].damageEventId,'quarantine-1');
});
