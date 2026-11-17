import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const check = (value, message) => { if (!value) throw Error(message); };
const same = isDeepStrictEqual;
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const capacityBytes = 16 * 1024 ** 3;
const retainedPrefixes = ['driver-reports/archive/v1/', 'photos/'];
const keys = ['DRIVER_AUDIT_NATIVE_OBJECT_STORE', 'DRIVER_AUDIT_NATIVE_PHOTO_CANDIDATES_SHA256'];
const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true, wtimeoutMS: 10000 }, readPreference: 'primary' };
const metadataNames = new Set(['driverAuditNativeFiles', 'driverAuditNativeChunks', 'driverAuditNativeControl',
  'driverAuditNativeLeases', 'driverAuditNativeArchiveControl']);
const emptyNames = ['Documents', 'Receipts', 'Historical', 'ReviewContexts', 'ReviewFiles', 'TechnicalRecords',
  'TechnicalChunks', 'Reservations', 'Consumption', 'ArchiveLedger', 'RoadCache'].map(name => 'driverAuditNative' + name);
const order = rows => rows.sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0);

export async function readNativeObjectStorePrivateFile(file, maximum = 64 * 1024 ** 2) {
  const stat = await fs.lstat(file);
  const valid = info => info.isFile() && info.uid === process.getuid() && !(info.mode & 0o077) && info.size <= maximum;
  const identity = info => ({ ino: info.ino, dev: info.dev, uid: info.uid, mode: info.mode,
    size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
  check(path.isAbsolute(file) && await fs.realpath(file) === file && valid(stat), 'A bounded owner-private regular file is required');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    check(valid(opened) && same(identity(opened), identity(stat)), 'Private file changed during admission');
    const bytes = await handle.readFile(), after = await handle.stat(), pathAfter = await fs.lstat(file);
    check(valid(after) && valid(pathAfter) && same(identity(after), identity(opened)) && same(identity(pathAfter), identity(opened))
      && bytes.length === opened.size && await fs.realpath(file) === file, 'Private file changed during reading');
    return bytes;
  } finally { await handle.close(); }
}
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  check(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077)
    && await fs.realpath(directory) === directory, 'An owner-private directory is required');
}
async function syncDirectory(directory) { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function immutable(file, bytes) {
  try { check((await readNativeObjectStorePrivateFile(file)).equals(bytes), 'Immutable object-store evidence differs'); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.' + randomUUID() + '.tmp', handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await fs.link(temporary, file); } finally { await fs.unlink(temporary); }
  await syncDirectory(path.dirname(file));
}
export async function replaceNativeObjectStorePrivateFile(file, before, after, boundary = async () => {}) {
  check((await readNativeObjectStorePrivateFile(file)).equals(before), 'Private settings or journal changed before update');
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(after); await handle.sync(); } finally { await handle.close(); }
    await boundary();
    check((await readNativeObjectStorePrivateFile(file)).equals(before), 'Private settings or journal changed during update');
    await fs.rename(temporary, file); await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}

export function proposeNativeObjectStoreEnvironment({ base, before, lookupSha256, parse }) {
  check(Buffer.isBuffer(base) && Buffer.isBuffer(before) && hex(lookupSha256) && typeof parse === 'function', 'Pinned storage settings are required');
  const original = { ...parse(base), ...parse(before) };
  check((original.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase', 'Preingest must preserve the Supabase reporting backend');
  check(original[keys[0]] === undefined || ['mongo', 'spaces'].includes(original[keys[0]]), 'Unknown existing archive mode');
  const after = Buffer.concat([before, Buffer.from((before.length && !before.toString().endsWith('\n') ? '\n' : '')
    + keys[0] + '=spaces\n' + keys[1] + '=' + lookupSha256 + '\n')]);
  const values = { ...parse(base), ...parse(after) };
  check(values[keys[0]] === 'spaces' && values[keys[1]] === lookupSha256
    && Object.entries(original).every(([key, value]) => keys.includes(key) || values[key] === value)
    && Object.keys(values).every(key => keys.includes(key) || Object.hasOwn(original, key)), 'Storage preparation changed unrelated application settings');
  return { after, values };
}

// Lifecycle is an independently managed bucket setting. A successful object
// read cannot prove that an enabled expiry rule will retain that object.
export function validateNativeObjectStoreLifecycle(response, { identitySha256, noConfiguration = false,
  observedAt = new Date().toISOString() } = {}) {
  check(hex(identitySha256) && Number.isFinite(Date.parse(observedAt)) && response && typeof response === 'object'
    && !Array.isArray(response) && Object.keys(response).every(key => ['Rules', '$metadata', 'TransitionDefaultMinimumObjectSize'].includes(key)),
  'The existing bucket retention configuration is inconclusive');
  const rules = response.Rules ?? [];
  check((noConfiguration || Object.hasOwn(response, 'Rules')) && Array.isArray(rules) && rules.length <= 1000 && (!noConfiguration || rules.length === 0)
    && Buffer.byteLength(JSON.stringify(response)) <= 256 * 1024, 'The existing bucket retention configuration exceeds its bound');
  const prefix = value => { check(typeof value === 'string' && value.length <= 1024, 'The lifecycle prefix is inconclusive'); return value; };
  const shape = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key));
  const tag = value => shape(value, ['Key', 'Value']) && typeof value.Key === 'string' && typeof value.Value === 'string';
  const size = value => integer(value);
  function filterPrefix(filter) {
    check(shape(filter, ['Prefix', 'Tag', 'And', 'ObjectSizeGreaterThan', 'ObjectSizeLessThan']), 'The lifecycle filter is unsupported');
    if (Object.hasOwn(filter, 'And')) {
      check(Object.keys(filter).length === 1 && shape(filter.And, ['Prefix', 'Tags', 'ObjectSizeGreaterThan', 'ObjectSizeLessThan'])
        && (!Object.hasOwn(filter.And, 'Tags') || Array.isArray(filter.And.Tags) && filter.And.Tags.length <= 1000 && filter.And.Tags.every(tag))
        && ['ObjectSizeGreaterThan', 'ObjectSizeLessThan'].every(key => !Object.hasOwn(filter.And, key) || size(filter.And[key])),
      'The lifecycle conjunction is unsupported');
      return Object.hasOwn(filter.And, 'Prefix') ? prefix(filter.And.Prefix) : '';
    }
    check((!Object.hasOwn(filter, 'Tag') || tag(filter.Tag))
      && ['ObjectSizeGreaterThan', 'ObjectSizeLessThan'].every(key => !Object.hasOwn(filter, key) || size(filter[key])),
    'The lifecycle filter is inconclusive');
    return Object.hasOwn(filter, 'Prefix') ? prefix(filter.Prefix) : '';
  }
  let enabledRules = 0, disabledRules = 0, unrelatedExpirationRules = 0, ignoredMultipartAbortRules = 0;
  for (const rule of rules) {
    check(shape(rule, ['ID', 'Status', 'Prefix', 'Filter', 'Expiration', 'NoncurrentVersionExpiration', 'AbortIncompleteMultipartUpload',
      'Transitions', 'NoncurrentVersionTransitions']) && ['Enabled', 'Disabled'].includes(rule.Status), 'The lifecycle rule is unsupported');
    if (rule.Status === 'Disabled') { disabledRules++; continue; }
    enabledRules++;
    check(!(Object.hasOwn(rule, 'Prefix') && Object.hasOwn(rule, 'Filter')), 'The lifecycle scope is ambiguous');
    const scope = Object.hasOwn(rule, 'Prefix') ? prefix(rule.Prefix) : Object.hasOwn(rule, 'Filter') ? filterPrefix(rule.Filter) : '';
    const expires = Object.hasOwn(rule, 'Expiration') || Object.hasOwn(rule, 'NoncurrentVersionExpiration');
    if (expires) {
      // Tags and size predicates cannot establish retention for every existing
      // or future referenced object. Prefix overlap is therefore conservative.
      check(!retainedPrefixes.some(target => target.startsWith(scope) || scope.startsWith(target)),
        'An enabled bucket expiration may remove retained archive or photo objects');
      unrelatedExpirationRules++;
    }
    if (Object.hasOwn(rule, 'AbortIncompleteMultipartUpload')) ignoredMultipartAbortRules++;
  }
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().filter(key => key !== '$metadata').map(key => [key, canonical(value[key])])) : value;
  return { version: 1, verified: true, kind: 'existing-bucket-retention-observation-v1', identitySha256, observedAt,
    configured: !noConfiguration, policySha256: hash(JSON.stringify(canonical({ configured: !noConfiguration, rules,
      transitionDefaultMinimumObjectSize: response.TransitionDefaultMinimumObjectSize ?? null }))),
    retainedPrefixes, enabledRules, disabledRules, relevantExpirationRules: 0, unrelatedExpirationRules, ignoredMultipartAbortRules,
    bucketConfigurationChanged: false, ownerDeletionOutsideApplicationNotPrevented: true };
}

