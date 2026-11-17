import { retainEvent } from './recentEvents.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

const context = new AsyncLocalStorage();
const allowedEvents = new Set([
  'http.completed',
  'dependency.completed',
  'job.started',
  'job.completed',
]);
const allowedFields = new Set([
  'request_id',
  'trace_id',
  'span_id',
  'parent_span_id',
  'run_id',
  'route_id',
  'route',
  'method',
  'status_code',
  'duration_ms',
  'outcome',
  'dependency',
  'operation',
  'job',
  'error_type',
]);
const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.*:/{}()?-]{1,180}$/.test(value);

export const traceContext = () => context.getStore();
export const newSpanId = () => randomBytes(8).toString('hex');
export const newTraceId = () => randomBytes(16).toString('hex');
export const inTraceContext = (value, work) => context.run(value, work);

// Do not serialize Error, request, response, payload or arbitrary fields here.
// A failed telemetry sink must never fail an application operation.
export function emitTelemetry(event, fields = {}, sink = (line) => console.info(line)) {
  if (process.env.MATTER_TELEMETRY_ENABLED === '0' || !allowedEvents.has(event)) return;
  const record = { timestamp: new Date().toISOString(), service: 'matter-admin', event };
  const release = process.env.MATTER_RELEASE_SHA;
  if (/^[a-f0-9]{7,40}$/.test(release || '')) record.release = release;
  for (const [key, value] of Object.entries({ ...traceContext(), ...fields })) {
    if (!allowedFields.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) record[key] = value;
    else if (label(value)) record[key] = value;
  }
  try {
    retainEvent(record);
    sink(JSON.stringify(record));
  } catch {
    /* Application responses remain independent of logging. */
  }
}

// Call around each execution, never around timer registration. A completed run
// records the returned outcome; a caught failure inside work must be marked there.
export async function traceJob(job, work) {
  const value = { trace_id: newTraceId(), span_id: newSpanId(), run_id: randomUUID(), job };
  const began = performance.now();
  return inTraceContext(value, async () => {
    emitTelemetry('job.started', { job });
    try {
      const result = await work();
      let outcome = 'completed';
      if (result?.complete === false || result?.failed > 0) outcome = 'partial';
      if (result?.status === 'failed') outcome = 'failed';
      if (['not-configured', 'already-running', 'already-claimed'].includes(result?.status))
        outcome = 'skipped';
      emitTelemetry('job.completed', { job, outcome, duration_ms: performance.now() - began });
      return result;
    } catch (error) {
      emitTelemetry('job.completed', {
        job,
        outcome: 'failed',
        error_type: 'job_error',
        duration_ms: performance.now() - began,
      });
      throw error;
    }
  });
}

// Explicit call wrapper preserves the provider client's existing defaults,
// test adapters, request arguments, retries and returned response/error objects.
export async function traceDependency(dependency, operation, work) {
  const parent = traceContext();
  const child = {
    ...parent,
    trace_id: parent?.trace_id || newTraceId(),
    span_id: newSpanId(),
    parent_span_id: parent?.span_id,
  };
  const began = performance.now();
  return inTraceContext(child, async () => {
    try {
      const result = await work();
      emitTelemetry('dependency.completed', {
        dependency,
        operation,
        status_code: result?.status || 0,
        outcome: result?.status >= 400 ? 'rejected' : 'completed',
        duration_ms: performance.now() - began,
      });
      return result;
    } catch (error) {
      emitTelemetry('dependency.completed', {
        dependency,
        operation,
        status_code: error.response?.status || 0,
        outcome: ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) ? 'timeout' : 'failed',
        duration_ms: performance.now() - began,
      });
      throw error;
    }
  });
}
