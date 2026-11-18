import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { checkDriverAuditSource } from './driverAuditSource.js';
import { readDriverAuditSourceConfig, readPrivateDriverAuditSource, runDriverAuditSourceChild } from '../services/driverAuditSource.js';
import { runDriverAuditSupabaseSync } from '../services/driverAuditSupabaseSync.js';

const requiredPaths = ['/api/collector?task=delivery', '/api/morning-gps', '/api/collector?task=gps-publish'];
const optionalPaths = ['/api/collector?task=photo-backlog', '/api/collector?task=photo-grade'];
const complete = new Set(['complete', 'not-due']);
const acceptedOptional = new Set([...complete, 'disabled', 'budget-exhausted', 'deferred']);

async function main(args) {
  const [configFlag, file, sourceFlag, sourceFile, mode] = args;
  if (configFlag !== '--config' || sourceFlag !== '--source' || !path.isAbsolute(file || '')
    || !path.isAbsolute(sourceFile || '') || args.length > 5 || ![undefined, '--check', '--seed-only'].includes(mode)) {
    throw Error('Use an exact private off-host sync and source configuration');
  }
  const config = JSON.parse(await readPrivateDriverAuditSource(file, 1024 * 1024));
  const source = await readDriverAuditSourceConfig(sourceFile);
  const env = source.environment;
  if (source.executionHost !== 'off-host' || source.dataStore !== 'supabase' || config.root !== path.dirname(file)
    || source.root !== path.join(config.root, 'collector', source.manifestSha256)
    || source.archiveCacheDirectory !== path.join(config.root, 'work', 'archive-cache')
    || env.MATTER_DELIVERY_ENABLED !== '1' || env.MATTER_GPS_ENABLED !== '1'
    || env.MATTER_GPS_PUBLICATION_ENABLED !== '1' || env.MATTER_PHOTO_READ_ENABLED !== '1') {
    throw Error('The qualified delivery, GPS and upload source for this off-host worker is required');
  }
  const paths = [...requiredPaths, ...optionalPaths];
  const entrypoints = paths.map(route => {
    const entries = source.runtime.entrypoints.filter(entry => entry.path === route);
    if (!entries.length) throw Error('A pinned off-host source handler is unavailable');
    return entries[0];
  });
  if (mode === '--check') await checkDriverAuditSource(source);
  return runDriverAuditSupabaseSync({ config, file, mode, env: {
    ...env, DRIVER_AUDIT_SUPABASE_SECRET: env.MATTER_SUPABASE_SECRET,
    DRIVER_AUDIT_ENABLED: mode === '--seed-only' ? '0' : '1', DRIVER_AUDIT_IMPORT_ENABLED: '0',
  }, async collectSource({ signal }) {
    for (const entrypoint of entrypoints) {
      signal?.throwIfAborted();
      const result = await runDriverAuditSourceChild(source, entrypoint, { signal });
      const allowed = requiredPaths.includes(entrypoint.path) ? complete : acceptedOptional;
      if (!allowed.has(result.status)) throw Error('The off-host source check did not finish');
    }
  } });
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    console.error('The off-host report worker is held. Check the private configuration and report proof.');
    process.exitCode = 1;
  });
}
