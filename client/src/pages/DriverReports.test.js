import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import DriverReports from './DriverReports';

jest.mock('react-redux', () => ({
  useSelector: select => select({ auth: { user: { _id: 'staff-fixture' } } }),
}));

jest.mock('../utils/driverAuditWorker.mjs', () => ({
  canOpenDriverAudits: async () => true,
  DRIVER_AUDIT_CLIENT: 'reporting-v1',
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

test('a changed Matter sign-in cannot reconnect an open report under a different account', async () => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ url: '/api/reporting/view?screen=reports&view=1&tab=mirror' }),
  });
  localStorage.setItem('token', 'fixture.staff-a');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DriverReports />));
    const frame = container.querySelector('iframe');
    expect(frame.getAttribute('src')).toContain('staffFrame=1');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture.staff-a');

    // Simulate a valid frame document and an expiry signal from that document.
    Object.defineProperty(frame, 'contentDocument', { value: document.implementation.createHTMLDocument() });

    const meta = frame.contentDocument.createElement('meta');
    meta.name = 'matter-driver-reports';
    frame.contentDocument.head.appendChild(meta);
    await act(async () => frame.dispatchEvent(new Event('load')));
    await act(async () => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: window.location.origin,
      data: 'matter-audit-session-expired',
    })));
    expect(container.querySelector('button').textContent).toBe('Reconnect');

    // Even if the storage event has not arrived yet, the current token is checked.
    localStorage.setItem('token', 'fixture.staff-b');
    await act(async () => container.querySelector('button').click());
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('button').textContent).toBe('Reload Matter');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    global.fetch = originalFetch;
  }
});
