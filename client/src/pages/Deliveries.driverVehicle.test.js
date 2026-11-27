import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Deliveries from './Deliveries';
import api from '../utils/api';

jest.mock('../utils/api', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('react-redux', () => ({ useSelector: selector => selector({ auth: { user: { role: 'dispatcher' } } }) }));
jest.mock('react-router-dom', () => ({ Link: ({ children }) => children, useSearchParams: () => [new URLSearchParams()] }), { virtual: true });
jest.mock('../contexts/SocketContext', () => ({ useSocket: () => ({ socket: null }) }));
jest.mock('../utils/activityCapture', () => ({ recordActivityChange: jest.fn() }));
jest.mock('../components/deliveries/PrintConfigModal', () => () => null);
jest.mock('../components/deliveries/DeliveryDetailModal', () => () => null);
jest.mock('../components/stickers/SatoStickerPrintModal', () => () => null);

let drivers;
const row = (id, driver) => ({ _id: id, customerId: id, customerName: `Drop ${id}`, type: 'Delivery', status: 'assigned', scheduledTime: '2026-11-27T02:00:00Z', driver });
const rows = [row('Alpha', { _id: 'A', profile: { firstName: 'Driver Alpha' } }),
  row('Beta', { _id: 'B', profile: { firstName: 'Driver Beta' } }),
  row('Gamma', { _id: 'C', profile: { firstName: 'Driver Gamma' } }), row('Unassigned', null)];

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers().setSystemTime(new Date('2026-11-27T08:00:00Z'));
  drivers = [
    { _id: 'A', profile: { firstName: 'Driver Alpha', vehicleType: 'bike', vehicleId: 'OLD-PROFILE' }, assignedVehicles: [
      { vehicleId: 'BIKE-1', type: 'bike', plateNumber: 'DXB-71592' }, { vehicleId: 'CAR-1', type: 'car', plateNumber: 'DXB-999' },
    ] },
    { _id: 'B', profile: { firstName: 'Driver Beta', vehicleType: 'van', vehicleId: 'VAN-02' }, assignedVehicles: [] },
    { _id: 'C', profile: { firstName: 'Driver Gamma', vehicleType: 'bike', truckoomVehicleNo: '73051' }, assignedVehicles: [] },
  ];
  api.get.mockReset(); api.post.mockReset();
  api.get.mockImplementation(async path => {
    if (path === '/deliveries') return { data: { success: true, data: { deliveries: rows } } };
    if (path === '/users/drivers') return { data: JSON.parse(JSON.stringify(drivers)) };
    return { data: { success: true, data: null } };
  });
  api.post.mockResolvedValue({ data: { data: { updated: 0 } } });
});
afterEach(() => jest.useRealTimers());

test('delivery rows and mobile cards show Fleet assignments, profile/GPS fallbacks, and refresh/search follow vehicle changes', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<Deliveries />));
    const table = node.querySelector('tbody');
    expect(table.textContent).toContain('Driver Alpha');
    expect(table.textContent).toContain('Assigned now: Bike DXB-71592 / Car DXB-999');
    expect(table.textContent).not.toContain('OLD-PROFILE');
    expect(table.textContent).toContain('Assigned now: Van VAN-02');
    expect(table.textContent).toContain('Assigned now: Bike 73051');
    expect(table.textContent).toContain('Unassigned');
    expect([...node.querySelectorAll('span')].filter(span => span.textContent === 'Assigned now: Bike DXB-71592 / Car DXB-999')).toHaveLength(2);
    expect([...node.querySelectorAll('option')].some(option => option.textContent.includes('Driver Alpha · Bike DXB-71592'))).toBe(true);
    const search = node.querySelector('input[placeholder*="Search customer"]');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    await act(async () => { setValue.call(search, '71592'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(node.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(node.querySelector('tbody').textContent).toContain('Drop Alpha');
    await act(async () => { setValue.call(search, ''); search.dispatchEvent(new Event('input', { bubbles: true })); });
    drivers[0] = { ...drivers[0], assignedVehicles: [{ type: 'bike', plateNumber: 'DXB-NEW' }] };
    await act(async () => node.querySelector('button[title="Refresh"]').click());
    expect(node.querySelector('tbody').textContent).toContain('Assigned now: Bike DXB-NEW');
    expect(node.querySelector('tbody').textContent).not.toContain('71592');
  } finally { await act(async () => root.unmount()); }
});

test('an unavailable assignment lookup keeps delivery names and unassigned stops usable', async () => {
  const implementation = api.get.getMockImplementation();
  api.get.mockImplementation(path => path === '/users/drivers' ? Promise.reject(new Error('unavailable')) : implementation(path));
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<Deliveries />));
    expect(node.querySelector('tbody').textContent).toContain('Driver Alpha');
    expect(node.querySelector('tbody').textContent).toContain('Vehicle unavailable');
    expect(node.querySelector('tbody').textContent).toContain('Drop Unassigned');
  } finally { await act(async () => root.unmount()); }
});
