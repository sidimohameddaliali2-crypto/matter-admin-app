import { createHash } from 'node:crypto';
import { loadRemotePreviewPackage } from '../vendor/driver-audits/integration/cloud/remote-preview-package.mjs';
import { readManifestBytes } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { createDriverAuditLightArchive, isDriverAuditLightReference } from './driverAuditLightArchive.js';
import { isDriverAuditDeliveryHead } from './driverAuditDeliveryHead.js';
import { verifyDriverAuditDeliveryStage } from './driverAuditDeliveryView.js';

export const driverAuditSupabaseReportHeadKey = 'app-sidi-report-head';

const chunkLimit = 8 * 1024 ** 2;
const fileLimit = 128 * 1024 ** 2;
const packageLimit = 256 * 1024 ** 2;
const pointerLimit = 256 * 1024;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const filename = value => typeof value === 'string' && value.length <= 240
  && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';

function fields(value, required, optional = []) {
  return object(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  const normalized = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === normalized;
}

function manifest(ref, domain, name, maximum) {
  check(fields(ref, ['version', 'domain', 'path', 'kind', 'size', 'sha256', 'chunks'])
    && ref.version === 1 && ref.domain === domain && ref.path === name && filename(name)
    && ref.kind === 'immutable-evidence' && Number.isSafeInteger(ref.size) && ref.size >= 0 && ref.size <= maximum
    && hex(ref.sha256) && Array.isArray(ref.chunks) && ref.chunks.length <= Math.ceil(maximum / chunkLimit),
  'Invalid Supabase serving package file metadata');
  let offset = 0;
  for (const part of ref.chunks) {
    check(fields(part, ['offset', 'size', 'sha256']) && part.offset === offset
      && positive(part.size) && part.size <= chunkLimit && hex(part.sha256),
    'Invalid Supabase serving package chunk metadata');
    offset += part.size;
    check(offset <= ref.size, 'Invalid Supabase serving package chunk size');
  }
  check(offset === ref.size && (ref.size !== 0 || ref.sha256 === sha(Buffer.alloc(0))),
    'Invalid Supabase serving package file size');
}

function pointer(value, { previous = true, identity = false } = {}) {
  check(fields(value, ['version', 'generation', 'reportHash', 'descriptor', 'servingPackage',
    'closureReceipt', 'restore', 'visibleCutoffAt'], ['publishedAt', 'lightView',
    ...(previous ? ['previous', 'deliveryView', 'previousDeliveryView'] : []),
    ...(identity ? ['sourceRevision', 'sourceBodySha256'] : [])]), 'Invalid Supabase serving pointer metadata');
  check(value.version === 1 && hex(value.generation) && hex(value.reportHash)
    && (value.visibleCutoffAt === null || timestamp(value.visibleCutoffAt))
    && (!Object.hasOwn(value, 'publishedAt') || timestamp(value.publishedAt)), 'Invalid Supabase serving pointer identity');
  manifest(value.descriptor, 'previewPackage', 'descriptor.json', chunkLimit);
  check(value.descriptor.size > 0, 'An exact Supabase serving descriptor is required');
  check(!Object.hasOwn(value, 'lightView') || isDriverAuditLightReference(value.lightView), 'Invalid indexed report reference');
  const source = value.servingPackage;
  check(fields(source, ['version', 'dataStore', 'collectorRevision', 'sourceBasis', 'manifestSha256'])
    && source.version === 1 && source.dataStore === 'supabase' && positive(source.collectorRevision)
    && hex(source.sourceBasis) && hex(source.manifestSha256), 'Invalid Supabase serving source metadata');
  if (Object.hasOwn(value, 'deliveryView')) {
    check(value.lightView && isDriverAuditDeliveryHead(value.deliveryView)
      && value.deliveryView.collectorRevision > source.collectorRevision
      && (!value.visibleCutoffAt || Date.parse(value.deliveryView.visibleCutoffAt) >= Date.parse(value.visibleCutoffAt)),
    'The incremental report must retain its verified base');
  }
  if (Object.hasOwn(value, 'previousDeliveryView')) {
    check(value.deliveryView && isDriverAuditDeliveryHead(value.previousDeliveryView)
      && value.previousDeliveryView.collectorRevision > source.collectorRevision
      && value.previousDeliveryView.collectorRevision <= value.deliveryView.collectorRevision
      && Date.parse(value.previousDeliveryView.visibleCutoffAt) <= Date.parse(value.deliveryView.visibleCutoffAt)
      && (value.previousDeliveryView.collectorRevision !== value.deliveryView.collectorRevision
        || value.previousDeliveryView.sourceBodySha256 === value.deliveryView.sourceBodySha256)
      && value.previousDeliveryView.ref.sha256 !== value.deliveryView.ref.sha256,
    'The previous incremental report identity differs');
  }
  const closure = value.closureReceipt;
  check(fields(closure, ['version', 'status', 'sourceBasis', 'manifestSha256', 'generation', 'reportHash',
    'descriptorSha256', 'checkedAt', 'checks'], ['collectorRevision'])
    && closure.version === 1 && closure.status === 'verified' && timestamp(closure.checkedAt)
    && closure.sourceBasis === source.sourceBasis && closure.manifestSha256 === source.manifestSha256
    && closure.generation === value.generation && closure.reportHash === value.reportHash
    && closure.descriptorSha256 === value.descriptor.sha256
    && (!Object.hasOwn(closure, 'collectorRevision') || closure.collectorRevision === source.collectorRevision)
    && fields(closure.checks, ['archive', 'photos', 'reviewHistory'])
    && Object.values(closure.checks).every(check => check === true),
  'A verified exact Supabase serving package closure binding is required');
  const restore = value.restore;
  check(fields(restore, ['version', 'archive', 'verified', 'manifestSha256', 'generation', 'reportHash', 'descriptorSha256'])
    && restore.version === 1 && restore.archive === 'matter-report-archive' && restore.verified === true
    && restore.manifestSha256 === source.manifestSha256 && restore.generation === value.generation
    && restore.reportHash === value.reportHash && restore.descriptorSha256 === value.descriptor.sha256,
  'A verified exact Supabase archive restore binding is required');
  if (identity && (Object.hasOwn(value, 'sourceRevision') || Object.hasOwn(value, 'sourceBodySha256'))) {
    check(positive(value.sourceRevision) && hex(value.sourceBodySha256), 'Invalid previous Supabase publication identity');
  }
  if (Object.hasOwn(value, 'previous') && value.previous !== null) {
    pointer(value.previous, { previous: false, identity: true });
    check(value.previous.servingPackage.collectorRevision <= source.collectorRevision,
      'Previous Supabase collector revision moved backwards');
  }
  return value;
}

function parsedRow(row) {
  check(fields(row, ['revision', 'body']) && Number.isSafeInteger(row.revision) && row.revision >= 0
    && (row.body === null && row.revision === 0 || typeof row.body === 'string' && row.revision > 0
      && Buffer.byteLength(row.body) > 0 && Buffer.byteLength(row.body) <= pointerLimit),
  'Invalid Supabase serving pointer state revision');
  if (row.body === null) return null;
  let value;
  try { value = JSON.parse(row.body); } catch { throw Error('Invalid Supabase serving pointer JSON'); }
  pointer(value);
  return { ...value, sourceRevision: row.revision, sourceBodySha256: sha(row.body) };
}

function expectedState(actual, expected) {
  if (expected === null) check(actual === null, 'Concurrent Supabase serving publication');
  else check(object(expected) && positive(expected.sourceRevision) && hex(expected.sourceBodySha256)
    && actual?.sourceRevision === expected.sourceRevision && actual.sourceBodySha256 === expected.sourceBodySha256,
  'Concurrent Supabase serving publication or invalid expected revision');
}

function previousSnapshot(actual) {
  const { previous, ...retained } = actual;
  return retained;
}

function sameCorePackage(left, right) {
  return left.generation === right.generation && left.reportHash === right.reportHash
    && left.descriptor.sha256 === right.descriptor.sha256
    && ['version', 'dataStore', 'collectorRevision', 'sourceBasis', 'manifestSha256']
      .every(key => left.servingPackage[key] === right.servingPackage[key])
    && left.visibleCutoffAt === right.visibleCutoffAt;
}

function samePackage(left, right) {
  return sameCorePackage(left, right) && left.lightView?.sha256 === right.lightView?.sha256
    && left.lightView?.size === right.lightView?.size;
}

export async function verifyDriverAuditSupabaseServingPackage({ head, archive } = {}) {
  pointer(head, { previous: true, identity: true });
  check(typeof archive?.readObject === 'function', 'The verified Supabase archive reader is required');
  const encoded = JSON.stringify(head);
  check(Buffer.byteLength(encoded) <= pointerLimit, 'Supabase serving pointer exceeds its metadata bound');
  head = JSON.parse(encoded);
  const descriptorBytes = await readManifestBytes(archive, head.descriptor, { maxBytes: chunkLimit });
  let descriptor;
  try { descriptor = JSON.parse(descriptorBytes); } catch { throw Error('Invalid Supabase serving descriptor JSON'); }
  check(fields(descriptor, ['version', 'files', 'sourceManifestSha256', 'reportHash', 'generation'])
    && descriptor.version === 1 && object(descriptor.files) && Object.keys(descriptor.files).length <= 32768
    && descriptor.sourceManifestSha256 === head.servingPackage.manifestSha256
    && descriptor.generation === head.generation && descriptor.reportHash === head.reportHash,
  'Supabase serving package source binding differs');
  let total = descriptorBytes.length;
  for (const [name, ref] of Object.entries(descriptor.files)) {
    manifest(ref, 'previewRuntime', name, fileLimit);
    total += ref.size;
    check(total <= packageLimit, 'Supabase serving package exceeds its byte bound');
  }
  const loaded = await loadRemotePreviewPackage({ descriptor: head.descriptor, transport: archive,
    parallelCoreReads: Boolean(head.lightView) });
  // The existing package loader verifies browser/generation and requires every
  // deferred-query/GPS reference to be declared. Read ALL declarations here,
  // including optional files, without retaining their bodies in another map.
  for (const name of Object.keys(descriptor.files)) await loaded.readAsync(name);
  const publication = JSON.parse(loaded.read('publication.private.json'));
  const observedAt = publication?.head?.source?.observedAt ?? null;
  check(observedAt === null ? head.visibleCutoffAt === null : timestamp(observedAt)
    && head.visibleCutoffAt !== null && Date.parse(observedAt) === Date.parse(head.visibleCutoffAt),
  'Supabase serving package source cutoff differs');
  if (head.lightView) {
    const { view } = loaded.takeVerifiedRuntime();
    await createDriverAuditLightArchive({ archive }).verify(head, view.gpsRows.map(row => row.key));
  }
  return { descriptor, totalBytes: total };
}

// Canonical Supabase records, reviews and archive objects remain in place.
// Only this separate CAS document selects the staff-visible, verified package.
export function createDriverAuditSupabaseReplica({ state, archive } = {}) {
  check(typeof state?.read === 'function' && typeof state?.compareAndSwap === 'function'
    && typeof archive?.readObject === 'function' && typeof archive?.putVerifiedObject === 'function',
  'Supabase serving state and verified archive are required');

  const readRow = () => state.read(driverAuditSupabaseReportHeadKey);

  async function readObject(key, options = {}) {
    check(typeof key === 'string' && /^[a-f0-9]{64}\.gz$/.test(key)
      && positive(options.maxBytes) && options.maxBytes <= chunkLimit, 'Invalid immutable Supabase serving object request');
    // The supplied archive is already the shared hash-verified read cache.
    return archive.readObject(key, options);
  }

  const verifiedPackage = head => verifyDriverAuditSupabaseServingPackage({ head, archive: { readObject } });
  async function writeSelection(before, next, event) {
    const body = JSON.stringify(next);
    check(Buffer.byteLength(body) <= pointerLimit, 'Supabase serving pointer exceeds its metadata bound');
    const revision = before?.sourceRevision ?? 0;
    check(revision < Number.MAX_SAFE_INTEGER, 'Supabase serving pointer revision exhausted');
    const bodySha256 = sha(body);
    const request = JSON.stringify({ expectedRevision: revision, expectedBodySha256: before?.sourceBodySha256 ?? null, bodySha256 });
    let recoveredAcknowledgement = false;
    try {
      const receipt = await state.compareAndSwap({ key: driverAuditSupabaseReportHeadKey,
        expectedRevision: revision, eventId: 'sidi-preview-' + sha(request), body, event: JSON.stringify(event), request });
      check(receipt?.revision === revision + 1 && receipt.body_text === body && receipt.body_sha256 === bodySha256,
        'Supabase serving publication acknowledgement mismatch');
    } catch (error) {
      const actual = await readRow();
      if (actual?.revision !== revision + 1 || actual.body !== body) throw error;
      recoveredAcknowledgement = true;
    }
    const actual = await readRow();
    check(actual?.revision === revision + 1 && actual.body === body,
      'Concurrent Supabase serving publication or exact readback mismatch');
    return { status: 'published', head: parsedRow(actual), ...(recoveredAcknowledgement ? { recoveredAcknowledgement: true } : {}) };
  }

  const replica = {
    async head() { return parsedRow(await readRow()); },
    readObject,
    async putObject(key, bytes) {
      check(typeof key === 'string' && /^[a-f0-9]{64}\.gz$/.test(key) && Buffer.isBuffer(bytes)
        && bytes.length > 0 && bytes.length <= chunkLimit && sha(bytes) === key.slice(0, 64),
      'Invalid immutable Supabase serving object');
      const body = Buffer.from(bytes), receipt = await archive.putVerifiedObject(key, body);
      check(receipt?.verified === true && receipt.key === key && receipt.sha256 === sha(body)
        && (receipt.bytes === undefined || receipt.bytes === body.length), 'Supabase serving object receipt was not verified');
      let size = 0;
      const hash = createHash('sha256');
      for await (const part of await readObject(key, { maxBytes: body.length })) {
        check(part instanceof Uint8Array && (size += part.byteLength) <= body.length,
          'Supabase serving object readback integrity failure');
        hash.update(part);
      }
      check(size === body.length && hash.digest('hex') === key.slice(0, 64),
        'Supabase serving object readback integrity failure');
      return receipt;
    },
    async activate({ expected, head } = {}) {
      // Capture caller metadata before any async work. No caller mutation can
      // change the verified identities between archive checks and the CAS.
      pointer(head);
      const encoded = JSON.stringify(head);
      check(Buffer.byteLength(encoded) <= pointerLimit, 'Supabase serving pointer exceeds its metadata bound');
      const expectedIdentity = expected === null ? null : {
        sourceRevision: expected?.sourceRevision, sourceBodySha256: expected?.sourceBodySha256,
      };
      const candidate = JSON.parse(encoded), before = parsedRow(await readRow());
      expectedState(before, expectedIdentity);
      check(!candidate.deliveryView && !before?.deliveryView, 'The full builder cannot replace a delivery-scoped report');
      if (before) {
        check(candidate.previous === null || candidate.previous === undefined,
          'Previous Supabase pointer must be derived from the actual current head');
        check(candidate.servingPackage.collectorRevision >= before.servingPackage.collectorRevision,
          'Supabase serving collector revision moved backwards');
        if (candidate.servingPackage.collectorRevision === before.servingPackage.collectorRevision) {
          check(samePackage(candidate, before) || !before.lightView && candidate.lightView && sameCorePackage(candidate, before),
            'Supabase serving collector revision package conflict');
        }
      }
      await verifiedPackage(candidate);
      if (!before && candidate.previous) await verifiedPackage(candidate.previous);
      const fresh = parsedRow(await readRow());
      expectedState(fresh, expectedIdentity);
      if (before && samePackage(candidate, before)) return { status: 'unchanged', head: fresh };
      const next = { ...candidate,
        previous: before ? sameCorePackage(candidate, before) ? before.previous ?? null : previousSnapshot(before)
          : candidate.previous ?? null };
      return writeSelection(before, next, { kind: 'app-sidi-report-publication', ...candidate.servingPackage,
        generation: candidate.generation, reportHash: candidate.reportHash, descriptorSha256: candidate.descriptor.sha256 });
    },
    async activateDeliveryView({ expected, staged } = {}) {
      const expectedIdentity = { sourceRevision: expected?.sourceRevision, sourceBodySha256: expected?.sourceBodySha256 };
      const before = parsedRow(await readRow());
      expectedState(before, expectedIdentity);
      check(verifyDriverAuditDeliveryStage(staged, before), 'Verified delivery-scoped staging is required');
      if (!staged.changedRecords) return { status: 'unchanged', head: before };
      const selected = staged.deliveryView, previous = before.deliveryView;
      check(isDriverAuditDeliveryHead(selected)
        && selected.collectorRevision >= (previous?.collectorRevision ?? before.servingPackage.collectorRevision)
        && (!previous || selected.collectorRevision !== previous.collectorRevision
          || selected.sourceBodySha256 === previous.sourceBodySha256)
        && (!previous || Date.parse(selected.visibleCutoffAt) >= Date.parse(previous.visibleCutoffAt)),
      'The delivery-scoped report source moved backwards');
      const { sourceRevision, sourceBodySha256, ...saved } = before;
      const next = { ...saved, deliveryView: selected, ...(previous ? { previousDeliveryView: previous } : {}) };
      pointer(next);
      return writeSelection(before, next, { kind: 'app-sidi-delivery-scoped-publication',
        generation: selected.ref.sha256, baseGeneration: before.generation,
        collectorRevision: selected.collectorRevision, changedRecords: staged.changedRecords, changedDays: staged.changedDays });
    },
  };
  return Object.freeze(replica);
}
