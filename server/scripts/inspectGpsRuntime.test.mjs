import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseDotenv } from 'dotenv';
import { createHash } from 'node:crypto';
import { sanitizeMongoUri, reconstructConfiguration as reconstructBase, gpsInterval, inspectRuntime as inspectBase } from './inspectGpsRuntime.mjs';

const reconstructConfiguration = (...args) => reconstructBase(...args, parseDotenv);
const inspectRuntime = options => inspectBase({ parseEnv: parseDotenv, ...options });
const secret = 'DO_NOT_DISCLOSE_PASSWORD';
const username = 'PRIVATE_USER';
const uri = `mongodb+srv://${username}:${secret}@cluster.example.net/fleet?authSource=admin&w=majority&journal=true&wtimeoutMS=10000&retryWrites=false&token=PRIVATE_QUERY_TOKEN`;
const hash = value => createHash('sha256').update(value).digest('hex');
const assertPrivate = value => {
  const text = JSON.stringify(value);
  for (const forbidden of [secret, username, 'PRIVATE_QUERY_TOKEN', 'PRIVATE_JWT', uri, 'PRIVATE_PATH', 'mongodb+srv://']) assert.ok(!text.includes(forbidden), `private value disclosed: ${forbidden}`);
};

test('Mongo output preserves required identity/options and never credentials or unapproved query values', () => {
  const result = sanitizeMongoUri(uri);
  assert.equal(result.status, 'parsed'); assert.deepEqual(result.hosts, ['cluster.example.net']);
  assert.equal(result.database, 'fleet'); assert.equal(result.authSource, 'admin');
  assert.equal(result.databaseUserFingerprint.sha256, hash(username));
  assert.equal(result.databaseUserFingerprint.algorithm, 'sha256_utf8_decoded_uri_username');
  assert.deepEqual(result.uriWriteOptions.w, { value: 'majority' });
  assert.deepEqual(result.uriWriteOptions.journal, { value: true });
  assert.deepEqual(result.uriWriteOptions.wtimeoutms, { value: 10000 });
  assert.deepEqual(result.uriWriteOptions.retrywrites, { value: false });
  assert.equal(result.accountOwner.status, 'unavailable'); assertPrivate(result);
});

test('account fingerprint decodes username only and is independent of password', () => {
  const first = sanitizeMongoUri('mongodb://test%40account:first%40secret@db.example.net:27017/one');
  const second = sanitizeMongoUri('mongodb://test%40account:changed-secret@db.example.net:27017/two');
  assert.equal(first.databaseUserFingerprint.sha256, hash('test@account'));
  assert.deepEqual(first.databaseUserFingerprint, second.databaseUserFingerprint);
  assert.ok(!JSON.stringify(first).includes('test@account'));
  assert.equal(sanitizeMongoUri('mongodb://db.example.net/one').databaseUserFingerprint, null);
});

test('replica hosts and IPv6 parse without a connection; unspecified database/default write concern stay unknown', () => {
  const result = sanitizeMongoUri('mongodb://user:password@db1.example.net:27017,[::1]:27018/?w=1');
  assert.deepEqual(result.hosts, ['db1.example.net:27017', '[::1]:27018']);
  assert.equal(result.database, null); assert.equal(result.databaseStatus, 'not_explicit_in_uri');
  assert.equal(result.effectiveServerDefault.status, 'unavailable');
  assert.deepEqual(result.uriWriteOptions.w, { value: 1 });
});

test('malformed input, duplicates and secret-bearing unsupported options fail closed without raw errors', () => {
  for (const value of [null, `https://${secret}`, `mongodb://${secret}@bad host/db`, `mongodb://bad%escape:pw@db.example.net/db`, 'mongodb+srv://a,b/db']) {
    const result = sanitizeMongoUri(value); assert.equal(result.status, 'unavailable'); assertPrivate(result);
  }
  const result = sanitizeMongoUri(`mongodb://u:${secret}@db.example.net/db?w=${secret}&j=${secret}&wtimeoutMS=${secret}&retryWrites=true&retrywrites=false&authSource=admin&authSource=${secret}`);
  assertPrivate(result); assert.equal(result.uriWriteOptions.w.status, 'unavailable');
  assert.equal(result.uriWriteOptions.retrywrites.reason, 'DUPLICATE_OPTION'); assert.equal(result.authSource, null);
});

