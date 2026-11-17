import '../loadEnv.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createDriverAuditMongoArchive } from '../services/driverAuditMongoArchive.js';
import { createDriverAuditTransferSessions, validateDriverAuditTransferPlan } from '../services/driverAuditTransferSession.js';
import { createDriverAuditTransferDownload } from '../services/driverAuditTransferDownload.js';
import { acquireWorkerLock } from '../vendor/driver-audits/integration/hosted/worker-lock.mjs';

const exec = promisify(execFile);

export function createDriverAuditTransferSpacesAdapter(env, { client } = {}) {
  if (!env.SPACES_KEY || !env.SPACES_SECRET || !env.SPACES_BUCKET) throw Error('Existing private Spaces connection required');
  const endpoint = new URL('https://' + (env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com').replace(/^https?:\/\//, ''));
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.digitaloceanspaces\.com$/.test(endpoint.hostname)
      || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash) {
    throw Error('Unexpected existing Spaces endpoint');
  }
  const s3 = client || new S3Client({ endpoint: endpoint.href, region: env.SPACES_REGION || endpoint.hostname.split('.')[0],
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.SPACES_KEY, secretAccessKey: env.SPACES_SECRET } });
  const object = id => ({ Bucket: env.SPACES_BUCKET, Key: '_driver_report_migration/' + id + '/transfer.enc' });
  return {
    async prepare(id, bytes) {
      const command = new PutObjectCommand({ ...object(id), ACL: 'private', ContentLength: bytes, ContentType: 'application/octet-stream' });
      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
      return { uploadUrl, headers: { 'content-type': 'application/octet-stream', 'x-amz-acl': 'private' }, expiresInSeconds: 3600 };
    },
    async head(id) { const value = await s3.send(new HeadObjectCommand(object(id)));
      return { bytes: value.ContentLength, etag: value.ETag, ...(value.VersionId === undefined ? {} : { versionId: value.VersionId }) }; },
    async read(id, signal, remote) {
      return createDriverAuditTransferDownload({ remote, signal,
        readRange: ({ start, end, etag, versionId, signal: attemptSignal }) => s3.send(new GetObjectCommand({ ...object(id),
          Range: `bytes=${start}-${end}`, IfMatch: etag, ...(versionId === undefined ? {} : { VersionId: versionId }) }),
        { abortSignal: attemptSignal }) });
    },
    async remove(id) { await s3.send(new DeleteObjectCommand(object(id))); },
    close() { s3.destroy(); },
  };
}

export async function runDriverAuditNativeTransfer({ operation, request, sessionId, expectedSha, appRoot = path.resolve('..') }) {
  const actual = (await exec('git', ['rev-parse', 'HEAD'], { cwd: appRoot, timeout: 5000 })).stdout.trim();
  if (process.platform !== 'linux' || !/^[a-f0-9]{40}$/.test(expectedSha || '') || actual !== expectedSha
      || !['prepare-transfer', 'receive-transfer'].includes(operation)) throw Error('Unexpected native transfer checkout or operation');
  const folder = path.join(appRoot, 'server/.private/driver-audit-native-transfer');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const lock = await acquireWorkerLock(path.join(folder, 'operator.lock'));
  let connection, spaces;
  try {
    const target = operation === 'prepare-transfer' ? validateDriverAuditTransferPlan(request)
      : JSON.parse(await fs.readFile(path.join(folder, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId || '')
        ? sessionId : 'invalid-session', 'session.private.json'), 'utf8'));
    connection = mongoose.createConnection(process.env.MONGODB_URI, {
      autoCreate: false, autoIndex: false, maxPoolSize: 2, serverSelectionTimeoutMS: 10000 });
    await connection.asPromise();
    const db = connection.db;
    if (db.databaseName !== target.targetDatabase) throw Error('Native transfer database differs');
    const archive = createDriverAuditMongoArchive({ db, client: connection.getClient(), capacityBytes: target.capacityBytes });
    spaces = createDriverAuditTransferSpacesAdapter(process.env);
    const canStage = async () => {
      const [authority, stage, processes] = await Promise.all([
        db.collection('driverAuditNativeControl').findOne({ _id: 'authority' }),
        db.collection('driverAuditControl').findOne({ _id: 'direct-stage' }),
        exec('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }),
      ]);
      const entries = JSON.parse(processes.stdout);
      const builder = entries.filter(row => row.name === 'matter-driver-audit-sync');
      const source = entries.filter(row => row.name === 'matter-driver-audit-source');
      if (authority?.status === 'active' || stage || builder.length !== 1 || builder[0].pm2_env?.status !== 'stopped'
          || source.some(row => row.pm2_env?.status !== 'stopped')) throw Error('Native transfer requires paused report writers and inactive authority');
      const capacity = await db.collection('driverAuditNativeControl').findOne({ _id: 'capacity' });
      if (capacity && capacity.limitBytes !== target.capacityBytes) throw Error('Native transfer allowance differs');
    };
    const sessions = createDriverAuditTransferSessions({ root: folder, targetDatabase: db.databaseName,
      capacityBytes: target.capacityBytes, archive, spaces, canStage });
    return operation === 'prepare-transfer' ? await sessions.prepare(request) : await sessions.receive(sessionId);
  } finally { spaces?.close(); await connection?.close(); await lock.release(); }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  const operation = process.env.NATIVE_HANDOFF_OPERATION;
  let request;
  try {
    if (operation === 'prepare-transfer') {
      const encoded = process.env.NATIVE_TRANSFER_PLAN_B64;
      if (!encoded || encoded.length > 24576 || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw Error('Bounded transfer plan required');
      request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    }
    console.log(JSON.stringify(await runDriverAuditNativeTransfer({ operation, request,
      sessionId: process.env.NATIVE_TRANSFER_SESSION_ID, expectedSha: process.env.EXPECTED_DEPLOYED_SHA,
      appRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..') })));
  } catch {
    console.error('Native transfer stopped. Check the reviewed target, paused writers, private session and original backup.');
    process.exitCode = 1;
  }
}
