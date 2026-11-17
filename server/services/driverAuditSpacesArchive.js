import { createHash } from 'node:crypto';
import { GetBucketPolicyCommand, GetObjectAclCommand, GetObjectCommand, PutObjectCommand,
  S3Client } from '@aws-sdk/client-s3';

export const driverAuditSpacesArchivePrefix = 'driver-reports/archive/v1/';
const maximumBytes = 16 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const keyPattern = /^[a-f0-9]{64}\.(?:gz|json)$/;
const etagPattern = /^"[\x21\x23-\x7e]{1,200}"$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const status = error => error?.$metadata?.httpStatusCode;
const missing = error => status(error) === 404 || error?.name === 'NoSuchKey';
const unsupported = error => status(error) === 501 || ['NotImplemented', 'NotSupported'].includes(error?.name);

export function validateDriverAuditSpacesArchiveReference(reference, { identitySha256, key, bytes } = {}) {
  const alias = reference?.kind === 'existing-photo-v1';
  const fields = ['version', 'provider', 'identitySha256', 'key', 'size', 'sha256',
    ...(alias ? ['kind', 'etag', 'versionId'] : [])];
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || Object.keys(reference).length !== fields.length || fields.some(field => !Object.hasOwn(reference, field))
      || reference.version !== 1 || reference.provider !== 'spaces'
      || !hashPattern.test(reference.identitySha256) || !hashPattern.test(reference.sha256)
      || !Number.isSafeInteger(reference.size) || reference.size < 1 || reference.size > maximumBytes
      || (alias ? !existingPhotoKey(reference.key) || !etagPattern.test(reference.etag)
        || !(reference.versionId === null || (typeof reference.versionId === 'string'
          && /^[A-Za-z0-9._~+/=-]{1,512}$/.test(reference.versionId)))
        : typeof reference.key !== 'string' || !reference.key.startsWith(driverAuditSpacesArchivePrefix)
          || !keyPattern.test(reference.key.slice(driverAuditSpacesArchivePrefix.length))
          || reference.key.slice(driverAuditSpacesArchivePrefix.length, driverAuditSpacesArchivePrefix.length + 64) !== reference.sha256)
      || (identitySha256 !== undefined && reference.identitySha256 !== identitySha256)
      || (key !== undefined && (!keyPattern.test(key) || (alias ? key.slice(0, 64) !== reference.sha256
        : reference.key !== driverAuditSpacesArchivePrefix + key)))
      || (bytes !== undefined && (!Number.isSafeInteger(bytes) || reference.size !== bytes))) {
    throw Error('Native Spaces archive reference is invalid');
  }
  return Object.freeze(Object.fromEntries(fields.map(field => [field, reference[field]])));
}

function existingPhotoKey(key) {
  return typeof key === 'string' && key.length <= 512
    && /^photos\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)
    && !key.split('/').some(part => part === '.' || part === '..');
}

function configuration(env) {
  const endpointText = env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com';
  const match = /^(?:https:\/\/)?([a-z][a-z0-9-]{1,19})\.digitaloceanspaces\.com\/?$/.exec(endpointText);
  const bucket = env.SPACES_BUCKET, region = env.SPACES_REGION || match?.[1];
  if (!match || region !== match[1] || typeof bucket !== 'string'
      || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)
      || typeof env.SPACES_KEY !== 'string' || !env.SPACES_KEY.trim()
      || typeof env.SPACES_SECRET !== 'string' || !env.SPACES_SECRET.trim()) {
    throw Error('Native Spaces archive configuration is invalid');
  }
  return { endpoint: `https://${match[1]}.digitaloceanspaces.com`, bucket, region };
}

// Always observe an already-created promise, including a synchronous abort in
// iterator.next(). Otherwise a late stream rejection could escape cancellation.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || Error('Native archive operation cancelled'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

function closeBody(body) {
  body?.destroy?.();
  if (body?.cancel) Promise.resolve(body.cancel()).catch(() => {});
}

function assertOwnerPrivate(acl) {
  const owner = acl?.Owner?.ID;
  if (typeof owner !== 'string' || !owner || owner.length > 256 || !Array.isArray(acl.Grants)
      || !acl.Grants.length || acl.Grants.length > 16
      || !acl.Grants.some(grant => grant?.Permission === 'FULL_CONTROL')
      || acl.Grants.some(grant => grant?.Grantee?.ID !== owner || grant.Grantee.URI
        || grant.Grantee.EmailAddress || (grant.Grantee.Type && grant.Grantee.Type !== 'CanonicalUser')
        || !['FULL_CONTROL', 'READ', 'READ_ACP', 'WRITE_ACP'].includes(grant.Permission))) {
    throw Error('Native Spaces archive object is not owner-private');
  }
}

