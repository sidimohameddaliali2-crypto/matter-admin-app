import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { recordActivityChange } from '../utils/activityCapture';
import api from '../utils/api';
process.env.REACT_APP_GOOGLE_MAPS_API_KEY = 'fixture';
const DispatcherMapAssignModal = require('./DispatcherMapAssignModal').default;
const DispatcherDesktop = require('../pages/DispatcherDesktop').default;
const DispatcherMobile = require('../pages/DispatcherMobile').default;

jest.mock('../utils/activityCapture', () => ({ recordActivityChange: jest.fn() }));
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), patch: jest.fn(), post: jest.fn() } }));
const mockDispatch = jest.fn();
const fixture = [{ _id: 'a', customerId: 'D-101', customerName: 'Aster', zone: 'Marina', addressDetails: { city: 'Dubai' }, gpsLocation: { lat: 25, lng: 55 }, status: 'pending' }, { _id: 'b', customerId: 'D-102', customerName: 'Birch', zone: 'JVC', addressDetails: { city: 'Abu Dhabi' }, gpsLocation: { lat: 26, lng: 56 }, status: 'pending' }];
const mockState = { auth: { user: { role: 'super_admin' } }, delivery: { deliveries: fixture, isLoading: false }, driver: { drivers: [] }, events: { events: [] } };
jest.mock('react-redux', () => ({ useDispatch: () => mockDispatch, useSelector: fn => fn(mockState) }));
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }), { virtual: true });
jest.mock('./events/EventCalendarView', () => () => null);
jest.mock('./events/EventDetailModal', () => () => null);
let mockScanner;
jest.mock('./SimpleQrScanner', () => props => { mockScanner = props; return null; });
jest.mock('./RouteOptimizationModal', () => () => null);
jest.mock('./ManualOrderModal', () => () => null);
let mockDrawing, mockMap;
jest.mock('@react-google-maps/api', () => ({
  useLoadScript: () => ({ isLoaded: true }),
  GoogleMap: props => { mockMap = props; return <div>{props.children}</div>; },
  DrawingManager: props => { mockDrawing = props; return null; },
  Marker: props => <button type="button" onClick={props.onClick}>Map marker</button>,
  Circle: () => null, Polygon: () => null, InfoWindow: () => null,
  StandaloneSearchBox: ({ children }) => <div>{children}</div>,
}));

let host, root;
const render = node => act(async () => root.render(node));
const click = text => act(async () => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === text).click());
const changes = () => recordActivityChange.mock.calls.map(([change]) => change);
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: { data: [] } }); api.patch.mockResolvedValue({ data: { success: true } });
  window.alert = jest.fn();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

test('map selection records only gestures, including geometry and reset, before assignment', async () => {
  await render(<DispatcherMapAssignModal open deliveries={fixture} drivers={[]}/>);
  expect(changes()).toEqual([]);
  await click('Map marker');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Selected deliveries', before: [], after: ['D-101'] }));
  await click('Reset');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Selected deliveries', before: ['D-101'], after: [] }));
  act(() => mockDrawing.onOverlayComplete({ type: 'circle', overlay: { getCenter: () => ({ lat: () => 26, lng: () => 56 }), getRadius: () => 100, setMap: jest.fn() } }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Selected deliveries', before: [], after: ['D-102'] }));
  const count = changes().length;
  await render(<DispatcherMapAssignModal open deliveries={[...fixture]} drivers={[]}/>);
  expect(changes()).toHaveLength(count);
  expect(api.patch).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

test('polygon gestures report selected references while automatic drawing callbacks stay unobserved', async () => {
  await render(<DispatcherMapAssignModal open deliveries={fixture} drivers={[]}/>);
  act(() => mockDrawing.onDrawingModeChanged());
  expect(changes()).toEqual([]);
  const points = [{ lat: () => 24.9, lng: () => 54.9 }, { lat: () => 25.1, lng: () => 54.9 }, { lat: () => 25.1, lng: () => 55.1 }, { lat: () => 24.9, lng: () => 55.1 }];
  act(() => mockDrawing.onOverlayComplete({ type: 'polygon', overlay: { getPath: () => ({ getArray: () => points }), setMap: jest.fn() } }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Selected deliveries', before: [], after: ['D-101'] }));
});

test('failed map pin writes still retain the attempted before and after coordinates', async () => {
  const delivery = { ...fixture[0], gpsLocation: undefined };
  api.patch.mockRejectedValueOnce(new Error('Fixture offline'));
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  await render(<DispatcherMapAssignModal open deliveries={[delivery]} drivers={[]}/>);
  await click('Pin');
  await act(async () => mockMap.onClick({ latLng: { lat: () => 25.2, lng: () => 55.3 } }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Location for D-101', before: 'Not set', after: '25.200000, 55.300000' }));
  expect(api.patch).toHaveBeenCalledWith('/deliveries/a', { gpsLocation: { lat: 25.2, lng: 55.3 } });
  error.mockRestore();
});

test.each([[DispatcherDesktop, '1am'], [DispatcherMobile, '1:00 AM']])('dispatcher custom timing and unassigned filters record before and after without saving', async (Component, hour) => {
  await render(<Component/>);
  expect(changes()).toEqual([]);
  const toggle = [...host.querySelectorAll('button')].find(node => node.textContent.includes('Unassigned'));
  act(() => toggle.click());
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Unassigned deliveries only', before: false, after: true }));
  const hours = [...host.querySelectorAll('button')].find(node => node.textContent.includes('Select Hours') || node.title === 'Filter by time');
  act(() => hours.click()); await click(hour);
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Delivery hours', before: [], after: ['1am'] }));
  expect(api.patch).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

test.each([DispatcherDesktop, DispatcherMobile])('area choices retain rapid toggles and clear back to all areas', async Component => {
  await render(<Component/>);
  await click('All Areas');
  act(() => { const nodes = [...host.querySelectorAll('button')]; nodes.find(node => node.textContent.trim() === 'Marina').click(); nodes.find(node => node.textContent.trim() === 'JVC').click(); });
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Delivery areas', before: ['Marina'], after: ['Marina', 'JVC'] }));
  const clear = [...host.querySelectorAll('button')].find(node => ['clear', 'clear all'].includes(node.textContent.trim().toLowerCase()));
  act(() => clear.click());
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Delivery areas', before: ['Marina', 'JVC'], after: [] }));
});

test('mobile select-all and clear report actual delivery references', async () => {
  await render(<DispatcherMobile/>);
  await click('Select All');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Selected deliveries', before: [], after: ['D-101', 'D-102'] }));
  await click('Deselect');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Selected deliveries', before: ['D-101', 'D-102'], after: [] }));
});

test('mobile bag scans and removal record unsaved bag selections', async () => {
  await render(<DispatcherMobile/>);
  act(() => host.querySelector('button[title="Assign bags to driver"]').click());
  await click('Start Scanner');
  act(() => mockScanner.onScan([{ rawValue: 'bag-001' }]));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Scanned bags', before: [], after: ['BAG-001'] }));
  act(() => host.querySelector('button[title="Remove"]').click());
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Scanned bags', before: ['BAG-001'], after: [] }));
  expect(api.post).not.toHaveBeenCalled();
});
