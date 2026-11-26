import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { destroyMapSuppressingSdkNoise, loadMapglOnce } from '../../utils/mapgl';
import ShopifyShippingMap from './ShopifyShippingMap';

jest.mock('../../utils/mapgl', () => ({
  MAPGL_API_KEY: 'fixture-key',
  destroyMapSuppressingSdkNoise: jest.fn(),
  loadMapglOnce: jest.fn(),
}));
global.IS_REACT_ACT_ENVIRONMENT = true;

const address = { latitude: '25.2', longitude: 55.27 };
let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
  jest.clearAllMocks();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
});

test('centers the map and places the marker at the Shopify coordinates', async () => {
  const events = {};
  const map = { on: (name, handler) => { events[name] = handler; } };
  const marker = { destroy: jest.fn() };
  const sdk = { Map: jest.fn(() => map), Marker: jest.fn(() => marker) };
  loadMapglOnce.mockResolvedValue(sdk);

  await act(async () => root.render(<ShopifyShippingMap address={address} />));
  expect(sdk.Map).toHaveBeenCalledWith(container.querySelector('[role="region"]'), expect.objectContaining({ center: [55.27, 25.2] }));
  expect(sdk.Marker).toHaveBeenCalledWith(map, { coordinates: [55.27, 25.2] });
  expect(new URL(container.querySelector('a').href).searchParams.get('query')).toBe('25.2,55.27');
  await act(async () => events.styleload());
  expect(container.querySelector('[role="status"]')).toBeNull();

  await act(async () => root.unmount());
  root = null;
  expect(marker.destroy).toHaveBeenCalledTimes(1);
  expect(destroyMapSuppressingSdkNoise).toHaveBeenCalledWith(map);
});

test('missing Shopify coordinates do not initialize a map or create a pin', async () => {
  await act(async () => root.render(<ShopifyShippingMap address={{ latitude: null, longitude: 55.27 }} />));
  expect(loadMapglOnce).not.toHaveBeenCalled();
  expect(container.querySelector('a')).toBeNull();
  expect(container.textContent).toContain('Shopify has no map pin');
});

test('the external pin is still available if the map cannot load', async () => {
  loadMapglOnce.mockRejectedValue(new Error('SDK unavailable'));
  await act(async () => root.render(<ShopifyShippingMap address={address} />));
  expect(container.textContent).toContain('Map preview unavailable.');
  expect(container.querySelector('a')).not.toBeNull();
});
