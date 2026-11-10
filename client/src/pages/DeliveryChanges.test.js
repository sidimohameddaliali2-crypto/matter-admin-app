import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import DeliveryChanges from './DeliveryChanges';
import api from '../utils/api';

jest.mock('react-redux', () => ({
  useDispatch: () => jest.fn(),
  useSelector: fn => fn({ deliveryChange: { isLoading: false, error: null, changes: [{
    _id: 'fixture-change', customerId: 'fixture-customer', customerName: 'Fixture Customer',
    scheduledDate: '2099-01-01', createdAt: '2098-12-01', status: 'pending', changes: { notes: 'Fixture note' },
  }] } }),
}));
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }), { virtual: true });
jest.mock('../utils/api', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => children,
  motion: { div: ({ children }) => <div>{children}</div>, aside: ({ children }) => <aside>{children}</aside> },
}));
global.IS_REACT_ACT_ENVIRONMENT = true;

test.each([true, false])('dispatcher applies through the operational API without an admin diagnostic request; success=%s', async success => {
  jest.clearAllMocks();
  const alert = jest.spyOn(window, 'alert').mockImplementation(() => {});
  if (success) api.post.mockResolvedValueOnce({ data: { success: true } });
  else api.post.mockRejectedValueOnce({ response: { status: 404, data: { message: 'No delivery found for this date' } } });
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DeliveryChanges />));
    await act(async () => container.querySelector('.cursor-pointer.group').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const apply = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === 'Apply');
    expect(apply).toBeTruthy();
    await act(async () => apply.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(api.post).toHaveBeenCalledWith('/delivery-changes/fixture-change/apply');
    expect(api.get).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(success ? 'Changes applied successfully!' : 'Failed to apply changes: No delivery found for this date');
  } finally {
    await act(async () => root.unmount()); container.remove(); alert.mockRestore(); error.mockRestore();
  }
});
