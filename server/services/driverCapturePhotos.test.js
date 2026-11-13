import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ingestDriverCapturePhoto } from './driverCapturePhotos.js';
import { createDriverEventsRouter } from '../routes/driverEvents.js';
import express from 'express';

const actor = { id: '0123456789abcdef01234567', role: 'driver' };
const bytes = Buffer.from([0xff, 0xd8, 0, 1, 0xff, 0xd9]); // Framing fixture, not a decoded-photo quality test.
const md5 = createHash('md5').update(bytes).digest('hex');
function fixture() {
  const photos = new Map();
  let owns = true;
  const ledger = { payloadHash: 'immutable-ledger-hash', originalEvent: {
    accountId: actor.id, eventType: 'photo.captured', data: { photoId: 'photo-one', byteSize: bytes.length,
      contentMd5: md5, deliveryId: 'abcdef012345678901234567' } } };
  return { setOwns(value) { owns = value; }, photos, ledger,
    async findEvent() { return ledger; }, async ownsDelivery() { return owns; },
    async findPhoto({ photoId }) { return photos.get(photoId); },
    async acceptPhoto(record) {
      if (photos.has(record.photoId)) return { ...photos.get(record.photoId), duplicate: true };
      photos.set(record.photoId, record); return { ...record, duplicate: false };
    } };
}
const input = repository => ({ actor, photoId: 'photo-one', eventId: 'photo:photo-one', contentMd5: md5, bytes, repository });
test('original photo bytes and stable receipt survive a lost response and reassignment', async () => {
  const store = fixture();
  const first = await ingestDriverCapturePhoto(input(store));
  assert.equal(first.data.durablyStored, true);
  assert.equal(first.data.deliveryStateApplied, false);
  assert.equal(first.data.duplicate, false);
  store.setOwns(false);
  const retry = await ingestDriverCapturePhoto(input(store));
  assert.equal(retry.data.duplicate, true);
  assert.equal(store.photos.size, 1);
  assert.deepEqual(store.photos.get('photo-one').originalBytes, bytes);
});
test('account, association, checksum, framing and missing ledger fail without replacing evidence', async () => {
  for (const status of [403, 409, 413, 422]) {
    const store = fixture();
    const request = input(store);
    if (status === 403) store.setOwns(false);
    if (status === 409) request.contentMd5 = '0'.repeat(32);
    if (status === 413) request.bytes = Buffer.alloc(750001);
    if (status === 422) request.bytes = Buffer.from('not-jpeg');
    await assert.rejects(ingestDriverCapturePhoto(request), error => error.status === status);
    assert.equal(store.photos.size, 0);
  }
  const store = fixture(); store.ledger.originalEvent.accountId = 'another-account';
  await assert.rejects(ingestDriverCapturePhoto(input(store)), error => error.status === 409);
  store.ledger.originalEvent.accountId = actor.id; store.ledger.originalEvent.data.photoId = 'another-photo';
  await assert.rejects(ingestDriverCapturePhoto(input(store)), error => error.status === 409);
});
test('same photo identity cannot acquire different original bytes or another event', async () => {
  const store = fixture();
  await ingestDriverCapturePhoto(input(store));
  const changed = Buffer.from([0xff, 0xd8, 9, 9, 0xff, 0xd9]);
  const changedMd5 = createHash('md5').update(changed).digest('hex');
  store.ledger.originalEvent.data.contentMd5 = changedMd5;
  await assert.rejects(ingestDriverCapturePhoto({ ...input(store), bytes: changed, contentMd5: changedMd5 }), error => error.status === 409);
  store.ledger.originalEvent.data.contentMd5 = md5;
  await assert.rejects(ingestDriverCapturePhoto({ ...input(store), eventId: 'different-event' }), error => error.status === 409);
  assert.deepEqual(store.photos.get('photo-one').originalBytes, bytes);
});
test('photo persistence failures cannot produce a durable acknowledgement', async () => {
  const store = fixture(); store.acceptPhoto = async () => { throw new Error('write concern timeout'); };
  await assert.rejects(ingestDriverCapturePhoto(input(store)), /write concern timeout/);
});
test('HTTP capture gate, authentication, JSON/binary limits and photo receipts work without a database', async () => {
  const repository = fixture();
  const authenticate = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer synthetic-test-token') return res.sendStatus(401);
    req.user = { _id: actor.id, role: 'driver' }; next();
  };
  const app = express();
  app.use('/disabled', createDriverEventsRouter({ store: repository, authenticate, enabled: () => false }));
  app.use('/capture', createDriverEventsRouter({ store: repository, authenticate, enabled: () => true }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ success: false }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer synthetic-test-token', 'Content-Type': 'image/jpeg', 'X-Capture-Event-Id': 'photo:photo-one', 'X-Content-MD5': md5 };
  try {
    assert.equal((await fetch(`${base}/disabled/batch`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/capture/batch`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/capture/batch`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [], padding: 'x'.repeat(66000) }) })).status, 413);
    assert.equal((await fetch(`${base}/capture/photos/photo-one`, { method: 'PUT', headers, body: Buffer.alloc(750001) })).status, 413);
    const result = await fetch(`${base}/capture/photos/photo-one`, { method: 'PUT', headers, body: bytes });
    assert.equal(result.status, 200);
    const receipt = await result.json(); assert.equal(receipt.data.durablyStored, true);
    assert.equal(receipt.data.contentMd5, md5);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
