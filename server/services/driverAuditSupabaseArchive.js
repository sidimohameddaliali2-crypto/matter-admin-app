import { createHash } from 'node:crypto';
import { driverAuditExistingPhotoKey } from './driverAuditNativeObjectStore.js';
import { validateDriverAuditSpacesArchiveReference } from './driverAuditSpacesArchive.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keyPattern = /^[a-f0-9]{64}\.(?:gz|json)$/;
const maximumBytes = 16 * 1024 ** 2;
const check = (condition, message) => { if (!condition) throw Error(message); };

// Existing Supabase objects stay untouched. Only new, fully verified photo
// references use the original delivery uploads; no image or archive is copied
// to Spaces by this adapter.
export function createDriverAuditSupabaseArchive({ archive, rpc, photoStore, env = process.env } = {}) {
  check(typeof archive?.readObject === 'function' && typeof archive?.putVerifiedObject === 'function'
    && typeof archive?.assertPrivate === 'function' && typeof rpc === 'function'
    && typeof photoStore?.verifyExistingPhoto === 'function' && typeof photoStore?.readExistingPhoto === 'function'
    && typeof photoStore?.assertExistingPhotoRetention === 'function'
    && /^[a-f0-9]{64}$/.test(photoStore.identitySha256 || ''), 'Supabase photo archive dependencies are required');
  const candidates = new Map();
  let retained;
  const retention = () => retained ??= photoStore.assertExistingPhotoRetention().catch(error => { retained = null; throw error; });
  function reference(value, key, bytes) {
    check(value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 1 && Object.hasOwn(value, 'reference'), 'Supabase photo alias response is invalid');
    if (value.reference === null) return null;
    const row = validateDriverAuditSpacesArchiveReference(value.reference,
      { identitySha256: photoStore.identitySha256, key, bytes });
    check(row.kind === 'existing-photo-v1', 'Supabase photo aliases must reference existing uploads');
    return row;
  }
  async function readAlias(key, bytes) {
    return reference(await rpc('matter_hosted_app_photo_alias_read', { p_key: key }), key, bytes);
  }
  async function readPhoto(row, options, key) {
    try {
      const bytes = await photoStore.readExistingPhoto(row, options);
      check(Buffer.isBuffer(bytes) && bytes.length === row.size && hash(bytes) === row.sha256,
        'Existing photo byte integrity failure');
      return bytes;
    } catch (photoError) {
      options.signal?.throwIfAborted();
      // Admission of a reference must never make a preserved older Supabase
      // object inaccessible. Only the exact same size/hash can recover it;
      // the immutable reference and original uploads are never changed.
      try {
        const parts = [];
        let size = 0;
        for await (const chunk of await archive.readObject(key, { ...options, maxBytes: row.size })) {
          options.signal?.throwIfAborted();
          size += chunk.byteLength;
          check(size <= row.size, 'Preserved photo exceeds its bound');
          parts.push(Buffer.from(chunk));
        }
        const preserved = Buffer.concat(parts, size);
        check(size === row.size && hash(preserved) === row.sha256, 'Preserved photo integrity failure');
        return preserved;
      } catch {
        options.signal?.throwIfAborted();
        throw photoError;
      }
    }
  }
  const offer = value => {
    if (!value || Object.keys(value).length !== 3 || !/^[a-f0-9]{64}$/.test(value.sha256)
      || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > maximumBytes) return false;
    const key = driverAuditExistingPhotoKey(value.url, env);
    if (!key) return false;
    candidates.delete(value.sha256);
    candidates.set(value.sha256, { key, size: value.size });
    if (candidates.size > 512) candidates.delete(candidates.keys().next().value);
    return true;
  };
  return Object.freeze({
    photoAliasIdentitySha256: photoStore.identitySha256,
    offerSourcePhotoCandidate: offer,
    offerExistingPhotoCandidate: offer,
    async assertPrivate() {
      retained = null;
      const [original, photos] = await Promise.all([archive.assertPrivate(), retention()]);
      return { ...original, photoRetention: photos, photoAliasIdentitySha256: photoStore.identitySha256 };
    },
    async readObject(key, options = {}) {
      check(keyPattern.test(key), 'Invalid Supabase archive object key');
      const maxBytes = options.maxBytes ?? maximumBytes;
      check(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= maximumBytes,
        'Supabase archive object exceeds its bound');
      options.signal?.throwIfAborted();
      const alias = key.endsWith('.gz') ? await readAlias(key) : null;
      check(!alias || alias.size <= maxBytes, 'Existing photo exceeds the caller read bound');
      if (alias) return [await readPhoto(alias, { ...options, maxBytes }, key)];
      return archive.readObject(key, { ...options, maxBytes });
    },
    async putVerifiedObject(key, bytes, options = {}) {
      check(keyPattern.test(key) && Buffer.isBuffer(bytes) && bytes.length > 0
        && bytes.length <= maximumBytes && hash(bytes) === key.slice(0, 64), 'Supabase archive upload binding differs');
      const body = Buffer.from(bytes);
      options.signal?.throwIfAborted();
      if (key.endsWith('.gz')) {
        let alias = await readAlias(key, body.length);
        if (!alias) {
          const candidate = candidates.get(key.slice(0, 64));
          if (candidate?.size === body.length) {
            await retention();
            let proposed;
            try {
              proposed = await photoStore.verifyExistingPhoto({ ...candidate, sha256: key.slice(0, 64) }, options);
            } catch (error) {
              options.signal?.throwIfAborted();
              // An upload changed before admission cannot represent historical
              // bytes. Preserve the caller's exact original in Supabase instead.
              if (!(error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey'
                || /integrity|reference/.test(error?.message || ''))) throw error;
              candidates.delete(key.slice(0, 64));
            }
            if (proposed) {
              const checked = reference({ reference: proposed }, key, body.length);
              alias = reference(await rpc('matter_hosted_app_photo_alias_register',
                { p_key: key, p_reference: checked }), key, body.length);
              check(alias, 'Supabase photo alias admission was not confirmed');
            }
          }
        }
        if (alias) {
          await readPhoto(alias, { ...options, maxBytes: body.length }, key);
          return { key, bytes: body.length, sha256: key.slice(0, 64), verified: true, reusedExistingPhoto: true };
        }
      }
      return archive.putVerifiedObject(key, body, options);
    },
  });
}
