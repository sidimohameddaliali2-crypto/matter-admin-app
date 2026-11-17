import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { createDriverAuditSpacesArchive, driverAuditSpacesArchivePrefix,
  validateDriverAuditSpacesArchiveReference } from './driverAuditSpacesArchive.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { SPACES_KEY: 'fictional-key', SPACES_SECRET: 'fictional-secret',
  SPACES_BUCKET: 'fictional-archive', SPACES_ENDPOINT: 'nyc3.digitaloceanspaces.com', SPACES_REGION: 'nyc3' };
const failure = (name, status) => Object.assign(Error(name), { name, $metadata: { httpStatusCode: status } });
const privateAcl = { Owner: { ID: 'fictional-owner' }, Grants: [
  { Grantee: { Type: 'CanonicalUser', ID: 'fictional-owner' }, Permission: 'FULL_CONTROL' },
] };

function fixture(options = {}) {
  const objects = options.objects || new Map(), calls = [], cancelled = [];
  const client = { async send(command, { abortSignal } = {}) {
    abortSignal?.throwIfAborted();
    const name = command.constructor.name, input = command.input;
    calls.push({ name, input });
    if (options.send) {
      const result = await options.send(name, input, abortSignal);
      if (result !== undefined) return result;
    }
    if (name === 'GetBucketPolicyCommand') {
      if (options.policy) return { Policy: JSON.stringify(options.policy) };
      throw failure('NoSuchBucketPolicy', 404);
    }
    if (name === 'GetObjectAclCommand') return options.acl || privateAcl;
    if (name === 'PutObjectCommand') {
      if (input.IfNoneMatch && options.conditional === 'unsupported') throw failure('NotImplemented', 501);
      if (input.IfNoneMatch && objects.has(input.Key) && options.conditional !== 'ignored') {
        throw failure('PreconditionFailed', 412);
      }
      objects.set(input.Key, Buffer.from(input.Body));
      return { ETag: '"fictional-etag"' };
    }
    if (name === 'GetObjectCommand') {
      if (!objects.has(input.Key)) throw failure('NoSuchKey', 404);
      const bytes = Buffer.from(objects.get(input.Key));
      return { ContentLength: bytes.length, ETag: '"fictional-etag"',
        Body: (async function* () { yield bytes; })() };
    }
    throw Error('Unexpected archive operation: ' + name);
  } };
  const anonymousFetch = async (url, request) => {
    assert.equal(new URL(url).search, '');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.headers?.Authorization, undefined);
    request.signal.throwIfAborted();
    return { status: options.anonymousStatus ?? 403,
      body: { async cancel() { await options.cancel?.(url); cancelled.push(url); } } };
  };
  const archive = createDriverAuditSpacesArchive({ env, client, anonymousFetch, lookupExistingPhoto: options.lookupExistingPhoto });
  return { archive, objects, calls, cancelled };
}

