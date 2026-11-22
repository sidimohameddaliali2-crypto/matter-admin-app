import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { confirmWebhookSecret, managedSettings, readEnvironmentSnapshot, replaceAndRestart } from './reporting-source-operator.mjs';

const parseFixture = bytes => Object.fromEntries(Array.from(bytes.toString().matchAll(/^([A-Z_]+)=([^\r\n]*)/gm), match => [match[1], match[2]]));
const signFixture = 'inert-fixture-signing-value-never-used-remotely';
const capture = 'MATTER_REPORTING_CAPTURE_ENABLED';
const emitter = 'MATTER_REPORTING_EMITTER_ENABLED';
const oidc = 'MATTER_REPORTING_VERCEL_OIDC_ENABLED';
const key = 'MATTER_REPORTING_WEBHOOK_SECRET';

test('stage, enable and rollback replace only the dedicated reporting block', () => {
  const original = Buffer.from('# unchanged comment\r\nUNRELATED=a:b% c\r\n');
  const staged = managedSettings(original, 'stage', undefined, parseFixture);
  assert.ok(staged.subarray(0, original.length).equals(original));
  assert.deepEqual(parseFixture(staged), { UNRELATED: 'a:b% c', [oidc]: '1', [capture]: '0', [emitter]: '0' });
  assert.deepEqual(managedSettings(staged, 'stage', undefined, parseFixture), staged);

  const extra = Buffer.from('OTHER_PRIVATE_SETTING=keeps trailing spaces  \r\n');
  const enabled = managedSettings(Buffer.concat([staged, extra]), 'enable', signFixture, parseFixture);
  assert.ok(enabled.subarray(0, original.length + extra.length).equals(Buffer.concat([original, extra])));
  assert.equal(parseFixture(enabled)[key], signFixture);
  assert.equal(parseFixture(enabled)[capture], '1');
  assert.equal(parseFixture(enabled)[emitter], '1');

  const disabled = managedSettings(enabled, 'disable', undefined, parseFixture);
  assert.deepEqual(parseFixture(disabled), { UNRELATED: 'a:b% c', OTHER_PRIVATE_SETTING: 'keeps trailing spaces  ',
    [oidc]: '0', [capture]: '0', [emitter]: '0' });
  assert.ok(!disabled.includes(signFixture));
});

test('refuses incomplete and contaminated blocks and rejects dotenv collateral changes', () => {
  const start = '# BEGIN MATTER DRIVER REPORTING PREVIEW\n';
  const end = '# END MATTER DRIVER REPORTING PREVIEW\n';
  assert.throws(() => managedSettings(Buffer.from(start), 'stage', undefined, parseFixture), /ambiguous-managed-settings/);
  assert.throws(() => managedSettings(Buffer.from(start + 'UNRELATED=private\n' + end), 'stage', undefined, parseFixture), /unexpected-managed-settings/);
  assert.throws(() => managedSettings(Buffer.alloc(0), 'enable', 'short', parseFixture), /missing-or-invalid-signing-value/);
  const mismatchedParse = bytes => ({ ...parseFixture(bytes), UNRELATED: String(bytes.length) });
  assert.throws(() => managedSettings(Buffer.alloc(0), 'stage', undefined, mismatchedParse), /unrelated-environment-would-change/);
});

test('qualifies a webhook signing value against an inert request without accepting a generic 400', async () => {
  const now = () => 1795358760000;
  await confirmWebhookSecret(signFixture, { now, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://trhhjfgfmxofxhnzocks.supabase.co/functions/v1/driver-reports-webhook');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.body, '{}');
    assert.equal(options.headers['x-matter-timestamp'], '1795358760');
    assert.equal(options.headers['x-matter-signature'], 'sha256=' + createHmac('sha256', signFixture).update('1795358760.{}').digest('hex'));
    return Response.json({ status: 'invalid-event' }, { status: 400 });
  } });
  for (const status of [200, 302, 400, 401, 403]) {
    await assert.rejects(confirmWebhookSecret(signFixture, { now,
      fetchImpl: () => Response.json({ status: 'other-response' }, { status }) }), /webhook-signature-not-verified/);
  }
});

async function environment(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'driver-reporting-operator-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return path.join(folder, '.env.local');
}

test('failed service check restores exact previous bytes and health', async t => {
  const file = await environment(t);
  const original = Buffer.from('KEEP=exact  \n');
  await writeFile(file, original, { mode: 0o600 });
  const previous = await readEnvironmentSnapshot(file);
  const staged = managedSettings(original, 'stage', undefined, parseFixture);
  let attempts = 0;
  await assert.rejects(replaceAndRestart({ file, previous, bytes: staged, verifyHost: async () => {},
    restartAndVerify: async () => {
      attempts++;
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
      if (attempts === 1) {
        assert.deepEqual(await readFile(file), staged);
        throw Error('first health check failed');
      }
      assert.deepEqual(await readFile(file), original);
    } }), /settings-rolled-back/);
  assert.equal(attempts, 2);
});

test('rolls back an initially absent file and leaves later external edits intact', async t => {
  const file = await environment(t);
  const staged = managedSettings(Buffer.alloc(0), 'stage', undefined, parseFixture);
  let attempts = 0;
  await assert.rejects(replaceAndRestart({ file, previous: null, bytes: staged, verifyHost: async () => {},
    restartAndVerify: async () => { if (++attempts === 1) throw Error('no health'); } }), /settings-rolled-back/);
  assert.equal(await readEnvironmentSnapshot(file), null);

  await assert.rejects(replaceAndRestart({ file, previous: null, bytes: staged,
    verifyHost: () => writeFile(file, 'UNRELATED=concurrent\n', { mode: 0o600 }),
    restartAndVerify: () => assert.fail('restart must not run') }), /environment-changed/);
  assert.equal(await readFile(file, 'utf8'), 'UNRELATED=concurrent\n');
  const link = path.join(path.dirname(file), '.env');
  await symlink(file, link);
  await assert.rejects(readEnvironmentSnapshot(link), { code: 'ELOOP' });
});
