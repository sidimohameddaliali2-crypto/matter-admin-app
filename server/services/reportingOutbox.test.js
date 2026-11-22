import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bulkWriteReportingDeliveries, isReportingWebhookReceipt, reportingCaptureEnabled, reportingChangesQuery, reportingEnvelope, reportingTransactionTopology, signReportingEvent, withReportingEvents } from './reportingOutbox.js';
import { serializeHistoryPoint } from './vehicleLocationView.js';
import { serializeDelivery } from '../routes/externalDeliveryApi.js';
import { isReportingApiClient } from '../middleware/apiKeyAuth.js';

const clock = new Date('2026-11-22T06:30:00.000Z');
const fixture = { sourceVersion: 7, eventType: 'delivery.changed', subjectId: 'fixture-delivery',
  occurredAt: new Date('2026-11-22T06:29:50.000Z'), attempts: 2, private: 'omitted' };

test('reporting is opt-in and disabled writes need neither Mongo nor a webhook', async () => {
  assert.equal(reportingCaptureEnabled({}), false);
  assert.equal(reportingCaptureEnabled({ MATTER_REPORTING_CAPTURE_ENABLED: '1' }), true);
  const old = process.env.MATTER_REPORTING_CAPTURE_ENABLED;
  delete process.env.MATTER_REPORTING_CAPTURE_ENABLED;
  try {
    const ops = [{ updateOne: { filter: { _id: 'fixture-delivery' }, update: { $set: { status: 'assigned' } } } }];
    assert.deepEqual(await bulkWriteReportingDeliveries({ bulkWrite(...args) {
      assert.deepEqual(args, [ops]);
      return { modifiedCount: 1 };
    } }, ops), { modifiedCount: 1 });
    assert.equal(await withReportingEvents(async (session, enqueue) => {
      assert.equal(session, undefined);
      await enqueue('delivery.changed', ['fixture-delivery']);
      return 'saved';
    }), 'saved');
  } finally {
    if (old === undefined) delete process.env.MATTER_REPORTING_CAPTURE_ENABLED;
    else process.env.MATTER_REPORTING_CAPTURE_ENABLED = old;
  }
});

test('retry signatures use the raw body and a fresh clock for the same event ID', () => {
  const secret = 'fixture-not-a-credential';
  const expected = { eventId: 'reporting-v1:7', eventType: 'delivery.changed', subjectId: 'fixture-delivery',
    sourceVersion: 7, occurredAt: '2026-11-22T06:29:50.000Z' };
  assert.deepEqual(reportingEnvelope(fixture), expected);
  const first = signReportingEvent(fixture, secret, clock);
  const again = signReportingEvent(fixture, secret, new Date(+clock + 2000));
  assert.equal(first.body, JSON.stringify(expected));
  assert.equal(again.body, first.body);
  assert.notEqual(again.headers['x-matter-signature'], first.headers['x-matter-signature']);
  const timestamp = first.headers['x-matter-timestamp'];
  assert.equal(timestamp, String(+clock / 1000));
  assert.equal(first.headers['x-matter-signature'], 'sha256='
    + createHmac('sha256', secret).update(timestamp + '.' + first.body).digest('hex'));
});

test('changes bounds are canonical safe integers and permit a fixed high watermark', () => {
  assert.deepEqual(reportingChangesQuery({ after: '7', through: '20', limit: '8' }), { after: 7, limit: 8, through: 20 });
  assert.deepEqual(reportingChangesQuery({}), { after: 0, through: null, limit: 200 });
  for (const query of [{ after: ['7'] }, { after: '007' }, { limit: '201' }, { limit: '0' },
    { after: '8', through: '7' }, { through: '9007199254740992' }]) {
    assert.throws(() => reportingChangesQuery(query), { statusCode: 400 });
  }
});

