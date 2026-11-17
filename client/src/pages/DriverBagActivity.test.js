import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import DriverMobile from './DriverMobile';
import BagOperations from './BagOperations';
import { recordActivityChange } from '../utils/activityCapture';
import api from '../utils/api';

jest.mock('../utils/activityCapture', () => ({ recordActivityChange: jest.fn() }));
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn() } }));
let mockState;
const mockDispatch = jest.fn(() => ({ unwrap: async () => ({}) }));
jest.mock('react-redux', () => ({ useDispatch: () => mockDispatch, useSelector: fn => fn(mockState) }));
jest.mock('react-router-dom', () => { const React = require('react'); return { useNavigate: () => jest.fn(), useSearchParams: () => { const [params, set] = React.useState(new URLSearchParams()); return [params, value => set(new URLSearchParams(value))]; } }; }, { virtual: true });
jest.mock('../utils/offlineSync', () => ({ setupAutoSync: jest.fn(), setupAutoRetry: jest.fn(), onSyncStatusChange: () => () => {}, syncOfflineData: async () => ({ success: true }), retryDeliverySync: jest.fn() }));
jest.mock('../utils/offlineStorage', () => ({ getPendingCount: async () => ({ total: 0 }), storePhotoOffline: jest.fn(), queueDeliveryUpdate: jest.fn() }));
jest.mock('../hooks/useSyncStatus', () => ({ useSyncStatus: () => ({ syncStatus: {}, isSyncing: false }), getSyncStatusIndicator: () => ({}) }));
jest.mock('../components/driver/BagHandoverPanel', () => () => null);
jest.mock('../components/driver/HandoffCard', () => () => null);
jest.mock('../components/driver/DriverSyncSummary', () => () => null);
jest.mock('qrcode.react', () => ({ QRCodeCanvas: () => null }));
jest.mock('../components/bags/bagQrLabels', () => ({ downloadBulkQrPdf: jest.fn() }));
let mockScan;
jest.mock('../components/SimpleQrScanner', () => props => { mockScan = props.onScan; return <button type="button" onClick={() => props.onScan([{ rawValue: 'BAG-00002' }])}>Fixture scan</button>; });

let host, root, mockData;
const changes = () => recordActivityChange.mock.calls.map(([change]) => change);
const render = node => act(async () => root.render(node));
const click = label => act(async () => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === label || node.getAttribute('aria-label') === label || node.title === label).click());
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks(); localStorage.clear();
  mockState = { auth: { user: { _id: 'driver', role: 'driver', profile: { firstName: 'Fixture', lastName: 'Driver' } } }, driverMobile: { deliveries: [], handoffs: [], currentDelivery: { _id: 'delivery', customerName: 'Fixture customer', type: 'Delivery', status: 'assigned' }, isLoading: false } };
  mockData = { generatedAt: '2026-11-17T09:00:00Z', summary: {}, canOperate: true, checks: [], reviewers: [], drivers: [], customers: [], stockCounts: [], bags: [{ _id: 'b1', bagId: 'BAG-00001', lifecycleState: 'ready', location: 'warehouse', reasons: [], custodyVersion: 1 }] };
  api.get.mockImplementation(async url => ({ data: { data: url === '/bag-operations' ? mockData : { ...mockData.bags[0], history: [] } } }));
  global.fetch = jest.fn(async () => ({ ok: true }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [], getVideoTracks: () => [] })) } });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); jest.restoreAllMocks(); });

test('warehouse scans and count-chip removals record unsaved lists and dependent confirmation reset', async () => {
  await render(<BagOperations warehouse/>);
  expect(changes()).toEqual([]);
  await click('Count the bags on the shelfStart a physical stock check'); await click('Start camera'); await click('Fixture scan');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Physical count tags', before: [], after: ['BAG-00002'] }));
  act(() => host.querySelector('input[type="checkbox"]').click());
  await click('Remove BAG-00002 from count');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Physical count tags', before: ['BAG-00002'], after: [] }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Physical count confirmed', before: true, after: false }));
  expect(api.post).not.toHaveBeenCalled();
});

test('warehouse reason buttons report the condition before the physical action is confirmed', async () => {
  await render(<BagOperations warehouse/>); await click('Scan a bag'); await click('Start camera');
  act(() => mockScan([{ rawValue: 'BAG-00001' }]));
  await act(async () => {}); await click('Report damage'); await click('Zip damaged');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Bag condition reason', before: '', after: 'Zip damaged' }));
  expect(api.post).not.toHaveBeenCalled();
});

