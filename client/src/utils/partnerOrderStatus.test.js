import { partnerAdminOrderStatus, canInvoicePartnerOrder } from './partnerOrderStatus';

test('cancelled orders stay out of New and Acknowledged and cannot be invoiced', () => {
  for (const acknowledgedAt of [null, '2026-01-01']) {
    const order = { status: 'cancelled', acknowledgedAt };
    expect(partnerAdminOrderStatus(order)).toBe('cancelled');
    expect(canInvoicePartnerOrder(order)).toBe(false);
  }
});

test('legacy locked orders await invoicing until both invoices are complete', () => {
  const order = { status: 'locked', invoiced: false };
  expect(partnerAdminOrderStatus(order)).toBe('locked');
  expect(canInvoicePartnerOrder(order)).toBe(true);
  order.invoiced = true;
  expect(partnerAdminOrderStatus(order)).toBe('invoiced');
  expect(canInvoicePartnerOrder(order)).toBe(false);
});

test('historical acknowledgement does not gate kitchen production', () => {
  expect(partnerAdminOrderStatus({ status: 'submitted' })).toBe('new');
  expect(partnerAdminOrderStatus({ status: 'submitted', acknowledgedAt: '2026-01-01' })).toBe('new');
  expect(canInvoicePartnerOrder({ status: 'submitted' })).toBe(true);
  expect(canInvoicePartnerOrder({ status: 'draft' })).toBe(false);
});
