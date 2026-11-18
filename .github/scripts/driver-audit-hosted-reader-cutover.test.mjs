import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const source = await fs.readFile(new URL('../workflows/driver-reports-reader-cutover.yml', import.meta.url), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const date = '2026-11-19T00:00:00.000Z';
const dateMs = Date.parse(date), minute = 60_000;
const oldSha = 'a'.repeat(40), appSha = 'b'.repeat(40), headSha = 'c'.repeat(64), generation = 'd'.repeat(64);
const repo = 'sidimohameddaliali2-crypto/matter-admin-app';

function driver(marker, spaces) {
  const step = source.split(marker)[1];
  assert.ok(step, marker);
  const before = ' '.repeat(spaces);
  const start = step.indexOf("<<'NODE'\n");
  assert.ok(start >= 0);
  return step.slice(start + "<<'NODE'\n".length).split('\n' + before + 'NODE')[0]
    .split('\n').map(line => line.slice(spaces)).join('\n');
}

function run(code, now, env, inputType = 'module') {
  const child = spawnSync(process.execPath, ['--input-type=' + inputType, '--eval', `Date.now = () => ${now};\n` + code],
    { cwd: new URL('../../', import.meta.url), env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.error, undefined);
  return child;
}

test('the dedicated production workflow is calendar-limited, manual or scheduled, and read-only in GitHub', () => {
  assert.match(source, /cron: '25 0 19 11 \*'/);
  assert.match(source, /workflow_dispatch:[\s\S]*default: check[\s\S]*- check[\s\S]*- switch/);
  assert.doesNotMatch(source, /\n\s{2}(?:push|pull_request|pull_request_target|workflow_run):/);
  assert.match(source, /permissions:\n  contents: read\n/);
  assert.match(source, /concurrency:\n  group: production-deploy\n  cancel-in-progress: false/);
  assert.match(source, /environment: production\n/);
  assert.match(source, /github\.repository == 'sidimohameddaliali2-crypto\/matter-admin-app'/);
  assert.match(source, /github\.ref == 'refs\/heads\/main'/);
  assert.match(source, /github\.sha == vars\.DRIVER_AUDIT_CUTOVER_RELEASE_SHA/);
  assert.match(source, /vars\.DRIVER_AUDIT_CUTOVER_ENABLED == '1'/);
  assert.match(source, /actions\/checkout@[0-9a-f]{40}\b/);
  assert.match(source, /appleboy\/ssh-action@[0-9a-f]{40}\b/);
  assert.match(source, /persist-credentials: false/);
  assert.doesNotMatch(source, /(?:run_build|npm ci|npm run build|worker --once|git push|gh workflow enable)/);
});

test('the actual runner driver rejects shifted dates and missing pins before transport preparation', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'hosted-reader-cutover-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const GITHUB_OUTPUT = path.join(root, 'output'), code = driver('Prepare the exact app reader operator', 10);
  const env = { GITHUB_OUTPUT, GITHUB_REPOSITORY: repo, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: appSha,
    GITHUB_EVENT_NAME: 'workflow_dispatch', READER_OPERATION: 'check', READER_RELEASE_SHA: appSha,
    READER_PREVIOUS_SHA: oldSha, READER_HEAD_SHA: headSha, READER_GENERATION: generation, READER_NOT_BEFORE: date };
  for (const [now, overrides] of [[dateMs - 1, {}], [dateMs + 24 * 60 * minute, {}], [dateMs + minute, { READER_NOT_BEFORE: 'bad' }],
    [dateMs + minute, { READER_PREVIOUS_SHA: appSha }], [dateMs + minute, { READER_OPERATION: 'deploy' }],
    [dateMs + minute, { READER_HEAD_SHA: '' }], [dateMs + minute, { GITHUB_REF: 'refs/heads/elsewhere' }]]) {
    assert.notEqual(run(code, now, { ...env, ...overrides }, 'commonjs').status, 0);
    await assert.rejects(fs.readFile(GITHUB_OUTPUT), { code: 'ENOENT' });
  }
  const checked = run(code, dateMs + minute, env, 'commonjs');
  assert.equal(checked.status, 0, checked.stderr);
  const entries = Object.fromEntries((await fs.readFile(GITHUB_OUTPUT, 'utf8')).trim().split('\n').map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
  assert.match(entries.sha256, /^[a-f0-9]{64}$/);
  assert.equal(entries.apply, '0');
  assert.deepEqual(JSON.parse(Buffer.from(entries.request, 'base64')), { version: 1, expectedOldSha: oldSha, selectedSha: appSha,
    reportHeadSha256: headSha, generation });
  const scheduled = run(code, dateMs + minute, { ...env, GITHUB_EVENT_NAME: 'schedule', READER_OPERATION: 'switch',
    READER_EVENT_SCHEDULE: '25 0 19 11 *' }, 'commonjs');
  assert.equal(scheduled.status, 0, scheduled.stderr);
  assert.match(await fs.readFile(GITHUB_OUTPUT, 'utf8'), /\napply=1\n$/);
});

test('the actual SSH driver requires a checked matching reader before any app switch', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'hosted-reader-cutover-driver-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const trace = path.join(root, 'trace'), code = driver('Check and switch only the selected reader', 12);
  const operator = Buffer.from(`import fs from 'node:fs/promises';
export const validateAppReaderReleaseRequest = request => request;
export async function releaseSupabaseAppReader({request, apply}) {
  await fs.appendFile(process.env.TEST_TRACE, String(apply) + '\\n');
  if (process.env.TEST_BLOCK && !apply) throw new Error('Produce no private log output');
  if (apply) return { status:'supabase-app-reader-released', previousCommit: request.expectedOldSha,
    applicationCommit: request.selectedSha, generation: request.generation, reportHeadSha256: request.reportHeadSha256,
    apiProcessRestartVerified: true, workersStarted: false, websiteRebuilt: false, dependenciesReinstalled: false,
    routingChanged: false, authenticatedGenerationAcceptancePending: true, authenticatedBrowserAcceptancePending: true };
  return { status:'supabase-app-reader-checked', applicationCommit: request.expectedOldSha, selectedCommit: request.selectedSha,
    generation: request.generation, reportHeadSha256: process.env.TEST_WRONG ? 'foreign' : request.reportHeadSha256,
    activationPerformed: false, namedEvidenceVerified: true, lightweight: true, prewarmed: true };
}`);
  const request = { version: 1, expectedOldSha: oldSha, selectedSha: appSha, reportHeadSha256: headSha, generation };
  const base = { DRIVER_AUDIT_APP_PATH: root, READER_OPERATOR_GZIP: gzipSync(operator).toString('base64'),
    READER_OPERATOR_SHA: sha(operator), READER_REQUEST: Buffer.from(JSON.stringify(request)).toString('base64'),
    READER_NOT_BEFORE: date, READER_APPLY: '1', TEST_TRACE: trace };
  const checked = run(code, dateMs + minute, { ...base, READER_APPLY: '0' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout), { status: 'supabase-app-reader-checked' });
  assert.equal(await fs.readFile(trace, 'utf8'), 'false\n');
  await fs.unlink(trace);
  const switched = run(code, dateMs + minute, base);
  assert.equal(switched.status, 0, switched.stderr);
  assert.deepEqual(JSON.parse(switched.stdout), { status: 'supabase-app-reader-released', staffVerificationPending: true });
  assert.equal(await fs.readFile(trace, 'utf8'), 'false\ntrue\n');
  for (const bad of [{ TEST_BLOCK: '1' }, { TEST_WRONG: '1' }]) {
    await fs.unlink(trace);
    const failed = run(code, dateMs + minute, { ...base, ...bad });
    assert.equal(failed.status, 1, failed.stderr);
    assert.doesNotMatch(failed.stdout + failed.stderr, /private log output|foreign|[a-f0-9]{40,64}/);
    assert.equal(await fs.readFile(trace, 'utf8'), 'false\n');
  }
  await fs.unlink(trace);
  for (const [now, bad] of [[dateMs + minute, { READER_OPERATOR_SHA: headSha }], [dateMs + 24 * 60 * minute, {}]]) {
    assert.equal(run(code, now, { ...base, ...bad }).status, 1);
    await assert.rejects(fs.readFile(trace), { code: 'ENOENT' });
  }
});