export async function readNativeObjectStoreRetention({ env, identitySha256, S3Client, GetBucketLifecycleConfigurationCommand }) {
  const match = /^(?:https:\/\/)?([a-z][a-z0-9-]{1,19})\.digitaloceanspaces\.com\/?$/.exec(env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com');
  check(match && (!env.SPACES_REGION || env.SPACES_REGION === match[1]) && typeof env.SPACES_BUCKET === 'string'
    && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.SPACES_BUCKET) && typeof env.SPACES_KEY === 'string' && env.SPACES_KEY.trim()
    && typeof env.SPACES_SECRET === 'string' && env.SPACES_SECRET.trim() && typeof S3Client === 'function'
    && typeof GetBucketLifecycleConfigurationCommand === 'function', 'The existing bucket retention reader is unavailable');
  const endpoint = `https://${match[1]}.digitaloceanspaces.com`;
  check(hash(JSON.stringify({ version: 1, provider: 'spaces', endpoint, bucket: env.SPACES_BUCKET, prefix: retainedPrefixes[0] })) === identitySha256,
    'The retention reader destination identity differs');
  const client = new S3Client({ endpoint, region: match[1], forcePathStyle: false, maxAttempts: 2,
    credentials: { accessKeyId: env.SPACES_KEY, secretAccessKey: env.SPACES_SECRET } });
  try {
    let response, noConfiguration = false;
    try { response = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: env.SPACES_BUCKET }), { abortSignal: AbortSignal.timeout(15000) }); }
    catch (error) {
      if ([error?.name, error?.Code, error?.code].includes('NoSuchLifecycleConfiguration')) { response = {}; noConfiguration = true; }
      else throw Error('The existing bucket retention configuration is unavailable or unsupported');
    }
    return validateNativeObjectStoreLifecycle(response, { identitySha256, noConfiguration });
  } finally { client.destroy?.(); }
}

async function collectionNames(db) {
  const rows = await db.listCollections({}, { nameOnly: true }).toArray(); check(rows.length <= 1000, 'Native reference census exceeds its bound');
  return [...new Set([...emptyNames, ...rows.map(row => row.name).filter(name => name.startsWith('driverAuditNative') && !metadataNames.has(name))])];
}
async function emptyGuard(db, names, identitySha256, session) {
  const options = { session };
  for (const name of names) check(await db.collection(name).countDocuments({}, options) === 0, 'A genuine or unknown native reference blocks preingest');
  const controls = await db.collection('driverAuditNativeControl').find({}, options).toArray();
  for (const row of controls) {
    if (row._id === 'capacity') {
      check(Object.keys(row).every(key => ['_id', 'limitBytes', 'usedBytes', 'technicalBytes'].includes(key))
        && row.limitBytes === capacityBytes && integer(row.usedBytes) && row.usedBytes <= capacityBytes
        && (row.technicalBytes === undefined || row.technicalBytes === 0), 'Unknown or active native allocation blocks preingest');
      continue;
    }
    check(row._id === 'archive-object-store' && Object.keys(row).sort().join(',') === '_id,identitySha256,provider,version'
      && row.version === 1 && row.provider === 'spaces' && row.identitySha256 === identitySha256,
    'Native authority, another storage identity or unknown controls block preingest');
  }
  check(!await db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }, options), 'A direct publication blocks preingest');
  for (const row of await db.collection('driverAuditNativeLeases').find({}, options).toArray()) {
    check(['collector', 'qualification'].includes(row._id) && row.expires_at instanceof Date && row.expires_at <= new Date(), 'A native writer lease is active');
  }
  for (const row of await db.collection('driverAuditNativeArchiveControl').find({}, options).toArray()) {
    check(row._id === 'total' && row.used_bytes === 0 && row.reserved_bytes === 0, 'A native reservation or ledger is in use');
  }
}
function file(row, identitySha256, validateExternalReference) {
  check(row && /^[a-f0-9]{64}\.(?:gz|json)$/.test(row._id || ''), 'Unknown native object key');
  if (Object.hasOwn(row, 'externalReference')) {
    check(Object.keys(row).sort().join(',') === '_id,externalReference', 'Mixed or unknown native file metadata');
    return { _id: row._id, externalReference: validateExternalReference(row.externalReference, { identitySha256, key: row._id }) };
  }
  const ref = row.reference;
  check(Object.keys(row).sort().join(',') === '_id,reference' && ref
    && Object.keys(ref).sort().join(',') === 'chunks,sha256,size,version' && ref.version === 1 && ref.sha256 === row._id.slice(0, 64)
    && integer(ref.size) && ref.size > 0 && ref.size <= 16 * 1024 ** 2 && Array.isArray(ref.chunks) && ref.chunks.length > 0 && ref.chunks.length <= 16
    && ref.chunks.every(part => part && Object.keys(part).sort().join(',') === 'sha256,size' && hex(part.sha256)
      && integer(part.size) && part.size > 0 && part.size <= 4 * 1024 ** 2)
    && ref.chunks.reduce((sum, part) => sum + part.size, 0) === ref.size, 'Invalid legacy native reference');
  return { _id: row._id, reference: ref };
}
export async function captureNativeObjectStorePreingest({ db, identitySha256, validateExternalReference }) {
  check(hex(identitySha256) && typeof validateExternalReference === 'function', 'The exact destination reference validator is required');
  const names = await collectionNames(db); await emptyGuard(db, names, identitySha256);
  const files = order((await db.collection('driverAuditNativeFiles').find({}).toArray()).map(row => file(row, identitySha256, validateExternalReference)));
  const chunks = order(await db.collection('driverAuditNativeChunks').find({}, { projection: { bytes: 0 } }).toArray());
  check(files.length <= 100000 && chunks.length <= 200000 && chunks.every(row => Object.keys(row).sort().join(',') === '_id,size'
    && hex(row._id) && integer(row.size) && row.size > 0 && row.size <= 4 * 1024 ** 2), 'Invalid native chunk metadata');
  const sizes = new Map(chunks.map(row => [row._id, row.size]));
  check(files.every(row => !row.reference || row.reference.chunks.every(part => sizes.get(part.sha256) === part.size)), 'Native reference metadata is incomplete');
  const capacity = await db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' });
  const usedBytes = chunks.reduce((sum, row) => sum + row.size + 1024, 0)
    + files.filter(row => row.externalReference).reduce((sum, row) => sum + row.externalReference.size + 1024, 0);
  check(capacity?.limitBytes === capacityBytes && capacity.usedBytes === usedBytes && usedBytes <= capacityBytes
    && (capacity.technicalBytes === undefined || capacity.technicalBytes === 0), 'Native logical allocation differs from exact unused metadata');
  const binding = await db.collection('driverAuditNativeControl').findOne({ _id: 'archive-object-store' });
  check(binding || !files.some(row => row.externalReference), 'External native files have no destination binding');
  return { files, chunks, capacity, servingHeadSha256: hash(JSON.stringify(await db.collection('driverAuditControl').findOne({ _id: 'head' }))) };
}

