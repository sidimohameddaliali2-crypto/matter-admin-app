import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliveryStagingConfig, stagingRequestAllowed } from './deliveryStagingConfig.js';
import { createDeliveryStagingApp, deliveryStagingRoutes } from './deliveryStagingApp.js';
import User from '../models/User.js';
import { sendDeliveryPushToDriver, sendRouteAssignedPushToDriver } from './pushNotificationService.js';

const env = { APP_ENV: 'staging', MONGODB_URI: 'mongodb://localhost/matter_staging',
  JWT_SECRET: 'a'.repeat(64), CLIENT_URL: 'https://staging.matterapp.online' };

test('staging refuses production selection, missing database isolation and integration credentials', () => {
  assert.equal(deliveryStagingConfig(env).origin, env.CLIENT_URL);
  for (const override of [{ APP_ENV: 'production' }, { MONGODB_URI: 'mongodb://localhost/test' },
    { MONGODB_URI: 'mongodb://localhost/matter_staging_other' }, { CLIENT_URL: 'https://matterapp.online' },
    { JWT_SECRET: 'short' }, { SPACES_KEY: 'production-key' }, { GALLABOX_API_KEY: 'key' },
    { CUSTOMER_SERVICE_STORAGE: 'supabase' }]) assert.throws(() => deliveryStagingConfig({ ...env, ...override }));
});

test('staging excludes outbound integrations and the placeholder bag return endpoint', () => {
  for (const p of ['/api/customers/send-whatsapp-reminder', '/api/drivers/returns', '/api/users/drivers/returns',
    '/api/drivers/123/route-directions', '/api/deliveries/geocode-google', '/api/deliveries/route-eta',
    '/api/deliveries/optimize-routes', '/api/deliveries/optimize-routes/apply']) assert.equal(stagingRequestAllowed(p), false, p);
  assert.equal(stagingRequestAllowed('/api/deliveries/123/complete'), true);
  assert.equal(stagingRequestAllowed('/api/bags/123/return'), true);
});

test('disabled driver pushes do not query device tokens or send messages', async () => {
  const previous = process.env.DISABLE_DRIVER_PUSH;
  const original = User.findById;
  let reads = 0;
  process.env.DISABLE_DRIVER_PUSH = '1';
  User.findById = () => { reads++; throw new Error('Unexpected database read'); };
  try {
    await sendDeliveryPushToDriver({ driverId: 'test', type: 'delivery_created', delivery: { _id: 'test' } });
    await sendRouteAssignedPushToDriver({ driverId: 'test', stopCount: 1 });
    assert.equal(reads, 0);
  } finally {
    User.findById = original;
    if (previous === undefined) delete process.env.DISABLE_DRIVER_PUSH;
    else process.env.DISABLE_DRIVER_PUSH = previous;
  }
});

test('API-only app exposes health, uses shared routers and stores mobile test photos locally', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'matter-staging-'));
  const routers = {};
  for (const [, name] of deliveryStagingRoutes) {
    const router = express.Router();
    router.get('/fixture', (_req, res) => res.json({ router: name }));
    routers[name] = router;
  }
  let ready = true;
  const app = createDeliveryStagingApp({ origin: env.CLIENT_URL, uploadsDir: dir, routers,
    databaseReady: () => ready, protect: (req, res, next) => req.headers.authorization === 'Bearer test'
      ? next() : res.sendStatus(401) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.environment, 'staging-delivery');
    assert.equal(health.backgroundJobsEnabled, false);
    assert.equal(health.driverCaptureEnabled, false);
    ready = false;
    assert.equal((await fetch(`${base}/api/health`)).status, 503);
    assert.equal((await (await fetch(`${base}/api/deliveries/fixture`)).json()).router, 'deliveries');
    for (const url of ['/api/menus', '/api/customer-service/me', '/api/matter', '/api/partner', '/']) {
      assert.equal((await fetch(base + url)).status, 404);
    }
    const form = new FormData();
    form.append('image', new Blob(['test-photo-bytes'], { type: 'image/jpeg' }), 'test.jpg');
    assert.equal((await fetch(`${base}/api/upload/delivery-photo`, { method: 'POST', body: form })).status, 401);
    assert.equal(readdirSync(dir).length, 0);
    const uploaded = await fetch(`${base}/api/upload/delivery-photo`, {
      method: 'POST', headers: { Authorization: 'Bearer test' }, body: form });
    assert.equal(uploaded.status, 200);
    const receipt = await uploaded.json();
    assert.equal(receipt.url, `${env.CLIENT_URL}/uploads/${receipt.filename}`);
    assert.equal(readFileSync(path.join(dir, receipt.filename), 'utf8'), 'test-photo-bytes');
    assert.equal(await (await fetch(`${base}/uploads/${receipt.filename}`)).text(), 'test-photo-bytes');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