const array = value => Array.isArray(value) ? value : [value];
function glob(pattern, value) {
  return typeof pattern === 'string' && pattern.length <= 2048
    && new RegExp('^' + pattern.split('*').map(part => part.split('?')
      .map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*') + '$').test(value);
}

function assertPrivatePolicy(text, bucket) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024) throw Error('Native Spaces archive policy is invalid');
  let policy;
  try { policy = JSON.parse(text); } catch { throw Error('Native Spaces archive policy is invalid'); }
  const statements = array(policy?.Statement);
  if (!statements.length || statements.length > 256 || statements.some(row => !row || typeof row !== 'object')) {
    throw Error('Native Spaces archive policy is invalid');
  }
  for (const row of statements) {
    if (row.Effect !== 'Allow') continue;
    const publicPrincipal = row.NotPrincipal !== undefined || row.Principal === '*'
      || array(row.Principal?.AWS).includes('*');
    if (!publicPrincipal) continue;
    const canRead = row.NotAction !== undefined || array(row.Action).some(action =>
      typeof action === 'string' && glob(action.toLowerCase(), 's3:getobject'));
    if (!canRead) continue;
    const resources = array(row.Resource);
    if (row.NotResource !== undefined || resources.some(resource => {
      if (resource === '*') return true;
      if (typeof resource !== 'string' || resource.length > 2048) return true;
      const arn = /^arn:aws:s3:::([^/]+)\/(.*)$/.exec(resource);
      if (!arn) return true;
      if (!glob(arn[1], bucket)) return false;
      const fixed = arn[2].split(/[?*]/, 1)[0];
      return fixed.startsWith(driverAuditSpacesArchivePrefix) || driverAuditSpacesArchivePrefix.startsWith(fixed);
    })) throw Error('Native Spaces archive policy permits public reads');
  }
}

