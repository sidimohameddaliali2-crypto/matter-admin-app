import { emitTelemetry, traceContext, newTraceId, newSpanId } from './telemetry.js';

export function instrumentAxios(client, dependency, sink) {
  client.interceptors.request.use((config) => {
    const parent = traceContext();
    config.__matterTrace = {
      began: performance.now(),
      context: {
        request_id: parent?.request_id,
        run_id: parent?.run_id,
        trace_id: parent?.trace_id || newTraceId(),
        parent_span_id: parent?.span_id,
        span_id: newSpanId(),
      },
    };
    return config;
  });
  const record = (config, status, outcome) => {
    const trace = config?.__matterTrace;
    if (!trace || trace.recorded) return;
    trace.recorded = true;
    emitTelemetry(
      'dependency.completed',
      {
        ...trace.context,
        dependency,
        operation: 'http',
        method: String(config.method || 'get').toUpperCase(),
        status_code: status || 0,
        outcome,
        duration_ms: performance.now() - trace.began,
      },
      sink,
    );
  };
  client.interceptors.response.use(
    (response) => {
      record(response.config, response.status, response.status >= 400 ? 'rejected' : 'completed');
      return response;
    },
    (error) => {
      record(
        error.config,
        error.response?.status,
        error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ? 'timeout' : 'failed',
      );
      return Promise.reject(error);
    },
  );
  return client;
}
