import { execFile } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';

const exec = promisify(execFile);
const service = 'matter-delivery-api';
const webhookUrl = 'https://trhhjfgfmxofxhnzocks.supabase.co/functions/v1/driver-reports-webhook';
const start = '# BEGIN MATTER DRIVER REPORTING PREVIEW';
const end = '# END MATTER DRIVER REPORTING PREVIEW';
const oidc = 'MATTER_REPORTING_VERCEL_OIDC_ENABLED';
const productionOidc = 'MATTER_REPORTING_VERCEL_OIDC_PRODUCTION_ENABLED';
const capture = 'MATTER_REPORTING_CAPTURE_ENABLED';
const emitter = 'MATTER_REPORTING_EMITTER_ENABLED';
const urlKey = 'MATTER_REPORTING_WEBHOOK_URL';
const secretKey = 'MATTER_REPORTING_WEBHOOK_SECRET';
const managed = new Set([oidc, capture, emitter, urlKey, secretKey]);
const limit = 256 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const modes = new Set(['inspect', 'stage', 'enable', 'disable']);
const allowedSecret = /^[A-Za-z0-9_-]{32,128}$/;
const criticalFiles = ['server/server.js', 'server/loadEnv.js', 'server/package.json', 'server/package-lock.json',
  'server/routes/externalReportingApi.js', 'server/middleware/reportingVercelIdentity.js',
  'server/services/reportingOutbox.js', 'server/models/ReportingOutbox.js'];

const requireState = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { operatorCode: code }); };
const configuration = env => ({ previewIdentity: env[oidc] === '1', capture: env[capture] === '1', emitter: env[emitter] === '1' });
const statPin = ({ dev, ino, size, mode, uid, gid, mtimeMs, ctimeMs }) => ({ dev, ino, size, mode, uid, gid, mtimeMs, ctimeMs });

export async function readEnvironmentSnapshot(file) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const info = await handle.stat();
    requireState(info.isFile() && info.nlink === 1 && info.uid === process.getuid() && !(info.mode & 0o022)
      && info.size <= limit, 'unsafe-environment-file');
    const pin = statPin(info);
    const bytes = await handle.readFile();
    requireState(bytes.length === info.size && isDeepStrictEqual(pin, statPin(await handle.stat()))
      && isDeepStrictEqual(pin, statPin(await lstat(file))), 'environment-changed');
    return { pin, bytes };
  } finally { await handle.close(); }
}

export function managedSettings(bytes, mode, signingSecret, parse) {
  requireState(['stage', 'enable', 'disable'].includes(mode), 'invalid-operation');
  const config = { [oidc]: mode === 'disable' ? '0' : '1', [capture]: '0', [emitter]: '0' };
  if (mode === 'enable') {
    requireState(allowedSecret.test(signingSecret ?? ''), 'missing-or-invalid-signing-value');
    Object.assign(config, { [capture]: '1', [emitter]: '1', [urlKey]: webhookUrl, [secretKey]: signingSecret });
  }
  const text = decoder.decode(bytes);
  const sections = new RegExp(`^${start}\\r?\\n[\\s\\S]*?^${end}(?:\\r?\\n|$)`, 'gm');
  const starts = text.split(start).length - 1;
  const ends = text.split(end).length - 1;
  const blocks = [...text.matchAll(sections)];
  requireState(starts === ends && starts === blocks.length && starts <= 1, 'ambiguous-managed-settings');
  if (blocks.length) {
    const [, ...entries] = blocks[0][0].split(/\r?\n/).filter(Boolean);
    entries.pop();
    requireState(entries.every(line => managed.has(line.split('=', 1)[0]) && line.includes('=')), 'unexpected-managed-settings');
  }
  const base = text.replace(sections, '');
  const separator = text.includes('\r\n') ? '\r\n' : '\n';
  const prefix = base && !base.endsWith('\n') ? base + separator : base;
  const output = Buffer.from(prefix + [start, ...Object.entries(config).map(pair => pair.join('=')), end, ''].join(separator));
  const before = parse(bytes);
  const after = parse(output);
  requireState(output.length <= limit && Object.entries(config).every(([key, value]) => after[key] === value)
    && isDeepStrictEqual(Object.fromEntries(Object.entries(before).filter(([key]) => !managed.has(key))),
      Object.fromEntries(Object.entries(after).filter(([key]) => !managed.has(key)))), 'unrelated-environment-would-change');
  return output;
}