test('dotenv reconstruction matches default-no-override then local override, ignoring unrelated secrets', () => {
  const result = reconstructConfiguration({ MONGODB_URI: 'initial', JWT_SECRET: 'PRIVATE_JWT' }, 'MONGODB_URI=base\nVEHICLE_LOCATION_RECORD_INTERVAL_MS=90000\nJWT_SECRET=PRIVATE_JWT', 'MONGODB_URI="local"\nVEHICLE_LOCATION_RECORD_INTERVAL_MS=120000');
  assert.deepEqual(result.values, { MONGODB_URI: 'local', VEHICLE_LOCATION_RECORD_INTERVAL_MS: '120000' });
  assert.equal(result.provenance.MONGODB_URI, 'current_server_env_local');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_JWT'));
  assert.equal(reconstructConfiguration({ MONGODB_URI: '' }, 'MONGODB_URI=base', '').values.MONGODB_URI, '');
});

test('interval reconstruction follows both checked source contracts rather than claiming a universal rule', () => {
  const current = fs.readFileSync(new URL('../jobs/recordVehicleLocations.js', import.meta.url), 'utf8');
  const legacy = "const RECORD_INTERVAL_MS = parseInt(process.env.VEHICLE_LOCATION_RECORD_INTERVAL_MS || '', 10) || 60 * 1000;";
  assert.equal(gpsInterval('30000', current).milliseconds, 60000);
  assert.equal(gpsInterval('120000', current).milliseconds, 120000);
  assert.equal(gpsInterval('120000junk', current).milliseconds, 120000);
  assert.equal(gpsInterval('30000', legacy).milliseconds, 30000);
  assert.equal(gpsInterval(undefined, legacy).milliseconds, 60000);
  assert.equal(gpsInterval('-1', legacy).warning, 'TIMER_VALUE_OUT_OF_RANGE');
  assert.equal(gpsInterval('PRIVATE_TOKEN', '').status, 'unavailable');
});

