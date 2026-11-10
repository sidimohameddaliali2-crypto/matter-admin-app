import { test } from 'node:test';
import assert from 'node:assert/strict';
import {gpsVisitEvents, evaluateGpsVisit, gpsFixTime, GPS_VISIT_METHOD} from './trackerGpsVisits.js';
const pin={lat:25.1,lng:55.2};
const point=(minute,lat=25.1,extra={})=>({latitude:lat,longitude:55.2,gpsTime:new Date(Date.UTC(2026,9,24,0,minute)),recordedAt:new Date(Date.UTC(2026,9,24,0,minute)),...extra});
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


test('the new 60 m default includes a 55 m point while saved 50 m visits keep their original boundary',()=>{
 const north=metres=>pin.lat+metres/6371000*180/Math.PI;
 const points=[point(0,north(70)),point(1,north(55)),point(2,north(65))];
 assert.deepEqual(gpsVisitEvents(points,pin).map(e=>e.flag),['entry','exit']);
 assert.deepEqual(gpsVisitEvents(points,pin,50),[]);
});

const evaluate = (points, minute = 5, extra = {}) => evaluateGpsVisit({
  points, pin, photoCapturedAt: point(minute).gpsTime, photoSource: 'camera',
  start: new Date('2026-10-24T00:00:00Z'), end: new Date('2026-10-25T00:00:00Z'),
  asOf: new Date('2026-10-25T00:00:00Z'), ...extra,
});

test('a receipt timestamp never supplies a missing GPS clock', () => {
  assert.deepEqual(gpsVisitEvents([point(0,25.1,{gpsTime:null}), point(10,25.11,{gpsTime:null})], pin), []);
  const result = evaluate([point(0,25.1,{gpsTime:null}), point(10,25.11,{gpsTime:null})]);
  assert.equal(result.status, 'incomplete_events');
  assert.equal(result.arrivedAt, null);
  assert.equal(result.departedAt, null);
  assert.ok(result.gpsQualityReasons.includes('missing_or_invalid_fix_time'));
});

test('malformed, timezone-less and rolled calendar clocks stay unusable', () => {
  for (const clock of [null, '', 0, '2026-10-24T00:00:00', '2026-02-30T00:00:00Z', '2026-10-24T24:00:00Z', 'bad']) {
    assert.equal(gpsFixTime(clock), null);
  }
});

test('a long gap cannot verify a photo between observations or manufacture a departure', () => {
  const points = [point(0), point(120,25.11)];
  const result = evaluate(points,60);
  assert.equal(result.status, 'incomplete_events');
  assert.equal(result.needsReview, false);
  assert.ok(result.gpsQualityReasons.includes('observation_gap'));
  assert.deepEqual(gpsVisitEvents(points,pin).map(e=>e.flag), ['entry']);
});

test('same-time conflicting positions remain unusable regardless of input order', () => {
  const points = [point(4),point(5),point(5,25.11),point(6)];
  const a = evaluate(points), b = evaluate([...points].reverse());
  assert.deepEqual(a,b);
  assert.equal(a.status,'incomplete_events');
  assert.ok(a.gpsQualityReasons.includes('conflicting_coordinates'));
});

test('impossible jumps taint both endpoints and their repeated destination plateau', () => {
  const result = evaluate([point(4,26.1),point(5),point(6)],6);
  assert.equal(result.status,'incomplete_events');
  assert.ok(result.gpsQualityReasons.includes('impossible_jump'));
  assert.ok(result.gpsQualityReasons.includes('jump_plateau'));
});

test('invalid coordinates and future fixes break support instead of disappearing between valid rows', () => {
  for(const bad of [point(5,0,{longitude:0}),point(5,25.1,{recordedAt:point(4).gpsTime})]) {
    assert.equal(evaluate([point(4),bad,point(6)]).status,'incomplete_events');
  }
  assert.equal(evaluate([point(5)],5,{asOf:point(4).gpsTime}).status,'incomplete_events');
});

test('repeated receipts do not extend a last-known position to the photo time', () => {
  const one = point(0);
  const repeats = [one,{...one,recordedAt:point(5).gpsTime},{...one,recordedAt:point(10).gpsTime}];
  const result = evaluate(repeats,5);
  assert.equal(result.status,'incomplete_events');
  assert.equal(result.arrivedAt,null);
});

test('qualified nearby fixes support only an estimated photo comparison', () => {
  const result = evaluate([point(4),point(6),point(7,25.11)]);
  assert.equal(result.status,'gps_visit_observed');
  assert.equal(result.gpsMethod,GPS_VISIT_METHOD);
  assert.equal(+result.arrivedAt,+point(4).gpsTime);
  assert.equal(+result.departedAt,+point(7).gpsTime);
  assert.equal(result.needsReview,false);
});

test('a directly observed outside fix can warrant review, but absence between outside fixes cannot', () => {
  assert.equal(evaluate([point(5,25.11)]).status,'gps_window_review');
  const between = evaluate([point(4,25.11),point(6,25.11)]);
  assert.equal(between.status,'incomplete_events');
  assert.equal(between.needsReview,false);
});

test('explicit ambiguous mapping cannot become usable driver evidence', () => {
  const result = evaluate([point(4),point(5,25.1,{driverMappingState:'ambiguous_current_mapping'}),point(6)]);
  assert.equal(result.status,'incomplete_events');
  assert.ok(result.gpsQualityReasons.includes('ambiguous_driver_mapping'));
});

test('GPS evaluation preserves upload and missing camera-time semantics', () => {
  assert.equal(evaluate([point(5)],5,{photoSource:'upload'}).status,'uploaded_photo');
  assert.equal(evaluate([point(5)],5,{photoCapturedAt:null}).status,'missing_photo_time');
});

test('an invalid saved radius cannot create an outside-position warning', () => {
  for (const radiusMetres of [-1, NaN, Infinity]) {
    const result=evaluate([point(5)],5,{radiusMetres});
    assert.equal(result.status,'incomplete_events');
    assert.equal(result.needsReview,false);
  }
});