const chain = (previous, row) => hash(previous + '\n' + JSON.stringify(row));
export function initialNativeExternalizationJournal(planSha256) {
  return { version: 1, planSha256, cursor: 0, referencesSha256: hash(''), objects: 0, bytes: 0 };
}

export async function externalizeNativeArchive({ db, client, archive, objectStore, validateExternalReference,
  plan, journal, saveJournal, safety = async () => {}, limits = {}, now = Date.now }) {
  check(plan?.version === 1 && plan.kind === 'unused-native-archive-externalization-v1' && plan.targetDatabase === db.databaseName
    && plan.identitySha256 === objectStore?.identitySha256 && hex(plan.implementationSha256) && typeof saveJournal === 'function', 'An exact externalization plan is required');
  const planSha256 = hash(json(plan));
  check(journal?.version === 1 && journal.planSha256 === planSha256 && integer(journal.cursor), 'The bounded current externalization journal differs');
  await safety();
  const current = await captureNativeObjectStorePreingest({ db, identitySha256: plan.identitySha256, validateExternalReference });
  check(current.servingHeadSha256 === plan.before.servingHeadSha256, 'The serving report pointer changed');
  const original = new Map(plan.before.files.map(row => [row._id, row])), currentFiles = new Map(current.files.map(row => [row._id, row]));
  const legacy = plan.before.files.filter(row => row.reference);
  check(journal.cursor <= legacy.length && currentFiles.size === original.size, 'The externalization file census changed');
  const positions = new Map(legacy.map((row, index) => [row._id, index]));
  let recoveredPrefix = 0;
  while (journal.cursor + recoveredPrefix < legacy.length
    && currentFiles.get(legacy[journal.cursor + recoveredPrefix]._id)?.externalReference) recoveredPrefix++;
  check(recoveredPrefix <= 32, 'More than one uncheckpointed conversion batch exists');
  let rolling = hash(''), completedBytes = 0;
  for (const row of current.files) {
    const old = original.get(row._id), position = positions.get(row._id);
    check(old && (position === undefined ? same(old, row) : position < journal.cursor + recoveredPrefix
      ? !!row.externalReference : same(old, row)),
      'Unexpected native file changes block externalization');
  }
  for (let index = 0; index < journal.cursor; index++) {
    const row = currentFiles.get(legacy[index]._id);
    rolling = chain(rolling, row); completedBytes += row.externalReference.size;
  }
  check(rolling === journal.referencesSha256 && journal.objects === journal.cursor && journal.bytes === completedBytes, 'Previously verified external references changed');
  const oldChunks = new Map(plan.before.chunks.map(row => [row._id, row.size]));
  check(current.chunks.every(row => oldChunks.get(row._id) === row.size), 'Native chunks were added or changed during externalization');
  const possibleRemoval = new Set(legacy.flatMap(row => row.reference.chunks.map(part => part.sha256)));
  const presentChunks = new Set(current.chunks.map(row => row._id));
  check(plan.before.chunks.every(row => presentChunks.has(row._id) || possibleRemoval.has(row._id)), 'A protected standalone native chunk disappeared');
  const maxObjects = limits.objects ?? 10000, maxBytes = limits.bytes ?? 1024 ** 3, maxMs = limits.milliseconds ?? 20 * 60_000;
  check(integer(maxObjects) && maxObjects > 0 && maxObjects <= 10000 && integer(maxBytes) && maxBytes > 0 && maxBytes <= 1024 ** 3
    && integer(maxMs) && maxMs > 0 && maxMs <= 20 * 60_000, 'Externalization limits differ');
  const start = now(); let done = 0, movedBytes = 0, expectedUsedBytes = current.capacity.usedBytes;
  while (journal.cursor < legacy.length && done < maxObjects && now() - start < maxMs) {
    const batch = []; let size = 0;
    while (journal.cursor + batch.length < legacy.length && batch.length < 32 && done + batch.length < maxObjects) {
      const row = legacy[journal.cursor + batch.length];
      if (size + row.reference.size > 16 * 1024 ** 2 || movedBytes + size + row.reference.size > maxBytes) break;
      batch.push(row); size += row.reference.size;
    }
    if (!batch.length || movedBytes >= maxBytes) break;
    await safety(); const names = await collectionNames(db); await emptyGuard(db, names, plan.identitySha256);
    const converted = Array.from({ length: batch.length }), stop = new AbortController(); let cursor = 0;
    const attempts = await Promise.allSettled(Array.from({ length: Math.min(4, batch.length) }, async () => {
      try {
      for (;;) {
        stop.signal.throwIfAborted();
        const index = cursor++; if (index >= batch.length) return;
        const old = batch[index], saved = await db.collection('driverAuditNativeFiles').findOne({ _id: old._id });
        const checked = file(saved, plan.identitySha256, validateExternalReference);
        if (checked.externalReference) {
          const bytes = await objectStore.readBytes(checked.externalReference, { maxBytes: old.reference.size, signal: stop.signal });
          check(Buffer.isBuffer(bytes) && bytes.length === old.reference.size && hash(bytes) === old._id.slice(0, 64), 'Interrupted externalization readback differs');
          converted[index] = checked; continue;
        }
        check(same(checked, old), 'A legacy original changed before externalization');
        const bytes = Buffer.concat(await archive.readObject(old._id, { maxBytes: old.reference.size, signal: stop.signal }));
        check(bytes.length === old.reference.size && hash(bytes) === old._id.slice(0, 64), 'Legacy original bytes differ');
        // The pinned official provider performs the full GET/SHA readback before
        // returning its frozen reference. Do not repeat that entire read here.
        const reference = await objectStore.putVerifiedObject(old._id, bytes, { signal: stop.signal });
        check(Object.isFrozen(reference), 'External verified reference must be frozen');
        converted[index] = { _id: old._id, externalReference: validateExternalReference(reference,
          { identitySha256: plan.identitySha256, key: old._id, bytes: old.reference.size }) };
      }
      } catch (error) { stop.abort(error); throw error; }
    }));
    const failed = attempts.find(row => row.status === 'rejected'); if (failed) throw failed.reason;
    check(converted.every(Boolean), 'The external readback batch is incomplete');
    const session = client.startSession(); let committedUsedBytes;
    try { await session.withTransaction(async () => {
      await emptyGuard(db, names, plan.identitySha256, session);
      check(hash(JSON.stringify(await db.collection('driverAuditControl').findOne({ _id: 'head' }, { session }))) === plan.before.servingHeadSha256,
        'Serving report pointer changed before externalization commit');
      const control = db.collection('driverAuditNativeControl'), capacity = await control.findOne({ _id: 'capacity' }, { session });
      check(capacity?.limitBytes === capacityBytes, 'Native capacity changed before externalization');
      if (capacity.usedBytes !== expectedUsedBytes) {
        check(integer(committedUsedBytes) && capacity.usedBytes === committedUsedBytes, 'Native capacity changed before externalization');
        for (const next of converted) check(same(file(await db.collection('driverAuditNativeFiles').findOne({ _id: next._id }, { session }),
          plan.identitySha256, validateExternalReference), next), 'An acknowledged conversion batch changed');
        return;
      }
      const binding = await control.findOne({ _id: 'archive-object-store' }, { session });
      if (!binding) await control.insertOne({ _id: 'archive-object-store', version: 1, provider: 'spaces', identitySha256: plan.identitySha256 }, { session });
      let charge = 0; const chunkIds = new Set();
      for (let index = 0; index < batch.length; index++) {
        const old = batch[index], next = converted[index], prior = await db.collection('driverAuditNativeFiles').findOne({ _id: old._id }, { session });
        const checked = file(prior, plan.identitySha256, validateExternalReference);
        if (checked.externalReference) { check(same(checked, next), 'A committed external reference changed'); continue; }
        check(same(checked, old), 'Legacy reference changed at externalization commit');
        const result = await db.collection('driverAuditNativeFiles').updateOne({ _id: old._id, reference: prior.reference,
          externalReference: { $exists: false } }, { $set: { externalReference: next.externalReference }, $unset: { reference: '' } }, { session });
        check(result.matchedCount === 1, 'Externalization reference CAS failed');
        charge += old.reference.size + 1024;
        old.reference.chunks.forEach(part => chunkIds.add(part.sha256));
      }
      const stillUsed = await db.collection('driverAuditNativeFiles').find({ 'reference.chunks.sha256': { $in: [...chunkIds] } },
        { session, projection: { reference: 1 } }).toArray();
      const usedIds = new Set(stillUsed.flatMap(row => row.reference.chunks.map(part => part.sha256)));
      const remove = [...chunkIds].filter(id => !usedIds.has(id));
      const chunks = await db.collection('driverAuditNativeChunks').find({ _id: { $in: remove } }, { session, projection: { bytes: 0 } }).toArray();
      check(chunks.length === remove.length && chunks.every(row => oldChunks.get(row._id) === row.size), 'Old native chunk allocation differs');
      const refund = chunks.reduce((sum, row) => sum + row.size + 1024, 0), nextUsed = expectedUsedBytes + charge - refund;
      check(integer(nextUsed) && nextUsed <= capacityBytes, 'External logical capacity exceeds its allowance');
      if (chunks.length) await db.collection('driverAuditNativeChunks').deleteMany({ _id: { $in: chunks.map(row => row._id) } }, { session });
      if (charge || refund) {
        const changed = await control.updateOne({ _id: 'capacity', limitBytes: capacityBytes, usedBytes: expectedUsedBytes },
          { $set: { usedBytes: nextUsed } }, { session }); check(changed.matchedCount === 1, 'Externalization capacity CAS failed');
      }
      committedUsedBytes = nextUsed;
    }, transactionOptions); } finally { await session.endSession(); }
    expectedUsedBytes = committedUsedBytes;
    const next = { ...journal };
    for (const row of converted) { next.cursor++; next.objects++; next.bytes += row.externalReference.size; next.referencesSha256 = chain(next.referencesSha256, row); }
    await saveJournal(next, journal); journal = next; done += batch.length; movedBytes += size;
  }
  await safety(); const after = await captureNativeObjectStorePreingest({ db, identitySha256: plan.identitySha256, validateExternalReference });
  check(after.servingHeadSha256 === plan.before.servingHeadSha256 && after.capacity.usedBytes === expectedUsedBytes, 'Externalization final allocation or serving pointer differs');
  check(after.files.length === original.size && after.files.every(row => {
    const position = positions.get(row._id), old = original.get(row._id);
    return old && (position === undefined || position >= journal.cursor ? same(old, row) : !!row.externalReference);
  }), 'Externalization final file census changed');
  const afterFiles = new Map(after.files.map(row => [row._id, row])); let finalRolling = hash('');
  for (let index = 0; index < journal.cursor; index++) finalRolling = chain(finalRolling, afterFiles.get(legacy[index]._id));
  check(finalRolling === journal.referencesSha256 && after.chunks.every(row => oldChunks.get(row._id) === row.size),
    'Externalization final references or chunks changed');
  const complete = journal.cursor === legacy.length;
  return { version: 1, status: complete ? 'unused-native-archive-externalized' : 'unused-native-archive-externalization-partial',
    verified: complete, completedPrefixVerified: true, complete, planSha256, objectsCompleted: journal.cursor, objectsTotal: legacy.length, bytesCompleted: journal.bytes,
    currentJournal: journal, nativeLogicalUsedBytes: after.capacity.usedBytes, remainingMongoObjects: after.files.filter(row => row.reference).length,
    fullGetVerification: 'pinned-provider-putVerifiedObject-full-GET-readback; recovered-commit-full-GET',
    sourceDataChanged: false, servingDataChanged: false, authorityChanged: false, activationPending: true };
}

