import { createHash } from 'node:crypto';
import { createCloudRepository, readManifestBytes } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { createCloudReportService, readCloudPhotoProposal } from '../vendor/driver-audits/integration/cloud/report-service.mjs';
import { photoCaseReviewed } from '../vendor/driver-audits/integration/cloud/photo-review-guard.mjs';
import { chooseLegacyProposal } from '../vendor/driver-audits/integration/cloud/photo-progress.mjs';
import { createPhotoProposalService } from '../vendor/driver-audits/integration/hosted/photo-proposals.mjs';
import { completedPhotoDay } from '../vendor/driver-audits/integration/hosted/photo-completion.mjs';
import { readRetainedDriverAuditFile } from './driverAuditLightEvidence.js';

const MiB = 1024 ** 2;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const mayHaveCloudResult = status => status === 'pending' || status === 'unavailable';

function pinRepository(publication, archive) {
  const body = JSON.stringify({ version: 1, catalog: publication.catalog, head: publication.head });
  return createCloudRepository({ stateStore: { read: async () => ({ body, revision: 1 }) },
    transport: archive, cacheBytes: 4 * MiB }).pin();
}

// The original queues can be tens of megabytes. During the one-time index
// build, keep only lookups for the original active scope. Result bodies stay
// in their existing immutable inventory and are read only when needed.
export async function buildDriverAuditLightPhotoLookup({ publication, archive }) {
  const repository = await pinRepository(publication, archive);
  const reportHash = publication.head.reportHash;
  const service = createCloudReportService({ repository, reviewStore: {}, identityStore: {} });
  const inventories = await service.photoInventoryFor(reportHash);
  const blocked = new Set();
  const queues = inventories.map(({ queue, flags, proposals, attempts }) => {
    const byKey = Object.create(null);
    for (const item of queue.items) {
      const keys = new Set([item.recordKey, item.datedRecordKey].filter(Boolean));
      if (proposals[item.id] || flags[item.id] || attempts?.[item.id]) {
        for (const key of keys) blocked.add(key);
      }
      const day = item.scopeDate || item.recordKey.slice(0, 10);
      if (item.duplicateOf || queue.scope && (day < queue.scope.from || day > queue.scope.to)) continue;
      // Only fields used to check the original photo binding are needed.
      const { id, recordKey, datedRecordKey, urlSha256, proofTimestamp, imageSha256, cachedSha256, scopeDate } = item;
      const binding = { id, recordKey, datedRecordKey, urlSha256, proofTimestamp, imageSha256, cachedSha256, scopeDate };
      for (const key of keys) (byKey[key] ??= []).push(binding);
    }
    return { rubricVersion: queue.rubricVersion, completedReportDays: queue.completedReportDays ?? [], byKey };
  });
  return { version: 1, reportHash, catalogSha256: publication.catalog.sha256,
    inventorySha256: sha(JSON.stringify(inventories)), blocked: [...blocked].sort(), queues };
}

