import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { decodeDriverAuditOperator } from './driver-audit-native-handoff.mjs';

test('compressed transport preserves exact reviewed operator bytes and legacy uncompressed calls', async () => {
  const code = await fs.readFile(new URL('./driver-audit-supabase-handoff.mjs', import.meta.url));
  const packed = gzipSync(code).toString('base64');
  assert.deepEqual(decodeDriverAuditOperator(packed, 'gzip-v1'), code);
  assert.deepEqual(decodeDriverAuditOperator(code.toString('base64')), code);
  const boundary = Buffer.alloc(192 * 1024, 65);
  assert.deepEqual(decodeDriverAuditOperator(boundary.toString('base64')), boundary);
  assert.deepEqual(decodeDriverAuditOperator(gzipSync(boundary).toString('base64'), 'gzip-v1'), boundary);
});

test('transport rejects malformed, unsupported, corrupt and excessive decoded payloads', () => {
  const code = Buffer.from('export {};');
  for (const [encoded, compression] of [
    [undefined, undefined], ['', undefined], ['not base64!', 'gzip-v1'],
    [code.toString('base64') + '=', undefined], [code.toString('base64'), 'unknown'],
    [code.toString('base64'), 'gzip-v1'], [gzipSync(Buffer.alloc(0)).toString('base64'), 'gzip-v1'],
    [gzipSync(Buffer.alloc(192 * 1024 + 1, 65)).toString('base64'), 'gzip-v1'],
    [Buffer.alloc(192 * 1024 + 1, 65).toString('base64'), undefined],
  ]) assert.throws(() => decodeDriverAuditOperator(encoded, compression));
  const packed = gzipSync(code);
  assert.throws(() => decodeDriverAuditOperator(packed.subarray(0, -1).toString('base64'), 'gzip-v1'));
});

test('the real reviewed shell transport stays below the Linux single-argument limit', async () => {
  const workflow = await fs.readFile(new URL('../workflows/driver-audit-native-handoff.yml', import.meta.url), 'utf8');
  assert(workflow.includes('gzip -cn .github/scripts/driver-audit-native-handoff.mjs | base64 -w0'));
  assert(workflow.includes('gzip -cn "$operator_file" | base64 -w0'));
  assert(workflow.includes('NATIVE_IMPORT_COMPRESSION: gzip-v1'));
  assert(workflow.includes('NATIVE_IMPORT_CODE,NATIVE_IMPORT_COMPRESSION,'));
  assert(workflow.includes('base64 -d | gzip -dc | node --input-type=module - --run'));
  const core = await fs.readFile(new URL('./driver-audit-native-handoff.mjs', import.meta.url));
  const operator = await fs.readFile(new URL('./driver-audit-supabase-handoff.mjs', import.meta.url));
  const script = 'export NATIVE_HANDOFF_CODE=' + gzipSync(core).toString('base64') + '\n'
    + 'export NATIVE_IMPORT_CODE=' + gzipSync(operator).toString('base64') + '\n'
    + 'printf \'%s\' "$NATIVE_HANDOFF_CODE" | base64 -d | gzip -dc';
  // Leave room for the SSH wrapper, public recipient and fixed environment.
  assert(Buffer.byteLength(script) < 64 * 1024);
  const actual = await promisify(execFile)('/bin/bash', ['-c', script], { maxBuffer: 512 * 1024 });
  assert.deepEqual(Buffer.from(actual.stdout), core);
  assert.deepEqual(gunzipSync(gzipSync(core)), core);
});

test('a corrupt core transport cannot look like a successful empty Node invocation', async () => {
  const script = "set -euo pipefail\nprintf '%s' aW52YWxpZA== | base64 -d | gzip -dc | '" + process.execPath + "' --input-type=module - --run";
  await assert.rejects(promisify(execFile)('/bin/bash', ['-c', script]), error => Number.isInteger(error.code) && error.code !== 0);
});
