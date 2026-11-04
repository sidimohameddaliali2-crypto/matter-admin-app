import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import PartnerPortal from './PartnerPortal';
import api from '../utils/partnerApi';
jest.mock('react-redux', () => ({
  useSelector: fn => fn({
    partnerAuth: {
      partner: {
        _id: 'partner',
        businessName: 'Fixture'
      }
    }
  }),
  useDispatch: () => jest.fn()
}));
jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn()
}), {
  virtual: true
});
jest.mock('../utils/partnerApi', () => ({
  __esModule: true,
  default: {
    get: jest.fn()
  }
}));
jest.mock('../components/PartnerDailyOrderPlanner', () => () => <div>Daily planner fixture</div>);
jest.mock('jspdf', () => jest.fn());
jest.mock('qrcode.react', () => ({
  QRCodeCanvas: () => null
}));
global.IS_REACT_ACT_ENVIRONMENT = true;
test.each([true, false])('new orders use the daily planner on desktop=%s', async desktop => {
  window.matchMedia = () => ({
    matches: desktop,
    addEventListener: () => {},
    removeEventListener: () => {}
  });
  api.get.mockResolvedValue({
    data: {
      success: true,
      data: []
    }
  });
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(<PartnerPortal />));
  expect(el.textContent).toContain('Daily planner fixture');
  expect(el.textContent).not.toContain('checkout appears here');
  expect(api.get.mock.calls.some(([p]) => p.includes('/partner/menu'))).toBe(false);
  await act(async () => root.unmount());
  el.remove();
});
