import test from 'node:test';
import assert from 'node:assert/strict';
import { removeClientMatterRevenue } from '../middleware/matterRevenueInput.js';
import Delivery from '../models/Delivery.js';

test('ordinary delivery queries do not expose pricing captures to driver-facing views', () => {
  assert.equal(Delivery.schema.path('matterRevenue').options.select, false);
});

test('ordinary full-record edits preserve server-owned financial captures while other fields remain editable', () => {
  const body = { customerName: 'Updated', scheduledTime: '2026-10-23T02:00:00Z', matterRevenue: { unitAmount: 1 }, deliveries: [{ customerId: 'CUST-1', matterRevenue: null }] };
  removeClientMatterRevenue(body);
  assert.deepEqual(body, { customerName: 'Updated', scheduledTime: '2026-10-23T02:00:00Z', deliveries: [{ customerId: 'CUST-1' }] });
});
test('operators and dotted paths cannot overwrite, clear or rename into a financial capture', () => {
  const body = { $set: { 'matterRevenue.unitAmount': 1, customerName: 'Updated' }, $unset: { matterRevenue: 1 }, $rename: { other: 'matterRevenue', 'matterRevenue.plan': 'name', phone: 'oldPhone' } };
  removeClientMatterRevenue(body);
  assert.deepEqual(body, { $set: { customerName: 'Updated' }, $unset: {}, $rename: { phone: 'oldPhone' } });
});
