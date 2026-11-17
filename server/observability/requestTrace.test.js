import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import axios from 'axios';
import { createRequestTrace } from './requestTrace.js';
import { resolveTraceRoute } from './routeCatalog.js';
import { instrumentAxios } from './axiosTrace.js';
import { traceContext, traceJob, emitTelemetry, inTraceContext } from './telemetry.js';

async function fixture(t) {
  const records = [];
  const sink = (line) => records.push(JSON.parse(line));
  const app = express();
  app.use(createRequestTrace({ resolveRoute: resolveTraceRoute, sink }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { app, records, sink, origin: `http://127.0.0.1:${server.address().port}` };
}

test('early raw handler, body-parser failure, denied auth and handled errors each retain one reference', async (t) => {
  const { app, origin, records } = await fixture(t);
  app.use('/api/driver-audits/session', (req, res) => {
    res.writeHead(503);
    res.end('unavailable');
  });
  app.use(express.json());
  app.get('/api/truckoom/vehicles', (_req, res) => res.status(403).json({ success: false }));
  app.get('/api/health', (_req, _res, next) => next(Error('PRIVATE_ERROR')));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false }));
  for (const [url, options, status] of [
    ['/api/driver-audits/session', {}, 503],
    [
      '/api/truckoom/vehicles?token=PRIVATE_QUERY',
      { headers: { 'x-request-id': 'PRIVATE_INJECTED' } },
      403,
    ],
    ['/api/health', {}, 500],
    [
      '/api/health',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{PRIVATE_BODY' },
      400,
    ],
  ]) {
    const response = await fetch(origin + url, options);
    await response.text();
    assert.equal(response.status, status);
    assert.match(response.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
    assert.equal(records.at(-1).request_id, response.headers.get('x-request-id'));
  }
  assert.equal(records.length, 4);
  assert.ok(!JSON.stringify(records).includes('PRIVATE'));
});

test('concurrent requests keep separate dependency contexts and preserve degraded 200 responses', async (t) => {
  const { app, origin, records, sink } = await fixture(t);
  const client = instrumentAxios(
    axios.create({
      adapter: async (config) => {
        await new Promise((resolve) => setTimeout(resolve, config.url === '/one' ? 20 : 1));
        return { config, status: 200, data: 'PRIVATE_PROVIDER_BODY', headers: {} };
      },
    }),
    'truckoom',
    sink,
  );
  app.get('/api/truckoom/vehicles', async (req, res) => {
    const before = traceContext();
    await client.get(req.query.slow ? '/one' : '/two', {
      headers: { Authorization: 'PRIVATE_CREDENTIAL' },
    });
    assert.equal(traceContext(), before);
    res.locals.traceOutcome = 'degraded';
    res.json({ success: true, trackerWarning: 'unavailable', data: [] });
  });
  const responses = await Promise.all([
    fetch(origin + '/api/truckoom/vehicles?slow=1'),
    fetch(origin + '/api/truckoom/vehicles'),
  ]);
  assert.deepEqual(await responses[0].json(), {
    success: true,
    trackerWarning: 'unavailable',
    data: [],
  });
  await responses[1].text();
  const completed = records.filter((r) => r.event === 'http.completed');
  assert.equal(completed.length, 2);
  assert.equal(new Set(completed.map((r) => r.trace_id)).size, 2);
  for (const request of completed) {
    const dependency = records.find(
      (r) => r.event === 'dependency.completed' && r.trace_id === request.trace_id,
    );
    assert.equal(dependency.request_id, request.request_id);
    assert.equal(dependency.parent_span_id, request.span_id);
    assert.equal(request.outcome, 'degraded');
    assert.equal(request.status_code, 200);
  }
  assert.ok(!JSON.stringify(records).includes('PRIVATE'));
});

test('disconnect is recorded once and telemetry failure cannot break a response', async (t) => {
  const { app, origin, records } = await fixture(t);
  app.get('/wait', (_req, res) => {
    res.write('first');
  });
  await new Promise((resolve, reject) => {
    const request = http.get(origin + '/wait', (response) => {
      response.once('data', () => {
        response.destroy();
        resolve();
      });
    });
    request.on('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'disconnected');
  assert.equal(records[0].status_code, 0);
  const safe = express();
  safe.use(
    createRequestTrace({
      sink: () => {
        throw Error('sink unavailable');
      },
    }),
  );
  safe.get('/', (_req, res) => res.json({ ok: true }));
  const server = safe.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const result = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.deepEqual(await result.json(), { ok: true });
});

test('route matching uses declared templates for tokens and dynamic IDs, including nested OAuth', () => {
  assert.equal(
    resolveTraceRoute('GET', '/api/deliveries/private-customer-id?secret=abc').path,
    '/api/deliveries/:id',
  );
  assert.equal(resolveTraceRoute('POST', '/api/mcp/oauth/consent').path, '/api/mcp/oauth/consent');
  assert.equal(resolveTraceRoute('POST', '/api/mcp/oauth/token').path, '/api/mcp/oauth/token');
  assert.equal(resolveTraceRoute('GET', '/report-data/private-file').path, '/report-data/*');
  assert.ok(!resolveTraceRoute('GET', '/private-unknown')?.path.includes('private-unknown'));
});

test('job context is fresh for each run, preserves returned values and errors, and records partial/skipped/failed', async () => {
  const records = [];
  const original = console.info;
  console.info = (line) => records.push(JSON.parse(line));
  try {
    const parent = { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) };
    await inTraceContext(parent, async () => {
      for (const result of [
        { complete: false },
        { status: 'failed' },
        { status: 'already-running' },
      ]) {
        assert.equal(await traceJob('test-job', async () => result), result);
      }
      const error = Error('PRIVATE_FAILURE');
      await assert.rejects(
        traceJob('test-job', async () => {
          throw error;
        }),
        (e) => e === error,
      );
      assert.equal(traceContext(), parent);
    });
  } finally {
    console.info = original;
  }
  const completions = records.filter((r) => r.event === 'job.completed');
  assert.deepEqual(
    completions.map((r) => r.outcome),
    ['partial', 'failed', 'skipped', 'failed'],
  );
  assert.equal(new Set(completions.map((r) => r.run_id)).size, 4);
  assert.ok(completions.every((r) => r.trace_id !== 'a'.repeat(32)));
  assert.ok(!JSON.stringify(records).includes('PRIVATE'));
});

test('only allowed fields reach JSON and instrumentation preserves Axios failure identity', async () => {
  const lines = [];
  emitTelemetry(
    'http.completed',
    {
      route: 'unmatched',
      authorization: 'PRIVATE',
      payload: { secret: 'PRIVATE' },
      duration_ms: Infinity,
    },
    (line) => lines.push(line),
  );
  assert.ok(!lines[0].includes('PRIVATE'));
  assert.ok(!lines[0].includes('duration_ms'));
  const records = [];
  const error = new Error('PRIVATE');
  error.code = 'ECONNABORTED';
  const client = instrumentAxios(
    axios.create({
      adapter: async (config) => {
        error.config = config;
        throw error;
      },
    }),
    'matter-nutrition',
    (line) => records.push(JSON.parse(line)),
  );
  await assert.rejects(client.get('/private'), (value) => value === error);
  assert.equal(records[0].outcome, 'timeout');
  assert.ok(!JSON.stringify(records).includes('PRIVATE'));
});
