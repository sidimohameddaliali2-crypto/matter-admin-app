import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { driverAuditSupabaseControlRequest, driverAuditSupabaseControlStoppedReceipt } from './driver-audit-native-handoff.mjs';
import { sealTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';

const commit = '7'.repeat(40), hash = 'a'.repeat(64), secret = 'fictional-private-cause-never-public';
const operations = [
  ['prepare-supabase-serving', 'prepare-serving'], ['start-supabase-report', 'start-report'],
  ['qualify-supabase-source-held', 'held-qualify-source'], ['run-supabase-report-once', 'run-report-once'],
];
const request = operation => ({ version: 1, recipientPublicKey: 'fixture public recipient', preparedReceiptSha256: hash,
  ...(['qualify-supabase-source-held', 'run-supabase-report-once'].includes(operation)
    ? { qualificationFixtureSha256: hash, environmentBackupProofSha256: hash } : {}),
  ...(operation === 'run-supabase-report-once' ? { qualificationReceiptSha256: hash } : {}) });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');

test('each Supabase control has an exact phase-specific public input contract', () => {
  for (const [external, internal] of operations) {
    const input = request(external), { version, ...expected } = input;
    assert.deepEqual(driverAuditSupabaseControlRequest(external, encode(input)), { operation: internal, ...expected });
    for (const key of Object.keys(input)) {
      const missing = { ...input }; delete missing[key];
      assert.throws(() => driverAuditSupabaseControlRequest(external, encode(missing)));
    }
    for (const invalid of [{ ...input, path: '/arbitrary' }, { ...input, version: 2 }, { ...input, preparedReceiptSha256: 'not-a-hash' },
      { ...input, recipientPublicKey: 'x'.repeat(8193) }, null, []])
      assert.throws(() => driverAuditSupabaseControlRequest(external, encode(invalid)));
    for (const key of Object.keys(input).filter(key => key.endsWith('Sha256')))
      for (const invalid of [[hash], { value: hash }, null, 42])
        assert.throws(() => driverAuditSupabaseControlRequest(external, encode({ ...input, [key]: invalid })));
  }
  for (const invalid of ['', '__proto__', 'inspect-database-config'])
    assert.throws(() => driverAuditSupabaseControlRequest(invalid, encode(request(operations[0][0]))));
  assert.throws(() => driverAuditSupabaseControlRequest(operations[0][0], 'not base64'));
  assert.throws(() => driverAuditSupabaseControlRequest(operations[0][0], 'a'.repeat(24580)));
});

async function bridgeFixture(t, code, plan) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'supabase-control-bridge-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = path.join(root, 'server'), bin = path.join(root, 'bin');
  await fs.mkdir(path.join(server, '.private'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(server, 'services')); await fs.mkdir(bin);
  await fs.writeFile(path.join(server, 'package.json'), '{"type":"module"}');
  await fs.copyFile(new URL('../../server/services/driverAuditSource.js', import.meta.url), path.join(server, 'services/driverAuditSource.js'));
  await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" ' + commit + '\n', { mode: 0o700 });
  const script = fileURLToPath(new URL('./driver-audit-native-handoff.mjs', import.meta.url));
  const source = 'Object.defineProperty(process,"platform",{value:"linux"});process.chdir(' + JSON.stringify(root)
    + ');process.argv.push("--run");await import(' + JSON.stringify(script) + ');';
  const run = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: {
    PATH: bin, EXPECTED_DEPLOYED_SHA: commit, NATIVE_HANDOFF_OPERATION: plan.operation,
    NATIVE_IMPORT_CODE: gzipSync(Buffer.from(code)).toString('base64'), NATIVE_IMPORT_COMPRESSION: 'gzip-v1',
    NATIVE_TRANSFER_PLAN_B64: encode(plan.input),
  }, timeout: 10000 });
  return { root, run };
}

