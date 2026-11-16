import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const driverAuditSourceHash = value => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const minuteMs = 60_000;

function requireSource(condition, message) {
  if (!condition) throw new Error(message);
}

export async function readPrivateDriverAuditSource(file, maxBytes = 16 * 1024 * 1024) {
  requireSource(path.isAbsolute(file) && await fs.realpath(file) === file, 'A real private source path is required.');
  const stat = await fs.lstat(file);
  requireSource(stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid() && stat.size <= maxBytes,
    'Source files must be owner-private regular files within the size limit.');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    requireSource(opened.ino === stat.ino && opened.dev === stat.dev, 'Source file changed while reading.');
    const bytes = await handle.readFile();
    requireSource(bytes.length <= maxBytes, 'Source file exceeded its size limit.');
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function requirePrivateDriverAuditSourceDirectory(directory) {
  requireSource(path.isAbsolute(directory) && await fs.realpath(directory) === directory, 'A real private source directory is required.');
  const stat = await fs.lstat(directory);
  requireSource(stat.isDirectory() && !(stat.mode & 0o077) && stat.uid === process.getuid(),
    'Source directories must be owner-private.');
}

export async function writeDriverAuditSourceState(file, state) {
  await requirePrivateDriverAuditSourceDirectory(path.dirname(file));
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length <= 1024 && value.split('/').every(part =>
    part !== '.' && part !== '..' && /^[a-zA-Z0-9_.-]+$/.test(part));
}

function parseSchedule(schedule) {
  requireSource(typeof schedule === 'string' && schedule.length <= 64, 'Invalid source schedule.');
  const fields = schedule.split(' ');
  requireSource(fields.length === 5, 'Invalid source schedule.');
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.map((field, index) => {
    const [minimum, maximum] = ranges[index];
    const values = new Set();
    for (const item of field.split(',')) {
      const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(item);
      requireSource(match, 'Invalid source schedule.');
      const step = match[2] === undefined ? 1 : Number(match[2]);
      const bounds = match[1] === '*' ? [minimum, maximum] : match[1].split('-').map(Number);
      const [start, end = match[2] === undefined ? start : maximum] = bounds;
      requireSource(step >= 1 && step <= maximum - minimum + 1 && start >= minimum && end <= maximum && start <= end,
        'Invalid source schedule.');
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return { values, wildcard: field.startsWith('*') };
  });
}

export function sourceScheduleMatches(schedule, date) {
  requireSource(date instanceof Date && Number.isFinite(date.getTime()), 'Invalid source schedule time.');
  const fields = parseSchedule(schedule);
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  const matches = fields.map((field, index) => field.values.has(values[index]));
  const dayMatches = fields[2].wildcard || fields[4].wildcard ? matches[2] && matches[4] : matches[2] || matches[4];
  return matches[0] && matches[1] && matches[3] && dayMatches;
}

export async function verifyDriverAuditSource({ runtimeRoot, expectedSha256 }) {
  requireSource(hashPattern.test(expectedSha256 ?? ''), 'A pinned source manifest is required.');
  await requirePrivateDriverAuditSourceDirectory(runtimeRoot);
  const manifestBytes = await readPrivateDriverAuditSource(path.join(runtimeRoot, 'manifest.private.json'));
  requireSource(driverAuditSourceHash(manifestBytes) === expectedSha256, 'Source manifest integrity failure.');
  const manifest = JSON.parse(manifestBytes);
  requireSource(manifest.schemaVersion === 1 && Array.isArray(manifest.files) && manifest.files.length > 0
    && manifest.files.length <= 4096 && Array.isArray(manifest.entrypoints) && manifest.entrypoints.length > 0
    && manifest.entrypoints.length <= 128, 'Invalid source manifest.');
  const declared = new Set();
  for (const file of manifest.files) {
    requireSource(safeRelativePath(file.path) && file.path.startsWith('source/'), 'Invalid source file path.');
    requireSource(!declared.has(file.path) && hashPattern.test(file.sha256 ?? '')
      && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 16 * 1024 * 1024, 'Invalid source file identity.');
    declared.add(file.path);
    const bytes = await readPrivateDriverAuditSource(path.join(runtimeRoot, file.path));
    requireSource(bytes.length === file.bytes && driverAuditSourceHash(bytes) === file.sha256, 'Source file integrity failure.');
  }
  async function checkDirectory(directory) {
    await requirePrivateDriverAuditSourceDirectory(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await checkDirectory(file);
      else requireSource(entry.isFile() && declared.has(path.relative(runtimeRoot, file).split(path.sep).join('/')),
        'Unlisted source file or symlink in runtime.');
    }
  }
  await checkDirectory(path.join(runtimeRoot, 'source'));
  const ids = new Set();
  for (const entry of manifest.entrypoints) {
    requireSource(typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) && !ids.has(entry.id),
      'Invalid or duplicate source schedule identity.');
    ids.add(entry.id);
    requireSource(declared.has(entry.module) && /\.mjs$/.test(entry.module) && entry.exportName === 'default'
      && entry.method === 'GET' && entry.timeZone === 'UTC' && typeof entry.path === 'string'
      && entry.path.startsWith('/api/') && !entry.path.startsWith('//') && !/[\s#\\]/.test(entry.path)
      && Number.isSafeInteger(entry.maxDurationSeconds) && entry.maxDurationSeconds > 0 && entry.maxDurationSeconds <= 300
      && Array.isArray(entry.requiredEnvironment) && entry.requiredEnvironment.every(key => /^[A-Z][A-Z0-9_]*$/.test(key)),
    'Invalid source schedule handler.');
    parseSchedule(entry.schedule);
  }
  return { ...manifest, manifestSha256: expectedSha256 };
}

async function readPinnedJson(reference, label) {
  requireSource(reference && hashPattern.test(reference.sha256 ?? '') && path.isAbsolute(reference.path ?? ''),
    `A pinned ${label} file is required.`);
  const bytes = await readPrivateDriverAuditSource(reference.path);
  requireSource(driverAuditSourceHash(bytes) === reference.sha256, `${label} integrity failure.`);
  return JSON.parse(bytes);
}

export const DRIVER_AUDIT_SOURCE_CACHE_ENV = 'MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY';

export function driverAuditSourceDataStore(files, environment) {
  const kind = environment.DRIVER_AUDIT_DATA_STORE || 'supabase';
  requireSource(['supabase', 'mongo'].includes(kind), 'Unknown source reporting data store.');
  if (kind === 'mongo') {
    requireSource(files.some(file => file.path === 'source/integration/hosted/native-backend.mjs'),
      'The source runtime does not support the app native data store.');
    requireSource(environment.MONGODB_URI === undefined && environment.DRIVER_AUDIT_NATIVE_CAPACITY_BYTES === undefined,
      'Native source jobs use the app database connection and storage allowance.');
  }
  return kind;
}

export function driverAuditSourceArchiveCacheDirectory(root, files, environment) {
  const directory = environment[DRIVER_AUDIT_SOURCE_CACHE_ENV];
  const supportsCache = files.some(file => file.path === 'source/integration/hosted/archive-read-cache.mjs');
  if (!supportsCache && directory === undefined) return null;
  const privateRoot = path.dirname(path.dirname(root));
  const parts = typeof directory === 'string' && path.isAbsolute(directory)
    ? path.relative(privateRoot, directory).split(path.sep) : [];
  requireSource(supportsCache && parts.length === 4 && parts[0] === 'driver-audits'
    && hashPattern.test(parts[1]) && parts[2] === 'work' && parts[3] === 'archive-cache'
    && directory === path.join(privateRoot, ...parts), 'Use the managed builder archive cache directory.');
  return directory;
}

export async function readDriverAuditSourceConfig(file) {
  const bytes = await readPrivateDriverAuditSource(file);
  const config = JSON.parse(bytes);
  requireSource(config.version === 1 && path.dirname(file) === config.root && path.basename(file) === 'source.json'
    && config.runtimeRoot === path.join(config.root, 'runtime') && config.nodeVersion === process.version,
  'Source configuration or the qualified Node version changed.');
  requireSource(typeof config.nodeExecutable === 'string' && path.isAbsolute(config.nodeExecutable),
    'An exact source Node executable is required.');
  let actualExecutable;
  try { actualExecutable = await fs.realpath(config.nodeExecutable); } catch { throw new Error('The qualified Node executable is unavailable.'); }
  requireSource(actualExecutable === await fs.realpath(process.execPath), 'Source Node executable differs from the qualified path.');
  await requirePrivateDriverAuditSourceDirectory(config.root);
  const runtime = await verifyDriverAuditSource({ runtimeRoot: config.runtimeRoot, expectedSha256: config.manifestSha256 });
  const environment = await readPinnedJson(config.environment, 'source environment');
  requireSource(environment && typeof environment === 'object' && !Array.isArray(environment)
    && Object.entries(environment).every(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key)
      && typeof value === 'string' && value.length <= 16384 && !value.includes('\0')),
  'Invalid source environment.');
  const archiveCacheDirectory = driverAuditSourceArchiveCacheDirectory(config.root, runtime.files, environment);
  const dataStore = driverAuditSourceDataStore(runtime.files, environment);
  // Runtime configuration contains source credentials only. Node loader and
  // process options remain controlled by the app's supervised runner.
  requireSource(!Object.keys(environment).some(key => ['NODE_OPTIONS', 'NODE_PATH', 'PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'].includes(key)),
    'Source environment contains process configuration.');
  requireSource(!Object.keys(environment).some(key => key.includes('OIDC')), 'Stored OIDC credentials are not accepted.');
  requireSource(typeof environment.CRON_SECRET === 'string' && environment.CRON_SECRET.length >= 32,
    'Source worker authentication is required.');
  for (const entry of runtime.entrypoints) {
    requireSource(entry.requiredEnvironment.every(key => typeof environment[key] === 'string' && environment[key].length > 0),
      'Source environment is missing a declared value.');
  }
  const switches = ['MATTER_DELIVERY_ENABLED', 'MATTER_PHOTO_READ_ENABLED', 'MATTER_PHOTO_GRADE_ENABLED', 'MATTER_GPS_ENABLED', 'MATTER_GPS_PUBLICATION_ENABLED'];
  requireSource(switches.every(key => environment[key] === undefined || ['0', '1'].includes(environment[key])), 'Invalid source switch value.');
  let gatewayCredential = null;
  if (config.gatewayCredential !== null && config.gatewayCredential !== undefined) {
    requireSource(config.gatewayCredential.environmentKey === 'AI_GATEWAY_API_KEY'
      && typeof environment.AI_GATEWAY_API_KEY === 'string' && environment.AI_GATEWAY_API_KEY.length > 0,
    'A private Gateway API key is required.');
    gatewayCredential = environment.AI_GATEWAY_API_KEY;
  }
  requireSource(environment.MATTER_PHOTO_GRADE_ENABLED !== '1' || gatewayCredential,
    'Enabled photo grading requires a qualified Gateway credential.');
  return { ...config, file, configSha256: driverAuditSourceHash(bytes), runtime,
    environmentReference: config.environment, environment, gatewayCredential, archiveCacheDirectory, dataStore };
}

export async function verifyDriverAuditSourceRelease(config, reference, now = new Date()) {
  const release = await readPinnedJson(reference, 'source release receipt');
  const verifiedAt = Date.parse(release.verifiedAt);
  const expires = Date.parse(release.validUntil);
  requireSource(release.version === 1 && release.verified === true && release.configSha256 === config.configSha256
    && release.runtimeManifestSha256 === config.manifestSha256 && release.environmentSha256 === config.environmentReference.sha256
    && release.nodeVersion === config.nodeVersion && typeof release.initialCursor === 'string'
    && Number.isFinite(Date.parse(release.initialCursor)) && Date.parse(release.initialCursor) % minuteMs === 0
    && Date.parse(release.initialCursor) <= verifiedAt,
  'Source release receipt does not match the qualified configuration.');
  requireSource(Number.isFinite(verifiedAt) && Number.isFinite(expires) && expires > verifiedAt && expires - verifiedAt <= 30 * minuteMs
    && now.getTime() >= verifiedAt && now.getTime() < expires, 'Source release fence is expired or not fresh.');
  for (const kind of ['backup', 'parity', 'credentials', 'sourceFence']) {
    const saved = release[kind];
    const receiptReference = typeof saved?.path === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.private\.json$/.test(saved.path)
      ? { ...saved, path: path.join(path.dirname(reference.path), saved.path) } : saved;
    const receipt = await readPinnedJson(receiptReference, kind + ' receipt');
    requireSource(receipt.version === 1 && receipt.verified === true, `The ${kind} receipt is not verified.`);
    if (kind === 'sourceFence') {
      requireSource(receipt.writersStopped === true && receipt.leasesDrained === true
        && receipt.initialCursor === release.initialCursor && Date.parse(receipt.validUntil) >= expires,
      'The source fence does not match the stopped and drained writers.');
    }
  }
  return { release, sha256: reference.sha256 };
}

export async function invokeDriverAuditSourceHandler(handler, { entrypoint, environment, gatewayCredential }) {
  requireSource(typeof handler === 'function' && typeof environment.CRON_SECRET === 'string'
    && environment.CRON_SECRET.length >= 32, 'Source handler configuration is invalid.');
  const headers = {
    authorization: 'Bearer ' + environment.CRON_SECRET,
    'user-agent': 'vercel-cron/1.0',
    'x-vercel-cron-schedule': entrypoint.schedule,
  };
  if (gatewayCredential) {
    requireSource(typeof gatewayCredential === 'string' && gatewayCredential.length <= 12000
      && !/[\x00-\x20\x7f]/.test(gatewayCredential), 'Source Gateway credential is invalid.');
    headers['x-vercel-oidc-token'] = gatewayCredential;
  }
  const request = { method: entrypoint.method, url: entrypoint.path, headers };
  let statusCode = 200;
  let ended = false;
  const chunks = [];
  let length = 0;
  const response = {
    headersSent: false,
    writeHead(code) { statusCode = code; this.headersSent = true; return this; },
    end(body = '') {
      requireSource(!ended, 'Source handler ended twice.');
      ended = true;
      const bytes = Buffer.from(body);
      length += bytes.length;
      requireSource(length <= 1024 * 1024, 'Source handler response exceeded its limit.');
      chunks.push(bytes);
    },
    destroy() { throw new Error('Source handler response was interrupted.'); },
  };
  await handler(request, response);
  requireSource(ended && statusCode >= 200 && statusCode < 300, 'Source handler failed.');
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Source handler response is invalid.'); }
  const safeStatuses = new Set(['disabled', 'not-due', 'complete', 'needs-inspection', 'budget-exhausted', 'unavailable', 'deferred', 'needs_recovery']);
  requireSource(safeStatuses.has(body?.status), 'Source handler status is invalid.');
  const result = { httpStatus: statusCode, status: body.status };
  for (const key of ['collected', 'failed', 'completed', 'pending', 'completedWindows', 'pendingWindows', 'failedWindows', 'sourceRevision', 'revision']) {
    if (Number.isSafeInteger(body[key]) && body[key] >= 0) result[key] = body[key];
  }
  const reasons = ['collector-lease-busy', 'publication-contended', 'source-paused', 'source-changed', 'source_backoff',
    'outside_delivery_hours', 'no-work-completed', 'byte-limit'];
  if (reasons.includes(body.reason)) result.reason = body.reason;
  if (['retained', 'settled'].includes(body.budgetSettlement)) result.budgetSettlement = body.budgetSettlement;
  return result;
}

export function runDriverAuditSourceChild(config, entrypoint, { probe = false, signal, onAdmission = async () => {} } = {}) {
  const script = fileURLToPath(new URL('../scripts/driverAuditSource.js', import.meta.url));
  return new Promise((resolve, reject) => {
    // Do not inherit app secrets, NODE_OPTIONS or the operator's environment.
    const env = Object.fromEntries(['HOME', 'LANG', 'LC_ALL', 'TZ'].filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]]));
    const child = fork(script, ['--config', config.file, '--child'], {
      cwd: config.runtimeRoot, env, execArgv: ['--max-old-space-size=3072'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let result;
    let timedOut = false;
    let dispatched = false;
    let admitted = probe;
    let cancelled = false;
    let admissionError;
    let timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    const abort = () => {
      if (!admitted) { cancelled = true; child.kill('SIGTERM'); }
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => reject(new Error('Source child could not start.')));
    child.on('message', value => {
      if (value?.version === 1 && value.ready === true && !dispatched) {
        if (cancelled) return;
        dispatched = true;
        if (!probe) clearTimeout(timer);
        child.send({ version: 1, configSha256: config.configSha256, id: entrypoint.id, probe }, error => {
          if (error) child.kill('SIGKILL');
        });
      }
      if (value?.version === 1 && value.admitted === true && !cancelled) {
        admitted = true;
        timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, entrypoint.maxDurationSeconds * 1000);
        Promise.resolve(onAdmission()).then(() => {
          if (child.connected) child.send({ version: 1, run: true });
        }).catch(error => { admissionError = error; child.kill('SIGKILL'); });
      }
      if (value?.version === 1 && value.ok === true && value.id === entrypoint.id
        && Number.isInteger(value.result?.httpStatus) && typeof value.result?.status === 'string') result = value.result;
    });
    child.once('exit', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (cancelled) reject(Object.assign(new Error('Source admission cancelled.'), { code: 'AUDIT_ADMISSION_CANCELLED' }));
      else if (admissionError) reject(admissionError);
      else if (timedOut) reject(new Error('Source child exceeded its execution time.'));
      else if (code !== 0 || !result) reject(new Error('Source child execution failed.'));
      else resolve(result);
    });
    if (signal?.aborted) abort();
  });
}

