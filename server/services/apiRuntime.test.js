import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apiRuntimeSettings, createApiRuntime } from './apiRuntime.js';

test('unmanaged startup retains jobs, managed web startup requires explicit isolated settings', () => {
  assert.equal(apiRuntimeSettings({}), null);
  assert.throws(() => apiRuntimeSettings({ MATTER_API_WEB_ONLY: '1' }));
  const valid = { MATTER_API_RELEASE: 'a'.repeat(40) + '-1-1', MATTER_API_PORT: '35000', MATTER_SHARED_SERVER_ROOT: '/shared/server', MATTER_API_WEB_ONLY: '1' };
  assert.equal(apiRuntimeSettings(valid).port, 35000);
  for (const change of [{ MATTER_API_WEB_ONLY: '0' }, { MATTER_API_PORT: '5000' }, { MATTER_SHARED_SERVER_ROOT: 'relative' }, { MATTER_API_RELEASE: '../escape' }]) assert.throws(() => apiRuntimeSettings({ ...valid, ...change }));
});
test('readiness is live and request completion is counted once across finish and close', () => {
  let ready = false;
  const runtime = createApiRuntime({ settings: { releaseId: 'fixture' }, readiness: () => ({ ready }) });
  const response = new EventEmitter(); let next = false;
  runtime.track({}, response, () => { next = true; });
  assert.equal(next, true); assert.equal(runtime.status().activeRequests, 1);
  assert.equal(runtime.status().backgroundJobs, false); assert.equal(runtime.status().ready, false);
  ready = true; assert.equal(runtime.status().ready, true);
  response.emit('finish'); response.emit('close'); assert.equal(runtime.status().activeRequests, 0);
});
