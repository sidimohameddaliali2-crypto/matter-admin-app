import test from 'node:test';
import assert from 'node:assert/strict';
import { mockScheduledWork } from '../testSupport/scheduledWorkFixture.js';
import { runFlaggedNotifierOnce } from './flaggedCustomerNotifier.js';
import { runMoveUncollectedCollectionsOnce } from './moveUncollectedCollections.js';
import { recordVehicleLocationsOnce } from './recordVehicleLocations.js';
import Bag from '../models/Bag.js';
import Delivery from '../models/Delivery.js';
import FlaggedAlert from '../models/FlaggedAlert.js';
import User from '../models/User.js';
import VehicleLocationHistory from '../models/VehicleLocationHistory.js';
import truckoom from '../services/truckoomApiService.js';
import axios from 'axios';

test('concurrent notifier runs send once, preserve daily dedup, and retry explicit failures', async t => {
  mockScheduledWork(t);
  const previous = { enabled: process.env.ENABLE_SLACK_NOTIFICATIONS, url: process.env.SLACK_BAG_COLLECTION_WEBHOOK_URL };
  process.env.ENABLE_SLACK_NOTIFICATIONS = '1'; process.env.SLACK_BAG_COLLECTION_WEBHOOK_URL = 'https://fixture.invalid/no-network';
  t.after(() => { for (const [key, value] of [['ENABLE_SLACK_NOTIFICATIONS', previous.enabled], ['SLACK_BAG_COLLECTION_WEBHOOK_URL', previous.url]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.mock.method(console, 'error', () => {});
  const bag = { bagId: 'fixture-bag', assignedTo: { customer: { customerId: 'fixture', customerName: 'Fixture' } } };
  t.mock.method(Bag, 'aggregate', () => ({ exec: async () => [{ _id: { key: 'fixture' }, count: 3, bags: [bag] }] }));
  t.mock.method(Delivery, 'findOne', () => ({ lean: () => ({ exec: async () => null }) }));
  let saved = null, sends = 0, unblock, started;
  t.mock.method(FlaggedAlert, 'findOne', () => ({ exec: async () => saved }));
  t.mock.method(FlaggedAlert, 'findOneAndUpdate', (filter, update) => ({ exec: async () => { saved = update; return saved; } }));
  t.mock.method(axios, 'post', async () => { sends++; started = true; await new Promise(r => { unblock = r; }); return { status: 200 }; });
  const first = runFlaggedNotifierOnce(); while (!started) await Promise.resolve();
  assert.equal((await runFlaggedNotifierOnce()).reason, 'busy');
  unblock(); assert.equal((await first).sent, 1);
  assert.equal((await runFlaggedNotifierOnce()).sent, 0); assert.equal(sends, 1);
  saved = null;
  t.mock.method(axios, 'post', async () => { throw new Error('explicit upstream failure'); });
  assert.equal((await runFlaggedNotifierOnce()).complete, false);
  assert.equal(saved, null);
  t.mock.method(axios, 'post', async () => { sends++; return { status: 200 }; });
  assert.equal((await runFlaggedNotifierOnce()).complete, true); assert.equal(sends, 2);
});

test('collection movement uses atomic old-status/time comparison and checks ownership before writes', async t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const originalTime = new Date('2099-01-02T02:00:00Z');
  const snapshot = { _id: 'fixture', driver: 'driver', scheduledTime: originalTime };
  let stored = { status: 'assigned', time: originalTime }, writes = 0;
  t.mock.method(Delivery, 'find', () => ({ exec: async () => [snapshot] }));
  t.mock.method(Delivery, 'updateOne', async (filter, update) => {
    assert.equal(filter.type, 'Collection');
    if (stored.status !== filter.status || +stored.time !== +filter.scheduledTime) return { modifiedCount: 0 };
    writes++; stored = { status: update.$set.status, time: update.$set.scheduledTime };
    assert.equal(update.$push.timeline.status, 'moved_to_next_day'); return { modifiedCount: 1 };
  });
  const results = await Promise.all([runMoveUncollectedCollectionsOnce(), runMoveUncollectedCollectionsOnce()]);
  assert.equal(results.reduce((n, r) => n + r.moved, 0), 1); assert.equal(writes, 1);
  assert.equal(+stored.time, +originalTime + 86400000);
  await assert.rejects(runMoveUncollectedCollectionsOnce({ assertOwned: async () => { throw new Error('lost'); } }), /lost/);
  assert.equal(writes, 1);
});

test('vehicle samples use stable database identities across partial-write retries', async t => {
  t.mock.method(truckoom, 'isConfigured', () => true);
  t.mock.method(truckoom, 'getFleetStatus', async () => [{ vehicleNo: 'fixture', latitude: 25.2, longitude: 55.3 }]);
  t.mock.method(User, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  const records = new Map();
  t.mock.method(VehicleLocationHistory, 'bulkWrite', async ops => {
    for (const { updateOne: op } of ops) { assert.equal(op.upsert, true); if (!records.has(op.filter._id)) records.set(op.filter._id, op.update.$setOnInsert); }
  });
  const context = { slot: 10, assertOwned: async () => {} };
  await recordVehicleLocationsOnce(context, 60000); await recordVehicleLocationsOnce(context, 60000);
  assert.equal(records.size, 1);
  await recordVehicleLocationsOnce({ ...context, slot: 11 }, 60000); assert.equal(records.size, 2);
  t.mock.method(console, 'error', () => {});
  await assert.rejects(recordVehicleLocationsOnce({ ...context, slot: 12, assertOwned: async () => { throw new Error('lost'); } }, 60000), /lost/);
  assert.equal(records.size, 2);
});
