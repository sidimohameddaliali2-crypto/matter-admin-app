import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTraceabilityRouter } from '../routes/traceability.js';
import { retainEvent, recentEvents } from './recentEvents.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('all history and diagnostic reads require the exact approved account, including against other super-admins', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'activity-private-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  process.env.MATTER_ACTIVITY_READERS_FILE = path.join(directory, 'readers.json');
  const approved = '111111111111111111111111';
  await writeFile(process.env.MATTER_ACTIVITY_READERS_FILE, JSON.stringify({ version: 1, readerIds: [approved] }), { mode: 0o600 });
  const app = express();
  app.use(
    '/api/traceability',
    createTraceabilityRouter({
      authenticate(req, res, next) {
        if (!req.headers['x-fixture-role']) return res.sendStatus(401);
        req.user = { _id: req.headers['x-fixture-id'], role: req.headers['x-fixture-role'], isActive: true };
        next();
      },
      activityReader: async () => ({ events: [], storage: { durable: true } }),
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
  for (const path of ['activity', 'catalog', 'events']) {
    assert.equal((await fetch(`${origin}/api/traceability/${path}`)).status, 401);
    assert.equal(
      (
        await fetch(`${origin}/api/traceability/${path}`, {
          headers: { 'x-fixture-role': 'admin' },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(`${origin}/api/traceability/${path}`, { headers: { 'x-fixture-role': 'super_admin', 'x-fixture-id': '222222222222222222222222', 'x-can-view-activity-history': 'true' } })).status, 403);
    const response = await fetch(`${origin}/api/traceability/${path}`, { headers: { 'x-fixture-role': 'admin', 'x-fixture-id': approved } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const value = await response.json();
    if (path === 'catalog') {
      assert.ok(value.data.api.length > 400);
      assert.ok(value.data.areas.length > 20);
    } else if (path === 'events') {
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