test('only a durable inbox receipt acknowledges a webhook', async () => {
  const workId = 'a704155c-ba14-4c29-89a4-ce1151a86bb2';
  assert.equal(await isReportingWebhookReceipt(Response.json({ status: 'accepted', workId }, { status: 202 })), true);
  assert.equal(await isReportingWebhookReceipt(Response.json({ status: 'duplicate', workId })), true);
  assert.equal(await isReportingWebhookReceipt(Response.json({ status: 'accepted', workId })), false);
  assert.equal(await isReportingWebhookReceipt(Response.json({ status: 'accepted' }, { status: 202 })), false);
  assert.equal(await isReportingWebhookReceipt(Response.json({ status: 'accepted', workId, large: 'a'.repeat(1024) }, { status: 202 })), false);
  assert.equal(await isReportingWebhookReceipt(new Response('<html>OK</html>')), false);
});

test('delivery detail separates and limits proof clocks and handset coordinates; list shape is unchanged', () => {
  const delivery = { _id: 'fixture-delivery', reportingVersion: 7, proof: {
    receivedAt: clock, photoCapturedAt: fixture.occurredAt, photoSource: 'camera',
    location: { lat: 25, lng: 55, address: 'not forwarded' },
  } };
  const list = serializeDelivery(delivery, new Map());
  assert.equal('reportingVersion' in list, false);
  assert.equal('receivedAt' in list.proof, false);
  const detail = serializeDelivery(delivery, new Map(), { includeProofEvidence: true });
  assert.equal(detail.reportingVersion, 7);
  assert.equal(detail.proof.receivedAt, clock);
  assert.equal(detail.proof.photoCapturedAt, fixture.occurredAt);
  assert.deepEqual(detail.proof.location, { lat: 25, lng: 55 });
  const invalid = serializeDelivery({ ...delivery, proof: { location: { lat: 0, lng: 0 } } }, new Map(), { includeProofEvidence: true });
  assert.equal(invalid.proof.location, null);
});

test('GPS batch rows retain observation and fix clocks and capture identifiers', () => {
  const row = serializeHistoryPoint({ _id: 'capture-id', vehicleNo: 'fixture-vehicle', latitude: 25, longitude: 55,
    recordedAt: clock, gpsTime: fixture.occurredAt, captureBatchId: 'fixture-batch', captureRow: 3 });
  assert.equal(row._id, 'capture-id');
  assert.equal(row.recordedAt, clock);
  assert.equal(row.gpsTime, fixture.occurredAt);
  assert.equal(row.capture.batchId, 'fixture-batch');
  assert.equal(row.capture.batchRow, 3);
});

test('new source reporting evidence is limited to explicitly selected external key labels', () => {
  assert.equal(isReportingApiClient({ apiClient: 'worker' }, {}), false);
  const env = { MATTER_REPORTING_API_CLIENTS: ' worker, default ' };
  assert.equal(isReportingApiClient({ apiClient: 'worker' }, env), true);
  assert.equal(isReportingApiClient({ apiClient: 'default' }, env), true);
  assert.equal(isReportingApiClient({ apiClient: 'kitchen' }, env), false);
  assert.equal(isReportingApiClient({}, env), false);
});


test('read-only hello evidence distinguishes standalone, replica sets and shards', () => {
  const common = { ok: 1, isWritablePrimary: true, logicalSessionTimeoutMinutes: 30, maxWireVersion: 17 };
  assert.deepEqual(reportingTransactionTopology(common), { topology: 'unsupported', supported: false, writable: false });
  assert.deepEqual(reportingTransactionTopology({ ...common, setName: 'fixture' }), { topology: 'replica_set', supported: true, writable: true });
  assert.deepEqual(reportingTransactionTopology({ ...common, msg: 'isdbgrid', readOnly: true }), { topology: 'sharded', supported: true, writable: false });
  assert.deepEqual(reportingTransactionTopology({ ...common, msg: 'isdbgrid', maxWireVersion: 7 }), { topology: 'sharded', supported: false, writable: false });
});
