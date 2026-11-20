import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import MatterImportJob from './MatterImportJob.js';

test('worker claim and recovery compound indexes are declared for normal model initialization', () => {
  const keys = MatterImportJob.schema.indexes().map(([key]) => key);
  assert.ok(keys.some(key => JSON.stringify(key) === JSON.stringify({ status: 1, createdAt: 1 })));
  assert.ok(keys.some(key => JSON.stringify(key) === JSON.stringify({ status: 1, leaseUntil: 1 })));
});

const uri = process.env.MATTER_IMPORT_TEST_MONGO_URI;
test('Mongo explain uses both indexes with completed history and no matching jobs', { skip: !uri }, async () => {
  // This test never loads app environment files and refuses non-isolated URIs.
  const target = new URL(uri);
  assert.equal(target.protocol, 'mongodb:');
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
  assert.match(target.pathname, /^\/matter_import_index_test_[a-z0-9_]+$/);
  const connection = await mongoose.createConnection(uri, { autoIndex: true, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const Job = connection.model('MatterImportJob', MatterImportJob.schema.clone());
    // Same schema/init index mechanism used by the app's enqueue path.
    await Job.init();
    const collection = Job.collection;
    const now = new Date('2026-11-22T00:00:00Z');
    await collection.insertMany(Array.from({ length: 20000 }, (_, i) => ({
      date: '2026-11-21', status: 'completed', createdAt: new Date(+now - i * 1000), finishedAt: now
    })));
    const cases = [
      ['claim', 'status_1_createdAt_1', { findAndModify: collection.name, query: { status: 'queued' },
        sort: { createdAt: 1 }, update: { $set: { status: 'running', startedAt: now } }, new: true }],
      ['recover', 'status_1_leaseUntil_1', { update: collection.name, updates: [{
        q: { status: 'running', leaseUntil: { $lte: now } },
        u: { $set: { status: 'failed' }, $unset: { activeKey: 1, owner: 1, leaseUntil: 1 } }, multi: true
      }] }]
    ];
    const plans = [];
    for (const [query, index, command] of cases) {
      const explain = await connection.db.command({ explain: command, verbosity: 'executionStats' });
      const winning = JSON.stringify(explain.queryPlanner.winningPlan);
      assert.ok(winning.includes(index), winning);
      assert.equal(winning.includes('COLLSCAN'), false);
      assert.equal(winning.includes('"SORT"'), false);
      assert.equal(explain.executionStats.totalDocsExamined, 0);
      plans.push({ query, index, docsExamined: explain.executionStats.totalDocsExamined, keysExamined: explain.executionStats.totalKeysExamined });
    }
    assert.equal(await collection.countDocuments({ status: 'completed' }), 20000);
    console.log(JSON.stringify({ fixture: 'isolated MongoDB, 20000 completed jobs, zero eligible jobs', plans }));
  } finally {
    await connection.dropDatabase();
    await connection.close();
  }
});
