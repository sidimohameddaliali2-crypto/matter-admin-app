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
    get: jest.fn(),
    post: jest.fn()
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


test.each([false, true])('existing-order edits preserve original duplicate lines and block unloaded lines (missing=%s)', async missing => {
  window.matchMedia = () => ({matches: true, addEventListener() {}, removeEventListener() {}});
  const original = {_id: 'original', name: 'Chicken Quinoa', mealType: 'main', category: 'Chicken', price: 30};
  const canonical = {_id: 'canonical', name: 'CHICKEN QUINOA', mealType: 'main', category: 'Chicken', price: 28};
  const order = {_id: 'order', deliveryDate: '2099-01-05T00:00:00Z', deliveryTime: 'Morning · 5–6am', status: 'submitted', editable: true,
    lines: [{menuItem: original, quantity: 2, unitPrice: 30}, {menuItem: canonical, quantity: 1, unitPrice: 28}]};
  api.get.mockImplementation(async path => ({data: {success: true, data: path === '/partner/orders' ? [order] : missing ? [canonical] : [original, canonical]}}));
  api.post.mockReset();
  api.post.mockResolvedValue({data: {success: true, data: {_id: 'order'}}});
  const el = document.createElement('div'); document.body.appendChild(el); const root = createRoot(el);
  const click = async label => act(async () => {
    const button = [...el.querySelectorAll('button')].find(button => button.textContent.trim() === label);
    expect(button).toBeTruthy(); button.click();
  });
  try {
    await act(async () => root.render(<PartnerPortal />));
    await click('My Orders'); await click('Edit meals');
    expect(api.get).toHaveBeenCalledWith('/partner/menu?date=2099-01-05&orderId=order');
    if (!missing) {
      expect(el.textContent).toContain('AED 88');
      await act(async () => el.querySelector('[aria-label="Remove one"]').click());
      expect(el.textContent).toContain('AED 58');
      await act(async () => el.querySelector('[aria-label="Remove one"]').click());
    }
    await click('Place order · AED 28');
    if (missing) {
      expect(el.textContent).toContain('All ordered items must load before saving');
      expect(api.post).not.toHaveBeenCalled();
    } else {
      expect(api.post).toHaveBeenCalledWith('/partner/orders', expect.objectContaining({lines: [
        {menuItemId: 'canonical', quantity: 1}, {menuItemId: 'original', quantity: 0}
      ]}));
    }
  } finally {await act(async () => root.unmount()); el.remove();}
});