test('Spaces identity binds only the strict Sidi endpoint, bucket and fixed private prefix', () => {
  const first = fixture().archive;
  const second = createDriverAuditSpacesArchive({ env: { ...env, SPACES_SECRET: 'rotated-secret' },
    client: { send() {} }, anonymousFetch() {} });
  assert.equal(first.identitySha256, second.identitySha256);
  assert.match(first.identitySha256, /^[a-f0-9]{64}$/);
  assert.equal(driverAuditSpacesArchivePrefix, 'driver-reports/archive/v1/');
  for (const change of [{ SPACES_ENDPOINT: 'http://nyc3.digitaloceanspaces.com' },
    { SPACES_ENDPOINT: 'https://evil.example' }, { SPACES_ENDPOINT: 'nyc3.digitaloceanspaces.com/path' },
    { SPACES_ENDPOINT: 'fictional-archive.nyc3.digitaloceanspaces.com' },
    { SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com:443' },
    { SPACES_REGION: 'fra1' }, { SPACES_BUCKET: '../other' }, { SPACES_BUCKET: '127.0.0.1' },
    { SPACES_KEY: '' }, { SPACES_SECRET: '' }]) {
    assert.throws(() => createDriverAuditSpacesArchive({ env: { ...env, ...change }, client: { send() {} } }),
      /Spaces.*configuration/);
  }
});

test('external references have an exact bounded hash-addressed schema and matching identity', () => {
  const bytes = Buffer.from('fictional compressed source evidence'), sha256 = hash(bytes);
  const ref = { version: 1, provider: 'spaces', identitySha256: 'a'.repeat(64),
    key: driverAuditSpacesArchivePrefix + sha256 + '.gz', size: bytes.length, sha256 };
  const checked = validateDriverAuditSpacesArchiveReference(ref, { identitySha256: ref.identitySha256,
    key: sha256 + '.gz', bytes: bytes.length });
  assert(Object.isFrozen(checked));
  assert.deepEqual(checked, ref);
  for (const change of [{ url: 'https://example.invalid' }, { version: 2 }, { provider: 'other' },
    { key: 'photos/' + sha256 + '.gz' }, { key: driverAuditSpacesArchivePrefix + 'b'.repeat(64) + '.gz' },
    { identitySha256: 'bad' }, { size: 0 }, { size: 16 * 1024 * 1024 + 1 }, { sha256: 'x'.repeat(64) }]) {
    assert.throws(() => validateDriverAuditSpacesArchiveReference({ ...ref, ...change }), /reference/);
  }
  assert.throws(() => validateDriverAuditSpacesArchiveReference(ref, { identitySha256: 'b'.repeat(64) }), /reference/);
  assert.throws(() => validateDriverAuditSpacesArchiveReference(ref, { key: sha256 + '.json' }), /reference/);
  assert.throws(() => validateDriverAuditSpacesArchiveReference(ref, { bytes: bytes.length + 1 }), /reference/);
});

test('private readiness verifies actual probe ACL, anonymous denial and conditional-write behavior', async () => {
  const f = fixture();
  const result = await f.archive.assertPrivate();
  assert.equal(result.public, false);
  assert.equal(result.conditionalWrites, true);
  assert.equal(result.identitySha256, f.archive.identitySha256);
  assert(f.calls.some(call => call.name === 'GetObjectAclCommand'));
  assert(f.cancelled.length > 0);
  assert(f.calls.filter(call => call.name === 'PutObjectCommand').every(call =>
    call.input.ACL === 'private' && call.input.IfNoneMatch === '*'));
  const count = f.calls.length, objectCount = f.objects.size;
  await f.archive.assertPrivate();
  assert(f.calls.length > count, 'Explicit readiness rechecks actual private access');
  assert.equal(f.objects.size, objectCount, 'Fresh privacy checks do not create new bookkeeping objects');
  assert.equal(objectCount, 2);
});

test('readiness fails closed on public or inconclusive access without uploading source evidence', async () => {
  const publicAcl = { ...privateAcl, Grants: [...privateAcl.Grants,
    { Grantee: { Type: 'Group', URI: 'http://acs.amazonaws.com/groups/global/AllUsers' }, Permission: 'READ' }] };
  for (const options of [{ acl: publicAcl }, { acl: { Grants: [] } }, { anonymousStatus: 200 },
    { anonymousStatus: 302 }, { anonymousStatus: 500 }]) {
    const f = fixture(options), bytes = Buffer.from('fictional evidence');
    await assert.rejects(f.archive.putVerifiedObject(hash(bytes) + '.gz', bytes), /private|privacy/);
    assert(!f.objects.has(driverAuditSpacesArchivePrefix + hash(bytes) + '.gz'));
  }
});

test('readable bucket policy may expose unrelated photos but cannot grant public native archive reads', async () => {
  const policy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*',
    Action: 's3:GetObject', Resource: 'arn:aws:s3:::fictional-archive/photos/*' }] };
  await fixture({ policy }).archive.assertPrivate();
  const unsafe = structuredClone(policy);
  unsafe.Statement[0].Resource = 'arn:aws:s3:::fictional-archive/driver-reports/*';
  await assert.rejects(fixture({ policy: unsafe }).archive.assertPrivate(), /private|policy/);
});

