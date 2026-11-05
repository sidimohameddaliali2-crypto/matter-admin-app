import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import truckoom from './truckoomApiService.js';

function groupEnvironment(t,value){
  const previous=process.env.TRUCKOOM_CUSTOMER_GEOFENCE_GROUP;
  if(value===undefined)delete process.env.TRUCKOOM_CUSTOMER_GEOFENCE_GROUP;
  else process.env.TRUCKOOM_CUSTOMER_GEOFENCE_GROUP=value;
  t.after(()=>{if(previous===undefined)delete process.env.TRUCKOOM_CUSTOMER_GEOFENCE_GROUP;else process.env.TRUCKOOM_CUSTOMER_GEOFENCE_GROUP=previous;});
}

function captureCreate(t){
  const service=new truckoom.constructor();
  Object.assign(service,{username:'fixture-user',password:'fixture-password',companyName:'Fixture Company'});
  const calls=[];
  t.mock.method(axios,'post',async(url,body)=>{
    calls.push({url,body});
    return url.includes('generateAccessToken')?{data:{result:1,data:{token:'fixture-token'}}}:{data:{result:1,data:{geofenceId:123}}};
  });
  return {service,calls};
}

test('daily fence creation omits group assignment and retains 50 m geometry',async t=>{
  groupEnvironment(t,undefined);
  const {service,calls}=captureCreate(t);
  assert.equal(await service.createCustomerGeofence('MATTER-fixture',{lat:25.1124,lng:55.2056}), '123');
  const body=calls.find(call=>call.url.includes('createGeofence')).body;
  assert.equal(Object.hasOwn(body,'geofence_group'),false);
  assert.equal(body.radius,'0.05');
  assert.deepEqual(body.coordinates,[[25.1124,55.2056]]);
  assert.equal(body.company_name,'Fixture Company');
});

test('a legacy group environment setting does not assign new circles to a group',async t=>{
  groupEnvironment(t,'  Customer Routes  ');
  const {service,calls}=captureCreate(t);
  await service.createCustomerGeofence('MATTER-fixture',{lat:25.1124,lng:55.2056});
  const body=calls.find(call=>call.url.includes('createGeofence')).body;
  assert.equal(Object.hasOwn(body,'geofence_group'),false);
  assert.equal(body.radius,'0.05');
});
