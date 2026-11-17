import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { generateKeyPairSync, createHash } from 'node:crypto';
import test from 'node:test';
import { driverAuditSupabaseControlRequest, driverAuditSupabaseControlStoppedReceipt,
  driverAuditSupabaseCanaryRequest, driverAuditSupabaseReleaseRequest, driverAuditSupabaseReleaseReceipts } from './driver-audit-native-handoff.mjs';
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
  }, timeout: 15000, maxBuffer: 8 * 1024 ** 2 });
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

const canaryOperations = [
  ['probe-supabase-canary', 'probe'], ['plan-supabase-canary', 'plan'], ['enable-supabase-canary', 'enable'],
  ['seal-supabase-canary-entry', 'seal-entry'], ['restore-supabase-canary', 'restore'], ['promote-supabase-report', 'promote'],
];
const releaseOperations = [
  ['export-supabase-release-inputs', 'export-release-inputs'], ['stage-supabase-source-release', 'stage-source-release'],
  ['start-supabase-source-sync', 'start-source-sync'],
];
const canaryInput = internal => ({ version: 1, recipientPublicKey: 'fixture public recipient',
  ...(internal === 'probe' ? {} : { preparedReceiptSha256: hash }),
  ...(['enable', 'seal-entry', 'restore', 'promote'].includes(internal) ? { planSha256: hash } : {}),
  ...(internal === 'promote' ? { canaryAcceptanceSha256: hash, canaryAcceptanceObjectSha256: hash } : {}) });
const releaseInput = internal => ({ version: 1, recipientPublicKey: 'fixture public recipient', preparedReceiptSha256: hash,
  qualificationReceiptSha256: hash, ...(internal === 'export-release-inputs' ? { reportCompletionIdentitySha256: hash } : { releasePackSha256: hash }) });

test('canary and source release operations admit only exact typed phase-specific public hashes', () => {
  for (const [list, inputFor, parse] of [[canaryOperations, canaryInput, driverAuditSupabaseCanaryRequest],
    [releaseOperations, releaseInput, driverAuditSupabaseReleaseRequest]]) {
    for (const [external, internal] of list) {
      const input = inputFor(internal), { version, ...expected } = input;
      assert.deepEqual(parse(external, encode(input)), { operation: internal, ...expected });
      for (const key of Object.keys(input)) {
        const missing = { ...input }; delete missing[key]; assert.throws(() => parse(external, encode(missing)));
      }
      for (const key of Object.keys(input).filter(name => name.endsWith('Sha256')))
        for (const invalid of [[hash], { value: hash }, null, 42, 'not-a-hash'])
          assert.throws(() => parse(external, encode({ ...input, [key]: invalid })));
      assert.throws(() => parse(external, encode({ ...input, arbitraryPath: '/forbidden' })));
      assert.throws(() => parse('__proto__', encode(input)));
      assert.throws(() => parse([external], encode(input)));
      assert.throws(() => parse(external, 'not base64'));
    }
  }
});

function releaseResult(args, capsule) {
  const exporting = args.operation === 'export-release-inputs', starting = args.operation === 'start-source-sync';
  return { status: exporting ? 'supabase-release-inputs-exported' : starting ? 'supabase-source-sync-started' : 'supabase-source-release-staged',
    operation: args.operation, applicationCommit: commit, releaseCommit: '4a00becfe4954b8139df6ac3c6058c2a592484d2',
    preparedReceiptSha256: args.preparedReceiptSha256, qualificationReceiptSha256: args.qualificationReceiptSha256,
    ...(exporting ? { reportCompletionIdentitySha256: args.reportCompletionIdentitySha256 } : { releasePackSha256: args.releasePackSha256 }),
    dataStore: 'supabase', sourceStarted: starting, syncSteadyStarted: starting, routingChanged: false,
    recipientSha256: createHash('sha256').update(args.recipientPublicKey).digest('hex'), metadataSha256: hash,
    diagnosticPages: 1, sealedPages: [capsule] };
}

test('the real compressed bridge dispatches all canary and source operations without opening a database', async t => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 }), capsule = sealTransferSecrets(publicKey, { fictional: true });
  for (const [external, internal] of canaryOperations) {
    const code = 'export async function runDriverAuditSupabaseCanaryControl(a){if(a.operation!==' + JSON.stringify(internal)
      + ')throw Error("Wrong dispatch");return {status:"canary-fixture",operation:a.operation};}';
    const f = await bridgeFixture(t, code, { operation: external, input: canaryInput(internal) });
    assert.deepEqual(JSON.parse((await f.run()).stdout), { status: 'canary-fixture', operation: internal });
  }
  for (const [external, internal] of releaseOperations) {
    const input = releaseInput(internal), args = driverAuditSupabaseReleaseRequest(external, encode(input));
    const expected = releaseResult(args, capsule), code = 'export async function runDriverAuditSupabaseReleaseControl(a){'
      + 'if(a.operation!==' + JSON.stringify(internal) + ')throw Error("Wrong dispatch");return ' + JSON.stringify(expected) + ';}';
    const f = await bridgeFixture(t, code, { operation: external, input });
    const rows = (await f.run()).stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2); assert.equal(rows[0].status, 'supabase-release-output-page');
    assert.equal(rows[1].status, expected.status); assert.equal(rows[1].sealedPages, undefined);
    await assert.rejects(fs.access(path.join(f.root, 'server/node_modules')), { code: 'ENOENT' });
  }
});

