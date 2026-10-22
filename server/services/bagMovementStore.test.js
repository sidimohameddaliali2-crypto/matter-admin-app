import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Bag from '../models/Bag.js';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import {moveBag} from './bagMovementStore.js';
import {recordDeliveryBagMovements} from './deliveryBagMovements.js';

const staff={_id:new mongoose.Types.ObjectId('111111111111111111111111'),role:'store_keeper'};
const driver={_id:new mongoose.Types.ObjectId('222222222222222222222222'),role:'driver'};
const deliveryId=new mongoose.Types.ObjectId('333333333333333333333333');
const saved={find:Bag.collection.findOne,commit:Bag.collection.findOneAndUpdate,user:User.findById,delivery:Delivery.findById,update:Delivery.updateOne};
let inventory,receipts,writes;
beforeEach(()=>{
  inventory=new Map();receipts=[];writes=[];
  Bag.collection.findOne=async({bagId})=>{const b=inventory.get(bagId);return b?{...b,history:[...b.history]}:null;};
  Bag.collection.findOneAndUpdate=async(filter,update)=>{
    const b=[...inventory.values()].find(b=>String(b._id)===String(filter._id));
    const versionMatches=typeof filter.custodyVersion==='object'?b.custodyVersion===undefined:b.custodyVersion===filter.custodyVersion;
    if(!b||!versionMatches||b.history.some(h=>h.eventId===filter['history.eventId'].$ne))return {value:null};
    const next={...b,...update.$set,history:[...b.history,update.$push.history]};
    for(const key of Object.keys(update.$unset||{}))delete next[key];inventory.set(next.bagId,next);writes.push(update);return {value:next};
  };
  User.findById=()=>({select:async()=>({role:'driver',isActive:true})});
  Delivery.findById=()=>({select:async()=>({_id:deliveryId,driver:driver._id,customerId:'C1',customerName:'Customer'})});
  Delivery.updateOne=async(filter,update)=>{receipts.push({filter,update});return {modifiedCount:1};};
});
afterEach(()=>{Bag.collection.findOne=saved.find;Bag.collection.findOneAndUpdate=saved.commit;User.findById=saved.user;Delivery.findById=saved.delivery;Delivery.updateOne=saved.update;});
const add=(code,extra={})=>inventory.set(code,{_id:code,bagId:code,lifecycleState:'outbound',location:'driver',status:'assigned',condition:'good',quantity:1,custodyVersion:4,assignedTo:{driver:driver._id},history:[],...extra});
test('raw storage persists state, version and event together and retains BSON driver IDs',async()=>{
  add('BAG-0001',{lifecycleState:'ready',location:'warehouse'});
  await moveBag('BAG-0001',{action:'pack',eventId:'pack',driverId:String(driver._id),expectedVersion:4,note:'Physical packed bag'},staff);
  const b=inventory.get('BAG-0001');assert.ok(b.pendingHandover.driver instanceof mongoose.Types.ObjectId);assert.equal(b.custodyVersion,5);assert.equal(b.history.length,1);
  assert.equal(writes[0].$set.lifecycleState,'packed');assert.equal(writes[0].$push.history.eventId,'pack');
});
test('all outgoing bags and incoming bags are processed with distinct stable movement IDs',async()=>{
  add('BAG-0001');add('BAG-0002');add('BAG-0003',{lifecycleState:'with_customer',location:'customer',assignedTo:{customer:{customerId:'C1'}}});
  const delivery={_id:deliveryId,customerId:'C1',driver:driver._id,proof:{}};
  const payload={status:'delivered',bagIds:['BAG-0001','BAG-0002'],proof:{returnedBags:['BAG-0003']}};
  await recordDeliveryBagMovements(delivery,payload,driver);
  assert.equal(inventory.get('BAG-0001').location,'customer');assert.equal(inventory.get('BAG-0002').location,'customer');assert.equal(inventory.get('BAG-0003').location,'driver');
  await recordDeliveryBagMovements(delivery,payload,driver);assert.equal(writes.length,3);
  assert.deepEqual(delivery.proof.bagIds,['BAG-0001','BAG-0002']);
});
test('partial batch failure remains retryable without replaying successful movements',async()=>{
  add('BAG-0001');add('BAG-0002',{assignedTo:{driver:'another'}});
  const delivery={_id:deliveryId,customerId:'C1',driver:driver._id,proof:{}};
  const payload={status:'delivered',bagIds:['BAG-0001','BAG-0002'],proof:{}};
  await assert.rejects(()=>recordDeliveryBagMovements(delivery,payload,driver),/another driver/);
  assert.equal(inventory.get('BAG-0001').history.length,1);assert.equal(inventory.get('BAG-0002').history.length,0);
  inventory.get('BAG-0002').assignedTo={driver:driver._id};
  await recordDeliveryBagMovements(delivery,payload,driver);assert.equal(inventory.get('BAG-0001').history.length,1);assert.equal(inventory.get('BAG-0002').history.length,1);
});
test('collection tasks never deliver collected bags back to the customer',async()=>{
  add('BAG-0001',{lifecycleState:'with_customer',location:'customer',assignedTo:{customer:{customerId:'C1'}}});
  const delivery={_id:deliveryId,type:'Task',taskType:'Bag Collection',customerId:'C1',driver:driver._id};
  await recordDeliveryBagMovements(delivery,{status:'completed',bagIds:['BAG-0001'],proof:{type:'bag_collection',scannedBags:['BAG-0001']}},driver);
  assert.equal(inventory.get('BAG-0001').lifecycleState,'collected');assert.deepEqual(delivery.proof.bagIds,[]);
});
test('warehouse receipts update only the original linked delivery, with a stable receipt filter',async()=>{
  add('BAG-0001',{lifecycleState:'collected',currentDelivery:deliveryId,assignedTo:{driver:driver._id,customer:{customerId:'C1'}}});
  const cmd={action:'receive',eventId:'warehouse-receipt',note:'Received physical bag',expectedVersion:4};
  await moveBag('BAG-0001',cmd,staff);await moveBag('BAG-0001',cmd,staff);
  assert.equal(inventory.get('BAG-0001').history.length,1);assert.ok(receipts.every(r=>String(r.filter._id)===String(deliveryId)));
  assert.equal(receipts[0].filter['bagReturnReceipts.eventId'].$ne,'warehouse-receipt');assert.equal(inventory.get('BAG-0001').status,'maintenance');
});
test('unknown scan does not cause an insert or a fabricated receipt',async()=>{
  await assert.rejects(()=>moveBag('BAG-9999',{action:'collect',eventId:'unknown',note:'Scanned'},driver),/not registered/);assert.equal(writes.length,0);assert.equal(receipts.length,0);
});
