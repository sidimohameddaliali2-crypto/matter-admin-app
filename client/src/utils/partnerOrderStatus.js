export const partnerAdminOrderStatus = (order) => {
  if (order.status === 'cancelled') return 'cancelled';
  if (order.invoiced) return 'invoiced';
  if (order.status === 'locked') return 'locked';
  return order.acknowledgedAt ? 'acked' : 'new';
};

export const canInvoicePartnerOrder = (order) =>
  ['submitted', 'locked'].includes(order.status) && !order.invoiced;