function fixture({ local = '', inaccessibleLocal = false, processChanged = false, targetName = 'matter-delivery-api', unsupportedLoader = false } = {}) {
  const root = '/fixture-proc', dir = '/PRIVATE_PATH/server';
  const stat = token => '123 (node) ' + [...Array(19).fill('0'), token].join(' ');
  const env = `name=${targetName}\0pm_id=0\0MONGODB_URI=${uri}\0VEHICLE_LOCATION_RECORD_INTERVAL_MS=30000\0JWT_SECRET=PRIVATE_JWT\0NODE_OPTIONS=--require PRIVATE_PATH\0`;
  const files = new Map([
    [`${root}/100/environ`, env], [`${root}/100/cmdline`, 'node\0/usr/bin/npm\0'],
    [`${root}/101/environ`, env], [`${root}/101/cmdline`, 'node\0server.js\0'],
    [`${root}/101/stat`, stat('500')], [`${dir}/package.json`, JSON.stringify({ name: 'matter-delivery-server' })],
    [`${dir}/loadEnv.js`, unsupportedLoader ? 'custom loader' : fs.readFileSync(new URL('../loadEnv.js', import.meta.url), 'utf8')],
    [`${dir}/.env`, 'MONGODB_URI=ignored\nPRIVATE_SECRET=PRIVATE_JWT'], [`${dir}/.env.local`, local],
    [`${dir}/server.js`, 'mongoose.connect(process.env.MONGODB_URI, { retryWrites: true });\nstartRecordVehicleLocationsJob();'],
    [`${dir}/jobs/recordVehicleLocations.js`, fs.readFileSync(new URL('../jobs/recordVehicleLocations.js', import.meta.url), 'utf8')],
    [`${dir}/services/vehicleLocationCaptureStore.js`, "const WRITE_OPTIONS = { writeConcern: { w: 'majority', j: true, wtimeoutMS: 10000 } };"],
    [`${dir}/services/truckoomGpsEvidence.js`, "store.create([], { writeConcern: { w: 'majority', j: true, wtimeoutMS: 10000 } });"]
  ]);
  const calls = []; let statReads = 0;
  const io = {
    readdirSync(p) { assert.equal(p, root); return ['100', '101', 'self']; },
    readFileSync(p) {
      if (p.endsWith('/.env.local') && inaccessibleLocal) throw Object.assign(Error(secret), { code: 'EACCES' });
      if (p.endsWith('/stat') && ++statReads > 1 && processChanged) return stat('600');
      if (!files.has(p)) throw Object.assign(Error(secret), { code: 'ENOENT' });
      return files.get(p);
    },
    readlinkSync(p) { if (p.endsWith('/cwd')) return dir; if (p.endsWith('/exe')) return '/usr/bin/node'; throw Error(secret); }
  };
  const run = (file, args) => {
    calls.push({ file, args });
    if (file === root + '/101/exe') { assert.deepEqual(args, ['--version']); return 'v22.21.0\n'; }
    assert.equal(file, '/usr/bin/git');
    assert.deepEqual(args, ['-c', 'core.fsmonitor=false', '-C', '/PRIVATE_PATH', 'rev-parse', 'HEAD']);
    return 'a'.repeat(40) + '\n';
  };
  return { root, io, run, calls };
}

test('actual worker discovery deduplicates npm/Node PM2 instance and only runs executable version/git read commands', () => {
  const f = fixture(); const report = inspectRuntime({ io: f.io, run: f.run, procRoot: f.root });
  assert.equal(report.status, 'observed_with_limits'); assert.equal(report.pm2.registeredInstancesObserved, 1);
  assert.equal(report.pm2.actualApiWorkersObserved, 1); assert.equal(report.workers[0].nodeVersion, 'v22.21.0');
  assert.equal(report.workers[0].revision.checkoutCommit, 'a'.repeat(40)); assert.equal(report.workers[0].revision.loadedCodeCommit, null);
  assert.equal(report.workers[0].configuration.loaderRecognized, true);
  assert.equal(report.workers[0].gpsInterval.milliseconds, 60000);
  assert.equal(report.workers[0].mongo.uriWriteOptions.retrywrites.value, false);
  assert.equal(report.workers[0].mongo.sourceConnectionOverrides.retryWrites, true);
  assert.equal(report.workers[0].gpsWriteConcern.w, 'majority'); assert.equal(f.calls.length, 2); assertPrivate(report);
});

test('current .env.local overrides initial proc configuration with explicit provenance', () => {
  const f = fixture({ local: 'MONGODB_URI=mongodb://other.example.net/otherdb\nVEHICLE_LOCATION_RECORD_INTERVAL_MS=180000' });
  const report = inspectRuntime({ io: f.io, run: f.run, procRoot: f.root });
  assert.deepEqual(report.workers[0].mongo.hosts, ['other.example.net']);
  assert.equal(report.workers[0].configuration.provenance.MONGODB_URI, 'current_server_env_local');
  assert.equal(report.workers[0].gpsInterval.milliseconds, 180000); assertPrivate(report);
});

for (const options of [{ inaccessibleLocal: true }, { unsupportedLoader: true }]) test('unreadable override/unknown loader never passes a guessed effective configuration', () => {
  const f = fixture(options); const report = inspectRuntime({ io: f.io, run: f.run, procRoot: f.root });
  assert.equal(report.workers[0].configuration.status, 'incomplete');
  assert.equal(report.workers[0].mongo.status, 'unavailable'); assertPrivate(report);
});

