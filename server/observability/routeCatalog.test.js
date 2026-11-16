import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveTraceRoute } from './routeCatalog.js';

test('route inventory matches the current owning source and covers installer and nested routers', () => {
  execFileSync(process.execPath, ['scripts/generateRouteMap.js', '--check'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  const catalog = JSON.parse(
    readFileSync(new URL('../../docs/traceability/routes.json', import.meta.url)),
  );
  assert.ok(catalog.api.length > 400);
  assert.ok(catalog.browser.length >= 50);
  assert.equal(
    resolveTraceRoute('GET', '/api/customer-service/policy').path,
    '/api/customer-service/policy',
  );
  assert.equal(
    resolveTraceRoute('GET', '/api/mcp/oauth/consent.js').path,
    '/api/mcp/oauth/consent.js',
  );
  assert.ok(catalog.rawDispatch.some((row) => row.pathLiteral === '/api/reporting/reviews'));
  assert.ok(catalog.socketEvents.some((row) => row.event === 'driver:join'));
  assert.ok(
    catalog.unmounted.some((row) => row.file === 'server/routes/customerServiceWebhook.js'),
  );
});