test('the real bridge dispatches all four compressed controls without any database or native-session modules', async t => {
  for (const [external, internal] of operations) {
    const input = request(external), expected = driverAuditSupabaseControlRequest(external, encode(input));
    const code = 'export async function runDriverAuditSupabaseControl(args){const {appRoot,expectedSha,...input}=args;'
      + 'if(expectedSha!==' + JSON.stringify(commit) + '||!appRoot||JSON.stringify(input)!==' + JSON.stringify(JSON.stringify(expected))
      + ')throw Error("Wrong control dispatch");return {status:"control-dispatched",operation:args.operation};}';
    const f = await bridgeFixture(t, code, { operation: external, input });
    assert.deepEqual(JSON.parse((await f.run()).stdout), { status: 'control-dispatched', operation: internal });
    await assert.rejects(fs.access(path.join(f.root, 'server/node_modules')), { code: 'ENOENT' });
  }
});

test('invalid control input is rejected before importing even the selected operator', async t => {
  const code = 'throw Error("' + secret + '");';
  const f = await bridgeFixture(t, code, { operation: 'prepare-supabase-serving', input: { ...request(operations[0][0]), command: 'forbidden' } });
  await assert.rejects(f.run(), error => error.code === 1 && !error.stderr.includes(secret) && !error.stdout.includes(secret));
  await assert.rejects(fs.access(path.join(f.root, 'server/.private/driver-audit-native-operators')), { code: 'ENOENT' });
  const arrayHash = await bridgeFixture(t, code, { operation: 'prepare-supabase-serving', input: { ...request(operations[0][0]), preparedReceiptSha256: [hash] } });
  await assert.rejects(arrayHash.run(), error => error.code === 1 && !error.stderr.includes(secret) && !error.stdout.includes(secret));
  await assert.rejects(fs.access(path.join(arrayHash.root, 'server/.private/driver-audit-native-operators')), { code: 'ENOENT' });
});

test('control failure output admits only the bound ciphertext receipt and static phase', async t => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const capsule = sealTransferSecrets(publicKey, { fictionalPrivateCause: secret });
  const receipt = { status: 'supabase-control-stopped', applicationCommit: commit, operatorPhase: 'fixture-child', metadataSha256: hash, capsule };
  assert.deepEqual(driverAuditSupabaseControlStoppedReceipt(receipt, commit, 'fixture-child'), receipt);
  for (const changed of [{ ...receipt, message: secret }, { ...receipt, applicationCommit: 'f'.repeat(40) }, { ...receipt, metadataSha256: [hash] },
    { ...receipt, operatorPhase: '/private/path' }, { ...receipt, capsule: { ...capsule, data: 'corrupt ciphertext' } }])
    assert.equal(driverAuditSupabaseControlStoppedReceipt(changed, commit, 'fixture-child'), null);
  const code = 'export async function runDriverAuditSupabaseControl(){const e=Object.assign(Error(' + JSON.stringify(secret)
    + '),{phase:"fixture-child"});Object.defineProperty(e,"supabaseControlStopped",{value:' + JSON.stringify(receipt) + '});throw e;}';
  const f = await bridgeFixture(t, code, { operation: operations[0][0], input: request(operations[0][0]) });
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 1); assert.deepEqual(JSON.parse(error.stdout), receipt);
    assert(!error.stdout.includes(secret)); assert(!error.stderr.includes(secret));
    assert(error.stderr.includes('operatorPhase=fixture-child')); return true;
  });
});

test('the reviewed workflow resolves every control to its existing Supabase-only operator', async () => {
  const workflow = await fs.readFile(new URL('../workflows/driver-audit-native-handoff.yml', import.meta.url), 'utf8');
  const from = workflow.indexOf('          case "$OPERATION" in'), to = workflow.indexOf("          printf 'import_code=", from);
  const selector = workflow.slice(from, to).split('\n').map(row => row.replace(/^ {10}/, '')).join('\n');
  for (const [operation] of operations) {
    assert(workflow.includes('          - ' + operation + '\n'));
    const result = await promisify(execFile)('/bin/bash', ['-c', selector + '\nprintf \'%s\' "$operator_file"'], { env: { OPERATION: operation } });
    assert.equal(result.stdout, '.github/scripts/driver-audit-supabase-control.mjs');
    assert((await fs.stat(new URL('./driver-audit-supabase-control.mjs', import.meta.url))).isFile());
  }
});
