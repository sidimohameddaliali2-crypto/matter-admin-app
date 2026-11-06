// Local HTTP simulation of the supplied Truckoom contract, not a vendor test
// account. No database, real credentials, production fences or vehicle changes.
// Run from server/: node scripts/testTruckoomSandbox.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';
import truckoom from '../services/truckoomApiService.js';
import Delivery from '../models/Delivery.js';
import {normalizeAlertData} from '../services/truckoomAlertData.js';
import {evaluateTrackerVisit,recordProofReceipt} from '../services/truckoomVisitRules.js';

const company='MATTER Sandbox';
const credentials={username:'sandbox-user',password:'sandbox-password'};
const token='sandbox-token';
const fenceName=`MATTER-20261027-${'a'.repeat(24)}`;
const vehicle='SANDBOX-VEHICLE';
const state={fences:new Map(),linked:false,tokenRequests:0,requests:0};
const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    const method=url.searchParams.get('token');
    state.requests++;
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    let response;
    if(method==='generateAccessToken'){
      assert.equal(req.method,'POST');assert.deepEqual(body,credentials);state.tokenRequests++;
      response={result:1,data:{token}};
    }else if(method==='getAlertData'){
      assert.equal(req.method,'POST');assert.equal(body.access_token,token);
      assert.equal(body.username,credentials.username);assert.equal(body.password,credentials.password);
      assert.equal(body.format,'json');assert.ok(Number.isSafeInteger(body.from)&&Number.isSafeInteger(body.to));
      assert.ok(body.to>=body.from&&body.to-body.from<=86400000);
      const events=state.linked&&state.fences.size&&body.from===Date.parse('2026-10-26T20:00:00Z')
        ?[
          {company,vehicle_no:vehicle,alert_info:`Enter In Geofence - ${fenceName}`,alert_generation:'27-10-2026 01:26:14 AM',alert_type:'Enter In Geofence'},
          {company,vehicle_no:vehicle,alert_info:`Out Of Geofence - ${fenceName}`,alert_generation:'27-10-2026 01:40:44 AM',alert_type:'Out Of Geofence'},
        ]:[];
      response={result:1,data:events};
    }else{
      assert.equal(req.method,'POST');assert.equal(req.headers['auth-code'],token);
      assert.equal(body.project_id,'49');
      if(method==='createGeofence'){
        assert.equal(body.geofence_name,fenceName);assert.equal(body.radius,'0.06');
        assert.deepEqual(body.coordinates,[[25.1124,55.2056]]);
        assert.equal(body.geofence_type,'circle');assert.equal(body.geo_shape,'circle');
        assert.equal(body.company_name,company);
        assert.equal(Object.hasOwn(body,'geofence_group'),false);
        const id='sandbox-fence-1';
        state.fences.set(id,{'Geofence Id':id,'Geofence name':body.geofence_name,'Company Name':body.company_name,'Geofence Group':'--',Radius:Number(body.radius)});
        response={result:1,data:{geofenceId:id}};
      }else if(method==='getGeofenceList'){
        response={result:1,data:[...state.fences.values(),{'Geofence Id':'other-company','Company Name':'Another Sandbox Company'}]};
      }else if(method==='deletGeofence'){
        assert.equal(body.geofence_id,'sandbox-fence-1');state.fences.delete(body.geofence_id);
        response={result:1,data:{}};
      }else throw new Error('Unexpected sandbox API method');
    }
    res.end(JSON.stringify(response));
  }catch(error){res.statusCode=400;res.end(JSON.stringify({result:0,message:error.message}));}
});

