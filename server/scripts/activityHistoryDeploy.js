import '../loadEnv.js';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statfs, stat } from 'node:fs/promises';
import User from '../models/User.js';
import { configureActivityHistoryAccess } from '../services/activityDeployment.js';
import { configuredActivityReaders, hasActivityHistoryAccess } from '../observability/activityAccess.js';

let stage = 'configuration';
try {
const operation = process.argv[2];
if (!['--apply', '--verify'].includes(operation)) throw Error('Explicit --apply or --verify is required.');
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.MATTER_ACTIVITY_READERS_FILE && path.resolve(process.env.MATTER_ACTIVITY_READERS_FILE) !== path.join(serverRoot, '.private/activity-history/readers.json')) throw Error('Production history requires the release-owned reader configuration.');
if (process.env.MATTER_ACTIVITY_JOURNAL_DIR && !path.isAbsolute(process.env.MATTER_ACTIVITY_JOURNAL_DIR)) throw Error('The production journal directory must be absolute.');
if (!process.env.MONGODB_URI) throw Error('The existing app database configuration is required.');
stage = 'database';
await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  stage = 'host-preflight';
  const filesystem = await statfs(serverRoot);
  const freeDiskBytes = filesystem.bavail * filesystem.bsize;
  const database = await mongoose.connection.db.command({ dbStats: 1, scale: 1 });
  const host = { freeDiskBytes, databaseDataBytes: database.dataSize, databaseStorageBytes: database.storageSize };
  if (operation === '--apply') {
    stage = 'reader-setup';
    if (freeDiskBytes < 512 * 1024 * 1024) throw Error('Activity history needs available private journal space before activation.');
    const setup = await configureActivityHistoryAccess({
      serverRoot,
      emails: process.env.MATTER_ACTIVITY_READER_EMAILS,
      releaseSha: process.env.DEPLOY_SHA,
      findAccounts: emails => User.find({ email: { $in: emails } }).select('_id email role isActive').lean(),
    });
    console.log(JSON.stringify({ activityHistory: 'configured', ...setup, ...host }));
  } else {
    stage = 'reader-verification';
    const readerIds = configuredActivityReaders();
    if (readerIds.length !== 1) throw Error('Exactly one private history reader must be configured.');
    const accounts = await User.find({ isActive: true }).select('_id isActive role').lean();
    const allowed = accounts.filter(account => hasActivityHistoryAccess(account));
    if (allowed.length !== readerIds.length) throw Error('An approved history account is inactive or missing.');
    const port = Number(process.env.PORT || 5000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid app port.');
    const denied = await fetch(`http://127.0.0.1:${port}/api/traceability/activity`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (denied.status !== 401) throw Error('Unauthenticated history access was not denied.');
    const journal = await stat(process.env.MATTER_ACTIVITY_JOURNAL_DIR || path.join(serverRoot, '.activity-journal'));
    if (!journal.isDirectory() || (journal.mode & 0o077)) throw Error('The private activity journal is not ready.');
    const collection = mongoose.connection.db.collection('activity_audit_events');
    const latest = await collection.find({}, { projection: { occurredAt: 1, stage: 1, _id: 0 } }).sort({ occurredAt: -1 }).limit(1).toArray();
    console.log(JSON.stringify({ activityHistory: 'ready', readers: allowed.length, otherActiveAccountsDenied: accounts.length - allowed.length, unauthenticatedAccessDenied: true, retainedEvents: await collection.estimatedDocumentCount(), latest: latest[0] || null, ...host }));
  }
} catch {
  console.error(JSON.stringify({ activityHistory: 'failed', stage }));
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => { console.error('ACTIVITY_HISTORY_CONNECTION_CLOSE_FAILED'); process.exitCode = 1; });
}
