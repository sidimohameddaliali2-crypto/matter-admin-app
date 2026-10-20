import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DELIVERY_DEPOT_LAT = '25.2';
process.env.DELIVERY_DEPOT_LNG = '55.3';
const { parsePinInput } = await import('./geocoding.js');

test('plain coordinates, with comma or space', () => {
  assert.deepEqual(parsePinInput('25.2048, 55.2708'), { lat: 25.2048, lng: 55.2708 });
  assert.deepEqual(parsePinInput(' 25.2048 55.2708 '), { lat: 25.2048, lng: 55.2708 });
});
test('Google Maps links in the common forms', () => {
  assert.deepEqual(parsePinInput('https://www.google.com/maps/place/Villa/@25.1234,55.5678,15z'), { lat: 25.1234, lng: 55.5678 });
  assert.deepEqual(parsePinInput('https://www.google.com/maps?q=25.1,55.2'), { lat: 25.1, lng: 55.2 });
  assert.deepEqual(parsePinInput('https://www.google.com/maps/place/x/data=!3d25.11!4d55.22'), { lat: 25.11, lng: 55.22 });
});
test('short links, text and empty give null', () => {
  assert.equal(parsePinInput('https://maps.app.goo.gl/abc123'), null);
  assert.equal(parsePinInput('Villa 5 Jumeirah'), null);
  assert.equal(parsePinInput(''), null);
});
