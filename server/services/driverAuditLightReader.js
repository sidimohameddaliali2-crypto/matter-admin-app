import { isDeepStrictEqual } from 'node:util';
import { driverAuditPageSize } from './driverAuditLightArchive.js';
import { driverAuditDeliveryIdentity, driverAuditRetainedLightHeads } from './driverAuditDeliveryHead.js';
import { createDriverAuditDeliveryView } from './driverAuditDeliveryView.js';
import { createDriverAuditLightEvidence } from './driverAuditLightEvidence.js';
import { driverAuditLightCss, driverAuditLightHtml, driverAuditLightJs } from './driverAuditLightPage.js';
import { createDriverAuditLightReviews } from './driverAuditLightReviews.js';

const base = '/api/reporting/light/';
const readHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'" };
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const allowedMethods = new Set(['GET', 'HEAD', 'POST']);
const endpoints = new Set(['dates', 'deliveries', 'case', 'detail', 'gps', 'photo', 'history', 'source-cases',
  'source-history', 'reviews', 'reader.css', 'reader.js']);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function reviewOptions(entry) {
  const options = new Map();
  for (const issue of entry.issues ?? []) options.set(issue.id, { id: issue.id, label: issue.title || issue.issue || null });
  for (const { issues } of entry.retainedReviews ?? []) {
    for (const issue of issues) {
      if (!options.has(issue.id)) options.set(issue.id, { id: issue.id, label: issue.title || issue.issue || null, archived: true });
    }
  }
  return [...options.values()];
}

function send(request, response, value, type = 'application/json; charset=utf-8', metadata = {}) {
  response.writeHead(200, { ...readHeaders, ...metadata, 'Content-Type': type });
  if (request.method === 'HEAD') return response.end();
  response.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}

function queryValue(url, name, { optional = false } = {}) {
  const values = url.searchParams.getAll(name);
  if (optional && values.length === 0) return undefined;
  if (values.length !== 1 || values[0].length > 350 || !values[0]) fail(400, 'Invalid report selection');
  return values[0];
}

async function readReview(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) fail(400, 'JSON review required');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 24 * 1024) fail(400, 'The review is too large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, bytes)); } catch { fail(400, 'Invalid review'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid review');
  return value;
}

