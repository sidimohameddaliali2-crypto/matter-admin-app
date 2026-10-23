import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import TrackerVisitCard, { trackerTime } from './TrackerVisitCard';
import api from '../../utils/api';
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let container, root;
beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: {} });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test('shows all three times and flags an outside-window photo', async () => {
  await act(async () => root.render(<TrackerVisitCard delivery={{ _id: 'd1',
    proof: { photoCapturedAt: '2026-10-22T04:11:00Z' },
    trackerVisit: { radiusMetres: 50, arrivedAt: '2026-10-22T04:00:00Z',
      departedAt: '2026-10-22T04:10:00Z', status: 'outside_window', needsReview: true },
  }} />));
  expect(container.textContent).toContain('Customer radius: 50 m');
  expect(container.textContent).toContain('Review: photo outside tracker visit');
  for (const time of ['08:00:00', '08:11:00', '08:10:00']) expect(container.textContent).toContain(time);
});

test('refreshes the verdict from the server and handles missing departure', async () => {
  api.get.mockResolvedValue({ data: { data: { delivery: { trackerVisit: { status: 'pending_exit' } } } } });
  await act(async () => root.render(<TrackerVisitCard delivery={{ _id: 'd1' }} />));
  expect(container.textContent).toContain('Waiting for tracker departure');
  expect(container.textContent).toContain('Tracker departure: Not recorded');
  expect(trackerTime('bad')).toBe('Not recorded');
});
