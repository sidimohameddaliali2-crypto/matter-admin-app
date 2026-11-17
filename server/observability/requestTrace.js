import { responseIssue } from './activityIssues.js';
import { randomUUID } from 'node:crypto';
import { emitTelemetry, inTraceContext, newTraceId, newSpanId } from './telemetry.js';

export function createRequestTrace({ resolveRoute = () => null, sink } = {}) {
  return (req, res, next) => {
    // Public input cannot choose log IDs, route names or sampling decisions.
    const action = req.headers['x-matter-activity-id'];
    const actionId =
      typeof action === 'string' && /^[a-f0-9-]{36}$/i.test(action) ? action : undefined;
    const value = {
      request_id: randomUUID(),
      trace_id: newTraceId(),
      span_id: newSpanId(),
      request: req,
      actionId,
    };
    req.activityContext = value;
    const began = performance.now();
    const route = resolveRoute(req.method, req.url) || { id: 'unmatched', path: 'unmatched' };
    req.activityRoute = route;
    req.requestId = value.request_id;
    if (req.app.get('activityHistoryEnabled')) {
      const json = res.json;
      res.json = function (body) {
        res.locals.activityIssue = responseIssue(body, res.statusCode);
        res.locals.activityResponseFailed = body?.success === false;
        res.locals.activityResponsePartial =
          body?.complete === false || body?.data?.complete === false;
        if (route.path === '/api/health' && body?.database === 'disconnected') {
          res.locals.activityResponseFailed = true;
          res.locals.activityIssue = 'The app cannot currently reach its database.';
        }
        if (route.path === '/api/auth/login' && res.statusCode < 400 && body?.data?.user?._id)
          req.activityVerifiedLogin = body.data.user;
        return json.call(this, body);
      };
    }
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
      if (req.app.get('activityHistoryEnabled')) {
        void import('./activityStore.js')
          .then(({ recordRequestActivity }) =>
            recordRequestActivity(req, res, { route, disconnected, context: value }),
          )
          .catch(() => console.error('ACTIVITY_HISTORY_WRITE_FAILED'));
      }
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
