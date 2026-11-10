// Owner-run, read-only Linux diagnostic. Never imports the app, runs PM2, or
// opens a database/provider connection. Output is an allowlist, not an env dump.
// Run: node server/scripts/inspectGpsRuntime.mjs [--pid <actual-node-worker-pid>]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ENV_KEYS = ['MONGODB_URI', 'VEHICLE_LOCATION_RECORD_INTERVAL_MS'];
const bounded = value => {
  const text = String(value);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('INPUT_TOO_LARGE');
  return text;
};
const selected = env => Object.fromEntries(ENV_KEYS.filter(key => Object.hasOwn(env, key)).map(key => [key, env[key]]));
const safeName = value => /^[a-zA-Z0-9_.-]{1,128}$/.test(value || '') ? value : null;
const missing = reason => ({ status: 'unavailable', reason });

export function sanitizeMongoUri(uri) {
  if (!uri) return missing('MONGODB_URI_NOT_FOUND');
  try {
    const match = bounded(uri).match(/^(mongodb(?:\+srv)?):\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/);
    if (!match) return missing('MONGODB_URI_UNRECOGNIZED');
    const [, scheme, authority, database, query] = match;
    const split = authority.lastIndexOf('@');
    const hostPart = authority.slice(split + 1);
    const hosts = hostPart.split(',');
    const validHost = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?$/;
    if (!hosts.length || hosts.some(host => !validHost.test(host)) || scheme === 'mongodb+srv' && hosts.length !== 1) return missing('MONGODB_HOSTS_UNRECOGNIZED');
    const db = database ? safeName(decodeURIComponent(database)) : null;
    const user = split === -1 ? null : decodeURIComponent(authority.slice(0, split).split(':')[0]);
    const options = {};
    const parameters = new URLSearchParams(query || '');
    for (const key of ['w', 'j', 'journal', 'wtimeoutms', 'retrywrites']) {
      const values = [...parameters].filter(([name]) => name.toLowerCase() === key).map(([, value]) => value);
      if (!values.length) { options[key] = { status: 'unspecified' }; continue; }
      if (values.length !== 1) { options[key] = missing('DUPLICATE_OPTION'); continue; }
      const value = values[0];
      if (['j', 'journal', 'retrywrites'].includes(key)) options[key] = /^(true|false)$/i.test(value) ? { value: value.toLowerCase() === 'true' } : missing('UNRECOGNIZED_BOOLEAN');
      else if (key === 'w' && value === 'majority') options[key] = { value };
      else if (/^[0-9]{1,12}$/.test(value) && Number.isSafeInteger(Number(value))) options[key] = { value: Number(value) };
      else options[key] = missing('NONSTANDARD_VALUE_NOT_DISCLOSED');
    }
    const authSources = [...parameters].filter(([name]) => name.toLowerCase() === 'authsource').map(([, value]) => value);
    const authSource = authSources.length === 1 ? safeName(authSources[0]) : null;
    return { status: 'parsed', scheme, hosts, database: db, authSource,
      authSourceStatus: authSource ? 'explicit_in_uri' : authSources.length ? 'unrecognized_or_duplicate_not_disclosed' : 'unspecified',
      databaseUserFingerprint: user ? { algorithm: 'sha256_utf8_decoded_uri_username', sha256: createHash('sha256').update(user, 'utf8').digest('hex') } : null,
      databaseStatus: db ? 'explicit_in_uri' : database ? 'name_not_disclosed' : 'not_explicit_in_uri',
      credentialsPresent: split !== -1, accountOwner: missing('NOT_ENCODED_IN_CONNECTION_URI'),
      uriWriteOptions: options,
      effectiveServerDefault: missing('REQUIRES_DATABASE_INSPECTION_NOT_PERFORMED') };
  } catch { return missing('MONGODB_URI_UNRECOGNIZED'); }
}

export function reconstructConfiguration(initial, baseText, localText, parseDotenv) {
  if (typeof parseDotenv !== 'function') throw new Error('ENV_PARSER_UNAVAILABLE');
  const base = selected(parseDotenv(baseText || ''));
  const local = selected(parseDotenv(localText || ''));
  const values = { ...base, ...selected(initial), ...local };
  const provenance = Object.fromEntries(ENV_KEYS.map(key => [key,
    Object.hasOwn(local, key) ? 'current_server_env_local'
      : Object.hasOwn(initial, key) ? 'proc_initial_environment'
        : Object.hasOwn(base, key) ? 'current_server_env' : 'missing']));
  return { values, provenance };
}

