import { createServer } from 'node:http';
import { createDriverAuditIntegration } from './driverAuditIntegration.js';
import { openDriverAuditDataBackend } from './driverAuditDataBackend.js';
import { createCloudState } from '../vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { createDriverAuditSupabaseReplica } from './driverAuditSupabaseReplica.js';

const staffEndpoint = 'http://127.0.0.1:5000/api/auth/me';
const deny = () => Object.assign(Error('The existing staff session could not be verified'), { status: 401 });

// Keep the application's existing staff account, activation and report
// permission checks. This process never opens a user or reporting database.
export function createDriverAuditStaffProxy({ fetchImpl = fetch } = {}) {
  return async token => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{1,8192}$/.test(token)) throw deny();
    const response = await fetchImpl(staffEndpoint, { method: 'GET', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(5000), headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!response.ok || response.redirected) { await response.body?.cancel(); throw deny(); }
    const parts = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 64 * 1024) throw deny();
      parts.push(Buffer.from(chunk));
    }
    let value;
    try { value = JSON.parse(Buffer.concat(parts, size)); } catch { throw deny(); }
    const user = value?.data?.user;
    if (value?.success !== true || !/^[a-f0-9]{24}$/.test(user?._id || '') || typeof user.email !== 'string'
      || user.email.length > 320 || typeof user.role !== 'string' || user.isActive === false
      || !user.permissions || typeof user.permissions !== 'object' || Array.isArray(user.permissions)) throw deny();
    // /auth/me runs the original protect middleware, which rejects deactivated
    // accounts before its success response. It returns effective permissions.
    return { _id: user._id, email: user.email, role: user.role, isActive: true,
      permissions: { reports: user.permissions.reports === true } };
  };
}

export async function createDriverAuditHttpServer({ env = process.env, backend: suppliedBackend,
  fetchImpl, createIntegration = createDriverAuditIntegration } = {}) {
  if (env.DRIVER_AUDIT_EXECUTION_HOST !== 'sidi' || env.DRIVER_AUDIT_DATA_STORE !== 'supabase'
    || env.DRIVER_AUDIT_ENABLED !== '1' || env.DRIVER_AUDIT_IMPORT_ENABLED !== '0') {
    throw Error('Explicit Supabase reporting settings are required');
  }
  const backend = suppliedBackend || await openDriverAuditDataBackend({ env });
  if (backend.kind !== 'supabase' || backend.executionHost !== 'sidi'
    || backend.transferAccounting !== 'supabase-http-bytes-v1') throw Error('The qualified Sidi reporting backend is required');
  const store = createDriverAuditSupabaseReplica({ state: createCloudState({ rpc: backend.rpc }), archive: backend.archive });
  const integration = createIntegration({ env, authenticateStaffToken: createDriverAuditStaffProxy({ fetchImpl }),
    db: () => { throw Error('The Supabase report process does not use MongoDB'); },
    dependencies: { backend, store } });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/health' && ['GET', 'HEAD'].includes(request.method)) {
        const ready = await integration.prewarm();
        const head = ready ? await store.head() : null;
        response.writeHead(head ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ service: 'driver-reports',
          dataStore: 'supabase', executionHost: 'sidi', ready: Boolean(head),
          generation: head?.generation ?? null, reportHash: head?.reportHash ?? null,
          collectorRevision: head?.servingPackage?.collectorRevision ?? null,
          release: env.DRIVER_AUDIT_RELEASE_SHA ?? null }));
        return;
      }
      await integration(request, response, () => { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end(); });
    } catch {
      if (!response.headersSent) response.writeHead(503, { 'Cache-Control': 'no-store' });
      response.end();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.maxHeadersCount = 60;
  return { server, integration, async close() {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await backend.close?.();
  } };
}
