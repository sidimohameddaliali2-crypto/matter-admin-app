import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { before, after, test } from 'node:test';
import { validateDriverAuditPollProgressBody, validateDriverAuditPollProgressWrite } from './driverAuditPollProgress.js';

const execute = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const migration = new URL('../migrations/20261117103823_driver_audit_app_poll_progress.sql', import.meta.url);
const bin = process.env.DRIVER_AUDIT_TEST_PG_BIN, skip = !bin;
const originalLeaseDefinitions = [
  "CREATE OR REPLACE FUNCTION matter_reporting_hosted.lease_acquire(p_owner uuid, p_ttl integer)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE old matter_reporting_hosted.collector_lease%ROWTYPE; next_token bigint; until_at timestamptz;\nBEGIN\n IF p_owner IS NULL OR p_ttl IS NULL OR p_ttl<30 OR p_ttl>900 THEN RAISE EXCEPTION 'Invalid collector lease'; END IF;\n PERFORM pg_advisory_xact_lock(hashtextextended('matter_reporting_hosted/lease/collector',0));\n SELECT * INTO old FROM matter_reporting_hosted.collector_lease WHERE name='collector';\n IF FOUND AND old.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'Collector lease unavailable' USING ERRCODE='55P03'; END IF;\n IF COALESCE(old.token,0)>=9007199254740991 THEN RAISE EXCEPTION 'Collector lease exhausted'; END IF;\n next_token:=COALESCE(old.token,0)+1;until_at:=clock_timestamp()+make_interval(secs=>p_ttl);\n INSERT INTO matter_reporting_hosted.collector_lease(name,owner_id,token,expires_at) VALUES('collector',p_owner,next_token,until_at)\n ON CONFLICT(name) DO UPDATE SET owner_id=EXCLUDED.owner_id,token=EXCLUDED.token,expires_at=EXCLUDED.expires_at;\n RETURN jsonb_build_object('token',next_token::text,'expiresAt',until_at);\nEND $function$\n",
  "CREATE OR REPLACE FUNCTION matter_reporting_hosted.lease_assert(p_owner uuid, p_token bigint)\n RETURNS boolean\n LANGUAGE sql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\n SELECT EXISTS(SELECT 1 FROM matter_reporting_hosted.collector_lease WHERE name='collector' AND owner_id=p_owner AND token=p_token AND expires_at>clock_timestamp())\n$function$\n",
  "CREATE OR REPLACE FUNCTION matter_reporting_hosted.lease_release(p_owner uuid, p_token bigint)\n RETURNS boolean\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nBEGIN\n PERFORM pg_advisory_xact_lock(hashtextextended('matter_reporting_hosted/lease/collector',0));\n UPDATE matter_reporting_hosted.collector_lease SET expires_at=clock_timestamp() WHERE name='collector' AND owner_id=p_owner AND token=p_token AND expires_at>clock_timestamp();\n RETURN FOUND;\nEND $function$\n",
  "CREATE OR REPLACE FUNCTION matter_reporting_hosted.collector_cas(p_owner uuid, p_token bigint, p_expected bigint, p_event_id text, p_body_text text, p_event_text text, p_request_text text)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog'\nAS $function$\nDECLARE result jsonb;\nBEGIN\n PERFORM pg_advisory_xact_lock(hashtextextended('matter_reporting_hosted/lease/collector',0));\n IF NOT matter_reporting_hosted.lease_assert(p_owner,p_token) THEN RAISE EXCEPTION 'Collector lease expired or superseded' USING ERRCODE='PT409'; END IF;\n result:=matter_reporting_hosted.state_cas_internal('collector-state',p_expected,p_event_id,p_body_text,p_event_text,p_request_text);\n IF NOT matter_reporting_hosted.lease_assert(p_owner,p_token) THEN RAISE EXCEPTION 'Collector lease expired or superseded' USING ERRCODE='PT409'; END IF;\n RETURN result;\nEND $function$\n"
];
let root, data, socket, sql, started = false, original;
const quote = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : "'" + String(value).replaceAll("'", "''") + "'";
const key = 'native-progress:delivery', owner = randomUUID(), digest = 'a'.repeat(64), driver = 'b'.repeat(24);
const time = '2026-11-17T10:00:00.123456Z', day = '2026-11-17';
const delivery = () => ({ version: 1, kind: 'native-delivery-poll-progress', lastPoll: null, lastSuccessfulPollAt: null,
  lastDataChangeAt: null, schedule: { pending: [] }, photoCursor: 0, photoSourceHalt: null });
