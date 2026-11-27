import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../client/public/service-worker.js', import.meta.url), 'utf8');
const origin = 'https://dispatch.example.test';
const fleetOptions = { url: origin + '/api/dispatcher-fleet/options?reload=1', method: 'GET' };
const fleetSave = { url: origin + '/api/Dispatcher-Fleet/', method: 'POST' };
const delivery = { url: origin + '/api/deliveries', method: 'GET' };

function worker({ fetch, caches }) {
  const events = new Map();
  vm.runInNewContext(source, {
    self: { addEventListener: (type, handler) => events.set(type, handler), clients: { claim() {} } },
    location: { origin }, caches, fetch, URL, Response, console: { log() {} },
  });
  return events;
}

test('fleet reads and writes bypass old offline cache entries and network HTTP caching', async () => {
  const calls = [];
  const offline = new Error('offline');
  const events = worker({
    fetch: async (request, options) => { calls.push([request, options?.cache]); throw offline; },
    caches: { match: async () => Response.json({ data: ['stale staff roster'] }) },
  });
  for (const request of [fleetOptions, fleetSave]) {
    let response;
    events.get('fetch')({ request, respondWith: promise => { response = promise; } });
    await assert.rejects(response, offline);
  }
  assert.deepEqual(calls, [[fleetOptions, 'no-store'], [fleetSave, 'no-store']]);
});

test('activating the worker removes existing fleet cache entries without removing delivery data', async () => {
  const removed = [];
  const events = worker({
    caches: {
      keys: async () => [],
      open: async () => ({
        keys: async () => [fleetOptions, delivery, fleetSave],
        delete: async request => removed.push(request),
      }),
    },
  });
  let cleanup;
  events.get('activate')({ waitUntil: promise => { cleanup = promise; } });
  await cleanup;
  assert.deepEqual(removed, [fleetOptions, fleetSave]);
});
