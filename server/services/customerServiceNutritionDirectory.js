import { createHash } from 'node:crypto';

// Observed read-only customer-list action. The host/path cannot be configured:
// Nutrition session cookies must never be sent to the separate v1 API service.
const endpoint = 'https://admin.matternutrition.xyz/customers';
const defaultAction = '40cf3c4d92f5b4cee202f07e3b97d51514b28cf8f8';
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const sourceId = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value)) return value;
  throw new Error('Invalid Nutrition identity');
};
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function readPage({ page, pageSize, cookie, action, fetchImpl, maxPageBytes, timeoutMs }) {
  const response = await fetchImpl(endpoint, {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    headers: { Cookie: cookie, 'next-action': action, Origin: 'https://admin.matternutrition.xyz', Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify([{ page, perPage: pageSize, search: '$undefined', hasActiveSubscription: '$undefined', status: '$undefined', sortBy: '$undefined', sortDir: 'asc', tagIds: '$undefined' }]),
  });
  if (!response.ok || response.redirected || (response.url && response.url !== endpoint) || !/^text\/x-component(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('Nutrition read rejected');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing Nutrition body');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxPageBytes) { await reader.cancel(); throw new Error('Nutrition body limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  // Only accept the observed two-record JSON action envelope, never evaluate RSC.
  const records = new Map();
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]+):(.*)$/.exec(line);
    if (!match || records.has(match[1])) throw new Error('Invalid Nutrition RSC');
    records.set(match[1], JSON.parse(match[2]));
  }
  const root = records.get('0');
  if (!root || root.a !== '$@1' || records.size !== 2 || !records.has('1')) throw new Error('Invalid Nutrition action envelope');
  return { payload: records.get('1'), bytes };
}

export async function readNutritionCustomerDirectory({ env = process.env, fetchImpl = fetch, pageSize = 20, maxPages = 200, maxRecords = 10000, maxPageBytes = 5 * 1024 * 1024, timeoutMs = 15000, clock = () => new Date() } = {}) {
  const cookie = env.CUSTOMER_SERVICE_NUTRITION_COOKIE;
  const action = env.CUSTOMER_SERVICE_NUTRITION_ACTION || defaultAction;
  if (typeof cookie !== 'string' || !cookie.trim() || cookie.length > 32768 || /[\r\n]/.test(cookie)) throw new Error('Nutrition cookie configuration is required');
  if (typeof action !== 'string' || !/^[a-f0-9]{40,64}$/.test(action)) throw new Error('Invalid Nutrition action configuration');
  for (const [value, maximum] of [[pageSize,100],[maxPages,1000],[maxRecords,100000],[maxPageBytes,5*1024*1024],[timeoutMs,30000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid Nutrition read budget');
  }
  try {
    const rows = [], ids = new Set(), digests = []; let total, pages, bytes = 0, requests = 0;
    // A first-page reread detects boundary drift. It still cannot
    // prove an atomic database snapshot because the source supplies no token.
    for (let pass = 0; pass < 2; pass++) {
      for (let page = 1; page <= (pass ? 1 : (pages ?? 1)); page++) {
        const result = await readPage({ page, pageSize, cookie, action, fetchImpl, maxPageBytes, timeoutMs });
        bytes += result.bytes; requests++;
        if (bytes > 64 * 1024 * 1024) throw new Error('Nutrition capture memory budget');
        const p = result.payload;
        if (!p || !Array.isArray(p.data) || p.currentPage !== page || p.perPage !== pageSize || !Number.isSafeInteger(p.total) || p.total < 0 || !Number.isSafeInteger(p.lastPage) || p.lastPage !== Math.max(1,Math.ceil(p.total/pageSize))) throw new Error('Nutrition pagination mismatch');
        if (total === undefined) { total = p.total; pages = p.lastPage; }
        if (total > maxRecords || pages > maxPages || p.total !== total || p.lastPage !== pages || p.data.length !== Math.min(pageSize, Math.max(0,total-(page-1)*pageSize))) throw new Error('Nutrition pagination drift or truncation');
        const digest = fingerprint(p);
        if (pass) { if (digests[page-1] !== digest) throw new Error('Nutrition source changed'); }
        else {
          digests.push(digest);
          for (const row of p.data) { const id = sourceId(row.id); if (ids.has(id)) throw new Error('Nutrition duplicate identity'); ids.add(id); rows.push(row); }
        }
      }
    }
    if (rows.length !== total || ids.size !== total) throw new Error('Nutrition count mismatch');
    const observedAt = new Date(clock()).toISOString();
    const report = { source:'nutrition_admin_customers', observedAt, sourceCustomerTotal:total, uniqueCustomers:ids.size, pagesRead:pages, verificationPagesRead:1, requests, sourcePagesExhausted:true, fullCustomerDirectory:true, fullAdminCustomerDirectory:true, reconciled:true, atomicSnapshot:false, coverage:'nutrition_admin_customer_directory', limitations:['All customers returned by the unfiltered Nutrition admin directory are included.','Page totals and unique identities reconcile and the first page was unchanged on reread; other concurrent profile updates may go undetected and the source supplies no atomic snapshot token.'] };
    const customers = rows.map(row => {
      const matterCustomerId = sourceId(row.id);
      const profile = { name:text(row.fullName,200) || [text(row.firstName,100),text(row.lastName,100)].filter(Boolean).join(' '), email:text(row.email,320), phone:text(row.telephone,80) || text(row.whatsappNumber,80) };
      const phones = [...new Set([text(row.telephone,80),text(row.whatsappNumber,80)].filter(Boolean))];
      return { customerId:`matter:${matterCustomerId}`, matterCustomerId, ...profile, telephone:text(row.telephone,80), whatsappNumber:text(row.whatsappNumber,80), profileObservations:phones.length ? phones.map(phone=>({...profile,phone})) : [profile], subscriptions:[], identityNeedsReview:phones.length > 1, accountStatus:text(row.accountStatus,80), hasActiveSubscription:typeof row.hasActiveSubscription === 'boolean' ? row.hasActiveSubscription : null, source:'nutrition_admin_customers', sourceCoverage:report.coverage, sourceObservedAt:observedAt, sourceReport:report };
    });
    report.customersWithPhone = customers.filter(c=>c.phone).length;
    return { customers, report };
  } catch {
    // No response bodies, upstream errors, names or cookies escape this boundary.
    throw new Error('Nutrition customer directory read failed; previous local directory must be retained.');
  }
}