const gps = () => ({ version: 1, kind: 'native-gps-poll-progress', namespace: 'fixture', turn: 0,
  lastPoll: null, lastSuccessfulPollAt: null, lastDataChangeAt: null, windows: {} });
const gpsKey = 'native-progress:gps:fixture';

before(async () => {
  if (!bin) return;
  assert(path.isAbsolute(bin));
  assert.match((await execute(path.join(bin, 'pg_ctl'), ['--version'])).stdout, /PostgreSQL\) 17\./);
  // macOS's per-user temporary directory exceeds PostgreSQL's socket-path bound.
  root = await fs.realpath(await fs.mkdtemp('/tmp/driver-audit-progress-pg-'));
  data = path.join(root, 'data'); socket = path.join(root, 's'); await fs.mkdir(socket, { mode: 0o700 });
  const env = { ...process.env, LC_ALL: 'C', PGHOST: socket, PGPORT: '58497', PGUSER: 'postgres', PGDATABASE: 'postgres' };
  delete env.PGPASSWORD; delete env.PGSERVICE; delete env.PGSERVICEFILE; delete env.PGOPTIONS;
  await execute(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale'], { env, timeout: 30000 });
  await execute(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(root, 'postgres.log'), '-w', '-t', '30', '-o',
    `-k ${socket} -p 58497 -c listen_addresses='' -c unix_socket_permissions=0700 -c max_connections=12 -c shared_buffers=32MB`, 'start'], { env, timeout: 40000 });
  started = true;
  sql = async statement => (await execute(path.join(bin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', statement],
    { env, timeout: 20000, maxBuffer: 4 * 1024 ** 2 })).stdout.trim();
  await sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA matter_reporting_hosted;
    CREATE TABLE matter_reporting_hosted.collector_lease(name text PRIMARY KEY,owner_id uuid,token bigint NOT NULL,expires_at timestamptz NOT NULL);
    CREATE TABLE matter_reporting_hosted.document(key text PRIMARY KEY,revision bigint,body_text text,updated_at timestamptz DEFAULT now());
    CREATE TABLE matter_reporting_hosted.receipt(key text,revision bigint,event_id text,body_text text,created_at timestamptz);
    CREATE TABLE public.fixture_original_history(id integer PRIMARY KEY,body_text text);
    INSERT INTO matter_reporting_hosted.document VALUES('collector-state',2118,'{"original":true,"observedAt":"2026-11-16T00:00:00.123456Z"}',now()),
      ('review-journal',3,'{"humanReview":"preserve"}',now()),('photo-grading-budget',2,'{"uncertainAttempts":5,"originalLimits":true}',now());
    INSERT INTO matter_reporting_hosted.receipt VALUES('collector-state',2118,'original-event','{"original":true}','2026-11-16 00:00:00.123456+04');
    INSERT INTO public.fixture_original_history VALUES(1,'{"gps":true,"photo":"original"}');`);
  for (const definition of originalLeaseDefinitions) await sql(definition);
  original = await fingerprint();
  await sql(await fs.readFile(migration, 'utf8'));
});
after(async () => {
  if (started) await execute(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop'], { timeout: 40000 });
  if (root) await fs.rm(root, { recursive: true, force: true });
});
async function fingerprint() {
  return sql(`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY key) FROM matter_reporting_hosted.document d),
    'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY key,revision) FROM matter_reporting_hosted.receipt r),
    'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM public.fixture_original_history h),
    'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl::text,pg_get_userbyid(p.proowner)) ORDER BY p.proname)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='matter_reporting_hosted'));`);
}
async function reset() {
  await sql(`TRUNCATE matter_reporting_app.progress_retry,matter_reporting_app.progress,matter_reporting_app.photo_alias,matter_reporting_app.photo_alias_store,
    matter_reporting_app.egress_retry,matter_reporting_app.egress_counter; UPDATE matter_reporting_app.photo_alias_capacity SET rows=0,bytes=0;
    UPDATE matter_reporting_app.egress_policy SET latest_day=NULL; UPDATE matter_reporting_hosted.collector_lease SET expires_at=clock_timestamp()-interval '1 second';`);
}
async function lease() { return JSON.parse(await sql(`SELECT matter_reporting_hosted.lease_acquire(${quote(owner)}::uuid,240);`)); }
function args(value, expected = 0, target = key, held = {}) {
  return bodyArgs(JSON.stringify(value), expected, target, held);
}
function bodyArgs(body, expected = 0, target = key, held = {}) {
  const bodySha256 = hash(body), event = JSON.stringify({ kind: 'native-poll-progress', key: target, phase: 'schedule', bodySha256 });
  return { p_key: target, p_owner: owner, p_token: held.token, p_expected: expected,
    p_event_id: 'progress-' + hash(JSON.stringify([target, expected, bodySha256])), p_body_text: body, p_event_text: event,
    p_request_text: JSON.stringify({ key: target, expectedRevision: expected, bodySha256 }) };
}
async function cas(value) { return JSON.parse(await sql('SET ROLE service_role; SELECT public.matter_hosted_app_progress_cas(' + Object.values(value).map(quote).join(',') + ');')); }
async function rpc(name, ...values) { return JSON.parse(await sql('SET ROLE service_role; SELECT public.' + name + '(' + values.map(quote).join(',') + ');')); }
const reserve = (id, request = 100, response = 1000) => rpc('matter_hosted_app_read_egress_reserve', id, request, response);
const settle = (id, request = 100, response = 200) => rpc('matter_hosted_app_read_egress_settle', id, request, response);
const usage = () => rpc('matter_hosted_app_read_egress_read');
const alias = sha256 => ({ version: 1, provider: 'spaces', identitySha256: 'c'.repeat(64), key: 'photos/original-fixture.jpg', size: 17,
  sha256, kind: 'existing-photo-v1', etag: '"original-etag"', versionId: null });

