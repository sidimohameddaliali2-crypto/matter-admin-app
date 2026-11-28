import test from 'node:test';
import assert from 'node:assert/strict';
import { acquisitionForProof, affectedBagDeliveries, amendmentEvidence, bagEvidence } from './arrivalSourceEvidence.js';
import { executeBagMovement } from './bagLifecycleService.js';

const order = '1'.repeat(24);
const peer = '2'.repeat(24);
const driver = '3'.repeat(24);
const bagId = 'BAG-00001';
const instant = minutes => new Date(Date.parse('2026-11-19T23:00:00.000Z') + 60_000 * minutes).toISOString();
const delivery = {_id:order,driver,customerId:'C1',scheduledTime:instant(0),proof:{bagIds:[bagId]}};
const event = (orderId, minutes, extra={}) => ({eventType:'deliver',eventId:'delivery:'+orderId+':deliver:'+bagId,
  assignedBy:{user:driver},assignedTo:{driver,customer:{customerId:'C1'}},occurredAt:instant(minutes),timestamp:instant(minutes),
  physicalScan:true,...extra});
const evidence = (...history) => bagEvidence(delivery,[{bagId,history}]);
test('manual entry, legacy flags, skipped tags and another order never establish QR acquisition', () => {
  const qr = {orderId:order,bagId:'BAG_00001',method:'qr',scannedAt:instant(-1)};
  const proof = records => ({bagAcquisitions:records});
  const read = p => acquisitionForProof(p,bagId,order,new Date(instant(0)));
  assert.deepEqual(read(proof([qr])),{acquisition:'qr',scannedAt:instant(-1)});
  assert.deepEqual(read(proof([{...qr,method:'manual'}])),{acquisition:'manual'});
  assert.equal(read(proof([{...qr,orderId:peer}])),null);
  assert.equal(read(proof([qr,qr])),null);
  assert.equal(read({...proof([qr]),qrSkipped:true}),null);
  assert.equal(read(proof([{...qr,scannedAt:instant(1)}])),null);
  assert.equal(evidence(event(order,0)).events[0].physicalScan,false);
  assert.equal(evidence(event(order,0,{acquisition:'manual'})).events[0].physicalScan,false);
});
test('same tag with rapid occurrence, decode or receipt on another order invalidates unique allocation', () => {
  const own = event(order,0,{acquisition:'qr',scannedAt:instant(-1)});
  const recordedNear = event(peer,-61,{timestamp:instant(4),acquisition:'manual'});
  const result = evidence(own,recordedNear);
  assert.equal(result.state,'recorded');
  assert.equal(result.events[0].physicalScan,true);
  assert.equal(result.peerEvents[0].physicalScan,false);
  assert.deepEqual(affectedBagDeliveries({bagId,history:[recordedNear,own]},own.eventId),[peer,order]);
  assert.equal(evidence(own,event(peer,60,{occurredAt:instant(-2)})).peerEvents.length,1);
  assert.equal(evidence(own,event(peer,60,{acquisition:'qr',scannedAt:instant(-1)})).peerEvents.length,1);
  assert.equal(evidence(own,event(peer,60)).peerEvents.length,0);
  assert.equal(evidence(own,{...event(peer,-520),eventId:'legacy-allocation'}).state,'recorded');
  assert.equal(evidence(own,{...event(peer,-1),eventId:'legacy-allocation'}).state,'partial');
  assert.equal(evidence(own,{...own,assignedTo:{driver,customer:{customerId:'C2'}}}).state,'partial');
  assert.equal(bagEvidence(delivery,[{bagId,history:[own]},{bagId:'BAG_00001',history:[own]}]).state,'partial');
});
test('an old saved movement cannot acquire QR metadata on a retry',async()=>{
  const command = {action:'deliver',deliveryId:order,eventId:'delivery:'+order+':deliver:'+bagId,customerId:'C1',physicalScan:true};
  const actor={_id:driver,role:'driver'};
  let saved;
  const store={find:async()=>saved,create:async(bag,plan)=>(saved={...bag,...plan.set,history:[plan.event]})};
  await executeBagMovement(store,bagId,command,actor);
  await executeBagMovement(store,bagId,{...command,acquisition:'qr',scannedAt:instant(-1)},actor);
  assert.equal(saved.history.length,1);
  assert.equal(saved.history[0].acquisition,undefined);
});
test('applied edits bind the exact customer, order and Dubai date while both schedule clocks survive', () => {
  const change={_id:'4'.repeat(24),appliedToDelivery:order,customerId:'C1',scheduledDate:instant(0),status:'applied',
    appliedAt:instant(-30),changes:{scheduledTime:{oldValue:instant(0),newValue:instant(15)},address:'private text'}};
  const result=amendmentEvidence(delivery,[change]);
  assert.equal(result.state,'complete');
  assert.equal(result.events[0].serviceDate,'2026-11-20');
  assert.equal(result.events[0].previousScheduledTime,instant(0));
  assert.equal(result.events[0].scheduledTime,instant(15));
  assert.equal(JSON.stringify(result).includes('private text'),false);
  assert.equal(amendmentEvidence(delivery,[{...change,appliedToDelivery:peer}]).state,'partial');
  assert.equal(amendmentEvidence(delivery,[{...change,appliedAt:null}]).state,'partial');
  assert.equal(amendmentEvidence(delivery,[{...change,appliedOrderIds:[order,peer]}]).events.length,1);
  assert.equal(amendmentEvidence(delivery,[{...change,scheduledDate:instant(1440)}]).events.length,0);
});
