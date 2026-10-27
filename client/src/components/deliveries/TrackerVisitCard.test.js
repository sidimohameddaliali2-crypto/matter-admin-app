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
test('sampled vehicle visits are explicitly labelled estimated',async()=>{
 await act(async()=>root.render(<TrackerVisitCard delivery={{_id:'d2',trackerVisit:{evidenceSource:'truckoom_gps_samples',status:'gps_visit_observed'}}}/>));
 expect(container.textContent).toContain('Photo time matches sampled GPS visit (estimated)');
 expect(container.textContent).toContain('Truckoom returned no matching alert for this customer and vehicle');
});

test('an assigned stop with no photo waits for proof rather than showing an old outage verdict',async()=>{
 await act(async()=>root.render(<TrackerVisitCard delivery={{_id:'d3',status:'assigned',trackerVisit:{status:'tracker_error',errorCode:'ECONNABORTED'}}}/>));
 expect(container.textContent).toContain('Waiting for delivery photo');
 expect(container.textContent).not.toContain('Truckoom unavailable');
 expect(container.textContent).toContain('ECONNABORTED');
});
test('completed delivery with an alert API failure still reports unverified',async()=>{
 await act(async()=>root.render(<TrackerVisitCard delivery={{_id:'d4',status:'delivered',proof:{photoUrl:'https://example.test/photo.jpg'},trackerVisit:{status:'tracker_error'}}}/>));
 expect(container.textContent).toContain('Unverified: Truckoom unavailable');
});

test('saved Afshan photo without a shutter time shows receipt separately and does not imply a missing image',async()=>{
 await act(async()=>root.render(<TrackerVisitCard delivery={{_id:'afshan',status:'delivered',
   proof:{images:['https://example.test/photo.jpg'],receivedAt:'2026-10-26T21:33:16Z',photoSource:'unknown'},
   trackerVisit:{status:'missing_photo_time',evidenceSource:'truckoom_gps_samples',arrivedAt:'2026-10-26T21:26:14Z',departedAt:'2026-10-26T21:40:44Z'}}}/>));
 expect(container.textContent).toContain('Photo saved · capture time not sent by driver app');
 expect(container.textContent).toContain('Camera capture time: Not sent by driver app');
 expect(container.textContent).toContain('Photo received by server: 2026-10-27 01:33:16');
 expect(container.textContent).toContain('Server receipt time cannot establish when the camera took it');
 expect(container.textContent).not.toContain('Photo within tracker visit');
});
test('an unavailable alert check is distinct from a successful check returning no matching alerts',async()=>{
 await act(async()=>root.render(<TrackerVisitCard delivery={{_id:'gps',trackerVisit:{status:'tracker_error',evidenceSource:'truckoom_gps_samples',errorCode:'HTTP_503'}}}/>));
 expect(container.textContent).toContain('Truckoom alert verification could not be completed');
 expect(container.textContent).not.toContain('Truckoom returned no matching alert');
});