test('verified upload reuses exact bytes after restart and never exposes an overwrite or deletion path', async () => {
  const f = fixture(), bytes = Buffer.from('fictional photo and full original GPS clocks'), key = hash(bytes) + '.gz';
  const reference = await f.archive.putVerifiedObject(key, bytes);
  assert(Object.isFrozen(reference));
  assert.equal(reference.key, driverAuditSpacesArchivePrefix + key);
  const puts = f.calls.filter(call => call.name === 'PutObjectCommand' && call.input.Key === reference.key);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].input.ContentLength, bytes.length);
  assert.equal(puts[0].input.ContentMD5, createHash('md5').update(bytes).digest('base64'));
  assert.deepEqual(await f.archive.readBytes(reference, { maxBytes: bytes.length }), bytes);
  assert.deepEqual(await f.archive.putVerifiedObject(key, bytes), reference);
  const reopened = fixture({ objects: f.objects });
  assert.deepEqual(await reopened.archive.readBytes(reference, { maxBytes: bytes.length }), bytes);
  assert.deepEqual(await reopened.archive.putVerifiedObject(key, bytes), reference);
  assert.equal(f.calls.filter(call => call.name === 'PutObjectCommand' && call.input.Key === reference.key).length, 1);
  assert(!reopened.calls.some(call => call.name.includes('Delete')));
  await assert.rejects(f.archive.putVerifiedObject(key, Buffer.from('replacement')), /binding/);
  await assert.rejects(f.archive.readBytes(reference, { maxBytes: bytes.length - 1 }), /bound|limit/);
});