async function put(file, expected, bytes, mode = 0o600) {
  const tmp = `${file}.reporting-${randomUUID()}`;
  let exists = false;
  try {
    if (bytes) {
      const handle = await open(tmp, 'wx', 0o600);
      exists = true;
      try {
        await handle.writeFile(bytes);
        await handle.chmod(mode);
        await handle.sync();
      } finally { await handle.close(); }
    }
    requireState(isDeepStrictEqual(await readEnvironmentSnapshot(file), expected), 'environment-changed');
    if (!bytes) await unlink(file);
    else {
      await rename(tmp, file);
      exists = false;
    }
  } finally {
    if (exists) await unlink(tmp);
  }
}

export async function confirmWebhookSecret(secret, { fetchImpl = fetch, now = Date.now } = {}) {
  requireState(allowedSecret.test(secret ?? ''), 'missing-or-invalid-signing-value');
  const timestamp = String(Math.floor(now() / 1000));
  // A valid signature on a deliberately invalid event reaches the parser only.
  // The receiver never queues an event from this request.
  const body = '{}';
  const digest = createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
  const res = await fetchImpl(webhookUrl, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(6000), body,
    headers: { 'Content-Type': 'application/json', 'x-matter-timestamp': timestamp, 'x-matter-signature': 'sha256=' + digest } });
  if (res.status !== 400 || !res.body || !res.headers.get('content-type')?.startsWith('application/json')) {
    await res.body?.cancel().catch(() => {});
    throw Object.assign(new Error('webhook-signature-not-verified'), { operatorCode: 'webhook-signature-not-verified' });
  }
  const chunks = [];
  let bytes = 0;
  for await (const part of res.body) {
    bytes += part.length;
    requireState(bytes <= 1024, 'invalid-webhook-probe-response');
    chunks.push(part);
  }
  requireState(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.status === 'invalid-event', 'webhook-signature-not-verified');
}

async function databaseProbe(uri, testTransaction) {
  const { default: mongoose } = await import('mongoose');
  const { inspectReportingMongoTopology, withReportingEvents, readReportingWatermark } = await import('../services/reportingOutbox.js');
  try {
    await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000,
      maxPoolSize: 2, connectTimeoutMS: 5000, socketTimeoutMS: 12000, ssl: true,
      tlsAllowInvalidCertificates: true, tlsAllowInvalidHostnames: true }); // Matches the running driver's Mongo connection.
    const topology = await inspectReportingMongoTopology();
    if (!testTransaction) return topology;
    requireState(topology.writable, 'mongo-transactions-unavailable');
    const savedFlag = process.env[capture];
    const abort = new Error('aborted-qualification');
    const subject = 'preview-rollback-probe-' + randomUUID();
    const before = await readReportingWatermark();
    process.env[capture] = '1'; // Only this diagnostic process. The driver API's capture is still off.
    try {
      await withReportingEvents(async (_session, enqueue) => {
        const events = await enqueue('delivery.changed', [subject]);
        requireState(events?.length === 1, 'outbox-transaction-not-exercised');
        throw abort;
      });
      requireState(false, 'outbox-transaction-not-aborted');
    } catch (error) { if (error !== abort) throw error; }
    finally {
      if (savedFlag === undefined) delete process.env[capture];
      else process.env[capture] = savedFlag;
    }
    requireState(await readReportingWatermark() === before, 'outbox-watermark-changed');
    const { ReportingOutbox } = await import('../models/ReportingOutbox.js');
    requireState(!await ReportingOutbox.exists({ subjectId: subject }).read('primary').readConcern('majority'), 'outbox-transaction-not-aborted');
    return { ...topology, rollbackChecked: true };
  } finally { await mongoose.disconnect(); }
}

export async function replaceAndRestart({ file, previous, bytes, verifyHost, restartAndVerify }) {
  await verifyHost();
  await put(file, previous, bytes);
  let installed;
  try {
    installed = await readEnvironmentSnapshot(file);
    requireState(installed?.bytes.equals(bytes), 'environment-changed');
    await restartAndVerify();
  } catch {
    try {
      requireState(installed?.bytes.equals(bytes), 'environment-changed');
      await put(file, installed, previous?.bytes, previous ? previous.pin.mode & 0o777 : 0o600);
      await restartAndVerify();
    } catch { requireState(false, 'rollback-needs-operator'); }
    requireState(false, 'settings-rolled-back');
  }
}

