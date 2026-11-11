// Issue #12: creating a delivery change for a date must use the same Dubai
// business day as applying one. UTC-midnight bounds missed 03:00 Dubai and
// selected the next morning instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import DeliveryChange from '../models/DeliveryChange.js';
import { createChangesForDateRange } from './deliveryChanges.js';

process.env.LOCAL_TIMEZONE_OFFSET_MINUTES = '240';

const TUE_EARLY = new Date('2026-10-12T23:00:00.000Z'); // Tue Oct 13 03:00 Dubai
const WED_EARLY = new Date('2026-10-13T23:00:00.000Z'); // Wed Oct 14 03:00 Dubai

async function withDeliveryStubs(find, fn) {
  const orig = {
    find: Delivery.find,
    update: Delivery.findByIdAndUpdate,
    save: DeliveryChange.prototype.save,
    populate: DeliveryChange.prototype.populate,
    log: console.log,
  };
  const updates = [];
  console.log = () => {};
  Delivery.find = find;
  Delivery.findByIdAndUpdate = async (id, update) => {
    updates.push({ id, update });
    return { _id: id, ...update.$set, toObject() { return this; } };
  };
  DeliveryChange.prototype.save = async function () { return this; };
  DeliveryChange.prototype.populate = async function () { return this; };
  try {
    return await fn(updates);
  } finally {
    Delivery.find = orig.find;
    Delivery.findByIdAndUpdate = orig.update;
    DeliveryChange.prototype.save = orig.save;
    DeliveryChange.prototype.populate = orig.populate;
    console.log = orig.log;
  }
}

test('a date-only change looks up the Dubai day, including 03:00 and not the next morning', async () => {
  const queries = [];
  const tueId = new mongoose.Types.ObjectId();
  const wedId = new mongoose.Types.ObjectId();
  const rows = [
    { _id: tueId, customerId: 'C-A', scheduledTime: TUE_EARLY, notes: 'old', zone: 'Z', company: 'Matter' },
    { _id: wedId, customerId: 'C-A', scheduledTime: WED_EARLY, notes: 'old', zone: 'Z', company: 'Matter' },
  ];
  await withDeliveryStubs(async (query) => {
    queries.push(query);
    const { $gte, $lt } = query.scheduledTime;
    return rows.filter((row) => row.customerId === query.customerId && row.scheduledTime >= $gte && row.scheduledTime < $lt);
  }, async (updates) => {
    const created = await createChangesForDateRange({
      customerId: 'C-A',
      customerName: 'Fixture',
      startDate: '2026-10-13',
      endDate: new Date('2026-10-13T00:00:00.000Z'),
      changes: { notes: 'gate' },
      reason: 'issue 12',
    });
    assert.equal(queries.length, 1);
    assert.equal(queries[0].scheduledTime.$gte.toISOString(), '2026-10-12T20:00:00.000Z');
    assert.equal(queries[0].scheduledTime.$lt.toISOString(), '2026-10-13T20:00:00.000Z');
    assert.equal(created.length, 1);
    assert.equal(created[0].status, 'applied');
    assert.equal(String(created[0].appliedToDelivery), String(tueId));
    assert.deepEqual(updates.map((call) => String(call.id)), [String(tueId), String(tueId)]);
    assert.equal(updates[0].update.$set.notes, 'gate');
  });
});

test('a weekday filter follows the Dubai date, not the UTC evening the window starts on', async () => {
  const keys = [];
  await withDeliveryStubs(async (query) => {
    keys.push(query.scheduledTime.$gte.toISOString());
    return [];
  }, async () => {
    const created = await createChangesForDateRange({
      customerId: 'C-A',
      customerName: 'Fixture',
      startDate: '2026-10-12',
      endDate: '2026-10-14',
      changes: { notes: 'tue' },
      daysOfWeek: [2],
    });
    assert.deepEqual(keys, ['2026-10-12T20:00:00.000Z']);
    assert.equal(created.length, 1);
    assert.equal(created[0].scheduledDate.toISOString(), '2026-10-13T00:00:00.000Z');
    assert.equal(created[0].status, 'pending');
  });
});

test('an inverted range creates nothing', async () => {
  await withDeliveryStubs(async () => {
    throw new Error('should not query');
  }, async () => {
    await assert.rejects(
      () => createChangesForDateRange({
        customerId: 'C-A',
        customerName: 'Fixture',
        startDate: '2026-10-14',
        endDate: '2026-10-13',
        changes: { notes: 'nope' },
      }),
      /earlier than start/
    );
  });
});