test('driver manual bag entry and remove retain changes before delivery completion', async () => {
  window.prompt = jest.fn(() => 'BAG-00002');
  await render(<DriverMobile/>); expect(changes()).toEqual([]); await click('Complete Delivery'); await click('Enter Bag ID Manually');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Delivery bag tags', before: [], after: ['BAG-00002'] }));
  await click('Remove this bag');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Delivery bag tags', before: ['BAG-00002'], after: [] }));
  expect(api.post).not.toHaveBeenCalled();
});

test('standalone return scan and removal report tags without submitting a return', async () => {
  mockState.driverMobile.currentDelivery = null;
  await render(<DriverMobile/>); await click('Return Bags'); await click('Fixture scan');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Returning bag tags', before: [], after: ['BAG-00002'] }));
  const remove = [...host.querySelectorAll('button')].find(node => node.className.includes('text-red-500'));
  act(() => remove.click());
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Returning bag tags', before: ['BAG-00002'], after: [] }));
  expect(api.post).not.toHaveBeenCalled();
});

test('driver camera capture and retake record only image counts and retain an unsaved return choice', async () => {
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: jest.fn() });
  jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,PRIVATE_IMAGE');
  window.prompt = jest.fn(() => 'BAG-00002');
  await render(<DriverMobile/>); await click('Complete Delivery'); await click('Enter Bag ID Manually');
  await click('Continue to Photo (1 bags)'); await click('Capture');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Delivery image count', before: 0, after: 1 }));
  await click('Retake');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Delivery image count', before: 1, after: 0 }));
  await click('Capture'); await click('Continue to Next Step'); await click('Scan Other Bags to Return');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Return bags decision', before: 'Not answered', after: 'Returning bags' }));
  expect(JSON.stringify(changes())).not.toContain('PRIVATE_IMAGE');
  expect(api.post).not.toHaveBeenCalled();
});

test('unrecognized scanner content is withheld from unsaved driver observations', async () => {
  mockState.driverMobile.currentDelivery = null;
  await render(<DriverMobile/>); await click('Return Bags');
  act(() => mockScan([{ rawValue: 'secret=sk-private-credential-fixture' }]));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Returning bag tags', before: [], after: ['Unrecognized bag tag'] }));
  expect(JSON.stringify(changes())).not.toContain('sk-private');
});

test('warehouse registration observes accepted and cleared scanned tags before registration', async () => {
  await render(<BagOperations warehouse/>); await click('Stock'); await click('Add bag'); await click('Start camera'); await click('Fixture scan');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Scanned registration tag', before: '', after: 'BAG-00002' }));
  act(() => mockScan([{ rawValue: 'invalid=secret-fixture' }]));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Scanned registration tag', before: 'BAG-00002', after: '' }));
  expect(JSON.stringify(changes())).not.toContain('secret-fixture');
  expect(api.post).not.toHaveBeenCalled();
});

test('a late image decode cannot attribute the old driver selection to a newly signed-in person', async () => {
  const pendingImage = { width: 10, height: 10 };
  jest.spyOn(window, 'Image').mockImplementation(() => pendingImage);
  URL.createObjectURL = jest.fn(() => 'blob:private-image-fixture'); URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: jest.fn() });
  jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,PRIVATE_IMAGE');
  localStorage.setItem('token', 'old-driver');
  await render(<DriverMobile/>);
  const input = host.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [new File(['fixture'], 'private-file-name.jpg', { type: 'image/jpeg' })] });
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  localStorage.setItem('token', 'new-driver');
  act(() => pendingImage.onload());
  expect(changes()).toEqual([]);
});

test('driver dashboard alphabet, search clear, view and history period choices retain before and after', async () => {
  mockState.driverMobile.currentDelivery = null;
  api.get.mockResolvedValue({ data: { data: [] } });
  await render(<DriverMobile/>); await click('Filter'); await click('B'); await click('Clear');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Customer initial filter', before: '', after: 'B' }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Customer initial filter', before: 'B', after: '' }));
  const search = host.querySelector('input[placeholder="Search by customer name..."]');
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'PRIVATE-SEARCH'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Clear');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Driver search', before: 'PRIVATE-SEARCH', after: '', private: true }));
  await click('History'); await click('Last 7 Days');
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'Driver view', before: 'Deliveries', after: 'History' }));
  expect(changes()).toContainEqual(expect.objectContaining({ field: 'History period', before: 'Today', after: 'Last 7 days' }));
  expect(api.post).not.toHaveBeenCalled();
});
