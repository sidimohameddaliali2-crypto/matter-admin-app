import { createDriverAuditHttpServer } from '../services/driverAuditHttp.js';

const key = process.env.DRIVER_AUDIT_READER_KEY;
const staffPort = Number(process.env.DRIVER_AUDIT_READER_STAFF_PORT);

async function main() {
  if (typeof process.send !== 'function' || !process.connected || !/^[A-Za-z0-9_-]{43}$/.test(key ?? '')
    || process.argv.length !== 2 || !Number.isInteger(staffPort) || staffPort < 1 || staffPort > 65535) {
    throw Error('The app-controlled report reader is required');
  }

  let service, stopping = false;
  const close = async () => {
    if (stopping) return;
    stopping = true;
    if (!service) return process.exit(0);
    const timer = setTimeout(() => service.server.closeAllConnections(), 5000);
    try { await service.close(); } finally { clearTimeout(timer); }
    if (process.connected) process.disconnect();
  };
  process.once('disconnect', close);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);

  service = await createDriverAuditHttpServer({ env: { ...process.env, DRIVER_AUDIT_SERVING_STORE: 'supabase',
    DRIVER_AUDIT_EXECUTION_HOST: 'sidi', DRIVER_AUDIT_DATA_STORE: 'supabase', DRIVER_AUDIT_ENABLED: '1',
    DRIVER_AUDIT_IMPORT_ENABLED: '0' }, ingressKey: key, staffPort });
  if (stopping || !process.connected) return close();
  await new Promise((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(0, '127.0.0.1', resolve);
  });
  process.send({ ready: true, port: service.server.address().port });
}

main().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
