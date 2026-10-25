import { test } from 'node:test';
import assert from 'node:assert/strict';
import {gpsVisitEvents} from './trackerGpsVisits.js';
const pin={lat:25.1,lng:55.2};
const point=(minute,lat=25.1,extra={})=>({latitude:lat,longitude:55.2,recordedAt:new Date(Date.UTC(2026,9,24,0,minute)),...extra});
test('records observed arrival and departure from actual vehicle samples',()=>{
 const events=gpsVisitEvents([point(0,25.11),point(1),point(2),point(3,25.11)],pin);
 assert.deepEqual(events.map(e=>e.flag),['entry','exit']);
 assert.equal(+events[0].at,+point(1).recordedAt);
 assert.equal(+events[1].at,+point(3).recordedAt);
});
test('uses actual GPS time and deduplicates cached tracker reports',()=>{
 const gpsTime='2026-10-24T00:00:00Z';
 const events=gpsVisitEvents([point(2,25.1,{gpsTime}),point(3,25.1,{gpsTime}),point(4,25.11)],pin);
 assert.equal(events.length,2);
 assert.equal(events[0].at.toISOString(),'2026-10-24T00:00:00.000Z');
});
test('missing/invalid coordinates and outside-only trajectories do not fabricate visits',()=>{
 assert.deepEqual(gpsVisitEvents([point(0,25.11),point(1,25.1,{longitude:null})],pin),[]);
 assert.deepEqual(gpsVisitEvents([point(0)],{lat:null,lng:null}),[]);
});
test('an unfinished visit keeps its departure unknown and separate visits are preserved',()=>{
 assert.deepEqual(gpsVisitEvents([point(0),point(1)],pin).map(e=>e.flag),['entry']);
 assert.deepEqual(gpsVisitEvents([point(0),point(1,25.11),point(2),point(3,25.11)],pin).map(e=>e.flag),['entry','exit','entry','exit']);
});
