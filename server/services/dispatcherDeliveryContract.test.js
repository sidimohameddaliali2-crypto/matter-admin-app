import test from 'node:test';
import assert from 'node:assert/strict';
import Delivery from '../models/Delivery.js';
const fixture={customerId:'FIXTURE-1',customerName:'Fixture customer',scheduledTime:new Date('2026-11-23T03:00:00Z'),address:'Fixture building'};
test('dispatch phone survives schema casting, BSON-shaped serialization and reload on create and edit',()=>{
  const created=new Delivery({...fixture,customerPhone:'  +971 50 000 0000  '});
  assert.equal(created.validateSync(),undefined);
  const reloaded=Delivery.hydrate(created.toObject());
  assert.equal(reloaded.customerPhone,'+971 50 000 0000');
  reloaded.set({customerPhone:' +971 50 000 0001 '});
  assert.equal(Delivery.hydrate(reloaded.toObject()).customerPhone,'+971 50 000 0001');
});
test('older deliveries without a phone remain valid and the optional contact can be cleared',()=>{
  const legacy=Delivery.hydrate(fixture);assert.equal(legacy.customerPhone,'');
  legacy.set('customerPhone','');assert.equal(legacy.validateSync(),undefined);assert.equal(legacy.toObject().customerPhone,'');
});
