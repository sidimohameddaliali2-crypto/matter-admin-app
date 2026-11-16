import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTraceabilityRouter } from '../routes/traceability.js';
import { retainEvent, recentEvents } from './recentEvents.js';

test('catalog and recent diagnostics enforce super-admin access and avoid caching', async (t) => {
  const app = express();
  app.use(
    '/api/traceability',
    createTraceabilityRouter({
      authenticate(req, res, next) {
        if (!req.headers['x-fixture-role']) return res.sendStatus(401);
        req.user = { role: req.headers['x-fixture-role'] };
        next();
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['catalog', 'events']) {
    assert.equal((await fetch(`${origin}/api/traceability/${path}`)).status, 401);
    assert.equal(
      (
        await fetch(`${origin}/api/traceability/${path}`, {
          headers: { 'x-fixture-role': 'admin' },
        })
      ).status,
      403,
    );
    const response = await fetch(`${origin}/api/traceability/${path}`, {
      headers: { 'x-fixture-role': 'super_admin' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const value = await response.json();
    if (path === 'catalog') {
      assert.ok(value.data.api.length > 400);
      assert.ok(value.data.areas.length > 20);
    } else {
      assert.equal(value.data.retentionMinutes, 30);
      assert.equal(value.data.preview, false);
    }
  }
});

test('recent events expire and have a hard memory bound', () => {
  retainEvent({
    timestamp: new Date(Date.now() - 31 * 60000).toISOString(),
    request_id: 'expired',
  });
  assert.ok(!recentEvents().events.some((row) => row.request_id === 'expired'));
  for (let index = 0; index < 2010; index++)
    retainEvent({ timestamp: new Date().toISOString(), request_id: String(index) });
  const value = recentEvents();
  assert.equal(value.events.length, 2000);
  assert.equal(value.events[0].request_id, '2009');
});
