// Issue #5: both "change a delivery's time" paths (dispatcher-applied changes in
// routes/deliveries.js and pending delivery-changes in routes/deliveryChanges.js)
// must keep the delivery on its business day, and agree with each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import Delivery from '../models/Delivery.js';
import { applyChangesToDelivery as applyFromDeliveries } from './deliveries.js';
import { applyChangesToDelivery as applyFromDeliveryChanges } from './deliveryChanges.js';

const impls = { 'routes/deliveries.js': applyFromDeliveries, 'routes/deliveryChanges.js': applyFromDeliveryChanges };

async function run(fn, delivery, changes) {
  const calls = [];
  const orig = Delivery.findByIdAndUpdate;
  const origLog = console.log;
  Delivery.findByIdAndUpdate = async (id, update) => { calls.push({ id, update }); return { _id: id, ...update.$set }; };
  console.log = () => {};
  try {
    const result = await fn(delivery, changes).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
    return { ...result, calls };
  } finally {
    Delivery.findByIdAndUpdate = orig;
    console.log = origLog;
  }
}

const early = { _id: 'd1', scheduledTime: new Date('2026-10-12T23:00:00.000Z'), zone: 'Z', company: 'Matter' }; // Tue Oct 13 03:00 Dubai

for (const [name, fn] of Object.entries(impls)) {
  test(`${name}: Tue 03:00 -> 05:00 is stored as 2026-10-13T01:00:00Z (still Tuesday)`, async () => {
    const out = await run(fn, early, { scheduledTime: '05:00' });
    assert.equal(out.ok, true);
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0].update.$set.scheduledTime.toISOString(), '2026-10-13T01:00:00.000Z');
  });

  test(`${name}: an invalid time is rejected before anything is written`, async () => {
    for (const bad of ['25:00', '09:75', '', 'noon']) {
      const out = await run(fn, early, { scheduledTime: bad, notes: 'should not be saved either' });
      assert.equal(out.ok, false, bad);
      assert.equal(out.calls.length, 0, `no write for "${bad}"`);
    }
  });
}

test('direct edits and pending-change edits produce identical UTC instants for every boundary time', async () => {
  const deliveries = [
    early,
    { _id: 'd2', scheduledTime: new Date('2026-12-31T22:00:00.000Z') }, // Jan 1 2027 02:00 Dubai
    { _id: 'd3', scheduledTime: new Date('2026-10-13T03:00:00.000Z') }  // Oct 13 07:00 Dubai
  ];
  for (const d of deliveries) {
    for (const time of ['00:00', '03:59', '04:00', '05:00', '23:59']) {
      const a = await run(applyFromDeliveries, d, { scheduledTime: time });
      const b = await run(applyFromDeliveryChanges, d, { scheduledTime: time });
      assert.equal(
        a.calls[0].update.$set.scheduledTime.toISOString(),
        b.calls[0].update.$set.scheduledTime.toISOString(),
        `${d._id} @ ${time}`
      );
    }
  }
});