async function run(mode, expectedSha) {
  requireState(process.platform === 'linux' && modes.has(mode) && /^[a-f0-9]{40}$/.test(expectedSha ?? ''), 'invalid-operation');
  const appRoot = await realpath(process.cwd());
  const server = path.join(appRoot, 'server');
  requireState(await realpath(server) === server, 'unexpected-app-root');
  const childEnv = { ...process.env };
  delete childEnv[secretKey];
  const command = (commandName, args, timeout = 6000) =>
    exec(commandName, args, { cwd: appRoot, env: childEnv, timeout, maxBuffer: 4 * 1024 * 1024 });
  const checkout = async () => {
    requireState((await command('git', ['rev-parse', 'HEAD'])).stdout.trim() === expectedSha, 'deployed-revision-mismatch');
    await command('git', ['diff', '--quiet', expectedSha, '--', ...criticalFiles]);
  };
  const currentProcess = async () => {
    const rows = JSON.parse((await command('pm2', ['jlist'])).stdout).filter(row => row?.name === service);
    const row = rows[0];
    const settings = row?.pm2_env;
    requireState(rows.length === 1 && row?.pid > 0 && settings?.status === 'online' && settings.pm_cwd === appRoot
      && isDeepStrictEqual(settings.args, ['start', '--prefix', 'server']), 'driver-process-not-ready');
    return { instance: [row.pid, settings.pm_uptime], inherited: settings };
  };
  await checkout();
  const active = await currentProcess();
  const dotenv = (await import('dotenv')).default;
  const envPath = path.join(server, '.env');
  const file = path.join(server, '.env.local');
  const base = await readEnvironmentSnapshot(envPath);
  const previous = await readEnvironmentSnapshot(file);
  const baseVars = dotenv.parse(base?.bytes ?? Buffer.alloc(0));
  const local = dotenv.parse(previous?.bytes ?? Buffer.alloc(0));
  const effective = {};
  for (const name of [...managed, productionOidc, 'MONGODB_URI', 'PORT']) {
    const values = [...new Set([active.inherited.env?.[name], active.inherited[name]].filter(value => value !== undefined))];
    requireState(Object.hasOwn(local, name) || values.length <= 1, 'ambiguous-driver-environment');
    effective[name] = local[name] ?? values[0] ?? baseVars[name];
  }
  const port = String(effective.PORT || '5000');
  requireState(/^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535, 'invalid-driver-port');
  const health = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    requireState(res.status === 200 && body.success === true && body.database === 'connected', 'driver-health-check-failed');
  };
  await health();
  const flags = configuration(effective);
  requireState(mode === 'inspect' || effective[productionOidc] !== '1', 'production-reporting-already-enabled');
  requireState(mode !== 'stage' || (!flags.capture && !flags.emitter), 'capture-already-present');
  requireState(mode !== 'enable' || (flags.previewIdentity && flags.capture === flags.emitter), 'prepare-preview-identity-first');
  const secret = process.env[secretKey];
  if (mode === 'enable') await confirmWebhookSecret(secret);
  const testTransaction = mode === 'enable' && !flags.capture;
  requireState(mode === 'disable' || typeof effective.MONGODB_URI === 'string' && effective.MONGODB_URI.length > 0,
    'driver-database-config-missing');
  const topology = mode === 'disable' ? null : await databaseProbe(effective.MONGODB_URI, testTransaction);
  requireState(mode !== 'enable' || topology?.writable, 'mongo-transactions-unavailable');
  const state = { appliedSha: expectedSha, driverApiHealthy: true, mongo: topology };
  if (mode === 'inspect') return { ...state, status: 'inspected', ...flags };
  const bytes = managedSettings(previous?.bytes ?? Buffer.alloc(0), mode, secret, dotenv.parse);
  const nextFlags = configuration(dotenv.parse(bytes));
  if (previous?.bytes.equals(bytes) && !(previous.pin.mode & 0o077)) {
    return { ...state, status: 'already-configured', ...nextFlags };
  }
  const lock = path.join(server, '.matter-reporting-source-operator.lock');
  const handle = await open(lock, 'wx', 0o600);
  try {
    await replaceAndRestart({ file, previous, bytes, verifyHost: async () => {
      await checkout();
      requireState(isDeepStrictEqual((await currentProcess()).instance, active.instance)
        && isDeepStrictEqual(await readEnvironmentSnapshot(envPath), base), 'driver-runtime-changed');
      await health();
    }, restartAndVerify: async () => {
      await command('pm2', ['restart', service], 20000);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          requireState(!isDeepStrictEqual((await currentProcess()).instance, active.instance), 'driver-did-not-restart');
          await health();
          return;
        } catch { await wait(1000); }
      }
      requireState(false, 'driver-health-check-failed');
    } });
  } finally {
    await handle.close();
    await unlink(lock);
  }
  return { ...state, status: mode === 'stage' ? 'staged' : mode === 'enable' ? 'enabled' : 'disabled', ...nextFlags };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    requireState(args.length === 2, 'invalid-operation');
    console.log(JSON.stringify(await run(...args)));
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', reason: error.operatorCode || 'host-preflight-failed' }));
    process.exitCode = 1;
  }
}
