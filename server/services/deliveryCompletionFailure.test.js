import test from 'node:test';
import assert from 'node:assert/strict';
import Delivery from '../models/Delivery.js';
import {completionFailureDetails,recordCompletionFailure} from './deliveryCompletionFailure.js';

test('failure records the requested bag and the actual failing lookup separately',()=>{
  const error=Object.assign(new Error('Bag BAG-00613 is not registered'),{statusCode:404,bagId:'BAG-00613'});
  const details=completionFailureDetails({bagId:'BAG_00523',proof:JSON.stringify({bagId:'BAG_00523',bagIds:['BAG-00613']})},error,'driver');
  assert.equal(details.bagId,'BAG-00613');
  assert.deepEqual(details.codes,[{source:'body.bagId',code:'BAG_00523'},{source:'proof.bagId',code:'BAG_00523'},{source:'proof.bagIds',code:'BAG-00613'}]);
  assert.equal(details.statusCode,404);
});
test('diagnostic contains bag references, not credentials, photos or the full request',()=>{
  const details=completionFailureDetails({token:'private-token',notes:'private-note',proof:{photoUrl:'https://private.invalid/photo',location:{lat:25,lng:55},bagId:'BAG_00523'}},new Error('Internal database connection detail'),'driver');
  const json=JSON.stringify(details);
  assert.ok(json.includes('BAG_00523'));
  for(const text of ['private-token','private-note','private.invalid','Internal database'])assert.ok(!json.includes(text));
  assert.equal(details.message,'Completion failed');
});
test('unauthorized/unresolved deliveries do not record a failure',async()=>{
  let calls=0;const store={updateOne:async()=>{calls++;}};
  await recordCompletionFailure(undefined,'driver',{},new Error('failed'),store);
  assert.equal(calls,0);
});
test('failure write is scoped to its current driver and cannot mark a completed delivery failed',async()=>{
  let captured;
  const store={updateOne:async(filter,update,options)=>{captured={filter,update,options};}};
  await recordCompletionFailure('delivery','driver',{bagId:'BAG-00523'},Object.assign(new Error('not registered'),{statusCode:404,bagId:'BAG-00523'}),store);
  assert.deepEqual(captured.filter,{_id:'delivery',driver:'driver',status:{$nin:['delivered','completed','collected']}});
  assert.deepEqual(Object.keys(captured.update.$set),['completionFailure']);
  assert.equal(captured.options.timestamps,false);
});
test('Mongoose preserves the bag failure details without dropping their source fields',()=>{
  const failure=completionFailureDetails({bagId:'BAG-00523'},Object.assign(new Error('not registered'),{statusCode:404,bagId:'BAG-00523'}),'222222222222222222222222');
  const stored=new Delivery({completionFailure:failure}).toObject().completionFailure;
  assert.equal(stored.bagId,'BAG-00523');
  assert.deepEqual(stored.codes,[{source:'body.bagId',code:'BAG-00523'}]);
});
