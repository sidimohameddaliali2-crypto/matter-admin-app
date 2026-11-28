// Issue #12: auto-applying pending changes onto a new delivery must count
// only writes that succeeded, flag the delivery, and reload it for the response.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Delivery from '../models/Delivery.js';
import DeliveryChange from '../models/DeliveryChange.js';
import { checkAndApplyPendingChanges } from './deliveries.js';

process.env.LOCAL_TIMEZONE_OFFSET_MINUTES = '240';

function changeDoc(id, changes) {
  return {
    _id: id,
    status: 'pending',
    changes,
    scheduledDate: new Date('2026-10-13T00:00:00.000Z'),
    async save() { this.saved = true; return this; },
  };
}

async function withStubs(fn) {
  const orig = {
    find: DeliveryChange.find,
    findById: DeliveryChange.findById,
    update: Delivery.findByIdAndUpdate,
    reload: Delivery.findById,
    log: console.log,
    err: console.error,
  };
  console.log = () => {};
  console.error = () => {};
  const updates = [];
  try {
    return await fn({ updates, orig });
  } finally {
    DeliveryChange.find = orig.find;
    DeliveryChange.findById = orig.findById;
    Delivery.findByIdAndUpdate = orig.update;
    Delivery.findById = orig.reload;
    console.log = orig.log;
    console.error = orig.err;
  }
}

test('a failed pending change is not counted and the saved delivery is reloaded (#12)', async () => {
  const deliveryId = new mongoose.Types.ObjectId();
  const okId = new mongoose.Types.ObjectId();
  const badId = new mongoose.Types.ObjectId();
  const ok = changeDoc(okId, { notes: 'gate' });
  const bad = changeDoc(badId, { notes: 'bad' });
  const delivery = {
    _id: deliveryId,
    customerId: 'C-A',
    scheduledTime: new Date('2026-10-12T23:00:00.000Z'),
    notes: 'old',
    zone: 'Z',
    company: 'Matter',
    set(values) { Object.assign(this, values); },
  };

  await withStubs(async ({ updates }) => {
    DeliveryChange.find = async () => [ok, bad];
    DeliveryChange.findById = async (id) => [ok, bad].find((change) => String(change._id) === String(id));
    Delivery.findByIdAndUpdate = async (id, update) => {
      updates.push(update.$set);
      if (update.$set.notes === 'bad') throw new Error('injected target-update failure');
      return { _id: id, ...update.$set, toObject() { return { _id: id, ...update.$set }; } };
    };
    Delivery.findById = async () => ({
      toObject() { return { _id: deliveryId, customerId: 'C-A', notes: 'gate', address: 'New address' }; },
    });

    const applied = await checkAndApplyPendingChanges(delivery);

    assert.equal(applied, 1);
    assert.equal(ok.status, 'applied');
    assert.equal(ok.saved, true);
    assert.equal(bad.status, 'pending');
    assert.equal(bad.saved, undefined);
    assert.equal(delivery.notes, 'gate');
    assert.equal(delivery.address, 'New address');
    assert.equal(updates.some((fields) => fields.notes === 'gate'), true);
    assert.equal(updates.some((fields) => fields.changeFlag?.active === true), true);
    assert.equal(updates.filter((fields) => fields.notes === 'bad').length, 1);
  });
});

test('when every pending change fails, nothing is counted and the delivery is left as created', async () => {
  const delivery = {
    _id: new mongoose.Types.ObjectId(),
    customerId: 'C-A',
    scheduledTime: new Date('2026-10-12T23:00:00.000Z'),
    notes: 'old',
    set() { throw new Error('should not reload'); },
  };
  const bad = changeDoc(new mongoose.Types.ObjectId(), { notes: 'bad' });
  await withStubs(async () => {
    DeliveryChange.find = async () => [bad];
    DeliveryChange.findById = async () => { throw new Error('should not read back'); };
    Delivery.findByIdAndUpdate = async () => { throw new Error('injected target-update failure'); };
    Delivery.findById = async () => { throw new Error('should not reload'); };
    const applied = await checkAndApplyPendingChanges(delivery);
    assert.equal(applied, 0);
    assert.equal(bad.status, 'pending');
    assert.equal(delivery.notes, 'old');
  });
});
