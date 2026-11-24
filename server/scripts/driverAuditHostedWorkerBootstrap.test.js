import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeDriverAuditHostedWorkerBootstrap, sealDriverAuditHostedWorkerBootstrap } from './driverAuditHostedWorkerBootstrap.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureSecret = 'fixture-private-reporting-key-0000000000000000';
const releaseSha = 'a'.repeat(40);
const root = '/private/fixture/worker';
const sourceRoot = 'collector/' + '1'.repeat(64);

function fixture() {
  const files = ['sync.json', 'validation-journals.private.json', 'hosted-release-pins.private.json',
    'hosted-environment-activation.private.json', 'source-replay.private.json.gz',
    ...['repository', 'environment', 'branches', 'secrets'].map(name => 'provisioning/' + name + '.private.json'),
    sourceRoot + '/source.json', sourceRoot + '/environment.private.json', 'builder/runtime-manifest.json',
    'baseline/files.private.json'].map(path => {
    const body = Buffer.from(path.endsWith('/environment.private.json') ? fixtureSecret : 'fixture:' + path);
    const metadata = { path, bytes: body.length, sha256: sha(body) };
    return path.endsWith('/environment.private.json')
      ? { ...metadata, chunks: [], embedded: body.toString('base64') }
      : { ...metadata, chunks: [{ key: metadata.sha256 + '.gz', bytes: metadata.bytes }] };
  });
  const hashFor = path => files.find(entry => entry.path === path).sha256;
  const source = sourceRoot + '/source.json';
  return { version: 1, kind: 'driver-report-hosted-bootstrap-v1', releaseSha, root, source,
    fixture: { path: 'source-replay.private.json.gz', sha256: hashFor('source-replay.private.json.gz') },
    preflight: {
      syncSha256: hashFor('sync.json'), sourceConfigSha256: hashFor(source),
      activationSha256: hashFor('hosted-environment-activation.private.json'),
      pinsSha256: hashFor('hosted-release-pins.private.json'),
    }, files };
}

test('private bootstrap authenticates exact file references, environment and release before extraction', () => {
  const input = fixture();
  const first = sealDriverAuditHostedWorkerBootstrap(input, fixtureSecret);
  const second = sealDriverAuditHostedWorkerBootstrap(input, fixtureSecret);
  assert.notDeepEqual(first, second);
  assert.equal(first.includes(fixtureSecret), false);
  const restored = decodeDriverAuditHostedWorkerBootstrap(first, { root, releaseSha, supabaseSecret: fixtureSecret });
  assert.deepEqual(restored, input);
});

test('changed bytes, credential, runner root and checkout identity cannot open a bootstrap', () => {
  const bytes = sealDriverAuditHostedWorkerBootstrap(fixture(), fixtureSecret);
  const damaged = Buffer.from(bytes);
  damaged[damaged.length - 1] ^= 1;
  const options = { root, releaseSha, supabaseSecret: fixtureSecret };
  assert.throws(() => decodeDriverAuditHostedWorkerBootstrap(damaged, options));
  assert.throws(() => decodeDriverAuditHostedWorkerBootstrap(bytes, { ...options, root: root + '-foreign' }));
  assert.throws(() => decodeDriverAuditHostedWorkerBootstrap(bytes, { ...options, releaseSha: 'b'.repeat(40) }));
  assert.throws(() => decodeDriverAuditHostedWorkerBootstrap(bytes, { ...options, supabaseSecret: fixtureSecret + 'changed' }));
});

test('unsafe paths, mismatched pins or a detached environment fail before sealing', () => {
  const input = fixture();
  assert.throws(() => sealDriverAuditHostedWorkerBootstrap({
    ...input, files: [...input.files, { ...input.files.at(-1), path: 'baseline/../outside.json' }],
  }, fixtureSecret));
  assert.throws(() => sealDriverAuditHostedWorkerBootstrap({
    ...input, preflight: { ...input.preflight, pinsSha256: 'f'.repeat(64) },
  }, fixtureSecret));
  const path = sourceRoot + '/environment.private.json';
  const files = input.files.map(({ embedded, ...file }) => file.path === path
    ? { ...file, chunks: [{ key: file.sha256 + '.gz', bytes: file.bytes }] }
    : file);
  assert.throws(() => sealDriverAuditHostedWorkerBootstrap({ ...input, files }, fixtureSecret));
});
