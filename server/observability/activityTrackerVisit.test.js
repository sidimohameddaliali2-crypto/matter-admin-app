import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutomaticTrackerVisit } from './activityScope.js';
import { createActivityPlugin } from './activityDatabase.js';
import { inTraceContext } from './telemetry.js';

const context = { job: 'customer-tracker-visits', run_id: 'synthetic-run' };
const update = () => ({ $set: { trackerVisit: { checkedAt: new Date(), status: 'inside_window' },
  updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } });

test('only the automatic tracker-only update shape is eligible to defer its duplicate start', () => {
  assert.equal(isAutomaticTrackerVisit(context, 'Delivery', 'updateOne', update()), true);
  const baseline = update(); baseline.$set.trackerVisitGpsBaseline = { evidence: { status: 'inside_window' } };
  assert.equal(isAutomaticTrackerVisit(context, 'Delivery', 'updateOne', baseline), true);
  const beforeFleet = update();
  beforeFleet.$set['trackerVisitGpsBaseline.beforeFleet'] = { evidence: { vehicleNo: 'old-alias' } };
  assert.equal(isAutomaticTrackerVisit(context, 'Delivery', 'updateOne', beforeFleet), true);
  for (const field of ['status', 'proof', 'driver', 'address', 'gpsLocation', 'bagAssignment']) {
    const mixed = update(); mixed.$set[field] = 'business-change';
    assert.equal(isAutomaticTrackerVisit(context, 'Delivery', 'updateOne', mixed), false);
  }
  for (const ctx of [{}, { job: 'other' }, { ...context, request: {} }, { ...context, actionId: 'human-action' }]) {
    assert.equal(isAutomaticTrackerVisit(ctx, 'Delivery', 'updateOne', update()), false);
  }
  for (const operation of ['save', 'updateMany', 'deleteOne']) assert.equal(isAutomaticTrackerVisit(context, 'Delivery', operation, update()), false);
  assert.equal(isAutomaticTrackerVisit(context, 'Customer', 'updateOne', update()), false);
  assert.equal(isAutomaticTrackerVisit(context, 'Delivery', 'updateOne', update(), { upsert: true }), false);
  assert.equal(isAutomaticTrackerVisit(context, 'Delivery', 'updateOne', { ...update(), $unset: { proof: 1 } }), false);
});

function fixture(writeOverride) {
  const events = []; const pre = {}; const post = {}; const errors = {};
  createActivityPlugin({ write: writeOverride || (async event => { events.push(event); }) })({ options: {},
    pre(name, ...args) { pre[name] = args.at(-1); },
    post(name, ...args) { const hook = args.at(-1); (hook.length === 3 ? errors : post)[name] = hook; }
  });
  const proposed = update();
  const query = { model: { modelName: 'Delivery', findOne: () => ({ session: () => ({ lean: async () => ({ _id: 'synthetic-delivery', status: 'delivered' }) }) }) },
    getUpdate: () => proposed, getFilter: () => ({ _id: 'synthetic-delivery' }), getOptions: () => ({}) };
  return { events, pre, post, errors, query, proposed };
}

test('saved tracker updates retain terminal evidence and write result, without another started snapshot', async () => {
  const f = fixture();
  const original = structuredClone(f.proposed);
  await inTraceContext(context, () => f.pre.updateOne.call(f.query));
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.proposed, original);
  await f.post.updateOne.call(f.query, { modifiedCount: 1 });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].stage, 'record_saved');
  assert.equal(f.events[0].outcome, 'saved');
  assert.equal(f.events[0].operationId, f.query.activityEvent.operationId);
  assert.ok(f.events[0].changes.some(change => change.field.toLowerCase().includes('tracker')));
});

test('only a confirmed poll with identical delivery evidence suppresses its saved entry', async () => {
  const clock = new Date('2026-11-20T02:00:00Z');
  const success = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  for (const [prior, change, baseline, result, expected] of [
    [{}, {}, false, success, []],
    [{}, { gpsSampleCount: 1 }, false, success, ['record_saved']],
    [{}, { status: 'outside_window' }, false, success, ['record_saved']],
    [{errorCode: 'TIMEOUT'}, {errorCode: 'TIMEOUT'}, false, success, ['record_saved']],
    [{}, {}, true, success, ['record_saved']],
    [{}, {}, false, { ...success, matchedCount: 0, modifiedCount: 0 }, ['record_not_changed']],
  ]) {
    const f = fixture();
    const row = { _id: 'synthetic-delivery', trackerVisit: { status: 'inside_window', checkedAt: clock, ...prior } };
    f.query.model.findOne = () => ({ session: () => ({ lean: async () => row }) });
    f.query.getFilter = () => ({ _id: row._id, 'trackerVisit.checkedAt': clock });
    Object.assign(f.proposed.$set.trackerVisit, change);
    if (baseline) f.proposed.$set.trackerVisitGpsBaseline = { evidence: prior };
    await inTraceContext(context, () => f.pre.updateOne.call(f.query));
    await f.post.updateOne.call(f.query, result);
    assert.deepEqual(f.events.map(event => event.stage), expected);
  }
});

