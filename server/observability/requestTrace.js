import { randomUUID } from 'node:crypto';
import { emitTelemetry, inTraceContext, newTraceId, newSpanId } from './telemetry.js';

export function createRequestTrace({ resolveRoute = () => null, sink } = {}) {
  return (req, res, next) => {
    // Public input cannot choose log IDs, route names or sampling decisions.
    const value = { request_id: randomUUID(), trace_id: newTraceId(), span_id: newSpanId() };
    const began = performance.now();
    const route = resolveRoute(req.method, req.url) || { id: 'unmatched', path: 'unmatched' };
    req.requestId = value.request_id;
    res.setHeader('X-Request-ID', value.request_id);
    res.locals.traceOutcome = undefined;
    let recorded = false;
    const record = (disconnected) => {
      if (recorded) return;
      recorded = true;
      let outcome =
        res.statusCode >= 500 ? 'server_error' : res.statusCode >= 400 ? 'rejected' : 'completed';
      if (['degraded', 'partial', 'failed'].includes(res.locals.traceOutcome))
        outcome = res.locals.traceOutcome;
      if (disconnected) outcome = 'disconnected';
      emitTelemetry(
        'http.completed',
        {
          ...value,
          route_id: route.id,
          route: route.path,
          method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)
            ? req.method
            : 'OTHER',
          status_code: disconnected ? 0 : res.statusCode,
          outcome,
          duration_ms: performance.now() - began,
        },
        sink,
      );
    };
    res.once('finish', () => record(false));
    res.once('close', () => record(!res.writableFinished));
    inTraceContext(value, next);
  };
}
