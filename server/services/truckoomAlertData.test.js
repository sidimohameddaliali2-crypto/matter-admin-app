import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import truckoom from './truckoomApiService.js';
import {alertDataRows,parseAlertDataTime,normalizeAlertData} from './truckoomAlertData.js';
import {evaluateTrackerVisit} from './truckoomVisitRules.js';

const name='MATTER-20261106-a7280b2fcfc572d4e1cbe4b9';
const company='Fixture Company';
const start=new Date('2026-11-05T20:00:00Z'),end=new Date('2026-11-06T20:00:00Z');
const entry={company,vehicle_no:'73502',alert_type:'Enter In Geofence',
 alert_info:`Enter In Geofence - ${name} `,alert_generation:'06-11-2026 07:53:45 AM',alert_id:21};
const exit={...entry,alert_type:'Out Of Geofence',alert_info:`Out Of Geofence - ${name}`,
 alert_generation:'06-11-2026 08:00:53 AM',alert_id:20};
const normalize=rows=>normalizeAlertData(rows,{companyName:company,start,end});

function serviceFixture(t) {
 const service=new truckoom.constructor();
 Object.assign(service,{username:'fixture-user',password:'fixture-password',companyName:company});
 t.mock.method(service,'getAccessToken',async()=> 'fixture-token');
 return service;
}

test('getAlertData parses Dubai AM/PM correctly including midnight, noon and invalid dates',()=>{
 assert.equal(parseAlertDataTime(entry.alert_generation).toISOString(),'2026-11-06T03:53:45.000Z');
 assert.equal(parseAlertDataTime('06-11-2026 12:01:00 AM').toISOString(),'2026-11-05T20:01:00.000Z');
 assert.equal(parseAlertDataTime('06-11-2026 12:01:00 PM').toISOString(),'2026-11-06T08:01:00.000Z');
 for(const value of ['31-02-2026 07:00:00 AM','06-11-2026 00:01:00 AM','06-11-2026 13:01:00 PM','bad'])assert.equal(parseAlertDataTime(value),null);
});

test('recorded Khalil visit confirms photo inside actual vendor entry/exit after Dubai conversion',()=>{
 const events=normalize([exit,entry,entry]);
 assert.equal(events.length,2);
 assert.equal(events[0].name,name);
 assert.equal(events[0].source,'truckoom_alert_data');
 assert.equal(events[0].vendorTimestamp,entry.alert_generation);
 const visit=evaluateTrackerVisit({events,photoCapturedAt:'2026-11-06T03:56:28Z',photoSource:'camera',start,end});
 assert.equal(visit.status,'inside_window');
 assert.equal(visit.arrivedAt.toISOString(),'2026-11-06T03:53:45.000Z');
 assert.equal(visit.departedAt.toISOString(),'2026-11-06T04:00:53.000Z');
 assert.equal(evaluateTrackerVisit({events,photoCapturedAt:'2026-11-06T03:50:00Z',photoSource:'camera',start,end}).status,'outside_window');
 assert.equal(evaluateTrackerVisit({events,photoSource:'unknown',start,end}).status,'missing_photo_time');
});

test('reused kitchen text does not override the actual managed name or alert type',()=>{
 const rows=normalize([{...entry,alert_info:`Vehicle left Matter Kitchen - Al Quoz. - ${name}`}]);
 assert.equal(rows.length,1);
 assert.equal(rows[0].flag,'entry');
 assert.equal(rows[0].name,name);
});

test('foreign-company events, unknown rules and partial/ambiguous names are not customer evidence',()=>{
 const other='MATTER-20261106-ffffffffffffffffffffffff';
 assert.deepEqual(normalize([{...entry,company:'Another Company'}, {...entry,alert_type:'Overspeed'},
 {...entry,alert_info:`${name}-extra`}, {...entry,alert_info:`${name} / ${other}`},
 {...entry,alert_info:'Matter Kitchen - Al Quoz'}, {...entry,company:undefined}]),[]);
});

test('alert generation time determines the UTC bucket, not the date in the geofence name',()=>{
 const before=normalizeAlertData([entry],{companyName:company,start:new Date('2026-11-05T00:00:00Z'),end:new Date('2026-11-06T00:00:00Z')});
 assert.deepEqual(before,[]);
 const current=normalizeAlertData([entry],{companyName:company,start:new Date('2026-11-06T00:00:00Z'),end:new Date('2026-11-07T00:00:00Z')});
 assert.equal(current.length,1);
});

test('malformed matching customer records fail safely rather than hiding incomplete evidence',()=>{
 assert.throws(()=>normalize([{...entry,alert_generation:'bad'}]),{code:'TRUCKOOM_INVALID_RESPONSE'});
 assert.throws(()=>normalize([{...entry,vehicle_no:''}]),{code:'TRUCKOOM_INVALID_RESPONSE'});
});

test('successful and empty envelopes unwrap, while HTTP-200 vendor failures remain errors',()=>{
 assert.deepEqual(alertDataRows({result:1,data:[entry]}),[entry]);
 assert.deepEqual(alertDataRows([{status:1,data:[entry]}]),[entry]);
 assert.deepEqual(alertDataRows({result:1,data:[]}),[]);
 assert.deepEqual(alertDataRows({result:0,data:[],message:'No Records Found.'}),[]);
 for(const payload of [[],null,{result:0,data:[],message:'Something went wrong on server.'},{result:1,data:{}},
 [{status:1,data:[entry]},{result:0,data:[],message:'Invalid Username/Password'}]])assert.throws(()=>alertDataRows(payload),{code:'TRUCKOOM_INVALID_RESPONSE'});
});

test('SDK sends explicit millisecond ranges and token in the documented JSON body',async t=>{
 const service=serviceFixture(t);let request;
 t.mock.method(axios,'post',async(url,body)=>{request={url,body};return {data:{result:1,data:[entry]}};});
 assert.deepEqual(await service.getAlertData(+start,+end-1),[entry]);
 assert.ok(request.url.endsWith('?token=getAlertData'));
 assert.deepEqual(request.body,{access_token:'fixture-token',username:'fixture-user',password:'fixture-password',format:'json',from:+start,to:+end-1});
});

test('SDK rejects missing, reversed and over-24-hour windows before authentication or HTTP',async t=>{
 const service=serviceFixture(t);
 t.mock.method(axios,'post',async()=>{throw new Error('must not request');});
 for(const [from,to] of [[undefined,undefined],[NaN,+end],[+end,+start],[+start,+end+1]])await assert.rejects(()=>service.getAlertData(from,to),RangeError);
 assert.equal(service.getAccessToken.mock.callCount(),0);
 assert.equal(axios.post.mock.callCount(),0);
});

test('SDK refreshes invalid access token once and validates the retried response',async t=>{
 const service=serviceFixture(t);let requests=0;
 t.mock.method(axios,'post',async()=>++requests===1?{data:{result:0,data:[],message:'Token is invalid or expired'}}:{data:{result:1,data:[entry]}});
 assert.deepEqual(await service.getAlertData(+start,+end-1),[entry]);
 assert.equal(requests,2);
 assert.equal(service.getAccessToken.mock.callCount(),2);
});

test('persistent token rejection and generic vendor failures never become valid empty evidence',async t=>{
 const service=serviceFixture(t);
 t.mock.method(axios,'post',async()=>({data:{result:0,data:[],message:'Token is invalid or expired'}}));
 await assert.rejects(()=>service.getAlertData(+start,+end-1),{code:'TRUCKOOM_INVALID_RESPONSE'});
 assert.equal(axios.post.mock.callCount(),2);
});
