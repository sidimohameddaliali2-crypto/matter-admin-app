import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

const binary =
  process.env.TEST_MONGOD_BIN ||
  path.join(os.homedir(), '.cache/mongodb-binaries/mongod-arm64-darwin-7.0.14');
test(
  'real driver form submission, identity, confirmed writes, rollback, redaction and durable recovery',
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'matter-activity-e2e-'));
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const mongo = spawn(
      binary,
      [
        '--dbpath',
        directory,
        '--port',
        String(port),
        '--bind_ip',
        '127.0.0.1',
        '--replSet',
        'activity-fixture',
        '--quiet',
        '--logpath',
        path.join(directory, 'mongo.log'),
      ],
      { stdio: 'ignore' },
    );
    let client;
    t.after(async () => {
      await mongoose.disconnect();
      await client?.close();
      if (mongo.exitCode === null) {
        mongo.kill('SIGTERM');
        await new Promise((resolve) => mongo.once('exit', resolve));
      }
      await rm(directory, { recursive: true, force: true });
    });
    const uri = `mongodb://127.0.0.1:${port}/activity_fixture`;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        client = await mongoose.mongo.MongoClient.connect(uri + '?directConnection=true', {
          serverSelectionTimeoutMS: 100,
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(client, 'Synthetic Mongo fixture started');
    await client.db('admin').command({
      replSetInitiate: {
        _id: 'activity-fixture',
        members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      },
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await client.db('admin').command({ hello: 1 })).isWritablePrimary) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    process.env.MATTER_ACTIVITY_JOURNAL_DIR = path.join(directory, 'journal');
    process.env.JWT_SECRET = 'synthetic-fixture-only-secret';
    await import('./installActivity.js');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
    const { default: User } = await import('../models/User.js');
    const { default: drivers } = await import('../routes/drivers.js');
    const { default: deliveries } = await import('../routes/deliveries.js');
    const { default: Delivery } = await import('../models/Delivery.js');
    const { createTraceabilityRouter } = await import('../routes/traceability.js');
    const { createRequestTrace } = await import('./requestTrace.js');
    const { resolveTraceRoute } = await import('./routeCatalog.js');
    const { activityJournal, readActivity } = await import('./activityStore.js');
    const { inTraceContext } = await import('./telemetry.js');
    const owner = await User.create({
      email: 'osman@example.invalid',
      password: 'SYNTHETIC_PASSWORD',
      role: 'super_admin',
      profile: { firstName: 'Osman' },
    });
    const token = jwt.sign({ id: owner._id.toString() }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
    });
    const app = express();
    app.set('activityHistoryEnabled', true);
    app.use(createRequestTrace({ resolveRoute: resolveTraceRoute, sink: () => {} }));
    app.use(express.json());
    app.use('/api/drivers', drivers);
    app.use('/api/users/drivers', drivers);
    app.use('/api/deliveries', deliveries);
    app.use('/api/traceability', createTraceabilityRouter());
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    );
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Matter-Activity-ID': '11111111-1111-4111-a111-111111111111',
    };
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(origin + '/api/users/drivers', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        firstName: 'Fixture driver',
        email: 'driver@example.invalid',
        password: 'PRIVATE_PASSWORD_NEVER_STORE',
        phone: 'PRIVATE_PHONE',
        nationalId: 'PRIVATE_NATIONAL',
      }),
    });
    assert.equal(response.status, 201);
    const driver = await response.json();
    const record = (await readActivity(100)).events.find(
      (event) => event.stage === 'record_saved' && event.record?.id === driver._id,
    );
    assert.ok(record, 'A confirmed driver change is recorded');
    assert.equal(record.actor.name, 'Osman');
    assert.equal(record.actor.id, owner._id.toString());
    assert.equal(record.actor.role, 'super_admin');
    assert.equal(record.summary, 'Osman added a driver.');
    assert.equal(record.actionId, headers['X-Matter-Activity-ID']);
    assert.ok(
      record.changes.some(
        (change) => change.field === 'profile first Name' || change.field === 'profile first name',
      ),
    );
    const delivery = await Delivery.create({
      customerId: 'synthetic-customer',
      customerName: 'Synthetic customer',
      scheduledTime: new Date(),
      type: 'Delivery',
    });
    const assigned = await fetch(origin + '/api/deliveries/assign-driver', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ deliveryIds: [delivery._id.toString()], driverId: driver._id }),
    });
    assert.equal(assigned.status, 200);
    let assignments = (await readActivity(200)).events.filter(
      (entry) => entry.stage === 'record_saved' && entry.record?.id === delivery._id.toString(),
    );
    assert.ok(
      assignments.some((entry) => entry.summary === 'Osman assigned a delivery to Fixture driver.'),
    );
    assert.ok(
      assignments.some((entry) =>
        entry.changes.some(
          (change) =>
            change.field === 'Assigned driver' &&
            change.after === 'Fixture driver' &&
            change.references.after === driver._id,
        ),
      ),
    );
    const replacement = await User.create({
      email: 'replacement@example.invalid',
      password: 'synthetic-password',
      role: 'driver',
      profile: { firstName: 'Replacement' },
    });
    const reassigned = await fetch(origin + '/api/deliveries/assign-driver', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        deliveryIds: [delivery._id.toString()],
        driverId: replacement._id.toString(),
      }),
    });
    assert.equal(reassigned.status, 200);
    assignments = (await readActivity(200)).events.filter(
      (entry) => entry.stage === 'record_saved' && entry.record?.id === delivery._id.toString(),
    );
    assert.ok(
      assignments.some(
        (entry) =>
          entry.summary === 'Osman assigned a delivery to Replacement.' &&
          entry.changes.some(
            (change) =>
              change.field === 'Assigned driver' &&
              change.before === 'Fixture driver' &&
              change.after === 'Replacement' &&
              change.references.before === driver._id &&
              change.references.after === replacement._id.toString(),
          ),
      ),
    );
    const unassigned = await fetch(origin + '/api/deliveries/unassign-driver', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ deliveryIds: [delivery._id.toString()] }),
    });
    assert.equal(unassigned.status, 200);
    assert.ok(
      (await readActivity(200)).events.some(
        (entry) => entry.summary === 'Osman removed the driver assignment from a delivery.',
      ),
    );
    const context = { request: { user: owner }, request_id: 'fixture-request' };
    await inTraceContext(context, () =>
      User.updateOne(
        { _id: driver._id },
        { $set: { 'profile.status': 'online', password: 'PRIVATE_UPDATE_PASSWORD' } },
      ),
    );
    let history = await readActivity(100);
    assert.ok(
      history.events.some(
        (event) =>
          event.stage === 'record_saved' &&
          event.changes.some(
            (change) => change.field === 'profile status' && change.after === 'online',
          ),
      ),
    );
    assert.ok(!JSON.stringify(history).includes('PRIVATE_'));
    await assert.rejects(
      inTraceContext(context, () =>
        mongoose.connection.transaction(async (session) => {
          const doc = await User.findById(driver._id).session(session);
          doc.profile.status = 'busy';
          await doc.save({ session });
          throw Error('rollback fixture');
        }),
      ),
      /rollback fixture/,
    );
    history = await readActivity(100);
    assert.ok(
      history.events.some(
        (event) => event.stage === 'record_not_saved' && event.issue?.includes('cancelled'),
      ),
    );
    assert.ok(
      !history.events.some(
        (event) =>
          event.stage === 'record_saved' && event.changes.some((change) => change.after === 'busy'),
      ),
    );
    const { configureCloudInbox } = await import('../services/customerServiceCloudStore.js');
    const { cloudWorkflowModel } = await import('../services/customerServiceCloudWorkflow.js');
    const Fixture = mongoose.model(
      'ServiceActivityFixture',
      new mongoose.Schema({ title: String, status: String }, { collection: 'serviceactions' }),
    );
    let committed = false;
    const fakeStore = {
      transaction: async (operation) => {
        const result = await operation(async (sql) =>
          sql.includes('SELECT row_to_json(h)') ? { revision: 1 } : null,
        );
        committed = true;
        return result;
      },
    };
    configureCloudInbox({ workflow: true, store: fakeStore });
    const facade = cloudWorkflowModel(Fixture);
    const csContext = { request: { user: owner, app }, request_id: 'cs-fixture' };
    const csSaved = await inTraceContext(csContext, () =>
      facade.create({ title: 'Fixture task', status: 'open' }),
    );
    assert.ok(committed);
    assert.ok(
      (await readActivity(300)).events.some(
        (entry) =>
          entry.stage === 'record_saved' &&
          entry.record?.id === csSaved._id.toString() &&
          entry.actor.id === owner._id.toString(),
      ),
    );
    fakeStore.transaction = async (operation) => {
      await operation(async (sql) =>
        sql.includes('SELECT row_to_json(h)') ? { revision: 2 } : null,
      );
      throw Error('cloud rollback fixture');
    };
    await assert.rejects(
      inTraceContext(csContext, () =>
        facade.create({ title: 'Rolled back', status: 'never_saved' }),
      ),
      /cloud rollback fixture/,
    );
    assert.ok(
      !(await readActivity(300)).events.some(
        (entry) =>
          entry.stage === 'record_saved' &&
          entry.changes.some((change) => change.after === 'never_saved'),
      ),
    );
    configureCloudInbox(null);
    await activityJournal.flush();
    assert.ok(
      (await mongoose.connection.db
        .collection('activity_audit_events')
        .countDocuments({ 'actor.id': owner._id.toString() })) > 0,
    );
    const batchModel = mongoose.model(
      'ActivityBatchFixture',
      new mongoose.Schema({ label: { type: String, unique: true } }),
    );
    await batchModel.init();
    await batchModel.create({ label: 'duplicate' });
    await assert.rejects(
      inTraceContext(context, () =>
        batchModel.insertMany(
          [{ label: 'partial-saved' }, { label: 'duplicate' }, { label: 'never-inserted' }],
          { ordered: true },
        ),
      ),
    );
    assert.ok(
      (await readActivity(300)).events.some(
        (entry) =>
          entry.stage === 'record_saved' &&
          entry.changes.some((change) => change.after === 'partial-saved'),
      ),
    );
    assert.ok(
      !(await readActivity(300)).events.some(
        (entry) =>
          entry.stage === 'record_saved' &&
          entry.changes.some((change) => change.after === 'never-inserted'),
      ),
    );
    const denied = await fetch(origin + '/api/traceability/activity');
    assert.equal(denied.status, 401);
    const activity = await fetch(origin + '/api/traceability/activity', { headers });
    assert.equal(activity.status, 200);
    assert.ok((await activity.json()).data.storage.durable);
    const pageOne = await (
      await fetch(origin + '/api/traceability/activity?limit=1', { headers })
    ).json();
    assert.ok(pageOne.data.nextCursor);
    const pageTwo = await (
      await fetch(
        origin +
          '/api/traceability/activity?limit=1&before=' +
          encodeURIComponent(pageOne.data.nextCursor),
        { headers },
      )
    ).json();
    assert.notEqual(pageOne.data.events[0].eventId, pageTwo.data.events[0].eventId);
    assert.equal(
      (await fetch(origin + '/api/traceability/activity?before=invalid', { headers })).status,
      400,
    );
  },
);
