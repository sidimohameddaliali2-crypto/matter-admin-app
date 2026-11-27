import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import EditDriverModal from './EditDriverModal';
import { updateDriver } from '../../store/slices/driverSlice';
import api from '../../utils/api';

const mockDispatch = jest.fn();
const mockDriverState = { isLoading: false, drivers: [] };
jest.mock('react-redux', () => ({
  useDispatch: () => mockDispatch,
  useSelector: select => select({ driver: mockDriverState }),
}));
jest.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => children,
  motion: { div: ({ initial, animate, exit, ...props }) => <div {...props} /> },
}));
jest.mock('../../store/slices/driverSlice', () => ({ updateDriver: jest.fn() }));
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

global.IS_REACT_ACT_ENVIRONMENT = true;

test('an ordinary driver edit omits the loaded tracker and an explicit clear is submitted', async () => {
  api.get.mockResolvedValue({ data: { data: [{ vehicleNo: 'fixture-old-tracker' }] } });
  mockDispatch.mockReturnValue({ unwrap: async () => {} });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const driver = { _id: 'fixture-driver', email: 'fixture@example.invalid',
      profile: { firstName: 'Fixture', phone: '5550101', truckoomVehicleNo: 'fixture-old-tracker' } };
    await act(async () => root.render(<EditDriverModal driver={driver} onClose={jest.fn()} />));
    const phone = container.querySelector('input[name="phone"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(phone, '5550102');
      phone.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = container.querySelector('form');
    const submit = () => act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await submit();
    expect(updateDriver.mock.calls[0][0].driverData.phone).toBe('5550102');
    expect(updateDriver.mock.calls[0][0].driverData.profile).not.toHaveProperty('truckoomVehicleNo');

    const tracker = container.querySelector('select[name="truckoomVehicleNo"]');
    await act(async () => {
      tracker.value = '';
      tracker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await submit();
    expect(updateDriver.mock.calls[1][0].driverData.profile.truckoomVehicleNo).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