test('worker replacement during inspection is explicitly inconsistent', () => {
  const f = fixture({ processChanged: true }); const report = inspectRuntime({ io: f.io, run: f.run, procRoot: f.root });
  assert.equal(report.workers[0].status, 'inconsistent'); assert.equal(report.workers[0].reason, 'PROCESS_CHANGED_DURING_INSPECTION'); assertPrivate(report);
});

test('missing /proc or unmatched PM2 application never invokes PM2 or starts an app', () => {
  const none = inspectRuntime({ io: { readdirSync() { throw Error(secret); } }, run() { assert.fail('unexpected command'); } });
  assert.equal(none.reason, 'LINUX_PROC_UNREADABLE'); assertPrivate(none);
  const f = fixture({ targetName: 'other-app' }); const absent = inspectRuntime({ io: f.io, run: f.run, procRoot: f.root });
  assert.equal(absent.status, 'unavailable'); assert.equal(f.calls.length, 0); assertPrivate(absent);
  const explicit = inspectRuntime({ io: f.io, run: f.run, procRoot: f.root, pid: '101' });
  assert.equal(explicit.workers.length, 1); assert.equal(explicit.pm2.registeredInstancesObserved, null); assertPrivate(explicit);
});

test('subprocess failures containing credentials never escape sanitized output', () => {
  const f = fixture(); const report = inspectRuntime({ io: f.io, procRoot: f.root, run() { throw Error(uri + ' PRIVATE_JWT'); } });
  assert.equal(report.workers[0].nodeVersion, null); assert.equal(report.workers[0].revision.checkoutStatus, 'unavailable'); assertPrivate(report);
});

test('detached script imports and runs outside the repository without its own node_modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-runtime-detached-'));
  try {
    const script = path.join(dir, 'inspectGpsRuntime.mjs');
    fs.copyFileSync(new URL('./inspectGpsRuntime.mjs', import.meta.url), script);
    // An invalid explicit PID performs no process/version/configuration action.
    const output = execFileSync(process.execPath, [script, '--pid', '9999999999'], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 5000
    });
    const report = JSON.parse(output);
    assert.equal(report.status, 'unavailable'); assertPrivate(report);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing parser dependency is explicit and does not disclose guessed configuration', () => {
  const f = fixture();
  const report = inspectBase({ io: f.io, run: f.run, procRoot: f.root, parseEnv() { throw Error(secret); } });
  assert.equal(report.workers[0].configuration.parserAvailable, false);
  assert.equal(report.workers[0].mongo.status, 'unavailable'); assertPrivate(report);
});

test('repository fsmonitor and clean filters cannot run during revision-only inspection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-runtime-git-'));
  const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
  const git = args => execFileSync('/usr/bin/git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['init', '-q', dir]);
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'synthetic');
    git(['-C', dir, 'add', 'tracked.txt']);
    git(['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
    const hook = path.join(dir, 'monitor.sh'), marker = path.join(dir, 'unexpected-hook-marker');
    fs.writeFileSync(hook, '#!/bin/sh\nprintf executed > "'+marker+'"\n', { mode: 0o700 });
    git(['-C', dir, 'config', 'core.fsmonitor', hook]);
    git(['-C', dir, 'config', 'filter.synthetic.clean', hook]);
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=synthetic\n');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'changed synthetic');
    const f = fixture();
    const report = inspectRuntime({ io: f.io, procRoot: f.root, run(file, args) {
      if (file.endsWith('/101/exe')) return 'v22.21.0';
      assert.equal(file, '/usr/bin/git');
      assert.deepEqual(args, ['-c', 'core.fsmonitor=false', '-C', '/PRIVATE_PATH', 'rev-parse', 'HEAD']);
      return git(args.map(value => value === '/PRIVATE_PATH' ? dir : value));
    } });
    assert.match(report.workers[0].revision.checkoutCommit, /^[a-f0-9]{40}$/);
    assert.equal(report.workers[0].revision.trackedFilesChanged, null);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