test('encrypted release output rejects plaintext, changed bindings, malformed pages and overlong lines before printing', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 }), capsule = sealTransferSecrets(publicKey, { fictional: true });
  const args = driverAuditSupabaseReleaseRequest(releaseOperations[0][0], encode(releaseInput(releaseOperations[0][1])));
  const valid = releaseResult(args, capsule);
  assert.equal(driverAuditSupabaseReleaseReceipts(valid, args, commit).length, 2);
  for (const changed of [{ ...valid, plaintext: secret }, { ...valid, operation: 'start-source-sync' },
    { ...valid, metadataSha256: [hash] }, { ...valid, applicationCommit: 'f'.repeat(40) },
    { ...valid, preparedReceiptSha256: 'f'.repeat(64) }, { ...valid, sourceStarted: true },
    { ...valid, diagnosticPages: 65 }, { ...valid, diagnosticPages: 2 },
    { ...valid, sealedPages: [{ ...capsule, plaintext: secret }] },
    { ...valid, sealedPages: [{ ...capsule, data: 'not canonical ciphertext' }] },
    { ...valid, sealedPages: [{ ...capsule, data: Buffer.alloc(50000).toString('base64') }] }])
    assert.throws(() => driverAuditSupabaseReleaseReceipts(changed, args, commit));
});

test('large real encrypted exports are emitted as bounded separate lines with one final summary', async t => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const input = { ...releaseInput('export-release-inputs'), recipientPublicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
  const codec = new URL('../../server/services/driverAuditTransferCodec.js', import.meta.url).href;
  const releaseModule = new URL('./driver-audit-supabase-release-control.mjs', import.meta.url).href;
  const code = 'import{createHash,createPublicKey,randomBytes}from"node:crypto";'
    + 'import{sealTransferSecrets}from' + JSON.stringify(codec) + ';import{sealDriverAuditSupabaseReleaseInputs}from' + JSON.stringify(releaseModule) + ';'
    + 'export async function runDriverAuditSupabaseReleaseControl(a){const bindings={applicationCommit:a.expectedSha,releaseCommit:"4a00becfe4954b8139df6ac3c6058c2a592484d2",'
    + 'preparedReceiptSha256:a.preparedReceiptSha256,qualificationReceiptSha256:a.qualificationReceiptSha256,reportCompletionIdentitySha256:a.reportCompletionIdentitySha256};'
    + 'const sealed=sealDriverAuditSupabaseReleaseInputs({metadata:{fixturePrivate:' + JSON.stringify(secret) + ',payload:randomBytes(400000).toString("base64")},bindings,'
    + 'recipientKey:createPublicKey(a.recipientPublicKey),sealTransferSecrets});'
    + 'return{status:"supabase-release-inputs-exported",operation:a.operation,...bindings,dataStore:"supabase",sourceStarted:false,syncSteadyStarted:false,routingChanged:false,'
    + 'recipientSha256:createHash("sha256").update(a.recipientPublicKey).digest("hex"),...sealed};}';
  const f = await bridgeFixture(t, code, { operation: 'export-supabase-release-inputs', input });
  const output = (await f.run()).stdout, lines = output.trim().split('\n'), rows = lines.map(line => JSON.parse(line));
  assert(rows.length > 3); assert(!output.includes(secret));
  assert(lines.every(line => Buffer.byteLength(line) < 64 * 1024));
  const summary = rows.at(-1); assert.equal(summary.status, 'supabase-release-inputs-exported');
  assert.equal(summary.diagnosticPages, rows.length - 1); assert.equal(summary.sealedPages, undefined);
  for (const [index, row] of rows.slice(0, -1).entries()) { assert.equal(row.pageIndex, index); assert.equal(row.metadataSha256, summary.metadataSha256); }
});

test('the workflow selects all reviewed canary/release modules and defaults to Supabase inspection', async () => {
  const workflow = await fs.readFile(new URL('../workflows/driver-audit-native-handoff.yml', import.meta.url), 'utf8');
  assert(workflow.includes('        default: inspect-supabase-host\n'));
  const from = workflow.indexOf('          case "$OPERATION" in'), to = workflow.indexOf("          printf 'import_code=", from);
  const selector = workflow.slice(from, to).split('\n').map(row => row.replace(/^ {10}/, '')).join('\n');
  for (const [list, expected] of [[canaryOperations, '.github/scripts/driver-audit-supabase-canary-control.mjs'],
    [releaseOperations, '.github/scripts/driver-audit-supabase-release-control.mjs']]) for (const [operation] of list) {
    const result = await promisify(execFile)('/bin/bash', ['-c', selector + '\nprintf \'%s\' "$operator_file"'], { env: { OPERATION: operation } });
    assert.equal(result.stdout, expected); assert((await fs.stat(new URL('../../' + expected, import.meta.url))).isFile());
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
