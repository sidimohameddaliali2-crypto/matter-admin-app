import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createDriverAuditSpacesArchive } from './driverAuditSpacesArchive.js';

export const driverAuditPhotoCandidatesRoot = fileURLToPath(new URL('../.private/driver-audit-native-photo-candidates/', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const photoKey = value => typeof value === 'string' && /^photos\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
const check = (condition, message) => { if (!condition) throw Error(message); };
const shape = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
function destination(env) {
  const region = /^(?:https:\/\/)?([a-z][a-z0-9-]{1,19})\.digitaloceanspaces\.com\/?$/.exec(env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com')?.[1];
  check(region && (!env.SPACES_REGION || env.SPACES_REGION === region) && typeof env.SPACES_BUCKET === 'string',
    'Native photo destination configuration differs');
  return { endpoint: `https://${region}.digitaloceanspaces.com`, region, bucket: env.SPACES_BUCKET, keyPrefix: 'photos/' };
}
export async function readDriverAuditPhotoCandidates({ env = process.env, root = driverAuditPhotoCandidatesRoot } = {}) {
  const sha256 = env.DRIVER_AUDIT_NATIVE_PHOTO_CANDIDATES_SHA256;
  check(hex(sha256), 'A pinned native photo candidate lookup is required');
  check(path.isAbsolute(root) && await fs.realpath(root) === path.resolve(root), 'Native photo lookup directory differs');
  const directory = await fs.lstat(root);
  check(directory.isDirectory() && directory.uid === process.getuid() && !(directory.mode & 0o077),
    'Native photo lookup must be owner-private');
  const file = path.join(root, sha256 + '.json'), stat = await fs.lstat(file);
  check(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size > 0 && stat.size <= 2 * 1024 * 1024
    && await fs.realpath(file) === file, 'Native photo lookup must be a bounded owned private file');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = await handle.stat();
    check(opened.isFile() && opened.uid === process.getuid() && !(opened.mode & 0o077)
      && opened.ino === stat.ino && opened.dev === stat.dev && opened.size === stat.size, 'Native photo lookup changed or is not private');
    bytes = await handle.readFile();
    const final = await handle.stat();
    check(final.isFile() && final.uid === process.getuid() && !(final.mode & 0o077)
      && final.ino === opened.ino && final.dev === opened.dev && final.size === opened.size, 'Native photo lookup changed or is not private');
  } finally { await handle.close(); }
  check(bytes.length === stat.size && digest(bytes) === sha256, 'Native photo lookup integrity failure');
  const value = JSON.parse(bytes);
  check(shape(value, ['version', 'kind', 'sourceMappingSha256', 'candidateOnly', 'existingObjectBytesVerified', 'expectedStorage', 'entries'])
    && value.version === 1 && value.kind === 'existing-photo-alias-lookup-candidates-v1'
    && hex(value.sourceMappingSha256) && value.candidateOnly === true && value.existingObjectBytesVerified === false,
  'Native photo lookup provenance differs');
  const target = destination(env);
  check(shape(value.expectedStorage, ['endpoint', 'region', 'bucket', 'keyPrefix'])
    && Object.keys(target).every(key => value.expectedStorage[key] === target[key]), 'Native photo lookup destination differs');
  check(Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= 10000, 'Native photo lookup exceeds its bound');
  const index = new Map();
  for (const row of value.entries) {
    check(shape(row, ['sha256', 'size', 'keys']) && hex(row.sha256) && !index.has(row.sha256)
      && Number.isSafeInteger(row.size) && row.size > 0 && row.size <= 8 * 1024 * 1024
      && Array.isArray(row.keys) && row.keys.length > 0 && row.keys.length <= 16
      && row.keys.every(photoKey) && new Set(row.keys).size === row.keys.length, 'Native photo candidate metadata differs');
    index.set(row.sha256, Object.freeze({ size: row.size, keys: Object.freeze([...row.keys]) }));
  }
  return index;
}

// A hint never alters an existing upload. Unsupported URLs simply continue
// through the ordinary exact-byte private archive path.
export function driverAuditExistingPhotoKey(url, env = process.env) {
  if (typeof url !== 'string' || url.length > 2048 || /[%\\]/.test(url)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const target = destination(env);
  if (parsed.protocol !== 'https:' || parsed.hostname !== `${target.bucket}.${target.region}.cdn.digitaloceanspaces.com`
      || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash
      || !photoKey(parsed.pathname.slice(1)) || url !== 'https://' + parsed.hostname + parsed.pathname) return null;
  return parsed.pathname.slice(1);
}

export async function createDriverAuditNativeObjectStore({ env = process.env, photoCandidatesRoot = driverAuditPhotoCandidatesRoot,
  client, anonymousFetch } = {}) {
  const mode = env.DRIVER_AUDIT_NATIVE_OBJECT_STORE || 'mongo';
  if (mode === 'mongo') return undefined;
  check(mode === 'spaces', 'Unknown native archive object store');
  const candidates = await readDriverAuditPhotoCandidates({ env, root: photoCandidatesRoot });
  const store = createDriverAuditSpacesArchive({ env, client, anonymousFetch,
    lookupExistingPhoto({ sha256, size }) {
      const row = candidates.get(sha256);
      return row?.size === size ? { key: row.keys[0] } : null;
    } });
  return Object.freeze({ ...store,
    offerSourcePhotoCandidate({ sha256, size, url }) {
      const key = driverAuditExistingPhotoKey(url, env);
      return key === null ? false : store.addExistingPhotoCandidate({ sha256, size, key });
    },
  });
}
