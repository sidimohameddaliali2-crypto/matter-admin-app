import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import LiveTracking from './LiveTracking';

jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn() } }));
const mockMap = { panTo: jest.fn(), setZoom: jest.fn(), fitBounds: jest.fn() };
let mockMapsLoaded = true;
jest.mock('@react-google-maps/api', () => {
  process.env.REACT_APP_GOOGLE_MAPS_API_KEY = 'fixture-key';
  const React = require('react');
  const OverlayView = ({ children }) => <div>{children}</div>;
  OverlayView.OVERLAY_MOUSE_TARGET = 'overlayMouseTarget';
  return {
    useLoadScript: () => ({ isLoaded: mockMapsLoaded }),
    GoogleMap: ({ children, onLoad }) => {
      React.useEffect(() => { onLoad(mockMap); }, [onLoad]);
      return <div>{children}</div>;
    },
    OverlayView,
    InfoWindow: ({ children, onCloseClick }) => <div data-testid="driver-popup">
      <button onClick={onCloseClick}>Close popup</button>{children}
    </div>,
    Polyline: () => <div data-testid="route-line" />,
    Circle: ({ radius }) => <div data-testid="customer-radius">{radius}</div>,
  };
});

global.IS_REACT_ACT_ENVIRONMENT = true;
const fleet = ['D1', 'D2'].map((id, i) => ({
  vehicleNo: `V${i + 1}`, latitude: 25.2 + i / 10, longitude: 55.3,
  gpsTime: '2026-10-23T06:58:09.000Z', speedKph: 0, ignition: 'OFF', trackerStatus: 'STOP',
  driver: { id, name: `Driver ${id}` },
}));
const stop = (id, lat) => ({ _id: id, customerName: `Customer ${id}`, type: 'Delivery',
  scheduledTime: '2026-10-13T02:00:00Z', gpsLocation: { lat, lng: 54.4 } });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
let root;
let container;
let requests;
const click = async (label) => {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent.includes(label));
  expect(button).toBeDefined();
  await act(async () => { button.click(); });
};
const resolveRoute = async (request, stops) => {
  await act(async () => { request.resolve({ data: { data: { deliveries: stops } } }); });
};

