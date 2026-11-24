import '../loadEnv.js';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDriverAuditHttpServer } from '../services/driverAuditHttp.js';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);

async function main() {
  const expected = process.env.DRIVER_AUDIT_RELEASE_SHA;
  if (!/^[a-f0-9]{40}$/.test(expected || '') || process.argv.length !== 2) throw Error('A reviewed report release is required');
  const [head, dirty] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000 }),
    exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: appRoot, timeout: 5000 }),
  ]);
  if (head.stdout.trim() !== expected || dirty.stdout.trim()) throw Error('The reviewed report release changed');
  const service = await createDriverAuditHttpServer();
  await new Promise((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(5002, '127.0.0.1', resolve);
  });
  console.info('Driver Reports is serving from Supabase on its private app connection.');
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => service.server.closeAllConnections(), 35000);
    try { await service.close(); } finally { clearTimeout(timeout); }
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

main().catch(() => { console.error('Driver Reports could not start. Check its private release settings.'); process.exitCode = 1; });