async function systemFileIdentity(file) {
  const realpath = await fs.realpath(file), before = await fs.lstat(realpath);
  check(before.isFile() && before.size > 0 && before.size <= 64 * 1024, 'The managed API executable differs');
  const handle = await fs.open(realpath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    check(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size
      && opened.uid === before.uid && opened.mode === before.mode, 'The managed API executable changed');
    const bytes = await handle.readFile(), after = await handle.stat();
    check(bytes.length === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs
      && await fs.realpath(file) === realpath, 'The managed API executable changed during reading');
    return { realpath, isFile: true, uid: opened.uid, mode: opened.mode, bytes: opened.size, sha256: hash(bytes) };
  } finally { await handle.close(); }
}
async function apiSnapshot(entries, appRoot, server, systemFile) {
  check(Array.isArray(entries), 'The exact managed process inventory is required');
  const api = entries.filter(row => row.name === 'matter-delivery-api'), sync = entries.filter(row => row.name === 'matter-driver-audit-sync');
  check(api.length === 1 && sync.length === 1 && !entries.some(row => row.name === 'matter-driver-audit-source')
    && api[0].pid > 0 && api[0].pm2_env?.status === 'online' && api[0].pm2_env.pm_cwd === appRoot
    && same(api[0].pm2_env.args, ['start', '--prefix', 'server']) && integer(api[0].pm2_env.pm_uptime)
    && sync[0].pm2_env?.status === 'stopped' && sync[0].pm2_env.pm_cwd === server
    && sync[0].pm2_env.pm_exec_path === path.join(server, 'scripts/driverAuditSync.js'), 'Source must be absent, sync stopped and the exact API online');
  const args = sync[0].pm2_env.args, root = typeof args?.[1] === 'string' ? path.dirname(args[1]) : '';
  check(args?.length === 2 && args[0] === '--config' && args[1] === path.join(root, 'sync.json')
    && path.dirname(root) === path.join(server, '.private/driver-audits') && hex(path.basename(root)), 'The managed sync configuration differs');
  const launch = [api[0].pm2_env.DRIVER_AUDIT_DATA_STORE, api[0].pm2_env.env?.DRIVER_AUDIT_DATA_STORE];
  check(launch.every(value => value === undefined || value === 'supabase'), 'The API launch backend must remain Supabase');
  const npm = await systemFile('/usr/bin/npm');
  check(npm?.isFile === true && npm.uid === 0 && !(npm.mode & 0o022) && integer(npm.bytes) && npm.bytes > 0 && npm.bytes <= 64 * 1024
    && hex(npm.sha256) && /^\/usr\/(?:share\/nodejs|(?:local\/)?lib\/node_modules)\/npm\/bin\/npm-cli\.js$/.test(npm.realpath || '')
    && ['/usr/bin/npm', npm.realpath].includes(api[0].pm2_env.pm_exec_path), 'The actual managed npm API invocation differs');
  return { apiId: api[0].pm_id, apiPid: api[0].pid, apiStartedAtMs: api[0].pm2_env.pm_uptime,
    apiInvocation: { launchContract: 'npm-start-prefix-server', executableIdentitySha256: hash(JSON.stringify([npm.realpath, npm.sha256])),
      executablePathSha256: hash(api[0].pm2_env.pm_exec_path) },
    apiLaunchBackends: launch.map(value => value ?? null), syncRoot: root, syncId: sync[0].pm_id,
    syncInvocation: { cwd: sync[0].pm2_env.pm_cwd, executable: sync[0].pm2_env.pm_exec_path, args } };
}
async function readBase(file) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return { bytes: Buffer.alloc(0), mtimeMs: 0 }; throw error; }
  check(stat.isFile() && stat.uid === process.getuid() && stat.size <= 1024 ** 2 && await fs.realpath(file) === file, 'Application base settings must be an owned regular file');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const opened = await handle.stat(); check(opened.ino === stat.ino && opened.dev === stat.dev, 'Application base settings changed');
    return { bytes: await handle.readFile(), mtimeMs: stat.mtimeMs }; } finally { await handle.close(); }
}
export function validateNativeObjectStoreStartupBaseline({ snapshot, baseMtimeMs, localMtimeMs, values, env }) {
  check(snapshot.apiStartedAtMs > 0 && snapshot.apiStartedAtMs <= Date.now()
    && baseMtimeMs <= snapshot.apiStartedAtMs && localMtimeMs <= snapshot.apiStartedAtMs,
  'The current settings must be from before the actual API startup');
  check((values.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase'
    && (env.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase', 'The live startup and durable report backend must remain Supabase');
  return { kind: 'same-api-startup-supabase-settings', api: snapshot, baseMtimeMs, localMtimeMs,
    liveDriverConnectionProven: false, liveReportBackendBasis: 'clean startup loader; settings older than unchanged API PID/start; unambiguous Supabase launch selection' };
}
// Match the read-only diagnostic's credential-free location identity. URI
// credentials and options never become part of this public control identity.
export function nativeObjectStoreMongoLocationSha256(uri) {
  check(typeof uri === 'string' && uri.length > 0 && uri.length <= 8192 && !/[\x00-\x20\x7f#]/.test(uri), 'The quota datasource is invalid');
  const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?[^#]*)?$/.exec(uri);
  check(match, 'The quota datasource is invalid');
  const authority = match[2].slice(match[2].lastIndexOf('@') + 1), hosts = [];
  for (const item of authority.split(',')) {
    const parsed = /^(\[[a-fA-F0-9:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::([0-9]{1,5}))?$/.exec(item);
    check(parsed && !parsed[1].includes('..') && (!parsed[2] || Number(parsed[2]) >= 1 && Number(parsed[2]) <= 65535)
      && (match[1] !== 'mongodb+srv' || !parsed[2] && !authority.includes(',') && !parsed[1].startsWith('[')), 'The quota datasource is invalid');
    hosts.push({ hostname: parsed[1].toLowerCase(), port: match[1] === 'mongodb+srv' ? null : Number(parsed[2] || 27017) });
  }
  let database; try { database = decodeURIComponent(match[3] || 'test'); } catch { throw Error('The quota datasource is invalid'); }
  check(hosts.length > 0 && hosts.length <= 16 && database === 'test', 'The quota datasource target differs');
  hosts.sort((a, b) => a.hostname.localeCompare(b.hostname) || (a.port || 0) - (b.port || 0));
  return hash(JSON.stringify({ version: 1, scheme: match[1], hosts, database }));
}

export async function measureNativeObjectStoreClusterHeadroom({ client, targetDatabase, quota, locationSha256, now = Date.now }) {
  check(client?.db && targetDatabase === 'test' && quota?.limitBytes === 5 * 1024 ** 3
    && quota.basis === 'actual-provider-limit-error-5120-mib' && hex(quota.evidenceSha256)
    && hex(quota.locationSha256) && quota.locationSha256 === locationSha256, 'The actual cluster quota and datasource must be explicitly pinned');
  const started = now(), admin = client.db('admin'); let stopped = false;
  const fresh = () => check(!stopped && now() >= started && now() - started <= 20000, 'Cluster quota sampling is incomplete or stale');
  const command = async (db, value) => { fresh(); const result = await db.command({ ...value, maxTimeMS: 5000 }); fresh();
    check(result?.ok === 1, 'Complete cluster quota metadata is unavailable'); return result; };
  const datasource = value => {
    check(value.msg === 'isdbgrid' || typeof value.setName === 'string' && value.setName.length > 0 && value.setName.length <= 200,
      'The quota sampling datasource is inconclusive');
    check(value.hosts === undefined || Array.isArray(value.hosts) && value.hosts.length <= 64
      && value.hosts.every(host => typeof host === 'string' && host.length <= 512), 'The quota sampling datasource is inconclusive');
    return hash(JSON.stringify({ setName: value.setName ?? null, hosts: [...(value.hosts || [])].sort(), msg: value.msg ?? null }));
  };
  const enumerate = async () => {
    // false requires cluster-wide enumeration privilege; true or omitted can
    // silently return only the databases visible to a restricted account.
    const result = await command(admin, { listDatabases: 1, nameOnly: true, authorizedDatabases: false });
    check(Array.isArray(result.databases) && result.databases.length > 0 && result.databases.length <= 64
      && !result.partialResultsReturned && !result.cursor, 'The complete cluster database census is unavailable');
    const names = result.databases.map(row => row?.name);
    check(names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 100 && !/[\x00/\\]/.test(name))
      && new Set(names).size === names.length && names.includes(targetDatabase), 'The complete cluster database census is invalid');
    return names.sort();
  };
  try {
    const beforeSource = datasource(await command(admin, { hello: 1 })), names = await enumerate();
    const rows = Array(names.length); let next = 0;
    const attempts = await Promise.allSettled(Array.from({ length: Math.min(4, names.length) }, async () => {
      try {
        for (;;) {
          fresh(); const index = next++; if (index >= names.length) return;
          const name = names[index], db = client.db(name); check(db.databaseName === name, 'The quota database selection differs');
          const value = await command(db, { dbStats: 1, scale: 1 });
          check(value.db === name && integer(value.dataSize) && integer(value.indexSize), 'A complete logical database size is unavailable');
          rows[index] = { databaseSha256: hash(name), dataSize: value.dataSize, indexSize: value.indexSize };
        }
      } catch (error) { stopped = true; throw error; }
    }));
    const failure = attempts.find(row => row.status === 'rejected'); if (failure) throw failure.reason;
    check(rows.every(Boolean) && same(await enumerate(), names) && datasource(await command(admin, { hello: 1 })) === beforeSource,
      'The cluster quota census or datasource changed during sampling');
    const completed = now(), usedBytes = rows.reduce((sum, row) => sum + row.dataSize + row.indexSize, 0);
    check(integer(usedBytes), 'The cluster quota total is invalid');
    const clusterHeadroomBytes = quota.limitBytes - usedBytes;
    check(clusterHeadroomBytes >= 512 * 1024 ** 2, 'The entire cluster needs at least 512 MiB of logical quota headroom');
    return { version: 1, verified: true, basis: 'all-databases-uncompressed-BSON-dataSize-plus-indexSize',
      allDatabasesEnumerated: true, authorizedDatabases: false, databaseCount: rows.length, internalDatabasesIncludedWhenListed: true,
      quota, locationSha256, datasourceSha256: beforeSource, startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(),
      samplingMilliseconds: completed - started, maximumAcceptedObservationMilliseconds: 20000, hardOperationDeadline: false,
      databaseCensusSha256: hash(JSON.stringify(names)), measurementsSha256: hash(JSON.stringify(rows)),
      clusterUsedBytes: usedBytes, clusterHeadroomBytes, minimumHeadroomBytes: 512 * 1024 ** 2, target: rows[names.indexOf(targetDatabase)], measurements: rows,
      evidenceIsCurrentObservation: true, futureBusinessGrowthNotReserved: true, actualAtlasUIConfirmationPending: true };
  } catch {
    throw Error('Complete fresh cluster-wide quota proof unavailable; verify all-database permissions, pinned limit and 512 MiB headroom');
  }
}

function publicHeadroom(value) {
  return Object.fromEntries(['verified', 'basis', 'allDatabasesEnumerated', 'databaseCount', 'startedAt', 'completedAt',
    'samplingMilliseconds', 'maximumAcceptedObservationMilliseconds', 'hardOperationDeadline', 'measurementsSha256', 'clusterUsedBytes',
    'clusterHeadroomBytes', 'minimumHeadroomBytes', 'actualAtlasUIConfirmationPending'].map(key => [key, value[key]]));
}

export async function runDriverAuditNativeObjectStore({ operation, sessionId, templateSha256, profileSha256, expectedSha, appRoot }, adapters = {}) {
  let connection; const locks = [], execute = adapters.exec || exec, env = adapters.env || process.env;
  try {
    check(['prepare-object-store', 'externalize-native-archive'].includes(operation) && uuid(sessionId) && hex(templateSha256)
      && (profileSha256 === undefined || hex(profileSha256)), 'Exact object-store operation and public identities required');
    check(path.isAbsolute(appRoot || '') && await fs.realpath(appRoot) === appRoot && /^[a-f0-9]{40}$/.test(expectedSha || ''), 'Exact application root and commit required');
    const checkout = async () => {
      check((adapters.platform || process.platform) === 'linux'
        && (await execute('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 })).stdout.trim() === expectedSha,
      'The exact deployed Linux application is required');
      await execute('git', ['diff', '--quiet', 'HEAD', '--', 'server'], { cwd: appRoot, timeout: 5000, maxBuffer: 4096 });
      check(!(await execute('git', ['ls-files', '--others', '--exclude-standard', '--', 'server'],
        { cwd: appRoot, timeout: 5000, maxBuffer: 65536 })).stdout.trim(), 'Unknown server code blocks object-store preparation');
    };
    await checkout(); const server = path.join(appRoot, 'server');
    const load = adapters.load || (name => import(pathToFileURL(path.join(server, name)).href)); await load('loadEnv.js');
    const { default: dotenv } = await load('node_modules/dotenv/lib/main.js');
    const { acquireWorkerLock } = await load('vendor/driver-audits/integration/hosted/worker-lock.mjs');
    const transferRoot = path.join(server, '.private/driver-audit-native-transfer'), folder = path.join(transferRoot, sessionId);
    await privateDirectory(transferRoot); await privateDirectory(folder); locks.push(await acquireWorkerLock(path.join(transferRoot, 'operator.lock')));
    const pinned = new Map();
    const readPinned = async (file, maximum = 1024 ** 2) => { const bytes = await readNativeObjectStorePrivateFile(file, maximum); pinned.set(file, hash(bytes)); return bytes; };
    const state = JSON.parse(await readPinned(path.join(folder, 'session.private.json'))), received = JSON.parse(await readPinned(path.join(folder, 'received.private.json')));
    const templateBytes = await readPinned(path.join(folder, 'object-store-template.private.json'));
    check(hash(templateBytes) === templateSha256, 'Object-store template differs'); const template = JSON.parse(templateBytes);
    check(state.version === 1 && state.sessionId === sessionId && state.targetDatabase === 'test' && state.capacityBytes === capacityBytes
      && state.plan?.inventorySha256 === state.inventorySha256 && state.plan.objectCount === 2 && integer(state.createdAt) && state.createdAt <= Date.now()
      && received.version === 1 && received.status === 'transfer-received' && received.verified === true && received.authorityChanged === false
      && received.sessionId === sessionId && received.targetDatabase === state.targetDatabase && received.inventorySha256 === state.inventorySha256
      && received.objects === 2 && received.bytes === state.plan.objectBytes && received.inputFiles?.length === 2
      && Number.isFinite(Date.parse(received.completedAt)) && Date.parse(received.completedAt) >= state.createdAt
      && Date.parse(received.completedAt) <= Date.now(),
    'The complete received object-store control session is required');
    check(template.version === 1 && template.kind === 'native-preingest-object-store-v1' && template.targetDatabase === state.targetDatabase
      && template.capacityBytes === capacityBytes && hex(template.lookupSha256) && hex(template.destinationIdentitySha256)
      && template.quota?.limitBytes === 5 * 1024 ** 3 && template.quota.basis === 'actual-provider-limit-error-5120-mib'
      && hex(template.quota.evidenceSha256) && hex(template.quota.locationSha256), 'Exact destination, lookup and provider quota pins required');
    const lookupBytes = await readPinned(path.join(folder, 'lookup.private.json'), 2 * 1024 ** 2);
    check(hash(lookupBytes) === template.lookupSha256, 'Original photo lookup integrity differs');
    const inputs = new Map(received.inputFiles.map(row => [row.name, row]));
    for (const [name, bytes] of [['object-store-template.private.json', templateBytes], ['lookup.private.json', lookupBytes]]) {
      check(inputs.size === 2 && inputs.get(name)?.sha256 === hash(bytes) && inputs.get(name)?.bytes === bytes.length, 'Received object-store input binding differs');
    }
    const processes = async () => JSON.parse((await execute('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 ** 2 })).stdout);
    const systemFile = adapters.systemFile || systemFileIdentity;
    const initialApi = await apiSnapshot(await processes(), appRoot, server, systemFile);
    for (const root of [path.dirname(initialApi.syncRoot), path.join(server, '.private/driver-audit-source'), path.join(server, '.private/driver-audit-heavy-work')]) await privateDirectory(root);
    for (const file of [path.join(path.dirname(initialApi.syncRoot), 'sync-worker.lock'), path.join(server, '.private/driver-audit-source/source-deployment.lock'),
      path.join(server, '.private/driver-audit-source/source-worker.lock'), path.join(server, '.private/driver-audit-heavy-work/work.lock')]) locks.push(await acquireWorkerLock(file));
    const baseFile = path.join(server, '.env'), localFile = path.join(server, '.env.local');
    const base = await readBase(baseFile), local = await readNativeObjectStorePrivateFile(localFile, 1024 ** 2), localStat = await fs.lstat(localFile);
    const originalValues = { ...dotenv.parse(base.bytes), ...dotenv.parse(local) };
    check(typeof env.MONGODB_URI === 'string' && env.MONGODB_URI.length > 0 && env.MONGODB_URI === originalValues.MONGODB_URI,
      'The loaded and durable database settings differ');
    const locationSha256 = nativeObjectStoreMongoLocationSha256(env.MONGODB_URI);
    check(locationSha256 === template.quota.locationSha256, 'The quota proof belongs to another datasource');
    check((env.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase' && (originalValues.DRIVER_AUDIT_DATA_STORE || 'supabase') === 'supabase',
      'Storage preparation cannot select the native reporting backend');
    const { default: mongoose } = await load('node_modules/mongoose/index.js');
    connection = mongoose.createConnection(env.MONGODB_URI, { autoCreate: false, autoIndex: false, maxPoolSize: 4,
      serverSelectionTimeoutMS: 10000, connectTimeoutMS: 5000, socketTimeoutMS: 5000 });
    await connection.asPromise(); const db = connection.db, client = connection.getClient(); check(db.databaseName === state.targetDatabase, 'Object-store database differs');
    const { createDriverAuditNativeObjectStore } = await load('services/driverAuditNativeObjectStore.js');
    const { validateDriverAuditSpacesArchiveReference } = await load('services/driverAuditSpacesArchive.js');
    const validateExternalReference = validateDriverAuditSpacesArchiveReference;
    const { createDriverAuditMongoArchive } = await load('services/driverAuditMongoArchive.js');
    const photoRoot = path.join(server, '.private/driver-audit-native-photo-candidates'); await privateDirectory(photoRoot);
    await immutable(path.join(photoRoot, template.lookupSha256 + '.json'), lookupBytes);
    const proposed = proposeNativeObjectStoreEnvironment({ base: base.bytes, before: local, lookupSha256: template.lookupSha256, parse: dotenv.parse });
    const plannedEnv = { ...env, ...proposed.values };
    const objectStore = await createDriverAuditNativeObjectStore({ env: plannedEnv, photoCandidatesRoot: photoRoot });
    check(objectStore?.identitySha256 === template.destinationIdentitySha256, 'The actual owned destination identity differs');
    const implementationFiles = ['services/driverAuditMongoArchive.js', 'services/driverAuditSpacesArchive.js', 'services/driverAuditNativeObjectStore.js'];
    const implementationSha256 = hash(JSON.stringify([hash(await fs.readFile(fileURLToPath(import.meta.url))),
      ...await Promise.all(implementationFiles.map(async file => [file, hash(await fs.readFile(path.join(server, file)))]))]));
    const prepFile = path.join(folder, 'object-store-preparation-plan.private.json'); let prepBytes;
    try { prepBytes = await readNativeObjectStorePrivateFile(prepFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let expectedEnvironment = local;
    const safety = async () => {
      await checkout(); check(same(await apiSnapshot(await processes(), appRoot, server, systemFile), initialApi), 'The original live API or stopped workers changed');
      check((await readBase(baseFile)).bytes.equals(base.bytes) && (await readNativeObjectStorePrivateFile(localFile)).equals(expectedEnvironment), 'Application settings changed during object-store work');
      for (const [file, sha256] of pinned) check(hash(await readNativeObjectStorePrivateFile(file, 2 * 1024 ** 2)) === sha256, 'An original object-store control input changed');
      check(hash(await readNativeObjectStorePrivateFile(path.join(photoRoot, template.lookupSha256 + '.json'), 2 * 1024 ** 2)) === template.lookupSha256,
        'Installed photo lookup changed');
    };
    const sdk = await load('node_modules/@aws-sdk/client-s3/dist-cjs/index.js'); let retention;
    const headroomProof = () => measureNativeObjectStoreClusterHeadroom({ client, targetDatabase: db.databaseName, quota: template.quota, locationSha256 });
    const assertProvider = async () => {
      retention = await readNativeObjectStoreRetention({ env: plannedEnv, identitySha256: objectStore.identitySha256,
        S3Client: sdk.S3Client || sdk.default?.S3Client,
        GetBucketLifecycleConfigurationCommand: sdk.GetBucketLifecycleConfigurationCommand || sdk.default?.GetBucketLifecycleConfigurationCommand });
      const proof = await objectStore.assertPrivate();
      check(proof?.public === false && proof.provider === 'spaces' && proof.identitySha256 === template.destinationIdentitySha256,
        'The actual provider privacy or owned destination differs'); return proof; };
    if (!prepBytes) {
      check(operation === 'prepare-object-store', 'Storage preparation must complete before externalization');
      const startup = validateNativeObjectStoreStartupBaseline({ snapshot: initialApi, baseMtimeMs: base.mtimeMs, localMtimeMs: localStat.mtimeMs,
        values: originalValues, env });
      await safety(); const native = await captureNativeObjectStorePreingest({ db, identitySha256: objectStore.identitySha256, validateExternalReference });
      const privacy = await assertProvider(), headroom = await headroomProof(); await safety();
      const prep = { version: 1, kind: 'native-object-store-preparation-v1', sessionId, templateSha256,
        identitySha256: objectStore.identitySha256, lookupSha256: template.lookupSha256, implementationSha256, startup,
        beforeEnvironmentSha256: hash(local), afterEnvironmentSha256: hash(proposed.after), baseEnvironmentSha256: hash(base.bytes),
        beforeNativeMetadataSha256: hash(json(native)), servingHeadSha256: native.servingHeadSha256,
        privacyProofSha256: hash(json(privacy)), retention, headroom,
        changedKeys: keys, originalReportingBackend: 'supabase', apiRestarted: false, preparedAt: new Date().toISOString(),
        rollback: { beforeFile: 'object-store-environment-before.private.bin', afterFile: 'object-store-environment-after.private.bin',
          requireCurrentAfterSha256: hash(proposed.after), restoreOnlyExactBeforeBytes: true, authorityMustBeAbsent: true } };
      await immutable(path.join(folder, prep.rollback.beforeFile), local); await immutable(path.join(folder, prep.rollback.afterFile), proposed.after);
      prepBytes = json(prep); await immutable(prepFile, prepBytes);
    }
    const prep = JSON.parse(prepBytes);
    check(prep.rollback?.beforeFile === 'object-store-environment-before.private.bin'
      && prep.rollback?.afterFile === 'object-store-environment-after.private.bin'
      && prep.rollback.restoreOnlyExactBeforeBytes === true && prep.rollback.authorityMustBeAbsent === true,
    'The fixed original storage recovery files are required');
    const before = await readNativeObjectStorePrivateFile(path.join(folder, prep.rollback.beforeFile)),
      after = await readNativeObjectStorePrivateFile(path.join(folder, prep.rollback.afterFile));
    const recoveredProposal = proposeNativeObjectStoreEnvironment({ base: base.bytes, before, lookupSha256: template.lookupSha256, parse: dotenv.parse });
    check(prep.version === 1 && prep.kind === 'native-object-store-preparation-v1' && prep.sessionId === sessionId && prep.templateSha256 === templateSha256
      && prep.identitySha256 === objectStore.identitySha256 && prep.lookupSha256 === template.lookupSha256 && prep.implementationSha256 === implementationSha256
      && same(prep.startup.api, initialApi) && prep.baseEnvironmentSha256 === hash(base.bytes)
      && prep.beforeEnvironmentSha256 === hash(before) && prep.afterEnvironmentSha256 === hash(after)
      && prep.rollback.requireCurrentAfterSha256 === hash(after) && same(prep.changedKeys, keys) && after.equals(recoveredProposal.after),
    'The preserved storage preparation changed or exceeds the two approved settings');
    const preparationCurrent = await captureNativeObjectStorePreingest({ db, identitySha256: objectStore.identitySha256, validateExternalReference });
    check(preparationCurrent.servingHeadSha256 === prep.servingHeadSha256, 'The original serving report pointer changed');
    if (operation === 'prepare-object-store') {
      check(local.equals(before) || local.equals(after), 'Storage settings changed outside the immutable proposal');
      let headroom;
      if (local.equals(before)) {
        try {
          await safety(); check(hash(json(await captureNativeObjectStorePreingest({ db, identitySha256: objectStore.identitySha256, validateExternalReference })))
            === prep.beforeNativeMetadataSha256, 'Native staging changed during storage preparation');
          await assertProvider(); await headroomProof(); await safety();
          await replaceNativeObjectStorePrivateFile(localFile, before, after); expectedEnvironment = after;
          await safety(); check(hash(json(await captureNativeObjectStorePreingest({ db, identitySha256: objectStore.identitySha256, validateExternalReference })))
            === prep.beforeNativeMetadataSha256, 'Native staging changed during storage preparation');
          await assertProvider(); headroom = await headroomProof(); await safety();
        } catch (error) {
          const actual = await readNativeObjectStorePrivateFile(localFile);
          if (actual.equals(after)) {
            try {
              await replaceNativeObjectStorePrivateFile(localFile, after, before, async () => {
                await safety();
                const current = await captureNativeObjectStorePreingest({ db, identitySha256: objectStore.identitySha256, validateExternalReference });
                check(hash(json(current)) === prep.beforeNativeMetadataSha256, 'Native or serving state changed before automatic rollback');
              });
            } catch {
              const observed = await readNativeObjectStorePrivateFile(localFile), failureFile = path.join(folder, 'object-store-preparation-failure.private.json');
              const failureBytes = json({ version: 1, kind: 'native-object-store-preparation-current-failure', observedAt: new Date().toISOString(),
                preparationSha256: hash(prepBytes), automaticRollbackApplied: false, rollbackSafetyRecheckFailed: true,
                plannedAfterEnvironmentRetained: observed.equals(after), observedEnvironmentSha256: hash(observed), inspectBeforeRetry: true });
              let previous; try { previous = await readNativeObjectStorePrivateFile(failureFile); } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
              if (previous) await replaceNativeObjectStorePrivateFile(failureFile, previous, failureBytes); else await immutable(failureFile, failureBytes);
              const blocked = Error('Automatic storage rollback blocked by changed native or application state'); blocked.phase = 'object-store-rollback-blocked'; throw blocked;
            }
          }
          throw error;
        }
      } else expectedEnvironment = after;
      if (!headroom) { await safety(); await assertProvider(); headroom = await headroomProof(); }
      return { version: 1, status: 'native-object-store-prepared', verified: true, preparationSha256: hash(prepBytes),
        destinationIdentitySha256: objectStore.identitySha256, lookupSha256: template.lookupSha256,
        headroom: publicHeadroom(headroom), retentionVerified: retention.verified, retentionPolicySha256: retention.policySha256,
        changedKeys: keys, apiRestarted: false, reportingBackend: 'supabase', authorityChanged: false };
    }
    check(local.equals(after), 'The exact completed storage preparation is required');
    expectedEnvironment = after; await safety(); await assertProvider(); await headroomProof();
    const planFile = path.join(folder, 'object-store-externalization-plan.private.json'); let planBytes;
    try { planBytes = await readNativeObjectStorePrivateFile(planFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!planBytes) {
      const before = await captureNativeObjectStorePreingest({ db, identitySha256: objectStore.identitySha256, validateExternalReference });
      planBytes = json({ version: 1, kind: 'unused-native-archive-externalization-v1', targetDatabase: db.databaseName,
        identitySha256: objectStore.identitySha256, implementationSha256, preparationSha256: hash(prepBytes),
        retentionPolicySha256: retention.policySha256, before, createdAt: new Date().toISOString() });
      check(profileSha256 === hash(prepBytes), 'The exact completed storage preparation is required to plan externalization');
      await immutable(planFile, planBytes);
    }
    const plan = JSON.parse(planBytes); check(plan.implementationSha256 === implementationSha256 && plan.preparationSha256 === hash(prepBytes), 'The initial externalization plan changed');
    if (profileSha256 === hash(prepBytes)) {
      const legacy = plan.before.files.filter(row => row.reference), referenced = new Set(legacy.flatMap(row => row.reference.chunks.map(part => part.sha256)));
      return { version: 1, status: 'unused-native-archive-externalization-planned', verified: true, applyPending: true,
        preparationSha256: hash(prepBytes), externalizationPlanSha256: hash(planBytes), destinationIdentitySha256: objectStore.identitySha256,
        originalObjects: legacy.length, originalBytes: legacy.reduce((sum, row) => sum + row.reference.size, 0),
        currentMongoChunkBytes: plan.before.chunks.reduce((sum, row) => sum + row.size + 1024, 0),
        protectedStandaloneMongoChunkBytes: plan.before.chunks.filter(row => !referenced.has(row._id)).reduce((sum, row) => sum + row.size + 1024, 0),
        providerFullGetReadbackRequired: true, sourceDataChanged: false, servingDataChanged: false, authorityChanged: false };
    }
    check(profileSha256 === hash(planBytes), 'The exact reviewed initial externalization plan is required');
    const journalFile = path.join(folder, 'object-store-externalization-current.private.json'); let journalBytes;
    try { journalBytes = await readNativeObjectStorePrivateFile(journalFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!journalBytes) { journalBytes = json(initialNativeExternalizationJournal(hash(planBytes))); await immutable(journalFile, journalBytes); }
    // This index covers only disposable staging metadata and bounds the orphan
    // query cost. It contains no evidence payload or permanent per-object log.
    await db.collection('driverAuditNativeFiles').createIndex({ 'reference.chunks.sha256': 1 }, { name: 'native_archive_chunk_references' });
    const result = await externalizeNativeArchive({ db, client, objectStore, validateExternalReference, plan, journal: JSON.parse(journalBytes),
      archive: createDriverAuditMongoArchive({ db, client, capacityBytes }), safety, limits: template.limits,
      async saveJournal(value) { const next = json(value); await replaceNativeObjectStorePrivateFile(journalFile, journalBytes, next); journalBytes = next; } });
    delete result.currentJournal;
    return { ...result, preparationSha256: hash(prepBytes), destinationIdentitySha256: objectStore.identitySha256,
      currentJournalSha256: hash(journalBytes), applicationCommit: expectedSha };
  } finally {
    let cleanupError;
    try { await connection?.close(); } catch (error) { cleanupError = error; }
    for (const lock of locks.reverse()) {
      try { await lock.release(); } catch (error) { cleanupError ||= error; }
    }
    if (cleanupError) throw cleanupError;
  }
}