export function gpsInterval(value, source) {
  const configured = Number.parseInt(value || '', 10);
  if (source.includes('Number.isSafeInteger(configuredInterval) && configuredInterval >= 60000')) {
    return { milliseconds: Number.isSafeInteger(configured) && configured >= 60000 ? configured : 60000,
      rule: 'minimum_60000_default_60000', configuredValueAccepted: Number.isSafeInteger(configured) && configured >= 60000 };
  }
  if (source.includes("parseInt(process.env.VEHICLE_LOCATION_RECORD_INTERVAL_MS || '', 10) || 60 * 1000")) {
    const delay = configured || 60000;
    return { milliseconds: delay, rule: 'legacy_parseInt_or_60000',
      warning: delay < 1 || delay > 2147483647 ? 'TIMER_VALUE_OUT_OF_RANGE' : null };
  }
  return missing('GPS_INTERVAL_RULE_UNRECOGNIZED');
}

function procEnvironment(text) {
  return Object.fromEntries(bounded(text).split('\0').filter(line => line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}
function startToken(stat) {
  const token = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  if (!/^[0-9]+$/.test(token || '')) throw new Error('PROCESS_START_UNREADABLE');
  return token;
}
const childEnv = { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const defaultRun = (file, args) => execFileSync(file, args, { encoding: 'utf8', env: childEnv,
  timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export function inspectRuntime({ io = fs, run = defaultRun, procRoot = '/proc', pid = null, parseEnv = null } = {}) {
  const read = file => bounded(io.readFileSync(file, 'utf8'));
  const report = { schemaVersion: 1, diagnostic: 'read_only_no_app_database_or_provider_start',
    pm2: { application: 'matter-delivery-api', registeredInstancesObserved: null }, workers: [],
    limitations: [
      '/proc exposes the initial environment, not dotenv changes made inside a running Node process.',
      'Configuration is reconstructed from the initial environment plus current .env/.env.local; files may have changed since startup.',
      'Checkout revision is exact for the running process directory, but loaded in-memory code revision and tracked-file cleanliness are not attested.',
      'GPS interval is a reconstructed configured timer, not evidence that provider configuration permits capture or that ticks are succeeding.',
      'No PM2 command, application startup, database connection or network request is performed.'
    ] };
  let entries;
  try { entries = io.readdirSync(procRoot).filter(name => /^[1-9][0-9]*$/.test(name)); }
  catch { report.status = 'unavailable'; report.reason = 'LINUX_PROC_UNREADABLE'; return report; }
  const records = [];
  const pmIds = new Set();
  let inaccessible = 0;
  for (const id of entries) {
    try {
      const env = procEnvironment(read(path.join(procRoot, id, 'environ')));
      const matches = env.name === 'matter-delivery-api' && /^[0-9]+$/.test(env.pm_id || '');
      if (matches) pmIds.add(env.pm_id);
      if (!matches && String(pid) !== id) continue;
      const argv = read(path.join(procRoot, id, 'cmdline')).split('\0').filter(Boolean);
      if (!argv[1] || path.basename(argv[1]) !== 'server.js') continue;
      const cwd = io.readlinkSync(path.join(procRoot, id, 'cwd'));
      const exe = io.readlinkSync(path.join(procRoot, id, 'exe'));
      if (!['node', 'nodejs'].includes(path.basename(exe))) continue;
      const entry = path.resolve(cwd, argv[1]);
      const serverDir = path.dirname(entry);
      const pkg = JSON.parse(read(path.join(serverDir, 'package.json')));
      if (pkg.name !== 'matter-delivery-server') continue;
      records.push({ id, env, serverDir, token: startToken(read(path.join(procRoot, id, 'stat'))) });
    } catch { inaccessible++; }
  }
  report.pm2.registeredInstancesObserved = pmIds.size || null;
  report.pm2.provenance = 'distinct_pm_id_in_readable_target_process_initial_environments';
  report.pm2.inaccessibleProcessCount = inaccessible;
  report.pm2.actualApiWorkersObserved = records.length;
  if (pid && !records.some(record => record.id === String(pid))) {
    report.status = 'unavailable'; report.reason = 'REQUESTED_PID_IS_NOT_A_READABLE_API_NODE_WORKER'; return report;
  }
  for (const record of records.filter(record => !pid || record.id === String(pid))) {
    const { id, env, serverDir, token } = record;
    const worker = { pid: Number(id), pm2Id: /^[0-9]+$/.test(env.pm_id || '') ? Number(env.pm_id) : null,
      nodeVersion: null, revision: {}, configuration: {} };
    const tryRead = file => { try { return { status: 'read', text: read(file) }; } catch (error) { return { status: error.code === 'ENOENT' ? 'absent' : 'unreadable', text: '' }; } };
    try {
      const version = run(path.join(procRoot, id, 'exe'), ['--version']).trim();
      if (/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) worker.nodeVersion = version;
      worker.nodeVersionProvenance = worker.nodeVersion ? 'running_worker_executable_version_with_clean_environment' : 'unavailable';
    } catch { worker.nodeVersionProvenance = 'unavailable'; }
    try {
      const root = path.dirname(serverDir);
      const sha = run('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-C', root, 'rev-parse', 'HEAD']).trim();
      if (/^[a-f0-9]{40}$/.test(sha)) worker.revision.checkoutCommit = sha;
      // Do not run status/diff: repository fsmonitor or clean filters can execute
      // programs even for apparently read-only worktree inspection.
      worker.revision.trackedFilesChanged = null;
      worker.revision.trackedFileProvenance = 'not_checked_no_worktree_commands';
    } catch { worker.revision.checkoutStatus = 'unavailable'; }
    worker.revision.loadedCodeCommit = null;
    worker.revision.provenance = 'current_checkout_for_actual_worker_entrypoint_not_memory_attestation';
    const loader = tryRead(path.join(serverDir, 'loadEnv.js'));
    const envFile = tryRead(path.join(serverDir, '.env'));
    const localFile = tryRead(path.join(serverDir, '.env.local'));
    const loaderKnown = loader.text.includes("dotenv.config({ path: path.join(__dirname, '.env') })")
      && loader.text.includes("dotenv.config({ path: path.join(__dirname, '.env.local'), override: true })");
    let values = {}, provenance = {}, parserAvailable = false;
    try {
      // Resolve only dotenv's parser from the verified application's installed
      // dependencies. A detached /tmp copy needs no own node_modules. Never call
      // dotenv.config(), loadEnv.js, server.js, or any application module.
      const parser = parseEnv || createRequire(path.join(serverDir, 'package.json'))('dotenv').parse;
      ({ values, provenance } = reconstructConfiguration(env, envFile.text, localFile.text, parser));
      parserAvailable = true;
    } catch { /* No parser errors or configuration contents enter output. */ }
    const reliable = parserAvailable && loaderKnown && envFile.status !== 'unreadable' && localFile.status !== 'unreadable';
    worker.configuration = { status: reliable ? 'reconstructed_not_live_attested' : 'incomplete',
      loaderRecognized: loaderKnown, parserAvailable, files: { env: envFile.status, envLocal: localFile.status }, provenance };
    if (reliable) {
      worker.mongo = sanitizeMongoUri(values.MONGODB_URI);
      const main = tryRead(path.join(serverDir, 'server.js')).text;
      const connect = main.match(/mongoose\.connect\(process\.env\.MONGODB_URI,\s*\{([\s\S]*?)\}\)/)?.[1];
      worker.mongo.sourceConnectionOverrides = connect && /retryWrites:\s*true\b/.test(connect)
        ? { retryWrites: true, provenance: 'inspected_current_server_connect_options' }
        : missing('CONNECTION_OVERRIDES_UNRECOGNIZED');
      const intervalSource = tryRead(path.join(serverDir, 'jobs', 'recordVehicleLocations.js')).text;
      worker.gpsInterval = main.includes('startRecordVehicleLocationsJob();') ? gpsInterval(values.VEHICLE_LOCATION_RECORD_INTERVAL_MS, intervalSource) : missing('GPS_JOB_CALL_UNRECOGNIZED');
      const explicitMajority = file => /writeConcern:\s*\{\s*w:\s*'majority',\s*j:\s*true,\s*wtimeoutMS:\s*10000\s*\}/.test(tryRead(path.join(serverDir, 'services', file)).text);
      worker.gpsWriteConcern = explicitMajority('vehicleLocationCaptureStore.js') && explicitMajority('truckoomGpsEvidence.js')
        ? { w: 'majority', journal: true, wtimeoutMS: 10000, provenance: 'explicit_current_source_capture_and_receipt_operations', acknowledgedDurability: 'not_checked' }
        : missing('NO_RECOGNIZED_EXPLICIT_GPS_WRITE_CONCERN');
    } else {
      worker.mongo = missing('CONFIGURATION_RECONSTRUCTION_INCOMPLETE');
      worker.gpsInterval = missing('CONFIGURATION_RECONSTRUCTION_INCOMPLETE');
    }
    try {
      if (startToken(read(path.join(procRoot, id, 'stat'))) !== token) {
        worker.status = 'inconsistent'; worker.reason = 'PROCESS_CHANGED_DURING_INSPECTION';
      } else worker.status = 'observed';
    } catch { worker.status = 'inconsistent'; worker.reason = 'PROCESS_EXITED_DURING_INSPECTION'; }
    report.workers.push(worker);
  }
  report.status = report.workers.length ? 'observed_with_limits' : 'unavailable';
  if (!report.workers.length) report.reason = 'NO_READABLE_API_WORKER_FOUND_USE_EXPLICIT_PID_IF_NEEDED';
  return report;
}

const invokedDirectly = () => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (invokedDirectly()) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--pid' && /^[1-9][0-9]{0,9}$/.test(args[1]))) {
    process.stdout.write(JSON.stringify({ status: 'unavailable', reason: 'USAGE_node_inspectGpsRuntime_mjs_optional_pid' }) + '\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(JSON.stringify(inspectRuntime({ pid: args[1] || null }), null, 2) + '\n'); }
    catch { process.stdout.write(JSON.stringify({ status: 'unavailable', reason: 'DIAGNOSTIC_FAILED_NO_PRIVATE_DETAILS_PRINTED' }) + '\n'); process.exitCode = 1; }
  }
}
