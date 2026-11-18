import { createHash, randomUUID } from 'node:crypto';

const key = 'app-sidi-report-worker-claim';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const validSlot = value => validTime(value) && /T(?:06:30|08:00):00\.000Z$/.test(value);
const check = (condition, message) => { if (!condition) throw Error(message); };

function parse(row) {
  check(Number.isSafeInteger(row?.revision) && row.revision >= 0, 'The report slot revision differs');
  if (row.revision === 0 && row.body === null) return null;
  check(row.revision > 0 && typeof row.body === 'string' && Buffer.byteLength(row.body) <= 1024,
    'The stored report slot claim differs');
  const value = JSON.parse(row.body);
  check(value?.version === 1 && Object.keys(value).length === 6 && uuid(value.owner)
    && validSlot(value.scheduledAt) && validTime(value.enrolledAt) && value.scheduledAt >= value.enrolledAt
    && hex(value.syncConfigSha256) && hex(value.sourceConfigSha256), 'The stored report slot identity differs');
  return value;
}

// Use the shared report database to claim a calendar slot before an ephemeral
// runner can open the delivery/GPS/photo source. A crashed owner does not make
// the same paid or published work eligible again. Noon remains a new slot.
export function createDriverAuditHostedSlots({ state, clock = Date.now, owner = randomUUID() } = {}) {
  check(typeof state?.read === 'function' && typeof state?.compareAndSwap === 'function'
    && typeof clock === 'function' && uuid(owner), 'A durable report slot owner is required');
  return Object.freeze({
    async claim({ scheduledAt, enrolledAt, syncConfigSha256, sourceConfigSha256 } = {}) {
      check(validSlot(scheduledAt) && validTime(enrolledAt) && scheduledAt >= enrolledAt
        && Date.parse(scheduledAt) <= clock() && clock() - Date.parse(scheduledAt) <= 16 * 60 * 60 * 1000
        && hex(syncConfigSha256) && hex(sourceConfigSha256), 'The hosted report slot is unavailable');
      const prior = await state.read(key), found = parse(prior);
      if (found?.scheduledAt >= scheduledAt) return false;
      const body = JSON.stringify({ version: 1, owner, scheduledAt, enrolledAt, syncConfigSha256, sourceConfigSha256 });
      const eventId = 'worker-claim-' + sha(scheduledAt);
      const event = JSON.stringify({ kind: 'driver-report-worker-slot-admission', scheduledAt, owner });
      const request = JSON.stringify({ kind: 'driver-report-worker-slot-admission', expectedRevision: prior.revision, bodySha256: sha(body) });
      let failure;
      try {
        const result = await state.compareAndSwap({ key, expectedRevision: prior.revision, eventId, body, event, request });
        check(result?.body_text === body && result.body_sha256 === sha(body), 'The hosted report slot acknowledgement differs');
      } catch (error) { failure = error; }
      const actual = await state.read(key), identity = parse(actual);
      if (actual.revision === prior.revision + 1 && actual.body === body) return true;
      if (identity?.scheduledAt >= scheduledAt) return false;
      throw failure ?? Error('The hosted report slot was not verified');
    },
  });
}
