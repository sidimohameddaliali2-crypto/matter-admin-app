import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installActivityCapture } from '../utils/activityCapture';
import RouteOptimizationModal from './RouteOptimizationModal';
import api from '../utils/api';
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('@2gis/mapgl', () => ({ load: () => new Promise(() => {}) }));
process.env.REACT_APP_2GIS_API_KEY = 'fixture-map-key';
const DriverRouteMap2GIS = require('./DriverRouteMap2GIS').default;
const drivers = ['65fe00000000000000000001', '65fe00000000000000000002'].map(_id => ({ _id, profile: { firstName: 'Alex', lastName: 'Same', vehicleType: 'van' } }));
let host, root, cleanup, capture, oldFetch;
const render = node => act(async () => root.render(node));
const releaseQueue = () => act(async () => window.dispatchEvent(new Event('pagehide')));
const observations = field => capture.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events).filter(event => event.form.field === field).map(event => event.changes[0]);
const click = label => act(async () => [...host.querySelectorAll('button')].find(button => button.textContent.trim() === label).click());
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  api.get.mockResolvedValue({ data: { data: false } });
  localStorage.setItem('token', 'fixture-staff'); window.history.replaceState({}, '', '/dispatcher/driver-routes');
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  oldFetch = window.fetch; capture = jest.fn(async () => ({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) })); window.fetch = capture;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); cleanup = installActivityCapture();
});
afterEach(() => { act(() => root.unmount()); cleanup(); host.remove(); localStorage.clear(); window.fetch = oldFetch; jest.restoreAllMocks(); });

test('optimizer hubs with identical names retain their actual distinct driver IDs through the real queue', async () => {
  await render(<RouteOptimizationModal open drivers={drivers} deliveries={[]} initialSelectedDriverIds={drivers.map(driver => driver._id)}/>);
  for (const driver of drivers) {
    const drop = new Event('drop', { bubbles: true }); Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => driver._id } });
    act(() => host.querySelector('.border-dashed').dispatchEvent(drop));
  }
  await releaseQueue();
  const changes = observations('Hub vans'); expect(changes).toHaveLength(2);
  expect(changes[0].after).toContain(drivers[0]._id);
  expect(changes[1].before).toContain(drivers[0]._id); expect(changes[1].after).toContain(drivers[1]._id);
  expect(changes[1].after).toContain('Alex Same'); expect(api.post).not.toHaveBeenCalled();
});

test('simulation hub and exclusion choices with identical names retain distinct driver IDs in the real queue', async () => {
  await render(<DriverRouteMap2GIS open asPage drivers={drivers} deliveries={[]} date="2099-01-05"/>); await click('Simulate');
  const choose = (selector, index) => act(() => host.querySelectorAll(selector)[index].click());
  await choose('[data-testid="sim-hub-vans"] > div > button', 0); await choose('[data-testid="sim-hub-vans"] > div > button', 1);
  await choose('[data-testid="sim-drivers"] button', 0); await choose('[data-testid="sim-drivers"] button', 1);
  await click('Include all'); await releaseQueue();
  const hubs = observations('Hub vans'), excluded = observations('Excluded drivers');
  expect(hubs[0].after).toContain(drivers[0]._id); expect(hubs[1].after).toContain(drivers[1]._id);
  expect(excluded).toHaveLength(3); expect(excluded[0].after).toContain(drivers[0]._id); expect(excluded[1].after).toContain(drivers[1]._id);
  expect(excluded[2].before).toContain(drivers[0]._id); expect(excluded[2].before).toContain(drivers[1]._id); expect(excluded[2].after).toBe('');
  expect(api.post).not.toHaveBeenCalled();
});