for (const conditional of ['ignored', 'unsupported']) {
  test('content-addressed fallback is explicit and concurrent legitimate writes remain identical: ' + conditional, async () => {
    const objects = new Map();
    let missingReads = 0, resume;
    const bothMissing = new Promise(resolve => { resume = resolve; });
    const bytes = Buffer.alloc(1300, 7), key = hash(bytes) + '.gz';
    async function send(name, input) {
      if (name === 'GetObjectCommand' && input.Key === driverAuditSpacesArchivePrefix + key
          && !objects.has(input.Key) && missingReads < 2) {
        missingReads++; if (missingReads === 2) resume(); await bothMissing;
      }
    }
    const a = fixture({ objects, conditional, send }), b = fixture({ objects, conditional, send });
    assert.equal((await a.archive.assertPrivate()).conditionalWrites, false);
    assert.equal((await b.archive.assertPrivate()).conditionalWrites, false);
    assert.equal(objects.size, 2);
    const probeBytes = [...objects].map(([name, body]) => [name, hash(body)]);
    await a.archive.assertPrivate();
    assert.deepEqual([...objects].map(([name, body]) => [name, hash(body)]), probeBytes,
      'Explicit fresh checks preserve the exact fixed sentinel bodies');
    const results = await Promise.all([a.archive.putVerifiedObject(key, bytes), b.archive.putVerifiedObject(key, bytes)]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(objects.get(driverAuditSpacesArchivePrefix + key), bytes);
    const puts = a.calls.concat(b.calls).filter(call => call.name === 'PutObjectCommand'
      && call.input.Key === driverAuditSpacesArchivePrefix + key);
    assert.equal(puts.length, 2, 'Both independent producers genuinely observed an absent object');
    assert(puts.every(call => Buffer.from(call.input.Body).equals(bytes)));
  });
}

test('an existing corrupt object fails without being overwritten even when conditional writes are unavailable', async () => {
  const f = fixture({ conditional: 'ignored' }), bytes = Buffer.from('immutable original'), key = hash(bytes) + '.gz';
  await f.archive.assertPrivate();
  const corrupt = Buffer.from('corrupt original');
  f.objects.set(driverAuditSpacesArchivePrefix + key, corrupt);
  await assert.rejects(f.archive.putVerifiedObject(key, bytes), /integrity/);
  assert.deepEqual(f.objects.get(driverAuditSpacesArchivePrefix + key), corrupt);
  assert(!f.calls.some(call => call.name === 'PutObjectCommand' && call.input.Key === driverAuditSpacesArchivePrefix + key));
});

test('bounded read rejects corrupt, truncated and oversized bodies and closes the stream', async () => {
  const bytes = Buffer.from('immutable original'), key = hash(bytes) + '.gz';
  for (const variant of ['hash', 'truncated', 'oversized', 'length']) {
    let destroyed = false;
    const f = fixture({ async send(name, input) {
      if (name !== 'GetObjectCommand' || input.Key !== driverAuditSpacesArchivePrefix + key) return;
      const chunk = variant === 'hash' ? Buffer.alloc(bytes.length, 1)
        : variant === 'truncated' ? bytes.subarray(1) : variant === 'oversized' ? Buffer.concat([bytes, bytes]) : bytes;
      return { ContentLength: variant === 'length' ? bytes.length + 1 : bytes.length,
        Body: { async *[Symbol.asyncIterator]() { yield chunk; }, destroy() { destroyed = true; } } };
    } });
    const ref = { version: 1, provider: 'spaces', identitySha256: f.archive.identitySha256,
      key: driverAuditSpacesArchivePrefix + key, size: bytes.length, sha256: hash(bytes) };
    await assert.rejects(f.archive.readBytes(ref, { maxBytes: bytes.length }), /integrity|bound|length/);
    assert(destroyed);
  }
});

test('cancellation before request and during a stalled body is observed and closes the stream', async () => {
  const stopped = new AbortController(); stopped.abort(Error('fictional stop'));
  const f = fixture(), bytes = Buffer.from('immutable original'), key = hash(bytes) + '.gz';
  await assert.rejects(f.archive.putVerifiedObject(key, bytes, { signal: stopped.signal }), /fictional stop/);
  assert.equal(f.calls.length, 0);
  let entered, destroyed = false;
  const reading = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
  const stalled = fixture({ async send(name, input) {
    if (name !== 'GetObjectCommand' || input.Key !== driverAuditSpacesArchivePrefix + key) return;
    return { ContentLength: bytes.length, Body: { [Symbol.asyncIterator]() { return this; },
      next() { entered(); return new Promise(() => {}); }, destroy() { destroyed = true; } } };
  } });
  const ref = { version: 1, provider: 'spaces', identitySha256: stalled.archive.identitySha256,
    key: driverAuditSpacesArchivePrefix + key, size: bytes.length, sha256: hash(bytes) };
  const result = assert.rejects(stalled.archive.readBytes(ref, { signal: controller.signal }), /fictional stop/);
  await reading;
  controller.abort(Error('fictional stop'));
  await result;
  assert(destroyed);
});

test('verified original Sidi photos reuse the existing key and preserve its ACL and URL', async () => {
  const bytes = Buffer.from('fictional original JPEG bytes'), sha256 = hash(bytes), key = sha256 + '.gz';
  const photoKey = 'photos/delivery-fictional-original.jpg';
  const f = fixture({ lookupExistingPhoto(args) {
    assert.equal(args.sha256, sha256); assert.equal(args.size, bytes.length);
    return { key: photoKey };
  } });
  f.objects.set(photoKey, bytes);
  const reference = await f.archive.putVerifiedObject(key, bytes);
  assert.equal(reference.kind, 'existing-photo-v1');
  assert.equal(reference.key, photoKey);
  assert.equal(reference.etag, '"fictional-etag"');
  assert.equal(reference.versionId, null);
  assert(Object.isFrozen(reference));
  assert.deepEqual(await f.archive.readBytes(reference), bytes);
  const reads = f.calls.filter(call => call.name === 'GetObjectCommand' && call.input.Key === photoKey);
  assert.equal(reads.length, 2, 'Admission performs one exact full read, and the later reference read is separately pinned');
  assert.equal(reads[1].input.IfMatch, reference.etag);
  assert(!f.calls.some(call => call.input.Key === photoKey && call.name !== 'GetObjectCommand'));
  assert(!f.objects.has(driverAuditSpacesArchivePrefix + key));
  f.objects.set(photoKey, Buffer.from('changed public image bytes'));
  await assert.rejects(f.archive.readBytes(reference), /integrity/);
});

test('missing or changed original photos fall back to exact private bytes before admission', async () => {
  for (const existing of [null, Buffer.from('mutated original')]) {
    const bytes = Buffer.from('fictional original JPEG bytes'), key = hash(bytes) + '.gz';
    const f = fixture({ lookupExistingPhoto: () => ({ key: 'photos/delivery-original.jpg' }) });
    if (existing) f.objects.set('photos/delivery-original.jpg', existing);
    const reference = await f.archive.putVerifiedObject(key, bytes);
    assert.equal(reference.kind, undefined);
    assert.equal(reference.key, driverAuditSpacesArchivePrefix + key);
    assert.deepEqual(await f.archive.readBytes(reference), bytes);
    assert(!f.calls.some(call => call.name === 'PutObjectCommand' && call.input.Key.startsWith('photos/')));
    assert.deepEqual(f.objects.get('photos/delivery-original.jpg') ?? null, existing);
  }
});

test('photo alias input rejects foreign, encoded and traversing keys and pins real versions on every read', async () => {
  const bytes = Buffer.from('fictional original'), key = hash(bytes) + '.gz';
  for (const candidate of [{ key: 'https://example.invalid/photos/original.jpg' },
    { key: 'photos/../original.jpg' }, { key: 'photos/%2e%2e/original.jpg' },
    { key: 'other/original.jpg' }, { key: 'photos/original.jpg', url: 'extra' }]) {
    const f = fixture({ lookupExistingPhoto: () => candidate });
    await assert.rejects(f.archive.putVerifiedObject(key, bytes), /reference/);
    assert(!f.calls.some(call => call.name === 'GetObjectCommand' && call.input.Key === candidate.key));
  }
  const f = fixture({ lookupExistingPhoto: () => ({ key: 'photos/versioned.jpg' }),
    send(name, input) {
      if (name === 'GetObjectCommand' && input.Key === 'photos/versioned.jpg') return {
        ContentLength: bytes.length, ETag: '"real-pinned-etag"', VersionId: 'real-version-id',
        Body: (async function* () { yield bytes; })(),
      };
    } });
  const reference = await f.archive.putVerifiedObject(key, bytes);
  assert.equal(reference.versionId, 'real-version-id');
  await f.archive.readBytes(reference);
  const read = f.calls.filter(call => call.name === 'GetObjectCommand' && call.input.Key === reference.key).at(-1);
  assert.equal(read.input.IfMatch, reference.etag);
  assert.equal(read.input.VersionId, reference.versionId);
  for (const change of [{ etag: 'bad' }, { versionId: '\r\nunsafe' }, { kind: 'other' },
    { key: 'photos/../../foreign' }, { sha256: 'a'.repeat(64) }]) {
    if (change.sha256) {
      assert.throws(() => validateDriverAuditSpacesArchiveReference({ ...reference, ...change }, { key }), /reference/);
    } else assert.throws(() => validateDriverAuditSpacesArchiveReference({ ...reference, ...change }), /reference/);
  }
});

test('real AWS SDK serialization sends private ACL, conditional headers and exact bounded bodies without network', async () => {
  const objects = new Map(), requests = [];
  const errorXml = code => Buffer.from(`<Error><Code>${code}</Code><Message>Fictional fixture</Message></Error>`);
  const response = (statusCode, body, headers = {}) => ({ response: { statusCode,
    headers: { 'content-length': String(body.length), ...headers }, body: Readable.from([body]) } });
  const client = new S3Client({ endpoint: 'https://nyc3.digitaloceanspaces.com', region: 'nyc3',
    credentials: { accessKeyId: env.SPACES_KEY, secretAccessKey: env.SPACES_SECRET }, maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { async handle(request) {
      assert.equal(request.hostname, 'fictional-archive.nyc3.digitaloceanspaces.com');
      assert.equal(request.protocol, 'https:'); requests.push(request);
      if (Object.hasOwn(request.query || {}, 'policy')) return response(404, errorXml('NoSuchBucketPolicy'));
      if (Object.hasOwn(request.query || {}, 'acl')) return response(200, Buffer.from(
        '<AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>fictional-owner</ID></Owner>'
        + '<AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser">'
        + '<ID>fictional-owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>'));
      if (request.method === 'PUT') {
        assert.equal(request.headers['x-amz-acl'], 'private');
        assert.equal(request.headers['if-none-match'], '*');
        if (objects.has(request.path)) return response(412, errorXml('PreconditionFailed'));
        objects.set(request.path, Buffer.from(request.body)); return response(200, Buffer.alloc(0));
      }
      if (!objects.has(request.path)) return response(404, errorXml('NoSuchKey'));
      return response(200, objects.get(request.path), { etag: '"fixture-etag"' });
    } } });
  const archive = createDriverAuditSpacesArchive({ env, client,
    anonymousFetch: async () => ({ status: 403, body: { async cancel() {} } }) });
  const bytes = Buffer.from('fictional actual SDK fixture'), key = hash(bytes) + '.gz';
  const ref = await archive.putVerifiedObject(key, bytes);
  assert.deepEqual(await archive.readBytes(ref), bytes);
  assert(requests.some(request => request.method === 'GET' && request.path.endsWith(key)));
  client.destroy();
});

test('the provider bound holds four active reads and cancellation removes queued work before opening it', async () => {
  const bytes = Buffer.from('fictional bounded read'), key = hash(bytes) + '.gz';
  let active = 0, peak = 0, entered = 0, unblock;
  const hold = new Promise(resolve => { unblock = resolve; });
  let four;
  const firstFour = new Promise(resolve => { four = resolve; });
  const f = fixture({ async send(name, input) {
    if (name !== 'GetObjectCommand' || input.Key !== driverAuditSpacesArchivePrefix + key) return;
    active++; entered++; peak = Math.max(peak, active); if (entered === 4) four();
    await hold; active--;
    return { ContentLength: bytes.length, Body: (async function* () { yield bytes; })() };
  } });
  await f.archive.assertPrivate();
  const ref = { version: 1, provider: 'spaces', identitySha256: f.archive.identitySha256,
    key: driverAuditSpacesArchivePrefix + key, size: bytes.length, sha256: hash(bytes) };
  const running = Array.from({ length: 4 }, () => f.archive.readBytes(ref));
  await firstFour;
  const controller = new AbortController();
  const stopped = assert.rejects(f.archive.readBytes(ref, { signal: controller.signal }), /queued cancellation/);
  controller.abort(Error('queued cancellation')); await stopped;
  assert.equal(entered, 4);
  unblock(); await Promise.all(running); assert.equal(peak, 4);
});

test('synchronous cancellation still observes a later iterator rejection and closes a late response body', async () => {
  const bytes = Buffer.from('fictional original'), key = hash(bytes) + '.gz', controller = new AbortController();
  let destroyed = false;
  const f = fixture({ send(name, input) {
    if (name !== 'GetObjectCommand' || input.Key !== driverAuditSpacesArchivePrefix + key) return;
    return { ContentLength: bytes.length, Body: { [Symbol.asyncIterator]() { return this; },
      next() { controller.abort(Error('synchronous fixture cancellation')); return Promise.reject(Error('late fixture iterator failure')); },
      destroy() { destroyed = true; } } };
  } });
  const ref = { version: 1, provider: 'spaces', identitySha256: f.archive.identitySha256,
    key: driverAuditSpacesArchivePrefix + key, size: bytes.length, sha256: hash(bytes) };
  await assert.rejects(f.archive.readBytes(ref, { signal: controller.signal }), /synchronous fixture cancellation/);
  await new Promise(resolve => setImmediate(resolve)); assert(destroyed);
  const lateAbort = new AbortController(); let release, close = false;
  const late = new Promise(resolve => { release = resolve; });
  const g = fixture({ async send(name, input) {
    if (name !== 'GetObjectCommand' || input.Key !== driverAuditSpacesArchivePrefix + key) return;
    await late;
    return { ContentLength: bytes.length, Body: { destroy() { close = true; } } };
  } });
  await g.archive.assertPrivate();
  const rejected = assert.rejects(g.archive.readBytes(ref, { signal: lateAbort.signal }), /late response cancellation/);
  await new Promise(resolve => setImmediate(resolve));
  lateAbort.abort(Error('late response cancellation')); await rejected;
  release(); await new Promise(resolve => setImmediate(resolve)); assert(close);
});

test('a stalled anonymous response cancellation cannot outlive its operation or poison the next privacy check', async () => {
  let began, stall = true;
  const cancellation = new Promise(resolve => { began = resolve; });
  const f = fixture({ cancel() { if (stall) { began(); return new Promise(() => {}); } } });
  const controller = new AbortController();
  const stopped = assert.rejects(f.archive.assertPrivate({ signal: controller.signal }), /privacy cancellation/);
  await cancellation;
  controller.abort(Error('fictional privacy cancellation'));
  await stopped;
  stall = false;
  const result = await Promise.race([f.archive.assertPrivate(), new Promise((_, reject) =>
    setTimeout(() => reject(Error('Privacy proof remained stuck')), 500))]);
  assert.equal(result.public, false);
  assert.equal(f.objects.size, 2);
});

test('an interrupted ignored-condition probe restores only its known fixed non-customer alternate on restart', async () => {
  const objects = new Map(), controller = new AbortController();
  let interrupt = true;
  const f = fixture({ objects, conditional: 'ignored', send(name, input) {
    if (interrupt && name === 'PutObjectCommand' && input.Key.endsWith('/conditional.json')
        && Buffer.from(input.Body).includes('non-customer-conditional-alternate')) {
      objects.set(input.Key, Buffer.from(input.Body)); interrupt = false;
      controller.abort(Error('Fictional interrupted conditional probe')); return {};
    }
  } });
  await assert.rejects(f.archive.assertPrivate({ signal: controller.signal }), /interrupted/);
  const reopened = fixture({ objects, conditional: 'ignored' });
  assert.equal((await reopened.archive.assertPrivate()).public, false);
  assert.equal(objects.size, 2);
  assert([...objects.values()].some(body => body.includes('driver-report-conditional-readiness')));
  assert(![...objects.values()].some(body => body.includes('non-customer-conditional-alternate')));
  const privateKey = [...objects.keys()].find(key => key.endsWith('/private.json'));
  const corrupt = Buffer.from('unrecognized private sentinel bytes'); objects.set(privateKey, corrupt);
  await assert.rejects(reopened.archive.assertPrivate(), /integrity/);
  assert.deepEqual(objects.get(privateKey), corrupt, 'Unknown preexisting bytes are never overwritten');
});

test('a freshly downloaded source photo can offer a RAM-only candidate without network or durable metadata', async () => {
  const bytes = Buffer.from('fictional fresh original image'), key = hash(bytes) + '.gz';
  const f = fixture({ lookupExistingPhoto: () => null });
  assert.equal(f.archive.addExistingPhotoCandidate({ sha256: hash(bytes), size: bytes.length,
    key: 'photos/delivery-new.jpg' }), true);
  assert.equal(f.calls.length, 0); assert.equal(f.objects.size, 0);
  f.objects.set('photos/delivery-new.jpg', bytes);
  const reference = await f.archive.putVerifiedObject(key, bytes);
  assert.equal(reference.kind, 'existing-photo-v1');
  assert.equal(reference.key, 'photos/delivery-new.jpg');
  assert(!f.objects.has(driverAuditSpacesArchivePrefix + key));
  for (const invalid of [{ sha256: 'bad', size: 1, key: 'photos/file.jpg' },
    { sha256: hash(bytes), size: 0, key: 'photos/file.jpg' },
    { sha256: hash(bytes), size: bytes.length, key: 'https://other.example/photos/file.jpg' },
    { sha256: hash(bytes), size: bytes.length, key: '../photos/file.jpg' },
    { sha256: hash(bytes), size: bytes.length, key: 'photos/file.jpg', extra: 'not-metadata' }]) {
    assert.equal(f.archive.addExistingPhotoCandidate(invalid), false);
  }
});

test('a failed RAM candidate can reuse an independently verified historical key', async () => {
  const bytes = Buffer.from('fictional repeated original image'), key = hash(bytes) + '.gz';
  const f = fixture({ lookupExistingPhoto: () => ({ key: 'photos/historical-original.jpg' }) });
  f.objects.set('photos/historical-original.jpg', bytes);
  f.archive.addExistingPhotoCandidate({ sha256: hash(bytes), size: bytes.length, key: 'photos/missing-current.jpg' });
  const reference = await f.archive.putVerifiedObject(key, bytes);
  assert.equal(reference.key, 'photos/historical-original.jpg');
  assert(!f.objects.has(driverAuditSpacesArchivePrefix + key));
});

test('RAM source hints keep at most 512 current SHA entries and retain the newest candidate', async () => {
  const f = fixture();
  const first = Buffer.from('first fictional photo'), last = Buffer.from('last fictional photo');
  f.archive.addExistingPhotoCandidate({ sha256: hash(first), size: first.length, key: 'photos/first.jpg' });
  for (let index = 0; index < 512; index++) {
    const body = index === 511 ? last : Buffer.from('middle fictional photo ' + index);
    f.archive.addExistingPhotoCandidate({ sha256: hash(body), size: body.length, key: 'photos/item-' + index + '.jpg' });
  }
  f.objects.set('photos/first.jpg', first); f.objects.set('photos/item-511.jpg', last);
  assert.equal((await f.archive.putVerifiedObject(hash(first) + '.gz', first)).kind, undefined);
  assert.equal((await f.archive.putVerifiedObject(hash(last) + '.gz', last)).kind, 'existing-photo-v1');
});