export function createDriverAuditSpacesArchive({ env = process.env, client, anonymousFetch = globalThis.fetch,
  lookupExistingPhoto } = {}) {
  const { endpoint, bucket, region } = configuration(env);
  if (typeof anonymousFetch !== 'function' || (client && typeof client.send !== 'function')
      || (lookupExistingPhoto !== undefined && typeof lookupExistingPhoto !== 'function')) {
    throw Error('Native Spaces archive configuration is invalid');
  }
  const identitySha256 = digest(JSON.stringify({ version: 1, provider: 'spaces', endpoint, bucket,
    prefix: driverAuditSpacesArchivePrefix }));
  const transport = client || new S3Client({ endpoint, region, forcePathStyle: false, maxAttempts: 2,
    credentials: { accessKeyId: env.SPACES_KEY, secretAccessKey: env.SPACES_SECRET },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  let ready = null, conditionalSupport, active = 0;
  const waiting = [], photoHints = new Map();

  async function acquire(signal) {
    signal.throwIfAborted();
    if (active < 4) { active++; return; }
    if (waiting.length >= 32) throw Error('Native Spaces archive concurrency bound exceeded');
    await new Promise((resolve, reject) => {
      const row = { resolve() { signal.removeEventListener('abort', abort); resolve(); } };
      function abort() { const index = waiting.indexOf(row); if (index >= 0) waiting.splice(index, 1); reject(signal.reason); }
      waiting.push(row); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  function release() { const next = waiting.shift(); if (next) next.resolve(); else active--; }
  async function operation(signal, callback) {
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]);
    await acquire(bounded);
    try { bounded.throwIfAborted(); return await callback(bounded); } finally { release(); }
  }
  const send = (command, signal) => {
    signal.throwIfAborted();
    const result = Promise.resolve(transport.send(command, { abortSignal: signal })).then(response => {
      if (signal.aborted) { closeBody(response?.Body); signal.throwIfAborted(); }
      return response;
    });
    return abortable(result, signal);
  };

  async function getVerified(key, size, sha256, signal, { etag, versionId } = {}) {
    const response = await send(new GetObjectCommand({ Bucket: bucket, Key: key,
      ...(etag ? { IfMatch: etag } : {}), ...(versionId ? { VersionId: versionId } : {}) }), signal);
    const body = response.Body;
    try {
      if (!Number.isSafeInteger(response.ContentLength) || response.ContentLength !== size
          || !body?.[Symbol.asyncIterator]) throw Error('Native Spaces archive length integrity failure');
      if ((etag && response.ETag !== etag) || (versionId && response.VersionId !== versionId)) {
        throw Error('Native Spaces archive version integrity failure');
      }
      const parts = [], iterator = body[Symbol.asyncIterator]();
      let count = 0;
      while (true) {
        signal.throwIfAborted();
        const step = await abortable(iterator.next(), signal);
        if (step.done) break;
        if (!(step.value instanceof Uint8Array)) throw Error('Native Spaces archive body integrity failure');
        count += step.value.length;
        if (count > size) throw Error('Native Spaces archive body exceeds its bound');
        parts.push(Buffer.from(step.value));
      }
      const bytes = Buffer.concat(parts, count);
      if (count !== size || digest(bytes) !== sha256) throw Error('Native Spaces archive byte integrity failure');
      return { bytes, etag: response.ETag, versionId: response.VersionId ?? null };
    } finally { closeBody(body); }
  }
  const getBytes = async (...args) => (await getVerified(...args)).bytes;

  function put(key, bytes, conditional, signal) {
    return send(new PutObjectCommand({ Bucket: bucket, Key: key, ACL: 'private', Body: bytes,
      ContentType: 'application/octet-stream', ContentLength: bytes.length,
      ContentMD5: createHash('md5').update(bytes).digest('base64'), Metadata: { sha256: digest(bytes) },
      ...(conditional ? { IfNoneMatch: '*' } : {}) }), signal);
  }

  async function privateObject(key, signal) {
    assertOwnerPrivate(await send(new GetObjectAclCommand({ Bucket: bucket, Key: key }), signal));
    const url = new URL(`https://${bucket}.${new URL(endpoint).hostname}/${key}`);
    const pending = Promise.resolve(anonymousFetch(url.href, { method: 'GET', redirect: 'error',
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Range: 'bytes=0-0' }, signal })).then(response => {
      if (signal.aborted) { closeBody(response?.body); signal.throwIfAborted(); }
      return response;
    });
    const response = await abortable(pending, signal);
    try {
      if (![403, 404].includes(response?.status)) throw Error('Native Spaces archive privacy check was not denied');
    } finally { if (response?.body?.cancel) await abortable(response.body.cancel(), signal); }
  }

  async function provePrivate(signal) {
    const root = driverAuditSpacesArchivePrefix + '.private-check/' + identitySha256 + '/';
    const probe = Buffer.from(JSON.stringify({ version: 1, kind: 'driver-report-private-readiness', identitySha256 }));
    const condition = Buffer.from(JSON.stringify({ version: 1, kind: 'driver-report-conditional-readiness', identitySha256 }));
    const alternate = Buffer.from(JSON.stringify({ version: 1, kind: 'non-customer-conditional-alternate', identitySha256 }));
    async function ensureProbe(key, body, recoverAlternate = false) {
      try { await getBytes(key, body.length, digest(body), signal); return; }
      catch (error) {
        if (recoverAlternate && /integrity/.test(error.message)) {
          // A prior interrupted test may have left only this exact non-customer
          // alternate. It is the sole path where restoring owned bytes is legal.
          await getBytes(key, alternate.length, digest(alternate), signal);
          await put(key, body, false, signal);
        } else if (missing(error)) {
          try { await put(key, body, true, signal); }
          catch (writeError) {
            if (unsupported(writeError)) await put(key, body, false, signal);
            else if (status(writeError) !== 412 && writeError?.name !== 'PreconditionFailed') throw writeError;
          }
        } else throw error;
      }
      await getBytes(key, body.length, digest(body), signal);
    }
    await ensureProbe(root + 'private.json', probe);
    await ensureProbe(root + 'conditional.json', condition, true);
    if (conditionalSupport === undefined) {
      try {
        await put(root + 'conditional.json', alternate, true, signal);
        // If this succeeds, the provider ignored the condition. Restore only our
        // fixed, non-customer sentinel; evidence keys have no overwrite route.
        await put(root + 'conditional.json', condition, false, signal);
        conditionalSupport = false;
      }
      catch (error) {
        if (status(error) === 412 || error?.name === 'PreconditionFailed') conditionalSupport = true;
        else if (unsupported(error)) conditionalSupport = false;
        else throw error;
      }
    }
    await getBytes(root + 'conditional.json', condition.length, digest(condition), signal);
    await privateObject(root + 'private.json', signal);
    await privateObject(root + 'conditional.json', signal);
    try {
      const policy = await send(new GetBucketPolicyCommand({ Bucket: bucket }), signal);
      assertPrivatePolicy(policy.Policy, bucket);
    } catch (error) {
      if (!(status(error) === 403 || status(error) === 404 || unsupported(error)
          || error?.name === 'NoSuchBucketPolicy')) throw error;
    }
    return Object.freeze({ provider: 'spaces', identitySha256, public: false,
      conditionalWrites: conditionalSupport, checkedAt: new Date().toISOString() });
  }
  function ensurePrivate(signal) {
    if (!ready) {
      const current = provePrivate(signal).catch(error => { if (ready === current) ready = null; throw error; });
      ready = current;
    }
    return abortable(ready, signal);
  }

  return Object.freeze({ identitySha256,
    addExistingPhotoCandidate(value) {
      if (!value || typeof value !== 'object' || Object.keys(value).length !== 3
          || !Object.hasOwn(value, 'sha256') || !Object.hasOwn(value, 'size') || !Object.hasOwn(value, 'key')
          || !hashPattern.test(value.sha256) || !Number.isSafeInteger(value.size)
          || value.size < 1 || value.size > maximumBytes || !existingPhotoKey(value.key)) return false;
      photoHints.delete(value.sha256);
      photoHints.set(value.sha256, Object.freeze({ key: value.key, size: value.size }));
      if (photoHints.size > 512) photoHints.delete(photoHints.keys().next().value);
      return true;
    },
    assertPrivate({ signal } = {}) {
      return operation(signal, bounded => { ready = null; return ensurePrivate(bounded); });
    },
    readBytes(reference, { maxBytes = maximumBytes, signal } = {}) {
      const checked = validateDriverAuditSpacesArchiveReference(reference, { identitySha256 });
      if (!Number.isSafeInteger(maxBytes) || maxBytes < checked.size || maxBytes > maximumBytes) {
        return Promise.reject(Error('Native Spaces archive read exceeds its bound'));
      }
      return operation(signal, async bounded => {
        await ensurePrivate(bounded);
        return getBytes(checked.key, checked.size, checked.sha256, bounded,
          checked.kind === 'existing-photo-v1' ? { etag: checked.etag, versionId: checked.versionId } : {});
      });
    },
    putVerifiedObject(key, bytes, { signal } = {}) {
      if (!keyPattern.test(key) || !Buffer.isBuffer(bytes) || !bytes.length
          || bytes.length > maximumBytes || digest(bytes) !== key.slice(0, 64)) {
        return Promise.reject(Error('Native Spaces archive object binding is invalid'));
      }
      // Own the admitted bytes: a caller cannot mutate its Buffer during I/O.
      const body = Buffer.from(bytes), objectKey = driverAuditSpacesArchivePrefix + key;
      return operation(signal, async bounded => {
        const proof = await ensurePrivate(bounded);
        const sha256 = digest(body), hint = photoHints.get(sha256), candidates = [], tried = new Set();
        if (hint?.size === body.length) candidates.push(() => ({ key: hint.key }));
        if (lookupExistingPhoto) candidates.push(() => abortable(lookupExistingPhoto({ sha256,
          size: body.length, signal: bounded }), bounded));
        for (const lookup of candidates) {
          const candidate = await lookup();
          if (candidate !== null && candidate !== undefined) {
            if (!candidate || Object.keys(candidate).length !== 1 || !Object.hasOwn(candidate, 'key')
                || !existingPhotoKey(candidate.key)) throw Error('Native Spaces existing photo reference is invalid');
            if (tried.has(candidate.key)) continue;
            tried.add(candidate.key);
            try {
              const original = await getVerified(candidate.key, body.length, digest(body), bounded);
              return validateDriverAuditSpacesArchiveReference({ version: 1, provider: 'spaces', identitySha256,
                kind: 'existing-photo-v1', key: candidate.key, size: body.length, sha256: digest(body),
                etag: original.etag, versionId: original.versionId }, { key, bytes: body.length });
            } catch (error) {
              bounded.throwIfAborted();
              // A missing/mutated/unverifiable current upload cannot represent
              // historical bytes. Preserve the supplied original privately.
              if (!missing(error) && !/integrity|reference/.test(error.message)) throw error;
              if (photoHints.get(sha256)?.key === candidate.key) photoHints.delete(sha256);
            }
          }
        }
        try {
          await getBytes(objectKey, body.length, digest(body), bounded);
        } catch (error) {
          if (!missing(error)) throw error;
          // Every permitted producer for this content-addressed key has exactly
          // these bytes. On providers without conditional PUT, concurrent absent
          // writes are therefore identical; present corrupt bytes are never
          // overwritten. The probe records which contract the provider supports.
          try { await put(objectKey, body, proof.conditionalWrites, bounded); }
          catch (writeError) {
            if (![409, 412].includes(status(writeError)) && writeError?.name !== 'PreconditionFailed') throw writeError;
          }
          await getBytes(objectKey, body.length, digest(body), bounded);
        }
        await privateObject(objectKey, bounded);
        bounded.throwIfAborted();
        return validateDriverAuditSpacesArchiveReference({ version: 1, provider: 'spaces', identitySha256,
          key: objectKey, size: body.length, sha256: digest(body) }, { key, bytes: body.length });
      });
    },
  });
}
