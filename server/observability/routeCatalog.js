import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pathToRegexp from 'path-to-regexp';

const catalog = JSON.parse(
  readFileSync(new URL('../../docs/traceability/routes.json', import.meta.url), 'utf8'),
);
const routes = catalog.api.map((route) => ({ ...route, matcher: pathToRegexp(route.path) }));
const boundaries = catalog.boundaries
  .filter((route) => route.path !== '/*')
  .map((route) => ({
    id: 'boundary_' + createHash('sha256').update(route.path).digest('hex').slice(0, 16),
    path: route.path,
    matcher: pathToRegexp(route.path),
  }));

export function resolveTraceRoute(method, url) {
  // Keep raw URLs local to matching. Only source-declared templates enter telemetry.
  const pathname = String(url || '').split('?')[0];
  // Audit and SDK handlers run before the normal Express routers.
  const boundary = boundaries.find((route) => route.matcher.test(pathname));
  if (boundary) return boundary;
  return routes.find(
    (route) =>
      (route.method === method ||
        route.method === 'ALL' ||
        (method === 'HEAD' && route.method === 'GET')) &&
      route.matcher.test(pathname),
  );
}