export function createDriverAuditLightPhotoSuggestions({ archive, rpcForResponseLimit, readPhoto, readDetail, readJournal, readLookup,
  clock = Date.now } = {}) {
  const originals = new Map();
  const priorPublications = new Map();
  const receiptMaps = new WeakMap();
  let current, refreshing;

  async function context(publication) {
    if (publication?.version !== 1 || !hex(publication.catalog?.sha256)
      || !hex(publication.head?.reportHash) || !hex(publication.head?.manifest?.sha256)
      || publication.cloudPhotoResults !== undefined && !object(publication.cloudPhotoResults)) {
      throw Error('The saved photo suggestion publication is invalid');
    }
    const repository = await pinRepository(publication, archive);
    return { repository, pointers: publication.cloudPhotoResults ?? {} };
  }

  function previous({ collectorRevision, sourceBodySha256 }) {
    let pending = priorPublications.get(sourceBodySha256);
    if (!pending) {
      pending = (async () => {
        const state = createCloudState({ rpc: rpcForResponseLimit(16 * MiB) });
        const [receipt] = await state.receipts('collector-state', { after: collectorRevision - 1 });
        if (receipt?.revision !== collectorRevision || receipt.body_sha256 !== sourceBodySha256
          || Buffer.byteLength(receipt.body_text) > 8 * MiB) throw Error('The retained photo suggestion publication differs');
        return context(JSON.parse(receipt.body_text));
      })().catch(error => { if (priorPublications.get(sourceBodySha256) === pending) priorPublications.delete(sourceBodySha256); throw error; });
      priorPublications.set(sourceBodySha256, pending);
      if (priorPublications.size > 2) priorPublications.delete(priorPublications.keys().next().value);
    }
    return pending;
  }

  function original(head, index) {
    const key = head.descriptor.sha256;
    let pending = originals.get(key);
    if (!pending) {
      pending = (async () => {
        const descriptor = JSON.parse(await readManifestBytes(archive, head.descriptor, { maxBytes: 8 * MiB }));
        const file = 'publication.private.json', ref = descriptor.files?.[file];
        if (descriptor.version !== 1 || descriptor.generation !== head.generation || descriptor.reportHash !== head.reportHash
          || ref?.domain !== 'previewRuntime' || ref.path !== file) throw Error('The original photo suggestions differ from the report');
        const publication = JSON.parse(await readManifestBytes(archive, ref, { maxBytes: 8 * MiB }));
        if (publication.head?.manifest?.sha256 !== head.generation || publication.head?.reportHash !== head.reportHash
          || publication.catalog?.sha256 !== index.catalog.sha256) throw Error('The original photo suggestions differ from the report');
        return context(publication);
      })().catch(error => { if (originals.get(key) === pending) originals.delete(key); throw error; });
      originals.set(key, pending);
      if (originals.size > 2) originals.delete(originals.keys().next().value);
    }
    return pending;
  }

  function latest() {
    if (current && clock() - current.checkedAt < 30000) return current.value;
    // The first read reuses the shared on-disk collector cache. Later checks
    // ask for a body only when its Supabase revision has changed.
    refreshing ??= (async () => {
      const rpc = rpcForResponseLimit(16 * MiB), p_key = 'collector-state';
      const next = current ? await rpc('matter_hosted_state_read_if_changed', { p_key, p_revision: current.revision })
        : await rpc('matter_hosted_state_read', { p_key });
      if (next?.unchanged === true && next.revision === current?.revision && next.body_text === null) {
        current.checkedAt = clock();
        return current.value;
      }
      if (!Number.isSafeInteger(next?.revision) || next.revision <= (current?.revision ?? 0)
        || typeof next.body_text !== 'string' || Buffer.byteLength(next.body_text) > 8 * MiB) {
        throw Error('The current photo suggestion publication is unavailable');
      }
      const value = await context(JSON.parse(next.body_text));
      current = { revision: next.revision, checkedAt: clock(), value };
      return value;
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  async function legacy(index, row, readImage, base, readAssessment) {
    if (!index.photoSuggestions) return { proposal: null, blocksCloud: false };
    const lookup = await readLookup(index);
    if (lookup.queues.some(queue => queue.completedReportDays.includes(row.key.slice(0, 10)))) {
      // A delivery added to an already graded day can still have its own
      // suggestion. The saved detail carries the original cohort marker.
      row = await readAssessment();
    }
    const completed = lookup.queues.some(queue => completedPhotoDay(row, queue.completedReportDays));
    if (completed) return { proposal: { recordKey: row.key, status: 'retained' }, blocksCloud: true };
    const queues = lookup.queues.map(queue => ({ rubricVersion: queue.rubricVersion,
      completedReportDays: queue.completedReportDays, items: Object.hasOwn(queue.byKey, row.key) ? queue.byKey[row.key] : [] }));
    const blocksCloud = lookup.blocked.includes(row.key);
    if (!queues.some(queue => queue.items.length)) return { proposal: null, blocksCloud };
    const { repository } = await base();
    // The compact lookup and these receipt maps were bound to the same
    // immutable inventory when the index was built.
    let pending = receiptMaps.get(lookup);
    if (!pending) {
      pending = readRetainedDriverAuditFile(repository, 'photo-inventories/' + lookup.inventorySha256 + '.json', 8 * MiB)
        .then(bytes => {
          const refs = JSON.parse(bytes);
          if (!Array.isArray(refs) || refs.length !== 2) throw Error('The original photo suggestion receipts differ');
          return refs;
        }).catch(error => { receiptMaps.delete(lookup); throw error; });
      receiptMaps.set(lookup, pending);
    }
    const refs = await pending;
    const params = new URLSearchParams({ record: row.key, snapshot: index.reportHash });
    const results = await Promise.all(queues.map(async (queue, position) => {
      const original = refs[position];
      const receipts = Object.fromEntries(['proposals', 'flags', 'attempts', 'unavailable'].map(kind => [kind,
        Object.fromEntries(queue.items.filter(item => Object.hasOwn(original[kind] ?? {}, item.id))
          .map(item => [item.id, original[kind][item.id]])),
      ]));
      const service = createPhotoProposalService({ snapshotFor: async () => ({ rows: [row] }),
        inventoryFor: async () => ({ ...receipts, queue }), readImage });
      return (await service(params)).proposals[0];
    }));
    const proposal = chooseLegacyProposal(...results);
    return { proposal, blocksCloud };
  }

  return async function suggestion(head, index, entry, actor, isCurrent) {
    const recordKey = entry.row.key;
    const { sha256, sourceUrl, proofTimestamp } = entry.photo ?? {};
    const none = { recordKey, status: 'none' };
    if (typeof sourceUrl !== 'string' || !sourceUrl) return none;
    const row = { ...entry.gpsRow, findings: [
      ...(entry.reviewRow?.findings ?? []),
      ...(entry.issues ?? []).map(issue => ({ issue_id: issue.id })),
      ...(entry.retainedReviews ?? []).flatMap(version => version.issues.map(issue => ({ issue_id: issue.id }))),
    ], delivery: { ...entry.gpsRow.delivery, photo_url: sourceUrl, raw_upload: proofTimestamp,
      upload: proofTimestamp, photo_sha256: sha256 } };
    let assessment;
    async function readAssessment() {
      if (!assessment) {
        const detail = await readDetail(index, entry), saved = detail?.rows?.[0];
        if (detail?.rows?.length !== 1 || saved?.key !== row.key || saved.assessmentHash !== row.assessmentHash)
          throw Error('The original photo assessment is unavailable');
        assessment = { ...saved, findings: [...(saved.findings ?? []), ...row.findings], delivery: row.delivery };
      }
      return assessment;
    }
    const readImage = async digest => {
      if (digest !== sha256) throw Error('The suggestion names a different saved photo');
      try { return (await readPhoto(index, entry)).body; }
      catch (error) { if (error.status === 404) error.code = 'ENOENT'; throw error; }
    };
    const base = () => original(head, index);
    const inherited = await legacy(index, row, readImage, base, readAssessment);
    // A saved legacy suggestion remains visible as historical evidence.
    // Staff decisions take priority over later automated results.
    if (inherited.proposal && !mayHaveCloudResult(inherited.proposal.status)) return inherited.proposal;
    if (photoCaseReviewed(row)) return { recordKey, status: 'retained' };
    if (inherited.blocksCloud || !hex(sha256)) return none;
    const find = ({ pointers, repository }) => readCloudPhotoProposal({ row, pointers,
      readResult: path => repository.readFile('state', path, { maxBytes: 65536 }), readImage });
    let saved = await find(await base());
    if (!saved && isCurrent) saved = await find(await latest());
    if (!saved && !isCurrent && head.deliveryView) saved = await find(await previous(head.deliveryView));
    if (!saved) return inherited.proposal ?? none;
    const [assessed, { history }] = await Promise.all([readAssessment(), readJournal(actor)]);
    return photoCaseReviewed(assessed, { records: { reportingReviews: history } })
      ? { recordKey, status: 'retained' } : saved;
  };
}
