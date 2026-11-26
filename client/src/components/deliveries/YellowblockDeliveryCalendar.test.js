import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../../utils/api';
import YellowblockDeliveryCalendar from './YellowblockDeliveryCalendar';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
global.IS_REACT_ACT_ENVIRONMENT = true;

test('daily counts open only that day’s orders, including after changing months', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onViewOrder = jest.fn();
  const orderList = () => container.querySelector('[aria-labelledby="yellowblock-delivery-orders"]');
  const button = (label) => container.querySelector(`button[aria-label="${label}"]`);
  api.get.mockResolvedValue({ data: { data: {
    today: '2026-11-29',
    deliveries: [
      { id: '1', name: '#101', date: '2026-11-30' },
      { id: '2', name: '#102', date: '2026-11-30' },
      { id: '3', name: '#103', date: '2026-12-01' },
    ],
  } } });

  try {
    await act(async () => root.render(<YellowblockDeliveryCalendar onViewOrder={onViewOrder} />));
    expect(button('Previous month').disabled).toBe(true);
    expect(button('Sunday, 29 November 2026, 0 deliveries').getAttribute('aria-pressed')).toBe('true');

    await act(async () => button('Sunday, 29 November 2026, 0 deliveries').click());
    expect(orderList().textContent).toContain('No deliveries scheduled for this date.');

    await act(async () => button('Monday, 30 November 2026, 2 deliveries').click());
    expect([...orderList().querySelectorAll('li')].map(row => row.textContent)).toEqual(['#101', '#102']);
    await act(async () => orderList().querySelector('button').click());
    expect(onViewOrder).toHaveBeenCalledWith('1');

    await act(async () => button('Next month').click());
    const refresh = [...container.querySelectorAll('button')].find(element => element.textContent.trim() === 'Refresh');
    await act(async () => refresh.click());
    expect(orderList().textContent).toContain('Select a date to view its orders.');
    await act(async () => button('Tuesday, 1 December 2026, 1 delivery').click());
    expect([...orderList().querySelectorAll('li')].map(row => row.textContent)).toEqual(['#103']);
  } finally {
    await act(async () => root.unmount());
  }
});
