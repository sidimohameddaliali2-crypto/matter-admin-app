import { randomUUID } from 'node:crypto';

const MAX_EVENTS = 2000;
const RETENTION_MS = 30 * 60 * 1000;
const instanceId = randomUUID();
const startedAt = new Date().toISOString();
const events = [];

export function retainEvent(record) {
  const cutoff = Date.now() - RETENTION_MS;
  while (events.length && (events.length >= MAX_EVENTS || Date.parse(events[0].timestamp) < cutoff))
    events.shift();
  events.push(Object.freeze({ ...record }));
}

export function recentEvents() {
  const cutoff = Date.now() - RETENTION_MS;
  while (events.length && Date.parse(events[0].timestamp) < cutoff) events.shift();
  return {
    instanceId,
    startedAt,
    retentionMinutes: 30,
    maxEvents: MAX_EVENTS,
    enabled: process.env.MATTER_TELEMETRY_ENABLED !== '0',
    events: events.slice().reverse(),
  };
}
