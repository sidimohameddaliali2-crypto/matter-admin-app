import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
process.env.DELIVERY_DEPOT_LAT = '25.2';
process.env.DELIVERY_DEPOT_LNG = '55.3';
const { parsePinInput, extractCoordsFromGoogleMapsUrl, resolveDeliveryCoordinates } = await import('./geocoding.js');

const clientSource = readFileSync(new URL('../../client/src/utils/gpsParsing.js', import.meta.url), 'utf8')
  .replace('export function parseGPSFromLink', 'function parseGPSFromLink');
const clientContext = { decodeURIComponent };
vm.createContext(clientContext);
vm.runInContext(`${clientSource}\nthis.parseGPSFromLink = parseGPSFromLink;`, clientContext);
const parseGPSFromLink = (link) => {
  const pin = clientContext.parseGPSFromLink(link);
  return pin && { lat: pin.lat, lng: pin.lng };
};

const DESTINATION = { lat: 25.3, lng: 55.4 };
const BOTH = 'https://www.google.com/maps/place/Villa/@25.1000,55.2000,17z/data=!4m6!3m5!8m2!3d25.3000!4d55.4000';

test('plain coordinates, with comma or space', () => {
  assert.deepEqual(parsePinInput('25.2048, 55.2708'), { lat: 25.2048, lng: 55.2708 });
  assert.deepEqual(parsePinInput(' 25.2048 55.2708 '), { lat: 25.2048, lng: 55.2708 });
  assert.deepEqual(parseGPSFromLink('25.2048, 55.2708'), { lat: 25.2048, lng: 55.2708 });
});
test('Google Maps links in the common forms', () => {
  assert.deepEqual(parsePinInput('https://www.google.com/maps/place/Villa/@25.1234,55.5678,15z'), { lat: 25.1234, lng: 55.5678 });
  assert.deepEqual(parsePinInput('https://www.google.com/maps?q=25.1,55.2'), { lat: 25.1, lng: 55.2 });
  assert.deepEqual(parsePinInput('https://www.google.com/maps/place/x/data=!3d25.11!4d55.22'), { lat: 25.11, lng: 55.22 });
  assert.deepEqual(parseGPSFromLink('https://maps.google.com/?q=loc:25.1234,55.5678'), { lat: 25.1234, lng: 55.5678 });
  assert.deepEqual(parseGPSFromLink('https://maps.apple.com/?ll=25.1972,55.2744'), { lat: 25.1972, lng: 55.2744 });
});
test('a map link uses the embedded destination, not the @ viewing centre', async () => {
  assert.deepEqual(parsePinInput(BOTH), DESTINATION);
  assert.deepEqual(extractCoordsFromGoogleMapsUrl(BOTH), DESTINATION);
  assert.deepEqual(parseGPSFromLink(BOTH), DESTINATION);
  const queried = 'https://www.google.com/maps/@25.1000,55.2000,17z?q=25.3000,55.4000';
  assert.deepEqual(parsePinInput(queried), DESTINATION);
  assert.deepEqual(parseGPSFromLink(queried), DESTINATION);
  assert.deepEqual(parsePinInput('https://www.google.com/maps?q=25.3000%2C55.4000'), DESTINATION);
  assert.deepEqual(parseGPSFromLink('https://www.google.com/maps?q=25.3000%2C55.4000'), DESTINATION);
  assert.deepEqual(await resolveDeliveryCoordinates({ mapsUrl: BOTH }), DESTINATION);
});
test('short links, text and empty give null', () => {
  assert.equal(parsePinInput('https://maps.app.goo.gl/abc123'), null);
  assert.equal(parseGPSFromLink('https://maps.app.goo.gl/abc123'), null);
  assert.equal(parsePinInput('Villa 5 Jumeirah'), null);
  assert.equal(parseGPSFromLink('Villa 5 Jumeirah'), null);
  assert.equal(parsePinInput(''), null);
  assert.equal(parseGPSFromLink(''), null);
});