let guard;
const passed=[];
const pass=name=>{passed.push(name);console.log(`PASS ${name}`);};
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  guard=axios.interceptors.request.use(config=>{
    assert.equal(new URL(config.url).origin,origin,'Sandbox blocks every non-local request');
    config.proxy=false;return config;
  });
  const service=new truckoom.constructor();
  Object.assign(service,{baseURL:`${origin}/webservice`,...credentials,companyName:company});
  const tokens=await Promise.all([service.getAccessToken(),service.getAccessToken()]);
  assert.deepEqual(tokens,[token,token]);assert.equal(state.tokenRequests,1);pass('token authentication and shared token request');
  const id=await service.createCustomerGeofence(fenceName,{lat:25.1124,lng:55.2056});
  const fences=await service.getGeofences();
  assert.equal(fences.length,1);assert.equal(fences[0]['Geofence Id'],id);assert.equal(fences[0].Radius,0.06);
  assert.equal(fences[0]['Geofence Group'],'--');
  pass('60 m ungrouped circle creation, company filtering and listing');
  const start=new Date('2026-10-26T20:00:00Z'),end=new Date('2026-10-27T20:00:00Z');
  assert.deepEqual(await service.getAlertData(+start,+end-1),[]);
  pass('created circle alone does not imply alerts in the unlinked fixture');
  // Fixture setup only, not a Truckoom vehicle-linking API.
  state.linked=true;
  const events=normalizeAlertData(await service.getAlertData(+start,+end-1),{companyName:company,start,end});
  assert.equal(events.length,2);assert.equal(events[0].at.toISOString(),'2026-10-26T21:26:14.000Z');
  assert.equal(events[0].source,'truckoom_alert_data');
  assert.deepEqual(await service.getAlertData(+end,+end+86400000-1),[]);
  await assert.rejects(()=>service.getAlertData(+start,+end+1),RangeError);
  pass('getAlertData JSON ranges and Dubai event times normalize to UTC');

  const captured='2026-10-26T21:33:00.000Z';
  const proof={photoUrl:'https://sandbox.invalid/photo.jpg',photoCapturedAt:captured,photoSource:'camera'};
  const delivery=new Delivery({proof});
  recordProofReceipt(delivery,proof,new Date('2026-10-27T01:00:00Z'));
  assert.equal(delivery.proof.photoCapturedAt.toISOString(),captured);
  const evaluate=(photoCapturedAt=delivery.proof.photoCapturedAt,photoSource=delivery.proof.photoSource)=>evaluateTrackerVisit({events,photoCapturedAt,photoSource,start,end});
  assert.equal(evaluate().status,'inside_window');
  pass('Android camera metadata survives a delayed offline receipt and verifies inside the visit');
  assert.equal(evaluate('2026-10-26T21:20:00Z').status,'outside_window');
  assert.equal(evaluate('2026-10-26T21:45:00Z').status,'outside_window');
  pass('camera photos before arrival and after departure are flagged');
  assert.equal(evaluate(captured,'upload').status,'uploaded_photo');
  pass('gallery upload is not treated as verified camera evidence');
  const legacy=new Delivery({proof:{photoUrl:'https://sandbox.invalid/legacy.jpg'}});
  recordProofReceipt(legacy,{photoUrl:legacy.proof.photoUrl},new Date('2026-10-26T21:33:00Z'));
  assert.equal(legacy.proof.photoCapturedAt,undefined);
  assert.equal(evaluateTrackerVisit({events,start,end,photoCapturedAt:legacy.proof.photoCapturedAt,photoSource:legacy.proof.photoSource}).status,'missing_photo_time');
  pass('saved photo without camera time stays unverified, even if receipt is inside the visit');
  await service.deleteCustomerGeofence(id);
  assert.equal((await service.getGeofences()).length,0);assert.equal(state.fences.size,0);
  pass('geofence deletion and cleanup');
  console.log(JSON.stringify({sandbox:'local simulation; not Truckoom-hosted',passed:passed.length,httpRequests:state.requests,productionCalls:0,databaseWrites:0}));
}catch(error){console.error(`FAIL ${error.message}`);process.exitCode=1;}
finally{
  if(guard!==undefined)axios.interceptors.request.eject(guard);
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