beforeEach(() => {
  mockMapsLoaded = true;
  Object.values(mockMap).forEach((fn) => fn.mockClear());
  window.google = { maps: {
    LatLngBounds: class { constructor() { this.points = []; } extend(p) { this.points.push(p); } },
    SymbolPath: { FORWARD_CLOSED_ARROW: 1 },
  } };
  requests = [];
  api.get.mockReset();
  api.get.mockImplementation((url, options) => {
    if (url === '/truckoom/vehicles') return Promise.resolve({ data: { data: fleet, appOnlyDrivers: [], fetchedAt: new Date().toISOString() } });
    if (url === '/users/drivers') return Promise.resolve({ data: [] });
    if (url === '/deliveries') {
      const request = { ...deferred(), driver: options.params.driver };
      requests.push(request);
      return request.promise;
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
const mount = async () => { await act(async () => { root.render(<LiveTracking />); }); };

test('frames the driver and distant stops after the route arrives, and does not reframe on refresh', async () => {
  await mount();
  await click('Driver D1');
  expect(mockMap.fitBounds).not.toHaveBeenCalled();
  await resolveRoute(requests[0], [stop('S1', 24.5)]);
  expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
  expect(mockMap.fitBounds.mock.calls[0][0].points).toEqual(expect.arrayContaining([
    { lat: 24.5, lng: 54.4 }, { lat: 25.2, lng: 55.3 },
  ]));
  await click('Refresh');
  await resolveRoute(requests[1], [stop('S1', 24.5)]);
  expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
});

test('closing the location popup preserves the selected driver and route through refresh', async () => {
  await mount();
  await click('Driver D1');
  await resolveRoute(requests[0], [stop('S1', 24.5), stop('S2', 24.6)]);
  expect(container.querySelector('[data-testid="driver-popup"]')).not.toBeNull();
  await click('Close popup');
  expect(container.querySelector('[data-testid="driver-popup"]')).toBeNull();
  expect(container.querySelector('[data-testid="driver-route-panel"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="route-line"]')).not.toBeNull();
  expect(container.textContent).toContain('Customer S1');
  await click('Refresh');
  await resolveRoute(requests[1], [stop('S1', 24.5), stop('S2', 24.6)]);
  expect(container.querySelector('[data-testid="driver-popup"]')).toBeNull();
  expect(container.querySelector('[data-testid="route-line"]')).not.toBeNull();
  await click('Driver D1');
  expect(container.querySelector('[data-testid="driver-popup"]')).not.toBeNull();
});

test('tracker popup shows the new GPS timestamp, speed and ignition', async () => {
  await mount();
  await click('Driver D1');
  const popup = container.querySelector('[data-testid="driver-popup"]');
  expect(popup.textContent).toContain('GPS report: 10:58 Dubai');
  expect(popup.textContent).toContain('0 km/h');
  expect(popup.textContent).toContain('STOP');
  expect(popup.textContent).toContain('Ignition OFF');
});

test('switching drivers hides the old route and waits for the new route before framing', async () => {
  await mount();
  await click('Driver D1');
  await resolveRoute(requests[0], [stop('S1', 24.5)]);
  await click('Driver D2');
  expect(container.textContent).not.toContain('Customer S1');
  expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
  await resolveRoute(requests[1], [stop('S2', 24.6)]);
  expect(mockMap.fitBounds).toHaveBeenCalledTimes(2);
  expect(mockMap.fitBounds.mock.calls[1][0].points).not.toContainEqual({ lat: 24.5, lng: 54.4 });
});

test('selecting a customer shows the 50 m fence and three-time verification', async () => {
  await mount();
  await click('Driver D1');
  await resolveRoute(requests[0], [{ ...stop('S1', 24.5),
    proof: { photoCapturedAt: '2026-10-13T02:11:00Z' },
    trackerVisit: { arrivedAt: '2026-10-13T02:00:00Z', departedAt: '2026-10-13T02:10:00Z',
      status: 'outside_window', needsReview: true, radiusMetres: 50 } }]);
  await click('Customer S1');
  expect(container.querySelector('[data-testid="customer-radius"]').textContent).toBe('50');
  expect(container.textContent).toContain('Review: photo outside tracker visit');
  for (const label of ['Tracker arrival:', 'Camera capture time:', 'Tracker departure:']) expect(container.textContent).toContain(label);
});

test('frames a loaded route when the map finishes loading later', async () => {
  mockMapsLoaded = false;
  await mount();
  await click('Driver D1');
  await resolveRoute(requests[0], [stop('S1', 24.5)]);
  expect(mockMap.fitBounds).not.toHaveBeenCalled();
  mockMapsLoaded = true;
  await mount();
  expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
});

test('shows the tracker outage warning while phone tracking remains available', async () => {
  api.get.mockImplementation((url) => Promise.resolve({ data: url === '/truckoom/vehicles' ? {
    data: [], trackerWarning: 'Tracker locations are unavailable. Showing driver phone locations.',
    appOnlyDrivers: [{ id: 'D1', name: 'Phone Driver', appLocation: { latitude: 25.2, longitude: 55.3 } }],
  } : [] }));
  await mount();
  expect(container.textContent).toContain('Tracker locations are unavailable');
  expect(container.textContent).toContain('Phone Driver');
});

test('keeps the selected driver through a tracker outage and recovery', async () => {
  await mount();
  await click('Driver D1');
  await resolveRoute(requests[0], [stop('S1', 24.5)]);
  const normalGet = api.get.getMockImplementation();
  api.get.mockImplementation((url, options) => url === '/truckoom/vehicles'
    ? Promise.resolve({ data: { data: [], trackerWarning: 'Tracker unavailable',
      appOnlyDrivers: [{ id: 'D1', name: 'Driver D1', appLocation: { latitude: 25.2, longitude: 55.3 } }],
      fetchedAt: '2026-10-13T03:00:00Z' } })
    : normalGet(url, options));
  await click('Refresh');
  expect(container.querySelector('[data-testid="driver-route-panel"]')).not.toBeNull();
  expect(container.textContent).toContain('Tracker unavailable');
  api.get.mockImplementation(normalGet);
  await click('Refresh');
  expect(container.querySelector('[data-testid="driver-route-panel"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Tracker unavailable');
});