test('a fenced-out tracker write remains visible as unchanged, not saved', async () => {
  const f = fixture();
  await inTraceContext(context, () => f.pre.updateOne.call(f.query));
  await f.post.updateOne.call(f.query, { modifiedCount: 0 });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].stage, 'record_not_changed');
});

test('failed tracker writes retain an uncertain result and propagate the exact original error', async () => {
  for (const sinkFails of [false, true]) {
    const events = [];
    const f = fixture(async event => { events.push(event); if (sinkFails) throw new Error('Synthetic audit outage'); });
    await inTraceContext(context, () => f.pre.updateOne.call(f.query));
    const error = new Error('Synthetic private connection detail');
    const received = await new Promise(resolve => f.errors.updateOne.call(f.query, error, null, resolve));
    assert.equal(received, error);
    assert.equal(events.length, 1);
    assert.equal(events[0].stage, 'record_not_saved');
    assert.equal(events[0].outcome, 'uncertain');
    assert.equal(JSON.stringify(events[0]).includes(error.message), false);
  }
});

test('mixed changes and human tracker edits keep the original started/saved pair', async () => {
  for (const mixed of [false, true]) {
    const f = fixture();
    if (mixed) f.proposed.$set.status = 'delivered';
    await inTraceContext(mixed ? context : { request: { method: 'PATCH' } }, () => f.pre.updateOne.call(f.query));
    await f.post.updateOne.call(f.query, { modifiedCount: 1 });
    assert.deepEqual(f.events.map(e => e.stage), ['record_change_started', 'record_saved']);
  }
});

test('real Mongoose preserves tracker/GPS writes and saved, unchanged and failed terminal outcomes', {
  skip: !process.env.TRACKER_AUDIT_TEST_MONGO_URI
}, async () => {
  const uri = process.env.TRACKER_AUDIT_TEST_MONGO_URI;
  const target = new URL(uri);
  assert.equal(target.protocol, 'mongodb:');
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
  assert.match(target.pathname, /^\/tracker_audit_test_[a-z0-9_]+$/);
  const { default: mongoose } = await import('mongoose');
  const connection = await mongoose.createConnection(uri, { autoIndex: false }).asPromise();
  const events = [];
  try {
    const schema = new mongoose.Schema({ trackerVisit: mongoose.Schema.Types.Mixed, status: String,
      trackerVisitGpsBaseline: mongoose.Schema.Types.Mixed, gpsLocation: mongoose.Schema.Types.Mixed, proof: mongoose.Schema.Types.Mixed }, { timestamps: true });
    schema.plugin(createActivityPlugin({ write: async event => { events.push(event); } }));
    const Delivery = connection.model('Delivery', schema);
    const id = new mongoose.Types.ObjectId();
    const evidence = { gpsLocation: { lat: 25.1, lng: 55.2 }, proof: { photoCapturedAt: new Date('2026-11-20T01:00:00Z') } };
    await Delivery.collection.insertOne({ _id: id, status: 'delivered', ...evidence, trackerVisit: { status: 'awaiting_events' } });
    await connection.db.command({ collMod: Delivery.collection.name, validator: {
      $jsonSchema: { properties: { trackerVisit: { properties: { status: { enum: ['awaiting_events', 'inside_window'] } } } } }
    } });
    const priorVisit = { evidence: { vehicleNo: 'old-alias', status: 'awaiting_events' } };
    const changed = await inTraceContext(context, async () => await Delivery.updateOne({ _id: id }, { $set: {
      trackerVisit: { status: 'inside_window' }, 'trackerVisitGpsBaseline.beforeFleet': priorVisit,
    } }));
    assert.equal(changed.modifiedCount, 1);
    assert.deepEqual(events.map(e => e.stage), ['record_saved']);
    const saved = await Delivery.findById(id).lean();
    assert.deepEqual(saved.trackerVisitGpsBaseline.beforeFleet, priorVisit);
    assert.deepEqual(saved.gpsLocation, evidence.gpsLocation);
    assert.deepEqual(saved.proof, evidence.proof);
    assert.equal(saved.status, 'delivered');
    events.length = 0;
    await inTraceContext(context, async () => await Delivery.updateOne({ _id: new mongoose.Types.ObjectId() }, { $set: { trackerVisit: { status: 'inside_window' } } }));
    assert.deepEqual(events.map(e => e.stage), ['record_not_changed']);
    events.length = 0;
    await assert.rejects(inTraceContext(context, async () => await Delivery.updateOne({ _id: id }, { $set: { trackerVisit: { status: 'invalid-for-fixture' } } })), { code: 121 });
    assert.deepEqual(events.map(e => [e.stage, e.outcome]), [['record_not_saved', 'uncertain']]);
    assert.equal((await Delivery.findById(id).lean()).trackerVisit.status, 'inside_window');
  } finally { await connection.dropDatabase(); await connection.close(); }
});