export async function createDriverAuditSourceScheduler({ entrypoints, stateFile, configSha256, initialCursor, invoke }) {
  requireSource(hashPattern.test(configSha256 ?? '') && typeof invoke === 'function', 'Invalid source scheduler configuration.');
  let state;
  try { state = JSON.parse(await readPrivateDriverAuditSource(stateFile)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) % minuteMs === 0;
  if (state) {
    requireSource(state.version === 1 && state.configSha256 === configSha256 && validTime(state.lastScanAt)
      && state.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs), 'Saved source schedule state differs from its configuration.');
    if (initialCursor !== undefined) {
      requireSource(validTime(initialCursor), 'A fenced initial source schedule cursor is required.');
      if (Date.parse(initialCursor) > Date.parse(state.lastScanAt)) {
        state.lastScanAt = initialCursor;
        state.pending = (state.pending ?? []).filter(item => Date.parse(item.scheduledAt) > Date.parse(initialCursor));
      }
    }
  } else {
    requireSource(validTime(initialCursor), 'A fenced initial source schedule cursor is required.');
    state = { version: 1, configSha256, lastScanAt: initialCursor, missedMinutes: 0, jobs: {}, pending: [] };
  }
  state.pending ??= [];
  const knownIds = new Set(entrypoints.map(entry => entry.id));
  requireSource(Array.isArray(state.pending) && state.pending.every(item => knownIds.has(item.id) && validTime(item.scheduledAt)),
    'Saved pending source schedule is invalid.');
  requireSource(new Set(state.pending.map(item => item.id + ':' + item.scheduledAt)).size === state.pending.length,
    'Saved pending source schedule has duplicate claims.');
  for (const [id, job] of Object.entries(state.jobs)) {
    if (job.status === 'running') {
      job.status = 'interrupted';
      state.pending = state.pending.filter(item => item.scheduledAt !== job.scheduledAt || item.id !== id);
    }
  }
  await writeDriverAuditSourceState(stateFile, state);
  let active;
  let stopped = false;
  let persistenceError;
  let queue = Promise.resolve();
  const cancellation = new AbortController();
  const enqueue = operation => {
    const result = queue.then(() => {
      if (persistenceError) throw persistenceError;
      return operation();
    });
    queue = result.catch(error => { persistenceError = error; stopped = true; });
    return result;
  };
  const save = () => writeDriverAuditSourceState(stateFile, state);
  async function dispatch() {
    while (!stopped && state.pending.length > 0) {
      const claim = state.pending[0];
      const entry = entrypoints.find(item => item.id === claim.id);
      await enqueue(async () => {
        state.jobs[claim.id] = { scheduledAt: claim.scheduledAt, status: 'waiting' };
        await save();
      });
      let outcome;
      let admitted = false;
      try {
        outcome = await invoke(entry, { scheduledAt: claim.scheduledAt, signal: cancellation.signal,
          onAdmission: () => enqueue(async () => {
            state.jobs[claim.id] = { scheduledAt: claim.scheduledAt, status: 'running' };
            state.pending.shift();
            await save();
            admitted = true;
          }) });
      } catch (error) {
        if (error.code === 'AUDIT_ADMISSION_CANCELLED' && stopped) break;
        outcome = { status: 'failed' };
      }
      await enqueue(async () => {
        state.jobs[claim.id] = { scheduledAt: claim.scheduledAt, ...outcome };
        if (!admitted) state.pending.shift();
        await save();
      });
    }
  }
  const kick = () => {
    if (active || stopped || state.pending.length === 0) return;
    active = dispatch().catch(error => { persistenceError = error; stopped = true; }).finally(() => { active = null; });
  };
  return {
    stop() { stopped = true; cancellation.abort(); },
    async drain() {
      await active;
      await queue;
      if (persistenceError) throw persistenceError;
    },
    snapshot() { return structuredClone(state); },
    async tick(now = new Date()) {
      await enqueue(async () => {
        if (stopped) return;
        const current = Math.floor(now.getTime() / minuteMs) * minuteMs;
        const previous = Date.parse(state.lastScanAt);
        requireSource(Number.isFinite(current) && current >= previous, 'Source schedule clock moved backwards.');
        if (current === previous) return;
        state.missedMinutes = (state.missedMinutes ?? 0) + Math.max(0, (current - previous) / minuteMs - 1);
        state.lastScanAt = new Date(current).toISOString();
        for (const entry of entrypoints) {
          if (!sourceScheduleMatches(entry.schedule, new Date(current))) continue;
          state.pending.push({ id: entry.id, scheduledAt: state.lastScanAt });
        }
        await save();
      });
      kick();
    },
  };
}
