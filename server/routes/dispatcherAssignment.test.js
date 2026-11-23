import test from 'node:test';
import assert from 'node:assert/strict';
import router from './deliveries.js';
import Delivery from '../models/Delivery.js';
import User from '../models/User.js';
import Handoff from '../models/Handoff.js';
const handler=(path,method)=>router.stack.find(l=>l.route?.path===path&&l.route.methods[method]).route.stack.at(-1).handle;
const response=()=>({code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
test('dispatcher assignment is saved, broadcast, and returned only to its assigned driver feed',async()=>{
 const driverId='111111111111111111111111',otherId='222222222222222222222222',id='333333333333333333333333';
 const original={user:User.findOne,byId:User.findById,find:Delivery.find,handoff:Handoff.find};
 let persistedDriver=null;const emitted=[];
 const job={_id:id,customerId:'FIXTURE',customerName:'Fixture customer',type:'Delivery',status:'pending',scheduledTime:new Date(),driver:null,timeline:[],save:async function(){persistedDriver=this.driver;return this;},populate:async function(){return this;}};
 const chain=rows=>({sort(){return this;},select(){return this;},populate(){return this;},lean:async()=>rows});
 User.findOne=async query=>{assert.equal(query.isActive,true);return {_id:driverId,email:'fixture@example.test',profile:{firstName:'Fixture',lastName:'Driver'}};};
 User.findById=()=>({select:async()=>({pushTokens:[]})});
 Delivery.find=query=>query._id?Promise.resolve([job]):chain(query.driver&&String(query.driver)===persistedDriver?[job]:[]);
 Handoff.find=()=>chain([]);
 try{
  const assigned=response();await handler('/assign-driver','patch')({body:{deliveryIds:[id],driverId},user:{role:'dispatcher'},app:{get:()=>({emit:(...args)=>emitted.push(args)})}},assigned);
  assert.equal(assigned.code,200);assert.equal(persistedDriver,driverId);assert.equal(job.status,'assigned');assert.equal(emitted[0][0],'delivery:updated');assert.equal(emitted[0][1]._id,id);
  const own=response();await handler('/driver/today','get')({user:{_id:driverId}},own);assert.equal(own.code,200);assert.equal(own.body.data.deliveries[0]._id,id);
  const other=response();await handler('/driver/today','get')({user:{_id:otherId}},other);assert.equal(other.code,200);assert.deepEqual(other.body.data.deliveries,[]);
 }finally{User.findOne=original.user;User.findById=original.byId;Delivery.find=original.find;Handoff.find=original.handoff;}
});

test('inactive driver assignment is rejected before changing a delivery',async()=>{
 const original=User.findOne;User.findOne=async query=>{assert.equal(query.isActive,true);return null;};
 try{const res=response();await handler('/assign-driver','patch')({body:{deliveryIds:['333333333333333333333333'],driverId:'111111111111111111111111'},user:{role:'dispatcher'}},res);assert.equal(res.code,404);}finally{User.findOne=original;}
});