export function createDriverAuditLightReader({ store, archive, rpcForResponseLimit, clock = Date.now } = {}) {
  const pages = createDriverAuditDeliveryView({ archive });
  const evidence = createDriverAuditLightEvidence({ archive });
  let cached, inFlight, prepared;

  async function current(fresh = false) {
    const now = clock();
    if (!fresh && cached && now - cached.at < 30000) return cached.head;
    inFlight ??= (async () => {
      const head = await store.head();
      if (!head?.lightView) fail(503, 'The indexed report has not been prepared');
      await pages.index(head);
      cached = { head, at: clock(), stale: false };
      return head;
    })().finally(() => { inFlight = undefined; });
    try { return await inFlight; }
    catch (error) {
      if (cached && !fresh) {
        cached.stale = true;
        cached.at = clock() - 25000;
        return cached.head;
      }
      throw error;
    }
  }

  function handles(url) {
    return url.pathname.startsWith(base) || ['/api/reporting/view', '/driver-audit-view'].includes(url.pathname)
      && url.searchParams.get('fullArchive') !== '1';
  }

  async function handle(request, response, url, session, auth) {
    const { actor } = session;
    if (!allowedMethods.has(request.method)) fail(405, 'This report action is unavailable');
    const endpoint = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : 'document';
    if (request.method === 'POST' && endpoint !== 'reviews') fail(405, 'This report action is read-only');
    if (endpoint === 'document') return send(request, response, driverAuditLightHtml, 'text/html; charset=utf-8');
    if (!endpoints.has(endpoint)) fail(404, 'Report path unavailable');
    if (endpoint === 'reader.css') return send(request, response, driverAuditLightCss, 'text/css; charset=utf-8');
    if (endpoint === 'reader.js') return send(request, response, driverAuditLightJs, 'application/javascript; charset=utf-8');
    const live = await current(request.method === 'POST');
    if (endpoint === 'dates') {
      const index = await pages.index(live);
      return send(request, response, { generation: index.generation, reportHash: index.reportHash,
        visibleCutoffAt: index.visibleCutoffAt, records: index.records, history: index.history, stale: cached.stale,
        ...(live.deliveryView ? { archiveReadOnly: true } : {}),
        days: index.days.map(({ day, records, extraCases }) => ({ day, records, extraCases })), pageSize: driverAuditPageSize,
        canReview: actor.role === 'reviewer' || actor.role === 'owner', token: session.csrf });
    }
    const generation = queryValue(url, 'generation');
    if (!hex(generation)) fail(400, 'Invalid report generation');
    const head = driverAuditRetainedLightHeads(live)
      .find(candidate => candidate.lightView && driverAuditDeliveryIdentity(candidate).generation === generation);
    if (!head) fail(409, 'The selected report was replaced');
    if (endpoint === 'deliveries') {
      const day = queryValue(url, 'day'), raw = queryValue(url, 'offset', { optional: true }) ?? '0';
      const driver = queryValue(url, 'driver', { optional: true });
      if (!/^\d{1,9}$/.test(raw) || driver !== undefined && !driver.startsWith('driver:')) fail(400, 'Invalid delivery page');
      return send(request, response, await pages.list(head, { day, offset: Number(raw), driver: driver?.slice(7) }));
    }
    if (endpoint === 'source-cases') return send(request, response, await pages.additionalCases(head, queryValue(url, 'day')));
    const recordKey = queryValue(url, 'record');
    if (endpoint === 'source-history') {
      const entry = await pages.additionalHistory(head, recordKey);
      return send(request, response, await evidence.history(await pages.index(head), entry));
    }
    const entry = await pages.record(head, recordKey), index = await pages.index(head);
    if (endpoint === 'reviews') {
      const issueId = queryValue(url, 'issueId');
      const issue = entry.issues?.find(item => item.id === issueId);
      const archived = entry.retainedReviews ?? [];
      if (!issue && !archived.some(context => context.issues.some(item => item.id === issueId)))
        fail(404, 'The saved review case is unavailable');
      const reviewHash = entry.review?.snapshotHash;
      const reviews = createDriverAuditLightReviews({ rpcForResponseLimit,
        resolveIssue: (hash, selectedIssue, key) => issue && entry.reviewRow && hash === reviewHash && selectedIssue === issueId && key === recordKey
          ? { ...entry.review, rows: [entry.reviewRow], issues: [issue] } : null,
      });
      if (request.method === 'POST') {
        if (!auth.csrfMatches(session.csrf, request.headers['x-reporting-token'])) fail(403, 'Invalid report request');
        const input = await readReview(request);
        // An unchanged delivery can cross a publication safely. A superseded
        // evidence binding can still be read, but cannot receive new replies.
        const liveEntry = head === live ? entry : await pages.record(live, recordKey);
        if (!issue || input.issueId !== issueId || input.snapshotHash !== reviewHash || !isDeepStrictEqual(liveEntry, entry))
          fail(409, 'The review evidence changed');
        return send(request, response, await reviews.save(input, actor, { recordKey }));
      }
      return send(request, response, await reviews.readCase({ snapshotHash: reviewHash, issueId, recordKey,
        archived, historicalOnly: !issue }, actor));
    }
    if (endpoint === 'case') return send(request, response, {
      photo: hex(entry.photo?.sha256), issues: reviewOptions(entry), findings: entry.policy?.findings ?? [],
    });
    if (endpoint === 'detail') return send(request, response,
      { saved: await evidence.detail(index, entry) ?? { delivery: entry.gpsRow.delivery }, policy: entry.policy ?? null });
    if (endpoint === 'history') return send(request, response, await evidence.history(index, entry));
    if (endpoint === 'gps') return send(request, response,
      await evidence.gps(index, entry, actor, queryValue(url, 'vehicle', { optional: true })));
    const photo = await evidence.photo(index, entry);
    return send(request, response, photo.body, photo.type, { 'X-Report-Image-Sha256': photo.sha256 });
  }

  return Object.freeze({
    handles, handle,
    async prewarm() {
      const head = await current(true);
      prepared = { generation: driverAuditDeliveryIdentity(head).generation, index: head.lightView.sha256 };
      return true;
    },
    isPreparedFor(head) {
      return Boolean(prepared && prepared.generation === driverAuditDeliveryIdentity(head).generation
        && prepared.index === head?.lightView?.sha256);
    },
  });
}
