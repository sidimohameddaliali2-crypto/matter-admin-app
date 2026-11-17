import { randomUUID } from 'node:crypto';

const maxRunMs = 300_000;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const month = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const requireBudget = (condition, message) => { if (!condition) throw Error(message); };

// Admission for the fixed server, independent of the preserved Vercel money
// ledgers. All pools on one backend share slots. The source supervisor's heavy
// work lock and child timeout provide the cross-process and execution bounds.
// An unfinished slot is never recycled on a timer: that work may still run.
export function createDriverAuditFixedHostBudgetFactory({ maxConcurrent = 4, maxReservations = 10_000 } = {}) {
  requireBudget(integer(maxConcurrent, 1, 4) && integer(maxReservations, 1, 10_000), 'Invalid fixed host admission bounds');
  const active = new Map(), seen = new Set();
  return function createExecutionBudget({ clock = Date.now, requestId = randomUUID,
    key = 'worker-budget', policy = { reservationMicros: 40_000, maxRunMs } } = {}) {
    requireBudget(typeof clock === 'function' && typeof requestId === 'function'
      && typeof key === 'string' && /^(?:worker|reader)-budget(?:-[a-zA-Z0-9._:-]{1,140})?$/.test(key)
      && policy?.maxRunMs === maxRunMs && integer(policy.reservationMicros, 40_000, 150_000),
    'Invalid fixed host budget dependencies or policy');
    const maximum = policy.reservationMicros, owner = Symbol(key);
    let lastTime = 0;
    const now = () => {
      const time = clock();
      requireBudget(integer(time, lastTime, 8_640_000_000_000_000), 'Invalid fixed host budget clock');
      lastTime = time;
      return time;
    };
    const amount = value => requireBudget(integer(value, 40_000, maximum), 'Invalid fixed host reservation amount');
    const identity = reservation => {
      requireBudget(reservation?.allowed === true && typeof reservation.id === 'string' && uuid.test(reservation.id)
        && typeof reservation.period === 'string' && month.test(reservation.period)
        && integer(reservation.startedAtMs, 0, 8_640_000_000_000_000), 'Invalid fixed host budget reservation');
      amount(reservation.reservationMicros);
      const current = active.get(reservation.id);
      if (current) requireBudget(current.owner === owner && current.period === reservation.period
        && current.startedAtMs === reservation.startedAtMs && current.reservationMicros >= reservation.reservationMicros,
      'Fixed host budget reservation mismatch');
      return current;
    };
    const duration = current => {
      const elapsed = now() - current.startedAtMs;
      requireBudget(integer(elapsed, 0, maxRunMs), 'Uncertain fixed host worker duration');
      return elapsed;
    };
    const receipt = current => ({ allowed: true, id: current.id, period: current.period,
      startedAtMs: current.startedAtMs, reservationMicros: current.reservationMicros });
    return {
      async reserve({ reservationMicros = maximum } = {}) {
        amount(reservationMicros);
        const time = now(), period = new Date(time).toISOString().slice(0, 7);
        requireBudget(month.test(period), 'Invalid fixed host budget period');
        if (active.size >= maxConcurrent) return { allowed: false, period, reason: 'concurrency-limit' };
        if (seen.size >= maxReservations) return { allowed: false, period, reason: 'admission-limit' };
        const id = requestId();
        requireBudget(typeof id === 'string' && uuid.test(id), 'Invalid fixed host budget request');
        requireBudget(!seen.has(id), 'Duplicate fixed host budget request');
        const current = { id, period, startedAtMs: time, reservationMicros, owner };
        seen.add(id);
        active.set(id, current);
        return receipt(current);
      },
      async increase(reservation, { reservationMicros = maximum } = {}) {
        const current = identity(reservation);
        amount(reservationMicros);
        if (!current) return { ...reservation, allowed: false, reason: 'not-active' };
        duration(current);
        current.reservationMicros = Math.max(current.reservationMicros, reservationMicros);
        return receipt(current);
      },
      async settle(reservation, { elapsedMs, extraMicros = 0, preReservationMs = 0, cpuMicros } = {}) {
        const current = identity(reservation);
        if (!current) return { settled: false, reason: 'not-active' };
        requireBudget(current.reservationMicros === reservation.reservationMicros, 'Fixed host budget reservation mismatch');
        const wallMs = duration(current);
        requireBudget(integer(elapsedMs, 0, maxRunMs) && integer(preReservationMs, 0, elapsedMs)
          && wallMs + preReservationMs + 10 >= elapsedMs, 'Uncertain fixed host worker duration');
        requireBudget(integer(extraMicros, 0, current.reservationMicros), 'Invalid fixed host additional measurement');
        requireBudget(cpuMicros === undefined || integer(cpuMicros, 0, elapsedMs * 2000 + 1_000_000),
          'Uncertain fixed host reader compute measurement');
        active.delete(reservation.id);
        return { settled: true, period: current.period, chargedMicros: 0, accountingBasis: 'fixed-host-execution-v1' };
      },
    };
  };
}
