import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Deliveries from './Deliveries';
import api from '../utils/api';
import { installActivityCapture } from '../utils/activityCapture';
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('react-redux', () => ({ useSelector: fn => fn({ auth: { user: { role: 'viewer' } } }) }));
jest.mock('react-router-dom', () => ({ Link: ({ children, to }) => <a href={to}>{children}</a>, useSearchParams: () => [new URLSearchParams()] }), { virtual: true });
jest.mock('../contexts/SocketContext', () => ({ useSocket: () => ({ socket: null }) }));
jest.mock('../components/deliveries/PrintConfigModal', () => () => null);
jest.mock('../components/deliveries/DeliveryDetailModal', () => () => null);
global.IS_REACT_ACT_ENVIRONMENT = true;
test('Clear All records each changed filter while retaining the delivery date', async () => {
  api.get.mockResolvedValue({ data: { success: true, data: { deliveries: [] } } });
  localStorage.setItem('token', 'fixture-session'); window.history.replaceState({}, '', '/deliveries');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {}), previousFetch = window.fetch;
  const capture = jest.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) }); window.fetch = capture;
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  let cleanup;
  try {
    await act(async () => root.render(<Deliveries />));
    const status = [...container.querySelectorAll('select')].find(select => [...select.options].some(option => option.value === 'pending'));
    await act(async () => { status.value = 'pending'; status.dispatchEvent(new Event('change', { bubbles: true })); });
    const date = container.querySelector('input[type="date"]').value;
    cleanup = installActivityCapture();
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Clear All').click());
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    const events = capture.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events);
    expect(events.map(event => event.changes[0])).toEqual([{ field: 'Status filter', before: 'Pending', after: 'All', redacted: false }]);
    expect(status.value).toBe('all'); expect(container.querySelector('input[type="date"]').value).toBe(date);
    expect(events[0].stage).toBe('form_edited');
  } finally { cleanup?.(); await act(async () => root.unmount()); container.remove(); localStorage.clear(); window.fetch = previousFetch; warn.mockRestore(); }
});
test('bulk delivery selection retains the individual delivery references before saving', async () => {
  const deliveries = [{ _id: 'delivery-one', customerName: 'Fixture One', status: 'pending', type: 'Delivery' }, { _id: 'delivery-two', customerName: 'Fixture Two', status: 'pending', type: 'Delivery' }];
  api.get.mockResolvedValue({ data: { success: true, data: { deliveries } } });
  localStorage.setItem('token', 'fixture-session'); window.history.replaceState({}, '', '/deliveries');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {}), previousFetch = window.fetch;
  const capture = jest.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) }); window.fetch = capture;
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  let cleanup;
  try {
    await act(async () => root.render(<Deliveries />)); cleanup = installActivityCapture();
    const checkbox = container.querySelector('thead input[type="checkbox"]'); expect(checkbox).toBeTruthy();
    await act(async () => checkbox.click()); await act(async () => window.dispatchEvent(new Event('pagehide')));
    const selection = capture.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events).find(event => event.form.field === 'Selected delivery records');
    expect(selection).toBeTruthy(); expect(selection.changes[0].before).toBe('');
    expect(selection.changes[0].after).toContain('delivery-one'); expect(selection.changes[0].after).toContain('delivery-two');
    expect(selection.changes[0].after).toContain('Fixture One'); expect(selection.stage).toBe('form_edited');
  } finally { cleanup?.(); await act(async () => root.unmount()); container.remove(); localStorage.clear(); window.fetch = previousFetch; warn.mockRestore(); }
});
