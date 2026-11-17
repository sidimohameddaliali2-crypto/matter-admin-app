import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installActivityCapture } from '../utils/activityCapture';
import IngredientTagEditor from './IngredientTagEditor';
import WeeklyCycleBoard from '../pages/adminMealSelectionV2/WeeklyCycleBoard';
import LocationPinPicker from './LocationPinPicker';
jest.mock('react-router-dom', () => ({ Link: ({ children }) => <span>{children}</span> }), { virtual: true });
let mockPick;
jest.mock('react-leaflet', () => ({ MapContainer: ({ children }) => <div>{children}</div>, Marker: () => null, TileLayer: () => null, useMapEvents: events => { mockPick = events.click; } }));
let host, root, cleanup, fetchMock;
const sent = () => fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events);
const render = node => act(async () => root.render(node));
const deliver = async () => { await act(async () => { jest.advanceTimersByTime(2000); for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true; jest.useFakeTimers();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
  localStorage.clear(); localStorage.setItem('token', 'fixture-staff'); window.history.replaceState({}, '', '/menus');
  fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) }); window.fetch = fetchMock;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); cleanup = installActivityCapture();
});
afterEach(() => { act(() => root.unmount()); cleanup(); host.remove(); jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

test('a custom ingredient choice reaches the private capture endpoint even when the editor is abandoned', async () => {
  function Editor() { const [tags, setTags] = useState([{ name: 'Rice', visible: true }]); return <IngredientTagEditor activityLabel="Monday main ingredients" value={tags} onChange={setTags}/>; }
  await render(<Editor/>); await deliver(); expect(sent()).toEqual([]);
  act(() => [...host.querySelectorAll('button')].find(node => node.textContent === 'Rice').click());
  await render(null); await deliver();
  expect(sent()).toEqual([expect.objectContaining({ stage: 'form_edited', changes: [{ field: 'Monday main ingredients', before: 'Rice (shown to customer)', after: 'Rice (backend only)', redacted: false }] })]);
  expect(fetchMock.mock.calls[0][0]).toContain('/traceability/capture'); expect(sent()[0]).not.toHaveProperty('actor');
});

test('the cycle Core checkbox uses native capture once, without a duplicate board observation', async () => {
  await render(<WeeklyCycleBoard initialBoards={{}} meals={[{ id: 'meal', name: 'Rice bowl', day: 'DAY 1', mealKind: 'Main meal', components: [] }]}/>);
  act(() => host.querySelector('.av2-core-label input').click()); await deliver();
  expect(sent().filter(event => event.stage === 'form_edited')).toHaveLength(1);
  expect(sent()[0].changes[0].after).toBe('Selected');
});

test('a map pick records an unsaved pin once through the real queue', async () => {
  await render(<LocationPinPicker onChange={jest.fn()}/>);
  act(() => mockPick({ latlng: { lat: 25.1, lng: 55.2 } })); await deliver();
  expect(sent()).toHaveLength(1); expect(sent()[0].changes[0]).toMatchObject({ before: 'Not set', after: '25.100000, 55.200000' });
});

test('public token pages still reject custom captures even with a cached staff session', async () => {
  window.history.replaceState({}, '', '/menu-select/fixture-token');
  await render(<LocationPinPicker onChange={jest.fn()}/>); act(() => mockPick({ latlng: { lat: 25.1, lng: 55.2 } })); await deliver();
  expect(sent()).toEqual([]);
});