test('additive migration never replaces original functions or writes original business/evidence tables', async () => {
  const text = await fs.readFile(migration, 'utf8');
  assert(!/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+matter_reporting_hosted/i.test(text));
  assert(!/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(?:matter_reporting_hosted|storage|auth|public)\./i.test(text));
  assert(!text.includes('__GPS_SCHEMA__')); assert(!text.includes('__EGRESS_FUNCTIONS__'));
  assert(text.includes("hashtextextended('matter_reporting_hosted/lease/collector', 0)"));
});
test('original source records, history, microsecond timestamps, function definitions, owners and ACLs remain exact', { skip }, async () => {
  assert.equal(await fingerprint(), original);
});
test('service-only RPC grants and private RLS tables reject anonymous/authenticated callers and direct table access', { skip }, async () => {
  for (const role of ['anon', 'authenticated']) await assert.rejects(sql(`SET ROLE ${role}; SELECT public.matter_hosted_app_progress_read('${key}');`), /42501/);
  await assert.rejects(sql('SET ROLE service_role; SELECT * FROM matter_reporting_app.progress;'), /42501/);
  const result = JSON.parse(await sql(`SELECT jsonb_build_object('rls',(SELECT bool_and(relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='matter_reporting_app' AND c.relkind='r'),
    'functions',(SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog']) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'matter_hosted_app_%'));`));
  assert.equal(result.rls, true); assert.equal(result.functions, true);
});
test('typed delivery/GPS metadata replays exactly and keeps only two retry rows without original receipt growth', { skip }, async () => {
  await reset(); const held = await lease();
  const value = delivery(); value.schedule.pending = [{ day, runId: 'stream-1', nativeCaptureRunId: 'stream-0', nativeCaptureSha256: digest, reason: 'fixture pending' }];
  value.schedule.migrationCheckpointSha256 = digest;
  let request = args(value, 0, key, held); validateDriverAuditPollProgressWrite(request);
  const first = await cas(request), replay = await cas(request); assert.equal(first.revision, 1); assert.equal(replay.replayed, true); assert.equal(replay.body_text, request.p_body_text);
  for (let revision = 1; revision < 6; revision++) { value.photoCursor++; request = args(value, revision, key, held); await cas(request); }
  assert.equal(await sql(`SELECT count(*) FROM matter_reporting_app.progress_retry WHERE key='${key}';`), '2');
  const g = gps(); g.windows[driver + '/' + day] = { driverId: driver, day, scopeKind: 'driver', lastAttemptAt: time, retryAt: null,
    failures: 1, error: { at: time, category: 'http', httpStatus: 429, message: 'Saved GPS refresh failed; previously verified history is retained' } };
  validateDriverAuditPollProgressBody(gpsKey, JSON.stringify(g)); await cas(args(g, 0, gpsKey, held));
  assert.equal((await rpc('matter_hosted_app_progress_read', key)).revision, 6); assert.equal(await fingerprint(), original);
});
test('SQL rejects raw payloads, duplicate JSON properties, forged event/request/hash and nested shape violations', { skip }, async t => {
  await reset(); const held = await lease();
  for (const mutate of [r => { r.p_body_text = r.p_body_text.replace('{', '{"rawPayload":"forbidden",'); },
    r => { r.p_body_text = r.p_body_text.replace('{', '{"kind":"hidden raw","kind":"native-delivery-poll-progress",'); },
    r => { r.p_event_id = 'progress-' + '0'.repeat(64); }, r => { r.p_event_text = '{}'; }, r => { r.p_request_text = '{}'; }]) {
    let r = args(delivery(), 0, key, held); const originalBody = r.p_body_text; mutate(r);
    if (r.p_body_text !== originalBody) r = bodyArgs(r.p_body_text, 0, key, held);
    await assert.rejects(cas(r));
  }
  for (const [name, value] of [['unknown nested', { ...delivery(), schedule: { pending: [], raw: [] } }],
    ['invalid date', { ...delivery(), schedule: { pending: [{ day: '2026-02-30', runId: 'stream-1' }] } }],
    ['unpaired capture', { ...delivery(), schedule: { pending: [{ day, runId: 'stream-1', nativeCaptureRunId: 'stream-0' }] } }],
    ['unsafe integer', { ...delivery(), photoCursor: Number.MAX_SAFE_INTEGER + 1 }],
    ['bad gps window', { ...gps(), windows: { bad: { driverId: driver, day } } }]]) await t.test(name, async () => {
      await assert.rejects(cas(args(value, 0, name === 'bad gps window' ? gpsKey : key, held)));
    });
  assert.equal(await sql('SELECT count(*) FROM matter_reporting_app.progress;'), '0');
});
test('full typed schedule/GPS variants match the existing JavaScript schema including canonical numbers and Unicode bounds', { skip }, async () => {
  const values = [], complete = delivery();
  complete.lastPoll = { runId: 'stream-3', day, startedAt: time, status: 'complete', completedAt: time, unchanged: true,
    captureRunId: 'stream-2', captureSha256: digest, lastDataChangeAt: null };
  complete.lastSuccessfulPollAt = time;
  complete.schedule = { pending: [{ day, runId: 'stream-1', final: true, fresh: false, sourceStarted: true, attempts: 2, nextAttempt: 0.0000001,
    lastFailure: { runId: 'stream-1', day, message: 'Saved source retry' } }], migrationPendingHistory: [], lastDay: day,
    sourceAttempts: { [day]: 1700000000000 }, lastAttempts: { [day]: 1700000000000.25 }, observations: { [day]: 0.5 },
    gaps: [{ reason: 'History is retained', from: day, to: day, count: 1, limit: 4096 }], sourceHalt: { code: 'source_denied', at: time },
    photoSourceHalt: { status: 429, at: time }, migrationCheckpointSha256: digest };
  values.push([key, complete]);
  const g = gps(); g.lastPoll = { driverId: driver, day, startedAt: time, status: 'complete', completedAt: time, unchanged: false, dataSnapshotSha256: digest };
  g.windows[driver + '/' + day] = { driverId: driver, day, scopeKind: 'vehicle', vehicleNo: '😀'.repeat(64),
    rosterReferenceDriverId: driver, lastAttemptAt: time, lastSuccessfulPollAt: time, retryAt: 0.0000001, failures: 0, error: null, refreshToken: 'refresh-token' };
  values.push([gpsKey, g]);
  for (const [target, value] of values) {
    const body = JSON.stringify(value); validateDriverAuditPollProgressBody(target, body);
    await sql('SELECT matter_reporting_app.validate_progress(' + quote(target) + ',' + quote(body) + ');');
  }
  g.windows[driver + '/' + day].vehicleNo += '😀';
  assert.throws(() => validateDriverAuditPollProgressBody(gpsKey, JSON.stringify(g)));
  await assert.rejects(sql('SELECT matter_reporting_app.validate_progress(' + quote(gpsKey) + ',' + quote(JSON.stringify(g)) + ');'));
});
test('progress key/total byte caps refuse rather than evict original current metadata', { skip }, async () => {
  await reset(); const held = await lease();
  await sql(`INSERT INTO matter_reporting_app.progress SELECT 'native-progress:gps:filler'||n,1,'{}',clock_timestamp() FROM generate_series(1,256)n;`);
  await assert.rejects(cas(args(delivery(), 0, key, held)), /key allowance/);
  assert.equal(await sql('SELECT count(*) FROM matter_reporting_app.progress;'), '256');
  await sql(`TRUNCATE matter_reporting_app.progress_retry,matter_reporting_app.progress;
    INSERT INTO matter_reporting_app.progress SELECT 'native-progress:gps:filler'||n,1,repeat('x',CASE WHEN n=64 THEN 983040 ELSE 1048576 END),clock_timestamp() FROM generate_series(1,64)n;`);
  await assert.rejects(cas(args(delivery(), 0, key, held)), /byte allowance/);
  assert.equal(await sql(`SELECT count(*) FROM matter_reporting_app.progress WHERE key='${key}';`), '0');
  assert.equal(await fingerprint(), original);
});
test('wrong, expired, released and superseded leases cannot write progress; original lease lock also blocks acquisition races', { skip }, async () => {
  await reset(); const held = await lease();
  await assert.rejects(cas({ ...args(delivery(), 0, key, held), p_owner: randomUUID() }), /PT409/);
  await sql(`SELECT matter_reporting_hosted.lease_release('${owner}',${held.token});`);
  await assert.rejects(cas(args(delivery(), 0, key, held)), /PT409/);
  const next = await lease(); await assert.rejects(cas(args(delivery(), 0, key, held)), /PT409/);
  const blocker = sql(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('matter_reporting_hosted/lease/collector',0)); SELECT pg_sleep(0.4); COMMIT;`);
  await new Promise(resolve => setTimeout(resolve, 100)); const start = Date.now(); await cas(args(delivery(), 0, key, next));
  assert(Date.now() - start >= 200); await blocker;
});
test('lease expiry during a progress write rolls the current row and retry back in the same transaction', { skip }, async () => {
  await reset(); const held = await lease(), request = args(delivery(), 0, key, held);
  await sql(`CREATE FUNCTION public.fixture_progress_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$;
    CREATE TRIGGER fixture_progress_delay BEFORE INSERT ON matter_reporting_app.progress FOR EACH ROW EXECUTE FUNCTION public.fixture_progress_delay();`);
  try {
    await assert.rejects(sql(`BEGIN; UPDATE matter_reporting_hosted.collector_lease SET expires_at=clock_timestamp()+interval '100 milliseconds';
      SELECT public.matter_hosted_app_progress_cas(${Object.values(request).map(quote).join(',')}); COMMIT;`), /PT409/);
    assert.equal(await sql('SELECT count(*) FROM matter_reporting_app.progress;'), '0');
    assert.equal(await sql('SELECT count(*) FROM matter_reporting_app.progress_retry;'), '0');
  } finally { await sql('DROP TRIGGER fixture_progress_delay ON matter_reporting_app.progress; DROP FUNCTION public.fixture_progress_delay();'); }
});
test('photo aliases are immutable, destination-bound, metadata-only and preserve the first exact admitted reference', { skip }, async () => {
  await reset(); const reference = alias(digest), objectKey = digest + '.gz';
  const first = await rpc('matter_hosted_app_photo_alias_register', objectKey, JSON.stringify(reference));
  assert.deepEqual(first.reference, reference);
  const changed = { ...reference, key: 'photos/other-fixture.jpg', etag: '"other-etag"' };
  assert.deepEqual((await rpc('matter_hosted_app_photo_alias_register', objectKey, JSON.stringify(changed))).reference, reference);
  for (const bad of [{ ...reference, size: 18 }, { ...reference, identitySha256: 'd'.repeat(64) }, { ...reference, rawPayload: 'forbidden' },
    { ...reference, key: 'photos/nested/fixture.jpg' }, { ...reference, sha256: 'e'.repeat(64) }])
    await assert.rejects(rpc('matter_hosted_app_photo_alias_register', objectKey, JSON.stringify(bad)));
  await assert.rejects(sql('UPDATE matter_reporting_app.photo_alias SET reference=reference;'), /immutable/);
  await assert.rejects(sql("UPDATE matter_reporting_app.photo_alias_store SET identity_sha256='" + 'f'.repeat(64) + "';"), /immutable/);
  assert.equal(await sql('SELECT rows FROM matter_reporting_app.photo_alias_capacity;'), '1'); assert.equal(await fingerprint(), original);
});
test('photo alias row/byte limits and size/type bounds fail without modifying admitted metadata', { skip }, async () => {
  await reset(); const ref = alias(digest); await rpc('matter_hosted_app_photo_alias_register', digest + '.gz', JSON.stringify(ref));
  const other = alias('d'.repeat(64));
  for (const size of [0, 17.5, 16777217]) await assert.rejects(rpc('matter_hosted_app_photo_alias_register', other.sha256 + '.gz', JSON.stringify({ ...other, size })));
  await sql('UPDATE matter_reporting_app.photo_alias_capacity SET bytes=134217728;');
  await assert.rejects(rpc('matter_hosted_app_photo_alias_register', other.sha256 + '.gz', JSON.stringify(other)), /allowance/);
  assert.deepEqual((await rpc('matter_hosted_app_photo_alias_read', digest + '.gz')).reference, ref);
  await sql('UPDATE matter_reporting_app.photo_alias_capacity SET bytes=0,rows=200000;');
  await assert.rejects(rpc('matter_hosted_app_photo_alias_register', other.sha256 + '.gz', JSON.stringify(other)), /allowance/);
  assert.equal(await sql('SELECT count(*) FROM matter_reporting_app.photo_alias;'), '1');
});
test('stored metadata corruption cannot turn read/replay RPCs into raw payload or foreign-destination readers', { skip }, async () => {
  await reset(); const held = await lease(), request = args(delivery(), 0, key, held); await cas(request);
  await sql(`UPDATE matter_reporting_app.progress SET body_text='{"rawPayload":"forbidden"}';`);
  await assert.rejects(rpc('matter_hosted_app_progress_read', key), /22023/);
  await sql(`UPDATE matter_reporting_app.progress_retry SET body_text='{"rawPayload":"forbidden"}';`);
  await assert.rejects(cas(request), /23505/);
  await sql(`INSERT INTO matter_reporting_app.photo_alias(key,reference) VALUES('${digest}.gz',${quote(JSON.stringify(alias(digest)))}::jsonb);`);
  await assert.rejects(rpc('matter_hosted_app_photo_alias_read', digest + '.gz'), /PT409/);
  await assert.rejects(rpc('matter_hosted_app_photo_alias_register', digest + '.gz', JSON.stringify(alias(digest))), /PT409/);
});
test('read-egress counters reserve before I/O, charge 8192 once and refund measured bytes exactly once', { skip }, async () => {
  await reset(); const id = randomUUID(), admitted = await reserve(id);
  assert.equal(admitted.allowed, true); assert.equal(admitted.summary.month.usedBytes, 8192); assert.equal(admitted.summary.month.reservedBytes, 1100);
  const duplicate = await reserve(id); assert.equal(duplicate.allowed, false); assert.equal(duplicate.replayed, true);
  const completed = await settle(id); assert.equal(completed.settled, true); assert.equal(completed.summary.month.usedBytes, 8492); assert.equal(completed.summary.month.reservedBytes, 0);
  assert.equal((await settle(id)).replayed, true); await assert.rejects(settle(id, 100, 201), /23505/);
  await assert.rejects(reserve(id, 100, 1001), /23505/); assert.equal((await usage()).month.usedBytes, 8492);
  assert.equal(await fingerprint(), original);
});
test('concurrent large read reservations enforce byte ceilings atomically and duplicate settlements refund once', { skip }, async () => {
  await reset(); const attempts = await Promise.all(Array.from({ length: 4 }, () => reserve(randomUUID(), 83886080, 83886080)));
  assert.equal(attempts.filter(value => value.allowed).length, 3);
  const admitted = attempts.find(value => value.allowed), settled = await Promise.all([settle(admitted.id, 1, 1), settle(admitted.id, 1, 1)]);
  assert.equal(settled.filter(value => value.replayed).length, 1);
  const current = await usage(); assert(current.day.usedBytes + current.day.reservedBytes <= current.day.limitBytes);
});
test('concurrent reads cannot over-admit slots, expired uncertain charge never refunds and missing settlements never change totals', { skip }, async () => {
  await reset(); const ids = Array.from({ length: 5 }, randomUUID), attempts = await Promise.all(ids.map(id => reserve(id)));
  assert.equal(attempts.filter(value => value.allowed).length, 4); assert.equal((await usage()).activeReservations, 4);
  const admitted = attempts.find(value => value.allowed); await assert.rejects(settle(admitted.id, 100, 1001), /exceed/);
  await sql(`UPDATE matter_reporting_app.egress_retry SET started_at=clock_timestamp()-interval '16 minutes';`);
  const before = await usage(); assert.equal(before.activeReservations, 0); assert.equal(before.uncertainReservations, 4);
  const priorBytes = before.month.usedBytes; assert.equal((await settle(admitted.id)).settled, false);
  assert.equal((await usage()).month.usedBytes, priorBytes);
  const next = await reserve(randomUUID()); assert.equal(next.allowed, true); assert.equal(next.summary.uncertainReservations, 4);
  assert.equal((await settle(admitted.id)).settled, false); assert.equal((await usage()).month.usedBytes + (await usage()).month.reservedBytes, priorBytes + 9292);
});
test('monthly/day caps, retry capacity, invalid bounds and backward UTC clock refuse new traffic', { skip }, async () => {
  await reset(); await reserve(randomUUID());
  await sql(`UPDATE matter_reporting_app.egress_retry SET settled_at=clock_timestamp(),actual_request_bytes=request_bytes,actual_response_bytes=response_bytes;
    UPDATE matter_reporting_app.egress_counter SET used_bytes=CASE WHEN kind='day' THEN 536870911 ELSE used_bytes END;`);
  assert.equal((await reserve(randomUUID())).reason, 'day-byte-limit');
  await sql(`UPDATE matter_reporting_app.egress_counter SET used_bytes=CASE WHEN kind='month' THEN 8589934591 ELSE 0 END;`);
  assert.equal((await reserve(randomUUID())).reason, 'month-byte-limit');
  await assert.rejects(reserve(randomUUID(), -1, 1)); await assert.rejects(reserve(randomUUID(), 83886081, 1));
  await sql("UPDATE matter_reporting_app.egress_policy SET latest_day=(clock_timestamp() AT TIME ZONE 'UTC')::date+1;");
  await assert.rejects(usage(), /PT409/);
});
test('egress retry/counter retention is bounded and old/unknown settlements cannot refund or recharge', { skip }, async () => {
  await reset();
  await sql(`INSERT INTO matter_reporting_app.egress_retry(id,month_period,day_period,request_bytes,response_bytes,started_at,settled_at,actual_request_bytes,actual_response_bytes)
    SELECT md5(n::text)::uuid,date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,(clock_timestamp() AT TIME ZONE 'UTC')::date,0,0,clock_timestamp(),clock_timestamp(),0,0 FROM generate_series(1,4096)n;`);
  assert.equal((await reserve(randomUUID())).reason, 'retry-capacity');
  await sql(`UPDATE matter_reporting_app.egress_retry SET started_at=clock_timestamp()-interval '16 minutes';
    INSERT INTO matter_reporting_app.egress_counter(kind,period,used_bytes) SELECT 'month',date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date-(n||' months')::interval,10 FROM generate_series(1,5)n;
    INSERT INTO matter_reporting_app.egress_counter(kind,period,used_bytes) SELECT 'day',(clock_timestamp() AT TIME ZONE 'UTC')::date-n,10 FROM generate_series(1,5)n;`);
  const admitted = await reserve(randomUUID()); assert.equal(admitted.allowed, true);
  assert.equal(await sql('SELECT count(*) FROM matter_reporting_app.egress_retry;'), '1');
  assert.equal(await sql('SELECT count(*) FROM matter_reporting_app.egress_counter;'), '4');
  const before = await usage(); assert.equal((await settle(randomUUID(), 0, 0)).settled, false);
  assert.deepEqual(await usage(), before); assert.equal(await fingerprint(), original);
});
