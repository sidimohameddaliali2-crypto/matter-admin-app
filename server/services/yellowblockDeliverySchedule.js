import { isDateKey } from '../utils/businessDate.js';

export const deliveryOrdersQuery = `
  query YellowblockDeliveryOrders($after: String) {
    orders(first: 100, after: $after, sortKey: ID, query: "status:open OR fulfillment_status:unfulfilled OR fulfillment_status:partial OR fulfillment_status:scheduled") {
      pageInfo { hasNextPage endCursor }
      nodes {
        legacyResourceId
        name
        cancelledAt
        test
        displayFulfillmentStatus
        shippingAddress { name address1 address2 city }
        customAttributes { key value }
        deliveryDate: metafield(namespace: "custom", key: "delivery_date-b82a") { value }
      }
    }
  }
`;

const pendingFulfillmentStatuses = new Set([
  'UNFULFILLED', 'PARTIALLY_FULFILLED', 'SCHEDULED', 'ON_HOLD',
  'IN_PROGRESS', 'OPEN', 'PENDING_FULFILLMENT', 'REQUEST_DECLINED',
]);

function readDeliveryDate(value, format) {
  const date = String(value ?? '').trim();
  if (isDateKey(date)) return date;

  const yearFirst = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(date);
  const dayOrMonthFirst = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  if (!yearFirst && !dayOrMonthFirst) return null;

  const monthFirst = String(format ?? '').trim().toLowerCase().startsWith('m');
  const dateKey = yearFirst
    ? yearFirst.slice(1).join('-')
    : `${dayOrMonthFirst[3]}-${dayOrMonthFirst[monthFirst ? 1 : 2]}-${dayOrMonthFirst[monthFirst ? 2 : 1]}`;
  return isDateKey(dateKey) ? dateKey : null;
}

export function toScheduledDelivery(order, today) {
  if (order.cancelledAt || order.test || !pendingFulfillmentStatuses.has(order.displayFulfillmentStatus)) return null;

  const attributes = new Map(order.customAttributes.map(({ key, value }) => [key.trim().toLowerCase(), value]));
  const checkoutMethod = attributes.get('checkout-method') || attributes.get('order type') || '';
  if (/pick[\s-]*up/i.test(checkoutMethod)) return null;

  // Prefer the store's typed order metafield. Older orders also carry checkout attributes.
  const date = readDeliveryDate(order.deliveryDate?.value)
    || readDeliveryDate(attributes.get('delivery_date'))
    || readDeliveryDate(attributes.get('delivery-date'))
    || readDeliveryDate(attributes.get('delivery date'), attributes.get('date format'));
  if (!date || date < today) return null;

  return {
    id: order.legacyResourceId,
    name: order.name,
    date,
    customerName: order.shippingAddress?.name || '',
    address: [order.shippingAddress?.address1, order.shippingAddress?.address2, order.shippingAddress?.city]
      .filter(Boolean).join(', '),
  };
}
