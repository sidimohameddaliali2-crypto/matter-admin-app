import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import dotenv from '../../server/node_modules/dotenv/lib/main.js';
import { sealTransferSecrets, openTransferSecrets } from '../../server/services/driverAuditTransferCodec.js';
import { acquireWorkerLock } from '../../server/vendor/driver-audits/integration/hosted/worker-lock.mjs';
import { createDriverAuditSupabaseSync } from '../../server/services/driverAuditSupabaseSync.js';
import { createDriverAuditSupabaseReplica, verifyDriverAuditSupabaseServingPackage } from '../../server/services/driverAuditSupabaseReplica.js';
import { createCloudState } from '../../server/vendor/driver-audits/integration/cloud/cloud-state.mjs';
import { withDriverAuditHeavyWork } from '../../server/services/driverAuditHeavyWork.js';
import { archiveBytes, archiveCatalog } from '../../server/vendor/driver-audits/integration/cloud/repository.mjs';
import { createVerifiedAuditArchive } from '../../server/vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs';
import { prepareRemotePreviewPackage } from '../../server/vendor/driver-audits/integration/cloud/remote-preview-package.mjs';
import { verifyDriverAuditSourceHostQualification, stageDriverAuditQualification } from '../../server/scripts/driverAuditSourceQualify.js';
import * as operator from './driver-audit-supabase-control.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const recipientPublicKey = publicKey.export({ type: 'spki', format: 'pem' });

test('continuation exposes only the fixed control interface and rejects invalid inputs before invoking commands', async () => {
  assert.equal(typeof operator.runDriverAuditSupabaseControl, 'function');
  let calls = 0;
  for (const args of [{}, { operation: 'activate-native' }, { operation: 'start-report', appRoot: '/arbitrary', command: 'anything' }]) {
    await assert.rejects(operator.runDriverAuditSupabaseControl(args, { exec: () => { calls++; throw Error('Must not run'); } }), /Supabase control stopped at inputs/);
  }
  assert.equal(calls, 0);
});

test('cancellation during final sealing or awaited lock release cannot return an accepted success', async t => {
  for(const boundary of ['sealing','unlock']){
    const f=await fixture(t),stop=new AbortController(),load=f.adapters.load;f.adapters.signal=stop.signal;let reached=false;
    f.adapters.load=async(...args)=>{
      const result=await load(...args);
      if(boundary==='sealing'&&args[0]==='services/driverAuditTransferCodec.js'){reached=true;stop.abort(Error('Fictional final cancellation'));}
      if(boundary==='unlock'&&args[0]==='vendor/driver-audits/integration/hosted/worker-lock.mjs')return{acquireWorkerLock:async file=>{
        const lock=await result.acquireWorkerLock(file);return{...lock,release:async()=>{await lock.release();if(file.endsWith('/driver-report-supabase-handoff/operator.lock')){reached=true;stop.abort(Error('Fictional cleanup cancellation'));}}};
      }};
      return result;
    };
    await assert.rejects(f.run('prepare-serving'),/Supabase control stopped/);assert(reached);
    const lock=await acquireWorkerLock(path.join(f.baseServer,'.private/driver-report-supabase-handoff/operator.lock'));await lock.release();
    assert.equal(JSON.parse(f.states.get('app-sidi-report-head').body).servingPackage.collectorRevision,f.p.current.revision);
  }
});

const sha = hash;
const at = '2026-11-12T00:00:00.000Z';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const basis = publication => sha(JSON.stringify(canonical({ head: { reportHash: publication.head.reportHash,
  manifest: publication.head.manifest, gps: publication.head.gps }, gps: {}, photos: {}, photoBindingRepair: null })));
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}

// A fictional builder implements the existing four-module boundary. The real
// public package preparation, dependency closure, CAS and OS locks run below.
const builderModules = {
  'integration/cloud/automatic-release.mjs': `
import fs from 'node:fs/promises';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const automaticReleaseBasis=p=>createHash('sha256').update(JSON.stringify(canonical({head:{reportHash:p.head.reportHash,manifest:p.head.manifest,gps:p.head.gps},gps:{},photos:{},photoBindingRepair:null}))).digest('hex');
export function createAutomaticRelease({root,baselineRoot,loadSource,build,validate,pinnedDirectSync}){
 if(pinnedDirectSync!==true)throw Error('Pinned fixture required');const pointerFile=path.join(root,'current.private.json');
 return{pointerFile,async tick(){const source=await loadSource(),output=path.join(root,'attempts',randomUUID());await fs.mkdir(output,{recursive:true,mode:0o700});
 const result=await build({source,output,baselineRoot});const validation=await validate(result);if(!validation.ok)throw Error('Fixture validation failed');
 const candidate={version:1,collectorRevision:source.savedState.revision,sourceBasis:automaticReleaseBasis(source.publication),privateRoot:result.privateRoot,manifestSha256:validation.manifestSha256};
 await fs.writeFile(pointerFile,JSON.stringify(candidate),{mode:0o600});return candidate;}};}
`,
  'integration/cloud/automatic-release-source.mjs': `
export const supportsManagedArchiveCache=true;
export function createAutomaticReleaseSource({stateStore,skipCacheWrite,archiveTransport}){
 if(!skipCacheWrite||archiveTransport.managedReadCache!==true)throw Error('Managed fixture cache required');
 return async()=>{const savedState=await stateStore.read('collector-state');return{savedState,publication:JSON.parse(savedState.body),transport:archiveTransport};};}
`,
  'integration/cloud/automatic-release-build.mjs': `
import fs from 'node:fs/promises';import path from 'node:path';export const compactDirectBuildVersion=1;
export async function buildAutomaticRelease({source,output,checkSpace}){await checkSpace();
 const privateRoot=path.join(output,'server-data');await fs.cp(source.publication.fixturePackageRoot,privateRoot,{recursive:true});
 await fs.appendFile(path.join(path.dirname(path.dirname(output)),'fixture-builds.private.txt'),'built\\n',{mode:0o600});return{privateRoot};}
`,
  'scripts/run-automatic-report.mjs': `
import fs from 'node:fs/promises';import path from 'node:path';import{createHash}from'node:crypto';
export async function validateAutomaticCandidate(candidate){const bytes=await fs.readFile(path.join(candidate.privateRoot,'files.private.json'));
 return{ok:true,manifestSha256:createHash('sha256').update(bytes).digest('hex')};}
`,
};

async function reportPackage(directory, revision, { largeRuntime = false } = {}) {
  const blobs = new Map(), files = {};
  const local = { async putVerifiedObject(key, body) {
    blobs.set(key, Buffer.from(body));
    return { key, sha256: sha(body), verified: true };
  } };
  const rows = [{key:'fictional-'+revision,assessmentHash:sha('assessment-'+revision),photo:{grade:'accepted'},findings:[],delivery:{date:'2026-11-12'}}];
  const browser = Buffer.from(JSON.stringify({ fictionalRevision: revision, matter:{validatedReporting:{queryId:'reporting_validated_deliveries'},lazyQueries:{reporting_validated_history:{count:1}}},
    queries:{reporting_validated_deliveries:{rows}} })), generation = sha(browser), reportHash = sha('report-' + revision);
  const snapshot = { sha256: generation, url: 'report-data/snapshot-' + generation + '.json' };
  const queue = { items: [] }, inventories = [{ queue, proposals: {} }, { queue, proposals: {} }];
  const inventoryDigest = sha(JSON.stringify(inventories)), queueDigest = sha(JSON.stringify(queue));
  const retained = [];
  for (const [name, body] of Object.entries({
    ['review-snapshots/' + reportHash + '.json.gz']: gzipSync(JSON.stringify({ snapshotHash: reportHash, rows: [], issues: [] })),
    ['photo-generations/' + reportHash + '.json']: Buffer.from(JSON.stringify({ digest: inventoryDigest })),
    ['photo-inventories/' + inventoryDigest + '.json']: Buffer.from(JSON.stringify(inventories.map(({ queue: ignored, ...rest }) => ({ queueDigest, ...rest })))),
    ['photo-inventories/queues/' + queueDigest + '.json']: Buffer.from(JSON.stringify(queue)),
  })) retained.push(await archiveBytes(local, body, { domain: 'state', path: name }));
  const catalog = await archiveCatalog(local, retained);
  const publication = { version: 1, head: { reportHash, manifest: snapshot, records:rows.length,history:1,source: { observedAt: at } }, catalog,
    fixturePackageRoot: directory };
  const values = {
    'publication.private.json': Buffer.from(JSON.stringify(publication)), 'identities.private.json': Buffer.from('{}'),
    'maps.private.json': Buffer.from('{}'), 'gps-index.private.json.gz': gzipSync('{"streamFiles":{}}'),
    'preview-read-view.private.json.gz': gzipSync(JSON.stringify({ reportHash, generation, catalogHash: catalog.sha256,
      browser: snapshot, allowedResources: [snapshot.url], photos: [], gpsRows: [],
      ...(largeRuntime ? { deferredQueryFiles: { fictional_large: 'deferred-large.private.bin' } } : {}) })),
    'renderer.private.html': Buffer.from('<html>Fictional</html>'), 'build.private.json': Buffer.from('{}'),
    'browser-data.private.json.gz': gzipSync(browser),
  };
  if (largeRuntime) values['deferred-large.private.bin'] = Buffer.alloc(8 * 1024 ** 2 + 23, 97);
  for (const [name, body] of Object.entries(values)) { await write(path.join(directory, name), body); files[name] = sha(body); }
  for (const [key, body] of blobs) {
    const name = 'archive-' + key.slice(0, 64) + '.private.bin';
    await write(path.join(directory, name), body); files[name] = sha(body);
  }
  const manifestBytes = Buffer.from(JSON.stringify(files)), manifestSha256 = sha(manifestBytes);
  await write(path.join(directory, 'files.private.json'), manifestBytes);
  const bundleRoot = path.join(path.dirname(directory), 'objects');
  const prepared = await prepareRemotePreviewPackage({ privateRoot: directory, validation: { ok: true, manifestSha256 },
    includeRetained: false, maxBytes: 128 * 1024 ** 2, runBatch: async (_, operation) => operation(),
    transport: { async putVerifiedObject(key, body) { await write(path.join(bundleRoot, key), body); return { key, sha256: sha(body), verified: true }; } } });
  const binding = { manifestSha256, generation, reportHash, descriptorSha256: prepared.descriptor.sha256 };
  return { publication, blobs, seed: { version: 1, mode: 'bootstrap', bundleRoot, collectorRevision: revision,
    sourceBasis: basis(publication), manifestSha256, pointer: { version: 1, generation, reportHash, descriptor: prepared.descriptor },
    visibleCutoffAt: at, closureReceipt: { version: 1, status: 'verified', sourceBasis: basis(publication), ...binding,
      checkedAt: at, checks: { archive: true, photos: true, reviewHistory: true } },
    restore: { version: 1, archive: 'matter-report-archive', verified: true, ...binding } } };
}


async function fixture(t, { largeRuntime = false } = {}) {
  const appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'supabase-control-')));
  let stopModel = async () => {};
  t.after(async () => { await stopModel(); await fs.rm(appRoot, { recursive: true, force: true }); });
  const p = { base: 'a'.repeat(40), release: 'b'.repeat(40), sourceFiles: 3, sourceEnvironmentBytes: 0, builderFiles: 4, fixtureObjects: 2 };
  const baseServer = path.join(appRoot, 'server'), releaseRoot = path.join(baseServer, '.private/driver-report-app-releases', p.release), server = path.join(releaseRoot, 'server');
  const secret = 'fictional-private-' + 's'.repeat(40), commands = [], uploads = [], calls = [];
  await write(path.join(baseServer, '.env.local'), 'MONGODB_URI=' + secret + '\n');
  await write(path.join(baseServer, '.env'), 'MATTER_SUPABASE_SECRET=' + secret + '\n');
  const oldRoot = path.join(baseServer, '.private/driver-audits', 'c'.repeat(64));
  await write(path.join(oldRoot, 'sync.json'), { version: 1, root: oldRoot });
  const sourceFiles = ['source/api/fixture.mjs', 'source/integration/hosted/native-backend.mjs', 'source/integration/cloud/native-poll-progress.mjs'];
  const sourceBytes = Buffer.from('export {};\n'), source = { schemaVersion: 1, managedSourceExecutionHost: 'sidi', managedSourceExecutionAdmission: 'fixed-host-v1',
    files: sourceFiles.map(file => ({ path: file, bytes: sourceBytes.length, sha256: hash(sourceBytes) })), entrypoints: [] };
  p.source = hash(JSON.stringify(source));
  const builder = { version: 1, files: Object.fromEntries(Object.entries(builderModules).map(([name, body]) => [name, hash(body)])) };
  p.builder = hash(JSON.stringify(builder));
  const packageRoot = path.join(appRoot, 'original-packages');
  const baseline = await reportPackage(path.join(packageRoot, 'baseline/server-data'), 4);
  const candidate = await reportPackage(path.join(packageRoot, 'candidate/server-data'), 7);
  const current = await reportPackage(path.join(packageRoot, 'current/server-data'), 6, { largeRuntime });
  const previous = await reportPackage(path.join(packageRoot, 'previous/server-data'), 5);
  p.baseline = baseline.seed.manifestSha256; p.candidate = candidate.seed.manifestSha256;
  p.current = { revision: 6, manifest: current.seed.manifestSha256, generation: current.seed.pointer.generation };
  p.previous = { revision: 5, manifest: previous.seed.manifestSha256, generation: previous.seed.pointer.generation };
  p.collector = { revision:7, bodySha256:hash(JSON.stringify(candidate.publication)), sourceBasis:candidate.seed.sourceBasis };
  const rootId = hash(JSON.stringify(['driver-reports-supabase-sync-v1', p.release, p.source, p.builder, p.baseline, p.candidate]));
  const syncRoot = path.join(server, '.private/driver-audits', rootId), sourceRoot = path.join(server, '.private/driver-audit-source');
  const cache = path.join(syncRoot, 'work/archive-cache'); await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const original = Object.fromEntries(['CRON_SECRET', 'MATTER_SUPABASE_SECRET', 'MATTER_DELIVERY_API_KEY', 'AI_GATEWAY_API_KEY',
    'MATTER_DELIVERY_ENABLED', 'MATTER_PHOTO_READ_ENABLED', 'MATTER_PHOTO_GRADE_ENABLED', 'MATTER_GPS_ENABLED', 'MATTER_GPS_PUBLICATION_ENABLED']
    .map(name => [name, name.endsWith('_ENABLED') ? '0' : secret]));
  const sourceEnvironment = { ...original, MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY: cache, DRIVER_AUDIT_EXECUTION_HOST: 'sidi' };
  const sourceEnvironmentBytes = Buffer.from(JSON.stringify(sourceEnvironment)); p.sourceEnvironment = hash(sourceEnvironmentBytes); p.sourceEnvironmentBytes = sourceEnvironmentBytes.length;
  const sourceConfigRoot = path.join(sourceRoot, p.source), sourceConfig = { version: 1, root: sourceConfigRoot, runtimeRoot: path.join(sourceConfigRoot, 'runtime'),
    manifestSha256: p.source, nodeExecutable: '/usr/bin/node', nodeVersion: 'v22.23.4',
    environment: { path: path.join(sourceConfigRoot, 'environment.private.json'), sha256: p.sourceEnvironment }, gatewayCredential: { environmentKey: 'AI_GATEWAY_API_KEY' } };
  await write(sourceConfig.environment.path, sourceEnvironmentBytes); await write(path.join(sourceConfigRoot, 'source.json'), sourceConfig);
  await write(path.join(sourceConfig.runtimeRoot, 'manifest.private.json'), source);
  for (const name of sourceFiles) await write(path.join(sourceConfig.runtimeRoot, name), sourceBytes);
  const packages = [];
  for (const [role, pkg, target] of [['baseline-builder-input', baseline, path.join(syncRoot, 'baseline')],
    ['candidate', candidate, path.join(syncRoot, 'retained/candidate/server-data')],
    ['serving-current', current, path.join(syncRoot, 'retained/serving-current/server-data')],
    ['serving-previous', previous, path.join(syncRoot, 'retained/serving-previous/server-data')]]) {
    const from = role === 'baseline-builder-input' ? path.join(packageRoot, 'baseline/server-data') : path.join(path.dirname(pkg.seed.bundleRoot), 'server-data');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.cp(from, target, { recursive: true });
    const entries = JSON.parse(await fs.readFile(path.join(target, 'files.private.json'))), omitted = Object.keys(entries).find(name => /^archive-/.test(name));
    await fs.unlink(path.join(target, omitted));
    const files = [];
    for (const name of (await fs.readdir(target)).sort((a,b) => a.localeCompare(b))) { const body = await fs.readFile(path.join(target, name)); files.push({ name, sha256: hash(body), bytes: body.length }); }
    const inventorySha256 = hash(JSON.stringify(files)), missing = [entries[omitted]], mask = { version: 1, kind: 'archive-backed-package-presence-v1',
      manifestSha256: pkg.seed.manifestSha256, inventorySha256, declaredFiles: Object.keys(entries).length, physicalFiles: files.length, missingArchiveReferences: missing };
    const presence = path.join(syncRoot, 'retained/package-presence', role + '.private.json'), maskBytes = Buffer.from(JSON.stringify(mask)); await write(presence, maskBytes);
    const row = { role, root: target, files: files.length, bytes: files.reduce((n,f)=>n+f.bytes,0), inventorySha256, manifestSha256: pkg.seed.manifestSha256,
      archiveBackedManifest: true, privateDirectoryBoundary: syncRoot, declaredFiles: mask.declaredFiles, missingArchiveReferencesSha256: hash(JSON.stringify(missing)),
      archiveReferences: { path: presence, sha256: hash(maskBytes), bytes: maskBytes.length, locallyMissing: 1, remoteAvailabilityVerified: false } };
    if (role.startsWith('serving-')) {
      const folder = path.dirname(target); const raw = Buffer.from(JSON.stringify(pkg.seed));
      await write(path.join(folder, 'direct-seed.original.private.json'), raw);
      await fs.cp(pkg.seed.bundleRoot, path.join(folder, 'audit-objects'), { recursive: true });
      Object.assign(row, { collectorRevision: pkg.seed.collectorRevision, sourceBasis: pkg.seed.sourceBasis,
        originalDirectSeedSha256: hash(raw), originalAcceptedSha256: hash('fictional accepted'), descriptorVerified: true });
    }
    packages.push(row);
  }
  const codeRoot = path.join(syncRoot, 'builder'); for (const [name, body] of Object.entries(builderModules)) await write(path.join(codeRoot, name), body);
  await write(path.join(codeRoot, 'runtime-manifest.json'), builder); await write(path.join(syncRoot, 'validation-journals.private.json'), '{}');
  const sync = { version: 1, root: syncRoot, codeRoot, baselineRoot: path.join(syncRoot, 'baseline'), builderSha256: p.builder,
    rendererBuild: { path: path.join(syncRoot, 'baseline/build.private.json'), sha256: hash('{}') },
    journals: { path: path.join(syncRoot, 'validation-journals.private.json'), sha256: hash('{}') } };
  await write(path.join(syncRoot, 'sync.json'), sync);
  const lockBytes = Buffer.from('{"lockfileVersion":3}'); await write(path.join(server, 'package-lock.json'), lockBytes);
  await write(path.join(server, 'package.json'), '{"type":"module"}');
  const depBytes = Buffer.from('module.exports = "fictional isolated dependency";'); await write(path.join(server, 'node_modules/fictional/index.js'), depBytes);
  const dependencyInventory = { sha256: hash(JSON.stringify([{ name:'fictional',kind:'directory' },{ name:'fictional/index.js',kind:'file',sha256:hash(depBytes),bytes:depBytes.length,mode:0o600 }])), entries: 2, bytes: depBytes.length };
  const npm = { realpath: '/usr/share/nodejs/npm/bin/npm-cli.js', uid: 0, mode: 0o100644, bytes: 1000, sha256: hash('fictional trusted npm') };
  const dependencyReceipt = Buffer.from(JSON.stringify({ version:1,mode:'isolated-npm-ci-v1',packageLockSha256:hash(lockBytes),npmIdentitySha256:hash(JSON.stringify([npm.realpath,npm.sha256])),nodeExecutable:'/usr/bin/node',nodeVersion:'v22.23.4',inventory:dependencyInventory }));
  const dependencyReceiptPath = path.join(server,'.private/dependencies/receipt.private.json'); await write(dependencyReceiptPath,dependencyReceipt);
  const selected = { JWT_SECRET: secret, MATTER_SUPABASE_SECRET: secret, DRIVER_AUDIT_SUPABASE_SECRET: secret,
    DRIVER_AUDIT_EXECUTION_HOST:'sidi',DRIVER_AUDIT_DATA_STORE:'supabase',MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY:cache,
    DRIVER_AUDIT_RELEASE_SHA:p.release,DRIVER_AUDIT_ENABLED:'0',DRIVER_AUDIT_IMPORT_ENABLED:'0',DRIVER_AUDIT_REPLICA_GC_ENABLED:'0' };
  const envBytes = Buffer.from(Object.entries(selected).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n'); await write(path.join(server,'.env.local'),envBytes);
  const oldConfigBytes = await fs.readFile(path.join(oldRoot,'sync.json'));
  const bootstrap = gzipSync(Buffer.from(JSON.stringify({ version:1,releaseSha:p.release,packageLockSha256:hash(lockBytes),expected:{syncConfigSha256:hash(oldConfigBytes)} })));
  p.bootstrap = hash(bootstrap); p.bootstrapBytes = bootstrap.length; await write(path.join(syncRoot,'retained/bootstrap.private.json.gz'),bootstrap);
  await write(path.join(syncRoot,'retained/original-sync.private.json'),oldConfigBytes);
  const receipt = { version:1,kind:'supabase-sidi-host-staging-receipt-v1',releaseRoot,releaseSha:p.release,syncRoot,rootId,
    syncConfig:path.join(syncRoot,'sync.json'),sourceConfig:path.join(sourceConfigRoot,'source.json'),nodeExecutable:'/usr/bin/node',nodeVersion:'v22.23.4',bootstrapSha256:p.bootstrap,
    packages,sourceManifestSha256:p.source,builderSha256:p.builder,sourceEnvironmentSha256:p.sourceEnvironment,appEnvironmentSha256:hash(envBytes),
    dependencies:{path:path.join(server,'node_modules'),mode:'isolated-npm-ci-v1',packageLockSha256:hash(lockBytes),receiptPath:dependencyReceiptPath,receiptSha256:hash(dependencyReceipt),inventory:dependencyInventory},
    seedSelected:false,registrationsChanged:false,workersStarted:false,routingChanged:false };
  const receiptBytes = Buffer.from(JSON.stringify(receipt)); await write(path.join(syncRoot,'staging.private.json'),receiptBytes);
  for (const folder of [path.join(baseServer,'.private/driver-audit-source'),path.join(baseServer,'.private/driver-report-supabase-handoff')]) await fs.mkdir(folder,{recursive:true,mode:0o700});
  const nginx = path.join(appRoot,'nginx.conf'); await write(nginx,'events {}\nhttp {}\n');
  const pm2Home = path.join(appRoot,'.pm2'); await fs.mkdir(pm2Home,{mode:0o700});
  const rows = [{name:'matter-delivery-api',pm_id:1,pid:100,pm2_env:{status:'online',pm_cwd:appRoot,pm_exec_path:'/usr/bin/npm',args:['start','--prefix','server'],pm_uptime:1,env:{}}},
    {name:'matter-driver-audit-sync',pm_id:2,pid:0,pm2_env:{status:'stopped',pm_cwd:baseServer,pm_exec_path:path.join(baseServer,'scripts/driverAuditSync.js'),args:['--config',path.join(oldRoot,'sync.json')],exec_interpreter:'/usr/bin/node',node_args:[],env:{},NODE_OPTIONS:'--max-old-space-size=1024'}}];
  await write(path.join(pm2Home,'dump.pm2'),rows); await write(path.join(pm2Home,'dump.pm2.bak'),rows);
  const states = new Map([['collector-state',{revision:7,body:JSON.stringify(candidate.publication)}],['photo-grading-budget',{revision:9,body:'{"uncertain":["fictional-retained-attempt"]}'}]]);
  const receipts = new Map([current,previous,candidate].map(pkg=>[pkg.seed.collectorRevision,{revision:pkg.seed.collectorRevision,body_text:JSON.stringify(pkg.publication),body_sha256:hash(JSON.stringify(pkg.publication)),event_text:'{}',event_id:'fictional-receipt-'+pkg.seed.collectorRevision,request_sha256:hash('request-'+pkg.seed.collectorRevision)}]));
  const objects = new Map(), reservations = new Map(); let lostAck=false, nextId=3;
  async function rpc(name,args){calls.push({name,args:structuredClone(args)});
    if(name==='matter_hosted_state_read'){const row=states.get(args.p_key)??{revision:0,body:null};return{revision:row.revision,body_text:row.body};}
    if(name==='matter_hosted_state_read_if_changed'){const row=states.get(args.p_key)??{revision:0,body:null};return{revision:row.revision,body_text:row.revision===args.p_revision?null:row.body,unchanged:row.revision===args.p_revision};}
    if(name==='matter_hosted_state_receipts')return[...receipts.values()].filter(row=>row.revision>args.p_after).sort((a,b)=>a.revision-b.revision).slice(0,1);
    if(name==='matter_hosted_state_cas'){assert.equal(args.p_key,'app-sidi-report-head');if(f.failPublication){f.failPublication=false;throw Error('Fictional precommit failure');}const old=states.get(args.p_key)??{revision:0,body:null};if(old.revision!==args.p_expected)throw Object.assign(Error('Conflict'),{status:409});const row={revision:old.revision+1,body:args.p_body_text};states.set(args.p_key,row);if(lostAck){lostAck=false;throw Error('Lost ACK');}return{revision:row.revision,body_text:row.body,body_sha256:hash(row.body),event_text:args.p_event_text,replayed:false};}
    if(name==='matter_hosted_archive_capacity')return{used_bytes:0,requested_bytes:args.p_requested_bytes,limit_bytes:60000000000,allowed:true};
    if(name==='matter_hosted_archive_reserve'){const row={id:args.p_id,reserved_bytes:args.p_reserved_bytes,consumed_bytes:0,released:false};reservations.set(args.p_id,row);return{...row};}
    if(name==='matter_hosted_archive_consume'){const row=reservations.get(args.p_id);row.consumed_bytes+=args.p_bytes;return{...row};}
    if(name==='matter_hosted_archive_release'){const row=reservations.get(args.p_id);row.released=true;return{...row};}
    throw Error('Unexpected fixture RPC '+name);
  }
  const archive={managedReadCache:true,assertPrivate:async()=>({bucket:'matter-report-archive',public:false}),async readObject(key,{maxBytes}){const body=objects.get(key);if(!body)throw Object.assign(Error('Missing fixture archive'),{code:'storage_not_found'});assert(body.length<=maxBytes);return[Buffer.from(body)];},async putVerifiedObject(key,body){objects.set(key,Buffer.from(body));uploads.push(key);await f.afterArchivePut?.(key);return{key,sha256:hash(body),bytes:body.length,verified:true};}};
  const usage=()=>({version:1,basis:'supabase-http-bytes-v1',month:{period:'2026-11',usedBytes:10,reservedBytes:0,limitBytes:8*1024**3},day:{period:'2026-11-17',usedBytes:10,reservedBytes:0,limitBytes:512*1024**2},activeReservations:0,uncertainReservations:0});
  const backend={kind:'supabase',executionHost:'sidi',executionAdmission:'fixed-host-v1',transferAccounting:'supabase-http-bytes-v1',rpc,rpcForResponseLimit:()=>rpc,archive,archiveCacheDirectory:cache,archiveReadBudget:{reserve:async()=>({allowed:true}),settle:async()=>({settled:true})},readTransferUsage:async()=>usage()};
  const proof={version:1,kind:'driver-report-source-environment-off-host-backup-v1',verified:true,releaseSha:p.release,bootstrapSha256:p.bootstrap,sourceManifestSha256:p.source,environmentSha256:p.sourceEnvironment,originalEnvironmentValuesMatched:9,backup:{kind:'owner-private-recovery-volume',readbackReceiptSha256:hash('independent readback fixture'),environmentSha256:p.sourceEnvironment,environmentBytes:p.sourceEnvironmentBytes,bootstrapSha256:p.bootstrap,bootstrapBytes:p.bootstrapBytes},verifiedAt:'2026-11-12T00:00:00.000Z'};
  const proofBytes=gzipSync(Buffer.from(JSON.stringify(proof)));p.backupProof=hash(proofBytes);objects.set(p.backupProof+'.gz',proofBytes);
  const fixtureObjects=[Buffer.from('fictional replay object one'),Buffer.from('fictional replay object two')];for(const b of fixtureObjects)objects.set(hash(b)+'.gz',b);
  const savedState=Buffer.from('{"rows":[]}'),fixtureBytes=gzipSync(Buffer.from(JSON.stringify({version:1,runtimeManifestSha256:p.source,savedState:{dataBase64:savedState.toString('base64'),sha256:hash(savedState)},objects:fixtureObjects.map(b=>({key:hash(b)+'.gz',bytes:b.length})),expected:{reportHash:hash('replay-report'),generation:hash('replay-generation'),retainedSignature:hash('replay-retained'),records:1,history:1,acceptedGrades:1,sourceRows:1,writeKeys:[hash(fixtureObjects[0])+'.gz']}})));
  p.fixture=hash(fixtureBytes);objects.set(p.fixture+'.gz',fixtureBytes);
  const adapters={platform:'linux',pins:p,node:{executable:'/usr/bin/node',version:'v22.23.4'},systemFile:async()=>npm,pm2Home,nginxFiles:[nginx],shell:{PATH:'/usr/bin:/bin',MONGODB_URI:secret},wait:async()=>{},inspectProcess:async()=>{},listenerFor:async pid=>pid?rows.some(row=>row.pid===pid&&row.name==='matter-driver-reports-api'):!rows.some(row=>row.name==='matter-driver-reports-api'&&row.pid),fetch:async()=>{const head=JSON.parse(states.get('app-sidi-report-head').body);return new Response(JSON.stringify({service:'driver-reports',dataStore:'supabase',executionHost:'sidi',ready:true,generation:head.generation,reportHash:head.reportHash,collectorRevision:head.servingPackage.collectorRevision,release:p.release}));}};
  const f={appRoot,baseServer,releaseRoot,server,syncRoot,sourceRoot,sourceConfig,p,receipt,receiptBytes,selected,original,rows,commands,calls,uploads,states,objects,archive,backend,pm2Home,secret,adapters,current,previous,candidate,usage,loseNextAck(){lostAck=true;}};
  let model;
  stopModel=async()=>{if(model){const active=model;model=undefined;active.controller.abort();await active.tick;await active.worker.close();}};
  const startModel=async()=>{
    assert.equal(model,undefined);const controller=new AbortController();
    const worker=await createDriverAuditSupabaseSync({config:sync,file:receipt.syncConfig,backend,signal:controller.signal});
    model={controller,worker,tick:worker.tick().catch(()=>{})};
  };
  f.modelActive=()=>Boolean(model);
  adapters.load=async name=>{
    if(name==='node_modules/dotenv/lib/main.js')return dotenv;
    if(name==='vendor/driver-audits/integration/hosted/worker-lock.mjs')return{acquireWorkerLock};
    if(name==='services/driverAuditTransferCodec.js')return{sealTransferSecrets};
    if(name==='services/driverAuditSupabaseAppBackend.js')return{createDriverAuditSupabaseAppBackend:async()=>backend};
    if(name==='services/driverAuditSupabaseReplica.js')return{createDriverAuditSupabaseReplica,verifyDriverAuditSupabaseServingPackage};
    if(name==='services/driverAuditSupabaseSync.js')return{createDriverAuditSupabaseSync};
    if(name==='integration/cloud/automatic-release.mjs')return{automaticReleaseBasis:basis};
    if(name==='vendor/driver-audits/integration/cloud/cloud-state.mjs')return{createCloudState};
    if(name==='services/driverAuditHeavyWork.js')return{withDriverAuditHeavyWork};
    if(name==='services/driverAuditSource.js')return{readDriverAuditSourceConfig:async()=>({...sourceConfig,file:path.join(sourceConfigRoot,'source.json'),configSha256:hash(await fs.readFile(path.join(sourceConfigRoot,'source.json'))),environmentReference:sourceConfig.environment,environment:sourceEnvironment,runtime:source,dataStore:'supabase',executionHost:'sidi',archiveCacheDirectory:cache})};
    if(name==='scripts/driverAuditSourceQualify.js')return{verifyDriverAuditSourceHostQualification};
    throw Error('Unexpected fixture import '+name);
  };
  adapters.exec=async(file,args,options)=>{
    commands.push({file,args,options});
    if(file==='git'){
      if(args.includes('show')){assert(args.at(-1).startsWith('HEAD:server/'));assert.equal(options.encoding,'buffer');assert.equal(options.maxBuffer,512*1024);
        return{stdout:await fs.readFile(path.join(args[1],args.at(-1).slice(5)))};}
      return{stdout:args[2]==='rev-parse'?(args[3]==='--show-toplevel'?args[1]:args[1]===appRoot?p.base:p.release)+'\n':''};
    }
    if(file==='pm2'){
      if(args[0]==='jlist')return{stdout:JSON.stringify(rows)};
      if(args[0]==='save'){await write(path.join(pm2Home,'dump.pm2'),rows);return{stdout:''};}
      if(args[0]==='delete'){const i=rows.findIndex(row=>row.pm_id===Number(args[1]));assert(i>=0);rows.splice(i,1);return{stdout:''};}
      if(args[0]==='stop'||args[0]==='restart'){
        const row=rows.find(row=>row.pm_id===Number(args[1])||row.name===args[1]);assert(row);
        if(row.name==='matter-driver-audit-sync'){
          await assert.rejects(acquireWorkerLock(path.join(server,'.private/driver-audit-heavy-work/work.lock')),/Collector already active/);
          if(args[0]==='stop'){if(f.failStops){f.failStops--;throw Error('Transient fixture stop failure');}await stopModel();}
          else await startModel();
        }
        row.pid=args[0]==='stop'?0:500+row.pm_id;row.pm2_env.status=args[0]==='stop'?'stopped':'online';return{stdout:''};
      }
      if(args[0]==='start'){
        const name=args[args.indexOf('--name')+1],isSync=name==='matter-driver-audit-sync';
        if(isSync)await assert.rejects(acquireWorkerLock(path.join(server,'.private/driver-audit-heavy-work/work.lock')),/Collector already active/);
        const row={name,pm_id:nextId++,pid:500+nextId,pm2_env:{status:'online',pm_cwd:args[args.indexOf('--cwd')+1],pm_exec_path:args[1],exec_interpreter:args[args.indexOf('--interpreter')+1],node_args:[],args:isSync?args.slice(args.indexOf('--')+1):[],env:{},...(options.env.NODE_OPTIONS?{NODE_OPTIONS:options.env.NODE_OPTIONS}:{})}};
        rows.push(row);
        if(isSync){await startModel();if(f.loseSyncStartAck){f.loseSyncStartAck=false;throw Error('Lost managed start acknowledgement');}}
        return{stdout:''};
      }
      throw Error('Unexpected PM2 fixture command');
    }
    if(file==='/usr/bin/node'&&args[0]===path.join(server,'scripts/driverAuditSync.js')){
      assert.deepEqual(args.slice(1),['--config',receipt.syncConfig,'--seed-only']);assert.equal(options.env.MONGODB_URI,undefined);
      const worker=await createDriverAuditSupabaseSync({config:sync,file:receipt.syncConfig,backend,signal:options.signal});
      try{const result=await worker.seed();return{stdout:JSON.stringify({status:result.status,dataStore:'supabase',executionHost:'sidi',activeGeneration:result.head.generation})};}finally{await worker.close();}
    }
    if(file==='/usr/bin/node'&&args[0]===path.join(server,'scripts/driverAuditSourceDeploy.js'))return f.qualify(args,options);
    throw Error('Unexpected fixture executable '+file);
  };
  f.qualify=async(args,options)=>{
    assert.deepEqual(args,[path.join(server,'scripts/driverAuditSourceDeploy.js'),'audit-source-qualify-held']);
    assert.equal(options.env.MONGODB_URI,undefined);assert.equal(options.env.DRIVER_AUDIT_DEPLOY_SHA,p.release);
    assert.equal(options.env.DRIVER_AUDIT_SOURCE_MANIFEST,p.source);assert.equal(options.env.DRIVER_AUDIT_SOURCE_QUALIFICATION_SHA256,p.fixture);
    const deployment=await acquireWorkerLock(path.join(sourceRoot,'source-deployment.lock'));
    try{return await withDriverAuditHeavyWork({root:path.join(server,'.private/driver-audit-heavy-work'),owner:'source',signal:options.signal},async()=>{
      const row=rows.find(row=>row.name==='matter-driver-audit-sync');assert.equal(row.pm2_env.status,'stopped');
      let temporary;
      try{
        await adapters.exec('pm2',['restart',String(row.pm_id)],{env:options.env});
        temporary=await fs.mkdtemp(path.join(sourceConfigRoot,'qualification-fixture-'));
        const saved=await stageDriverAuditQualification({root:temporary,fixtureSha256:p.fixture,runtimeManifestSha256:p.source,archive,signal:options.signal});
        const sourceReceipt={status:'verified',platform:'linux',nodeVersion:'v22.23.4',networkAttempts:0,executionAdmission:'fixed-host-v1',executionLedgersPreserved:true,
          managedArchiveCache:true,archiveCacheEnabled:true,dataStore:'supabase',executionHost:'sidi',transferAccounting:'supabase-http-bytes-v1',pollProgressDuplicateFree:true,outputObjects:0,failureKind:'progress',failureRetry:true,archiveReads:{requests:5,bytes:500}};
        const measurements=Object.fromEntries(['source','builder','source-after-builder'].map(phase=>[phase,{samples:1,peakApiRssBytes:1,peakSyncRssBytes:1,minimumAvailableBytes:1024**3}]));
        const result={version:1,status:f.partialQualification?'partial':'verified',verified:!f.partialQualification,checkedAt:new Date().toISOString(),
          fixtureSha256:p.fixture,commit:p.release,configSha256:hash(await fs.readFile(path.join(sourceConfigRoot,'source.json'))),manifestSha256:p.source,environmentSha256:p.sourceEnvironment,
          nodeExecutable:'/usr/bin/node',nodeVersion:'v22.23.4',source:sourceReceipt,sourceAfterBuilder:{...sourceReceipt,failureKind:null,archiveReads:{requests:1,bytes:50}},
          builder:{status:'verified',platform:'linux',networkAttempts:0,builderSha256:p.builder,rendererSha256:hash('{}'),journalsSha256:hash('{}'),nodeExecutable:'/usr/bin/node',nodeVersion:'v22.23.4',nodeArgs:['--max-old-space-size=1024'],managedArchiveCache:true,archiveCacheEnabled:true,dataStore:'supabase',executionHost:'sidi'},
          sourceArchiveCacheDirectory:cache,dataStore:'supabase',executionHost:'sidi',transferAccounting:'supabase-http-bytes-v1',transferUsage:{before:usage(),after:usage()},measurements,fixtureArchive:{objects:saved.objects,bytes:saved.objectBytes}};
        if(f.mutateQualification)f.mutateQualification(result);
        const raw=Buffer.from(JSON.stringify(result));await write(path.join(sourceConfigRoot,'qualification-'+p.fixture+'.private.json'),raw);
        return{stdout:JSON.stringify({...result,receiptSha256:hash(raw)})};
      }finally{
        await adapters.exec('pm2',['stop',String(row.pm_id)],{env:options.env});await adapters.exec('pm2',['save'],{env:options.env});
        if(temporary)await fs.rm(temporary,{force:true,recursive:true});
      }
    });}finally{await deployment.release();}
  };
  // The real isolated child loads a fictional provider facade. Only provider
  // I/O is forwarded through its private IPC channel; the real Sync/Replica,
  // builder boundary, heap option, OS locks and child cleanup execute normally.
  await write(path.join(server,'services/driverAuditSupabaseSync.js'),`export {createDriverAuditSupabaseSync} from ${JSON.stringify(new URL('../../server/services/driverAuditSupabaseSync.js',import.meta.url).href)};`);
  await write(path.join(server,'services/driverAuditSupabaseAppBackend.js'),`
let next=0;const pending=new Map();process.on('message',message=>{if(message?.type!=='fixture-provider-result')return;const saved=pending.get(message.id);if(!saved)return;pending.delete(message.id);message.error?saved.reject(Object.assign(Error('Fictional provider failure'),message.error)):saved.resolve(message.result);});
const call=(method,args)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});process.send({type:'fixture-provider-call',id,method,args});});
export async function createDriverAuditSupabaseAppBackend({env}){const rpc=(name,args)=>call('rpc',{name,args});return{
kind:'supabase',executionHost:'sidi',executionAdmission:'fixed-host-v1',transferAccounting:'supabase-http-bytes-v1',rpc,rpcForResponseLimit:()=>rpc,
archiveCacheDirectory:env.MATTER_AUDIT_ARCHIVE_CACHE_DIRECTORY,archiveReadBudget:{reserve:async()=>({allowed:true}),settle:async()=>({settled:true})},
readTransferUsage:()=>call('usage',{}),archive:{managedReadCache:true,assertPrivate:()=>call('private',{}),
async readObject(key,options){return(await call('read',{key,maxBytes:options.maxBytes})).map(x=>Buffer.from(x,'base64'));},
putVerifiedObject:(key,bytes)=>call('put',{key,bytes:Buffer.from(bytes).toString('base64')})}};}
`);
  adapters.childExecutable=process.execPath;adapters.childVersion=process.version;
  adapters.spawn=(file,args,options)=>{
    assert.equal(file,process.execPath);assert.deepEqual(args.slice(0,2),['--input-type=module','-e']);
    assert.equal(options.env.NODE_OPTIONS,'--max-old-space-size=1024');assert.equal(options.env.MONGODB_URI,undefined);
    const child=spawn(file,args,options), emit=child.emit.bind(child);
    child.emit=(event,...values)=>{
      if(event!=='message'||values[0]?.type!=='fixture-provider-call')return emit(event,...values);
      const message=values[0];Promise.resolve().then(async()=>{
        const {method,args}=message;if(method==='rpc')return backend.rpc(args.name,args.args);
        if(method==='read'){const chunks=[];for await(const bytes of await archive.readObject(args.key,{maxBytes:args.maxBytes}))chunks.push(Buffer.from(bytes).toString('base64'));return chunks;}
        if(method==='put')return archive.putVerifiedObject(args.key,Buffer.from(args.bytes,'base64'));
        if(method==='usage')return backend.readTransferUsage();if(method==='private')return archive.assertPrivate();throw Error('Unexpected fixture provider request');
      }).then(result=>{if(child.connected)child.send({type:'fixture-provider-result',id:message.id,result});},error=>{if(child.connected)child.send({type:'fixture-provider-result',id:message.id,error:{...(error.code?{code:error.code}:{}),...(error.status?{status:error.status}:{})}});});
      return true;
    };
    f.lastChild=child;return child;
  };
  const receiptCodePaths=['scripts/driverAuditSync.js','services/driverAuditDataBackend.js',
    'vendor/driver-audits/integration/hosted/supabase-archive.mjs','vendor/driver-audits/integration/cloud/driver-audit-handoff.mjs'];
  const targetCodePaths=[...receiptCodePaths,'services/driverAuditSupabaseAppBackend.js','services/driverAuditSupabaseArchive.js'];
  for(const name of targetCodePaths){
    const bytes=await fs.readFile(new URL('../../server/'+name,import.meta.url));await write(path.join(baseServer,name),bytes);
    if(name!=='services/driverAuditSupabaseAppBackend.js')await write(path.join(server,name),bytes);
  }
  const namespace=async(root,names)=>({archiveIdentitySha256:hash(JSON.stringify({project:'https://trhhjfgfmxofxhnzocks.supabase.co',bucket:'matter-report-archive'})),
    files:await Promise.all(names.map(async name=>{const bytes=await fs.readFile(path.join(root,name));return{name,sha256:hash(bytes),bytes:bytes.length};}))});
  const retainedBytes=Buffer.from('fictional independently verified historical archive object'),retainedKey=hash(retainedBytes)+'.gz';objects.set(retainedKey,retainedBytes);
  const receiptRoot=path.join(oldRoot,'archive-receipts'),receiptArchive=createVerifiedAuditArchive({receiptRoot,remote:{async readObject(key){assert.equal(key,retainedKey);return[retainedBytes];}}});
  await receiptArchive.verify(retainedKey,retainedBytes.length);
  const receiptName=retainedKey+'.json',receiptBody=await fs.readFile(path.join(receiptRoot,receiptName)),stat=await fs.stat(path.join(receiptRoot,receiptName),{bigint:true});
  const receiptRows=[{name:receiptName,sha256:hash(receiptBody),bytes:receiptBody.length,objectBytes:retainedBytes.length}];
  await write(path.join(syncRoot,'archive-receipts',receiptName),receiptBody);
  const sourceNamespace=await namespace(baseServer,receiptCodePaths),targetNamespace=await namespace(server,targetCodePaths);
  const envPin=await Promise.all(['.env','.env.local'].map(async name=>hash(await fs.readFile(path.join(baseServer,name)))));
  const prefix={version:1,kind:'retained-supabase-archive-receipts-v1',stagingReceiptSha256:hash(receiptBytes),
    source:{applicationCommit:p.base,syncRoot:oldRoot,syncConfigSha256:hash(oldConfigBytes),dataStore:'supabase',environmentPin:envPin,
      runtimeSelectionSha256:hash(JSON.stringify([2,'supabase',null,'--max-old-space-size=1024',hash(secret)])),...sourceNamespace,
      directoryPresent:true,inventorySha256:hash(JSON.stringify(receiptRows)),physicalInventorySha256:hash(JSON.stringify([{name:receiptName,
        physicalSignature:[stat.dev,stat.ino,stat.uid,stat.gid,stat.mode,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(':')}]))},
    destination:{releaseSha:p.release,root:path.join(syncRoot,'archive-receipts'),...targetNamespace},receipts:receiptRows,
    retainedVerificationMetadataBytes:receiptBody.length,originalVerifiedObjectBytes:retainedBytes.length,
    freshRemoteObjectBytesVerified:false,remoteAvailabilityAsserted:false,originalReceiptsChanged:false};
  const prefixFile=path.join(syncRoot,'retained/archive-verification-receipts.private.json');await write(prefixFile,prefix);
  Object.assign(f,{prefix,prefixFile,oldReceiptRoot:receiptRoot,retainedReceiptName:receiptName});
  f.run=async(operation,extra={})=>{
    const result=await operator.runDriverAuditSupabaseControl({operation,appRoot,expectedSha:p.base,preparedReceiptSha256:hash(receiptBytes),recipientPublicKey,
      ...(['held-qualify-source','run-report-once'].includes(operation)?{qualificationFixtureSha256:p.fixture,environmentBackupProofSha256:p.backupProof}:{}),
      ...(operation==='run-report-once'?{qualificationReceiptSha256:f.qualificationReceiptSha256}:{}),...extra},adapters);
    if(operation==='held-qualify-source')f.qualificationReceiptSha256=JSON.parse(gunzipSync(Buffer.from(openTransferSecrets(privateKey,result.capsule).metadataGzipBase64,'base64'))).result.receiptSha256;
    return result;
  };
  return f;
}

test('prepare-serving uses the actual Sync and Replica to publish current plus previous in one CAS without selecting the newer candidate', async t => {
  const f = await fixture(t), source = structuredClone(f.states.get('collector-state')), paid = structuredClone(f.states.get('photo-grading-budget'));
  const result = await f.run('prepare-serving'); assert.equal(result.status, 'serving-prepared');
  const head = JSON.parse(f.states.get('app-sidi-report-head').body);
  assert.equal(head.servingPackage.collectorRevision, f.p.current.revision); assert.equal(head.previous.servingPackage.collectorRevision, f.p.previous.revision);
  assert.equal(head.generation, f.p.current.generation); assert.notEqual(head.generation, f.candidate.seed.pointer.generation);
  assert.equal(f.calls.filter(row=>row.name==='matter_hosted_state_cas').length, 1);
  assert.deepEqual(f.states.get('collector-state'), source); assert.deepEqual(f.states.get('photo-grading-budget'), paid);
  assert.equal(dotenv.parse(await fs.readFile(path.join(f.server,'.env.local'))).DRIVER_AUDIT_ENABLED,'0');
  assert(f.commands.filter(row=>row.file==='pm2').every(row=>row.args[0]==='jlist'));
  assert.equal(result.sourceStarted,false); assert.equal(result.routingChanged,false); assert.equal(result.sourceReleasePending,true);
  const capsule = openTransferSecrets(privateKey,result.capsule), {gunzipSync}=await import('node:zlib');
  const raw=gunzipSync(Buffer.from(capsule.metadataGzipBase64,'base64')); assert.equal(hash(raw),result.metadataSha256);
  assert(!raw.includes(Buffer.from(f.secret))); assert(!JSON.stringify(result).includes(f.appRoot));
});

async function runtimeParts(f, role, name) {
  const row = f.receipt.packages.find(item => item.role === role), folder = path.dirname(row.root);
  const seed = JSON.parse(await fs.readFile(path.join(folder, 'direct-seed.original.private.json')));
  const descriptor = JSON.parse(await fs.readFile(path.join(folder, 'audit-objects', seed.pointer.descriptor.sha256 + '.gz')));
  const ref = descriptor.files[name]; assert(ref); return { row, folder, ref, file: path.join(row.root, name) };
}

async function retainedObjectInventory(f) {
  const values = [];
  for (const role of ['serving-current', 'serving-previous']) {
    const folder = path.join(f.syncRoot, 'retained', role, 'audit-objects');
    for (const name of (await fs.readdir(folder)).sort()) {
      const file = path.join(folder, name), bytes = await fs.readFile(file), stat = await fs.stat(file, { bigint: true });
      values.push({ role, name, sha256: hash(bytes), bytes: bytes.length, inode: String(stat.ino), mode: String(stat.mode), mtimeNs: String(stat.mtimeNs) });
    }
  }
  return values;
}

test('serving preparation links an exact missing whole-runtime chunk only into selected objects and seeds both genuine heads', async t => {
  const f = await fixture(t), part = await runtimeParts(f, 'serving-previous', 'publication.private.json');
  assert.equal(part.ref.chunks.length, 1); const key = part.ref.chunks[0].sha256 + '.gz';
  await fs.unlink(path.join(part.folder, 'audit-objects', key));
  const inventory = await retainedObjectInventory(f), before = await fs.stat(part.file, { bigint: true });
  const originals = new Map([f.prefixFile, path.join(f.syncRoot, 'staging.private.json'), path.join(part.row.root, 'files.private.json')]
    .map(file => [file, null])); for (const file of originals.keys()) originals.set(file, await fs.readFile(file));
  const source = structuredClone(f.states.get('collector-state')), paid = structuredClone(f.states.get('photo-grading-budget'));
  assert.equal((await f.run('prepare-serving')).status, 'serving-prepared');
  const seed = JSON.parse(await fs.readFile(path.join(f.syncRoot, 'seed.json'))), selected = path.join(seed.bundleRoot, key);
  const after = await fs.stat(selected, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev); assert.equal(after.mode, before.mode); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(hash(await fs.readFile(selected)), part.ref.sha256);
  assert.deepEqual(await retainedObjectInventory(f), inventory);
  for (const [file, bytes] of originals) assert.deepEqual(await fs.readFile(file), bytes);
  const head = JSON.parse(f.states.get('app-sidi-report-head').body);
  assert.equal(head.servingPackage.collectorRevision, f.p.current.revision); assert.equal(head.previous.servingPackage.collectorRevision, f.p.previous.revision);
  assert.deepEqual(f.states.get('collector-state'), source); assert.deepEqual(f.states.get('photo-grading-budget'), paid);
  const accepted = structuredClone(f.states.get('app-sidi-report-head')); await f.run('prepare-serving');
  assert.deepEqual(f.states.get('app-sidi-report-head'), accepted); await f.run('start-report');
  assert.equal(f.rows.find(row => row.name === 'matter-driver-audit-source'), undefined);
});

test('missing partial runtime chunks use only exact bounded selected-cache bytes while the actual seed worker validates every chunk', async t => {
  const f = await fixture(t, { largeRuntime: true }), part = await runtimeParts(f, 'serving-current', 'deferred-large.private.bin');
  assert.equal(part.ref.chunks.length, 2);
  for (const chunk of part.ref.chunks) await fs.unlink(path.join(part.folder, 'audit-objects', chunk.sha256 + '.gz'));
  const inventory = await retainedObjectInventory(f), original = await fs.readFile(part.file), before = await fs.stat(part.file, { bigint: true });
  await f.run('prepare-serving');
  const seed = JSON.parse(await fs.readFile(path.join(f.syncRoot, 'seed.json')));
  for (const chunk of part.ref.chunks) {
    const file = path.join(seed.bundleRoot, chunk.sha256 + '.gz'), bytes = await fs.readFile(file), stat = await fs.stat(file, { bigint: true });
    assert(bytes.equals(original.subarray(chunk.offset, chunk.offset + chunk.size))); assert.equal(hash(bytes), chunk.sha256);
    assert.notEqual(stat.ino, before.ino); assert.equal(stat.mode & 0o777n, 0o600n);
  }
  assert.deepEqual(await fs.readFile(part.file), original); assert.deepEqual(await retainedObjectInventory(f), inventory);
  assert.equal(JSON.parse(f.states.get('app-sidi-report-head').body).servingPackage.collectorRevision, f.p.current.revision);
});

test('a failed seed retries exact existing derived chunks without claiming or reserving extra disk bytes', async t => {
  const f = await fixture(t, { largeRuntime: true }), part = await runtimeParts(f, 'serving-current', 'deferred-large.private.bin');
  for (const chunk of part.ref.chunks) await fs.unlink(path.join(part.folder, 'audit-objects', chunk.sha256 + '.gz'));
  f.failPublication = true; await assert.rejects(f.run('prepare-serving'), /Supabase control stopped at seed-cli/);
  assert.equal(f.states.has('app-sidi-report-head'), false);
  const seed = JSON.parse(await fs.readFile(path.join(f.syncRoot, 'seed.json'))), before = [];
  for (const chunk of part.ref.chunks) before.push(await fs.stat(path.join(seed.bundleRoot, chunk.sha256 + '.gz'), { bigint: true }));
  const statfs = fs.statfs; fs.statfs = async () => ({ bavail: 0n, bsize: 4096n });
  try { assert.equal((await f.run('prepare-serving')).status, 'serving-prepared'); } finally { fs.statfs = statfs; }
  for (const [index, chunk] of part.ref.chunks.entries()) {
    const after = await fs.stat(path.join(seed.bundleRoot, chunk.sha256 + '.gz'), { bigint: true });
    assert.equal(after.ino, before[index].ino); assert.equal(after.mtimeNs, before[index].mtimeNs);
  }
  assert(!(await fs.readdir(seed.bundleRoot)).some(name => name.startsWith('.runtime-derived-')));
});

test('insufficient derived-cache space fails before seed admission and preserves retained objects', async t => {
  const f = await fixture(t, { largeRuntime: true }), part = await runtimeParts(f, 'serving-current', 'deferred-large.private.bin');
  for (const chunk of part.ref.chunks) await fs.unlink(path.join(part.folder, 'audit-objects', chunk.sha256 + '.gz'));
  const inventory = await retainedObjectInventory(f), statfs = fs.statfs; fs.statfs = async () => ({ bavail: 0n, bsize: 4096n });
  try { await assert.rejects(f.run('prepare-serving'), /Supabase control stopped at select-local-seed/); } finally { fs.statfs = statfs; }
  assert.equal(f.states.has('app-sidi-report-head'), false); assert.deepEqual(await retainedObjectInventory(f), inventory);
  await assert.rejects(fs.access(path.join(f.syncRoot, 'seed.json')), { code: 'ENOENT' });
});

test('an independently changed selected partial chunk is preserved and cannot be hidden by a valid original runtime', async t => {
  const f = await fixture(t, { largeRuntime: true }), part = await runtimeParts(f, 'serving-current', 'deferred-large.private.bin');
  for (const chunk of part.ref.chunks) await fs.unlink(path.join(part.folder, 'audit-objects', chunk.sha256 + '.gz'));
  f.failPublication = true; await assert.rejects(f.run('prepare-serving'), /Supabase control stopped at seed-cli/);
  const seed = JSON.parse(await fs.readFile(path.join(f.syncRoot, 'seed.json'))), file = path.join(seed.bundleRoot, part.ref.chunks[0].sha256 + '.gz');
  await fs.writeFile(file, 'independent selected cache edit');
  await assert.rejects(f.run('prepare-serving'), /Supabase control stopped at select-local-seed/);
  assert.equal(await fs.readFile(file, 'utf8'), 'independent selected cache edit'); assert.equal(f.states.has('app-sidi-report-head'), false);
});

test('existing bundle corruption never falls through to a valid runtime copy or admits a seed', async t => {
  const f = await fixture(t), part = await runtimeParts(f, 'serving-current', 'publication.private.json');
  const object = path.join(part.folder, 'audit-objects', part.ref.chunks[0].sha256 + '.gz'); await fs.writeFile(object, 'independent bad bundle bytes');
  await assert.rejects(f.run('prepare-serving'), /Supabase control stopped at seed-inputs/);
  assert.equal(await fs.readFile(object, 'utf8'), 'independent bad bundle bytes');
  assert.equal(f.states.has('app-sidi-report-head'), false); assert.equal(f.calls.length, 0);
  await assert.rejects(fs.access(path.join(f.syncRoot, 'seed.json')), { code: 'ENOENT' });
});

test('a runtime pathname swap during fallback stops before publication without reading or changing outside bytes', async t => {
  const f = await fixture(t), part = await runtimeParts(f, 'serving-previous', 'publication.private.json');
  const missing = path.join(part.folder, 'audit-objects', part.ref.chunks[0].sha256 + '.gz'); await fs.unlink(missing);
  const outside = path.join(f.appRoot, 'outside-runtime.private.json'); await write(outside, 'outside private bytes');
  const open = fs.open, lstat = fs.lstat; let eligible = false, reached = false, outsideReads = 0;
  fs.lstat = async (file, ...args) => { try { return await lstat(file, ...args); } catch (error) {
    if (file === missing && error.code === 'ENOENT') eligible = true; throw error;
  } };
  fs.open = async (file, ...args) => {
    if (file === outside) outsideReads++;
    const fd = await open(file, ...args);
    if (eligible && !reached && file === part.file && args[0] === (fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)) {
      reached = true; await fs.rename(part.file, part.file + '.preserved'); await fs.symlink(outside, part.file);
    }
    return fd;
  };
  try { await assert.rejects(f.run('prepare-serving'), /Supabase control stopped/); } finally { fs.open = open; fs.lstat = lstat; }
  assert(reached); assert.equal(outsideReads, 0); assert.equal(await fs.readFile(outside, 'utf8'), 'outside private bytes');
  assert.equal(f.states.has('app-sidi-report-head'), false);
});

test('a copied verification prefix must be admitted before any serving RPC and cannot be replaced by an unchecked verified flag',async t=>{
  const f=await fixture(t);await fs.rm(path.join(f.syncRoot,'retained/archive-verification-receipts.private.json'),{force:true});
  await assert.rejects(f.run('prepare-serving'),/Supabase control stopped at receipt-prefix/);assert.equal(f.calls.length,0);
});

test('copied-prefix receipt, namespace and source-runtime bindings reject drift before any remote state access',async t=>{
  for(const mutate of [p=>p.stagingReceiptSha256=hash('foreign stage'),p=>p.source.dataStore='mongo',p=>p.source.applicationCommit='f'.repeat(40),
    p=>p.source.syncConfigSha256=hash('different config'),p=>p.source.archiveIdentitySha256=hash('other project'),
    p=>p.destination.files[0].sha256=hash('other code'),p=>p.destination.root='/fictional/outside',p=>p.source.runtimeSelectionSha256=hash('other runtime'),
    p=>p.receipts[0].objectBytes++,p=>p.freshRemoteObjectBytesVerified=true,p=>p.remoteAvailabilityAsserted=true]){
    const f=await fixture(t),proof=structuredClone(f.prefix);mutate(proof);await write(f.prefixFile,proof);
    await assert.rejects(f.run('prepare-serving'),/Supabase control stopped at receipt-prefix/);assert.equal(f.calls.length,0);
  }
});

test('clean tracked legacy code with normal664 permissions is verified by exact Git blobs without changing original modes',async t=>{
  const f=await fixture(t),file=path.join(f.baseServer,'vendor/driver-audits/integration/hosted/supabase-archive.mjs');
  await fs.chmod(file,0o664);await f.run('prepare-serving');assert.equal((await fs.stat(file)).mode&0o777,0o664);
});

test('receipt namespace rejects dirty Git bytes and a changed HEAD before any serving RPC',async t=>{
  for(const kind of ['dirty','head']){
    const f=await fixture(t),execute=f.adapters.exec;let changed=false;
    f.adapters.exec=async(file,args,options)=>{
      if(file==='git'&&args[1]===f.appRoot&&args.includes('diff')&&args.includes('--no-textconv')&&kind==='dirty')throw Error('Fictional dirty tracked code');
      if(file==='git'&&args[1]===f.appRoot&&args.includes('rev-parse')&&changed)return{stdout:'f'.repeat(40)+'\n'};
      const result=await execute(file,args,options);if(file==='git'&&args[1]===f.appRoot&&args.includes('show')&&kind==='head')changed=true;return result;
    };
    await assert.rejects(f.run('prepare-serving'),/Supabase control stopped at receipt-prefix/);assert.equal(f.calls.length,0);
  }
});

test('old receipt physical or target-prefix changes remain untouched and cannot become inherited verification',async t=>{
  for(const kind of ['original-body','original-time','original-mode','target-body','target-link']){
    const f=await fixture(t),original=path.join(f.oldReceiptRoot,f.retainedReceiptName),target=path.join(f.syncRoot,'archive-receipts',f.retainedReceiptName);
    if(kind==='original-body'||kind==='target-body'){
      const file=kind==='original-body'?original:target,value=JSON.parse(await fs.readFile(file));value.bytes++;await write(file,value);
    }
    if(kind==='original-time')await fs.utimes(original,new Date(0),new Date(0));
    if(kind==='original-mode')await fs.chmod(original,0o644);
    if(kind==='target-link'){await fs.unlink(target);await fs.symlink(original,target);}
    await assert.rejects(f.run('prepare-serving'),/Supabase control stopped at receipt-prefix/);assert.equal(f.calls.length,0);
    if(kind==='original-mode')assert.equal((await fs.stat(original)).mode&0o777,0o644);
    if(kind==='target-link')assert((await fs.lstat(target)).isSymbolicLink());
  }
});

test('post-retarget prefix provenance requires the exact saved original registration and does not reinterpret the new Sync as the source',async t=>{
  const f=await readyForOneReport(t),planFile=path.join(f.syncRoot,'controls/sync-retarget-plan.private.json'),plan=JSON.parse(await fs.readFile(planFile));
  assert.equal(f.rows.find(row=>row.name==='matter-driver-audit-sync').pm2_env.pm_cwd,f.server);
  plan.originalRegistrationSha256=hash('foreign original registration');await write(planFile,plan);
  const before=structuredClone(f.states.get('app-sidi-report-head'));
  await assert.rejects(f.run('run-report-once'),/Supabase control stopped at receipt-prefix/);assert.deepEqual(f.states.get('app-sidi-report-head'),before);
});

test('lost seed acknowledgement and repeated preparation preserve the same remote head and original local selection', async t => {
  const f=await fixture(t);f.loseNextAck();await f.run('prepare-serving');
  const head=structuredClone(f.states.get('app-sidi-report-head')), seed=await fs.readFile(path.join(f.syncRoot,'seed.json')), uploads=f.uploads.length;
  await f.run('prepare-serving');assert.deepEqual(f.states.get('app-sidi-report-head'),head);
  assert.deepEqual(await fs.readFile(path.join(f.syncRoot,'seed.json')),seed);assert.equal(f.uploads.length,uploads);
  assert.equal(f.calls.filter(row=>row.name==='matter_hosted_state_cas').length,1);
});

test('starting the private report service changes only its isolated enable setting and leaves the main API and held workers intact', async t => {
  const f=await fixture(t);await f.run('prepare-serving');
  const main=structuredClone(f.rows[0]), oldSync=structuredClone(f.rows[1]), base=await fs.readFile(path.join(f.baseServer,'.env.local'));
  const result=await f.run('start-report');assert.equal(result.status,'report-started');
  assert.deepEqual(f.rows.find(row=>row.name==='matter-delivery-api'),main);
  assert.deepEqual(f.rows.find(row=>row.name==='matter-driver-audit-sync'),oldSync);
  assert.deepEqual(await fs.readFile(path.join(f.baseServer,'.env.local')),base);
  const enabled=dotenv.parse(await fs.readFile(path.join(f.server,'.env.local')));assert.equal(enabled.DRIVER_AUDIT_ENABLED,'1');
  assert.deepEqual({...enabled,DRIVER_AUDIT_ENABLED:'0'},f.selected);
  assert(!f.commands.some(row=>row.file==='pm2'&&row.args.includes('matter-driver-audit-source')));
  const starts=f.commands.filter(row=>row.file==='pm2'&&row.args[0]==='start').length;
  await f.run('start-report');assert.equal(f.commands.filter(row=>row.file==='pm2'&&row.args[0]==='start').length,starts);
});

test('held qualification retargets only the old stopped sync and keeps actual Sync work excluded through both modeled process lifecycles', async t => {
  const f=await fixture(t);await f.run('prepare-serving');await f.run('start-report');
  const head=structuredClone(f.states.get('app-sidi-report-head')),main=structuredClone(f.rows.find(row=>row.name==='matter-delivery-api'));
  const result=await f.run('held-qualify-source');assert.equal(result.status,'source-qualified');
  const sync=f.rows.find(row=>row.name==='matter-driver-audit-sync');assert.equal(sync.pm2_env.pm_exec_path,path.join(f.server,'scripts/driverAuditSync.js'));
  assert.equal(sync.pid,0);assert.equal(sync.pm2_env.status,'stopped');assert.equal(f.modelActive(),false);
  assert.deepEqual(f.rows.find(row=>row.name==='matter-delivery-api'),main);assert.deepEqual(f.states.get('app-sidi-report-head'),head);
  assert.equal(f.calls.filter(row=>row.name==='matter_hosted_state_cas').length,1);
  assert(!f.calls.some(row=>row.name==='matter_hosted_state_read'&&row.args.p_key==='collector-state'));
  await assert.rejects(fs.access(path.join(f.syncRoot,'work/fixture-builds.private.txt')),{code:'ENOENT'});
  const control=path.join(f.syncRoot,'controls');assert.equal(JSON.parse(await fs.readFile(path.join(control,'old-sync-registration.original.private.json'))).pm_id,2);
  assert((await fs.readFile(path.join(control,'before-sync-retarget-dump.original.private.json'))).length>0);
  assert(!f.commands.some(row=>row.file==='pm2'&&row.args.includes('matter-driver-audit-source')));
});

test('one report tick uses the actual Sync worker to compare retained business files before one publication and keeps all processes held', async t => {
  const f=await fixture(t);await f.run('prepare-serving');await f.run('start-report');await f.run('held-qualify-source');
  const source=structuredClone(f.states.get('collector-state')), paid=structuredClone(f.states.get('photo-grading-budget'));
  const main=structuredClone(f.rows.find(row=>row.name==='matter-delivery-api')), commands=f.commands.length;
  const result=await f.run('run-report-once');assert.equal(result.status,'report-generated');
  const head=JSON.parse(f.states.get('app-sidi-report-head').body);
  assert.equal(head.servingPackage.collectorRevision,f.p.collector.revision);assert.equal(head.generation,f.candidate.seed.pointer.generation);
  assert.equal(head.previous.generation,f.p.current.generation);assert.equal(head.previous.previous,undefined);
  assert.deepEqual(f.states.get('collector-state'),source);assert.deepEqual(f.states.get('photo-grading-budget'),paid);
  assert.deepEqual(f.rows.find(row=>row.name==='matter-delivery-api'),main);
  assert(f.commands.slice(commands).filter(row=>row.file==='pm2').every(row=>row.args[0]==='jlist'));
  assert.equal(f.rows.find(row=>row.name==='matter-driver-audit-sync').pid,0);assert.equal(f.modelActive(),false);
  assert.equal((await fs.readFile(path.join(f.syncRoot,'work/fixture-builds.private.txt'),'utf8')).trim(),'built');
  const capsule=openTransferSecrets(privateKey,result.capsule),raw=JSON.parse(gunzipSync(Buffer.from(capsule.metadataGzipBase64,'base64')));
  assert.equal(raw.result.businessParity.allDeclaredFilesEqual,true);assert.equal(raw.result.businessParity.fingerprints.records,1);
  assert.notEqual(raw.result.oneTimeChild.measurements.pid,process.pid);assert.equal(f.lastChild.exitCode,0);
  assert.equal(raw.result.oneTimeChild.measurements.nodeOptions,'--max-old-space-size=1024');
  assert(raw.result.oneTimeChild.measurements.heapSizeLimitBytes>=1024**3&&raw.result.oneTimeChild.measurements.heapSizeLimitBytes<1280*1024**2);
  assert.equal(raw.result.oneTimeChild.transferUsage.basis,'supabase-http-bytes-v1');
  assert.equal(raw.result.source.bodySha256,f.p.collector.bodySha256);assert.equal(raw.result.source.receiptSha256.length,64);
  const committed=structuredClone(f.states.get('app-sidi-report-head'));
  await f.run('run-report-once');assert.deepEqual(f.states.get('app-sidi-report-head'),committed);
  assert.equal((await fs.readFile(path.join(f.syncRoot,'work/fixture-builds.private.txt'),'utf8')).trim(),'built');
});

async function readyForOneReport(t) {
  const f=await fixture(t);await f.run('prepare-serving');await f.run('start-report');await f.run('held-qualify-source');return f;
}

test('an advanced collector before build or during real archive preparation cannot publish a relabelled candidate', async t => {
  for(const late of [false,true]){
    const f=await readyForOneReport(t), before=structuredClone(f.states.get('app-sidi-report-head'));
    const advance=()=>{const row=f.states.get('collector-state');row.revision++;row.body=JSON.stringify({...JSON.parse(row.body),revision:row.revision});};
    if(late)f.afterArchivePut=()=>{f.afterArchivePut=undefined;advance();};else advance();
    await assert.rejects(f.run('run-report-once'),/Supabase control stopped/);
    assert.deepEqual(f.states.get('app-sidi-report-head'),before);
    assert.equal(f.calls.filter(row=>row.name==='matter_hosted_state_cas').length,1);
    const lock=await acquireWorkerLock(path.join(path.dirname(f.syncRoot),'sync-worker.lock'));await lock.release();
  }
});

test('a genuine business-file or policy-clock difference stays private and stops before the serving CAS', async t => {
  const f=await readyForOneReport(t), before=structuredClone(f.states.get('app-sidi-report-head'));
  const root=f.candidate.publication.fixturePackageRoot, file=path.join(root,'maps.private.json'), body=Buffer.from('{"policyClock":"2026-11-13T00:00:00.000Z"}');
  await write(file,body);const manifest=JSON.parse(await fs.readFile(path.join(root,'files.private.json')));manifest['maps.private.json']=hash(body);await write(path.join(root,'files.private.json'),manifest);
  await assert.rejects(f.run('run-report-once'),/Supabase control stopped at one-report-prepublication/);
  assert.deepEqual(f.states.get('app-sidi-report-head'),before);
  const names=await fs.readdir(path.join(f.syncRoot,'controls'));const name=names.find(name=>name.startsWith('report-business-difference-'));
  assert(name);const comparison=JSON.parse(await fs.readFile(path.join(f.syncRoot,'controls',name)));
  assert.equal(comparison.allDeclaredFilesEqual,false);assert.deepEqual(comparison.differences.map(row=>row.name),['maps.private.json']);
});

test('only file-manifest key ordering is an admitted metadata delta while every declared file remains byte-identical', async t => {
  const f=await readyForOneReport(t), file=path.join(f.candidate.publication.fixturePackageRoot,'files.private.json');
  const manifest=JSON.parse(await fs.readFile(file));await write(file,Object.fromEntries(Object.entries(manifest).reverse()));
  const result=await f.run('run-report-once'), raw=JSON.parse(gunzipSync(Buffer.from(openTransferSecrets(privateKey,result.capsule).metadataGzipBase64,'base64')));
  assert.notEqual(raw.result.businessParity.generatedManifestSha256,raw.result.businessParity.retainedManifestSha256);
  assert.deepEqual(raw.result.businessParity.permittedMetadataDeltas,['files.private.json-key-order-only']);
  assert.equal(raw.result.businessParity.allDeclaredFilesEqual,true);
  assert.equal(JSON.parse(f.states.get('app-sidi-report-head').body).generation,f.candidate.seed.pointer.generation);
});

test('an interrupted genuine publication retries the retained candidate without another build and lost acknowledgement recovers the exact head', async t => {
  const f=await readyForOneReport(t), before=structuredClone(f.states.get('app-sidi-report-head'));f.failPublication=true;
  await assert.rejects(f.run('run-report-once'),/Supabase control stopped/);assert.deepEqual(f.states.get('app-sidi-report-head'),before);
  f.loseNextAck();await f.run('run-report-once');
  assert.equal((await fs.readFile(path.join(f.syncRoot,'work/fixture-builds.private.txt'),'utf8')).trim(),'built');
  const after=structuredClone(f.states.get('app-sidi-report-head'));await f.run('run-report-once');assert.deepEqual(f.states.get('app-sidi-report-head'),after);
  assert.equal(JSON.parse(after.body).previous.generation,f.p.current.generation);
});

test('a protected review change during preparation stops publication and retains the independently written review', async t => {
  const f=await readyForOneReport(t), before=structuredClone(f.states.get('app-sidi-report-head'));
  f.afterArchivePut=()=>{f.afterArchivePut=undefined;f.states.set('review-journal',{revision:1,body:'{"humanReview":"fictional-preserved"}'});};
  await assert.rejects(f.run('run-report-once'),/Supabase control stopped/);assert.deepEqual(f.states.get('app-sidi-report-head'),before);
  assert.deepEqual(f.states.get('review-journal'),{revision:1,body:'{"humanReview":"fictional-preserved"}'});
});

test('expired host measurements or a foreign qualification reference cannot admit the one-time report', async t => {
  const f=await fixture(t);await f.run('prepare-serving');await f.run('start-report');
  f.mutateQualification=result=>{result.checkedAt=new Date(Date.now()-31*60_000).toISOString();};await f.run('held-qualify-source');
  await assert.rejects(f.run('run-report-once'),/Supabase control stopped at one-report-admission/);
  await assert.rejects(f.run('run-report-once',{qualificationReceiptSha256:hash('foreign receipt')}),/Supabase control stopped at one-report-admission/);
  await assert.rejects(fs.access(path.join(f.syncRoot,'work/fixture-builds.private.txt')),{code:'ENOENT'});
});

test('cancelled report preparation releases actual worker locks and retains the served head and immutable evidence', async t => {
  const f=await readyForOneReport(t), before=structuredClone(f.states.get('app-sidi-report-head')), stop=new AbortController();f.adapters.signal=stop.signal;
  f.afterArchivePut=()=>{f.afterArchivePut=undefined;stop.abort(Error('Fictional cancellation'));};
  await assert.rejects(f.run('run-report-once'),/Supabase control stopped/);assert.deepEqual(f.states.get('app-sidi-report-head'),before);
  assert(f.uploads.length>0);const lock=await acquireWorkerLock(path.join(path.dirname(f.syncRoot),'sync-worker.lock'));await lock.release();
  const heavy=await acquireWorkerLock(path.join(f.server,'.private/driver-audit-heavy-work/work.lock'));await heavy.release();
  f.adapters.signal=undefined;await f.run('run-report-once');assert.equal(JSON.parse(f.states.get('app-sidi-report-head').body).servingPackage.collectorRevision,f.p.collector.revision);
});

test('failure after publication preserves the new head and a later human review while recovery performs no extra CAS or build', async t => {
  const f=await readyForOneReport(t), fetch=f.adapters.fetch;
  f.adapters.fetch=async(...args)=>JSON.parse(f.states.get('app-sidi-report-head').body).servingPackage.collectorRevision===f.p.collector.revision
    ?new Response('{}',{status:503}):fetch(...args);
  await assert.rejects(f.run('run-report-once'),/Supabase control stopped at one-report-readback/);
  const accepted=structuredClone(f.states.get('app-sidi-report-head')), child=f.lastChild;
  f.states.set('review-journal',{revision:1,body:'{"humanReview":"fictional-after-publication"}'});f.adapters.fetch=fetch;
  const result=await f.run('run-report-once');assert.equal(result.status,'report-generated');
  assert.deepEqual(f.states.get('app-sidi-report-head'),accepted);assert.equal(f.lastChild,child);
  assert.equal(f.states.get('review-journal').revision,1);assert.equal(f.calls.filter(row=>row.name==='matter_hosted_state_cas').length,2);
  const raw=JSON.parse(gunzipSync(Buffer.from(openTransferSecrets(privateKey,result.capsule).metadataGzipBase64,'base64')));
  assert.deepEqual(raw.result.protectedHeadsAdvancedSincePublication,['review-journal']);
});

test('child failure output is owner-private and returned only as a bounded encrypted stopped receipt', async t => {
  const f=await readyForOneReport(t), root=f.candidate.publication.fixturePackageRoot;
  await fs.unlink(path.join(root,'publication.private.json'));
  let failure;try{await f.run('run-report-once');}catch(error){failure=error;}
  assert(failure);assert.match(failure.message,/^Supabase control stopped at /);
  const receipt=failure.supabaseControlStopped;assert.equal(receipt.status,'supabase-control-stopped');
  assert(!JSON.stringify(receipt).includes(f.appRoot));assert(!JSON.stringify(receipt).includes(f.secret));
  const raw=JSON.parse(gunzipSync(Buffer.from(openTransferSecrets(privateKey,receipt.capsule).metadataGzipBase64,'base64')));
  assert.equal(raw.acceptedAsVerified,false);assert.equal(raw.child.exit.code,1);assert(raw.child.childFailure);
  const info=await fs.stat(raw.child.path);assert.equal(info.mode&0o077,0);assert.equal(hash(await fs.readFile(raw.child.path)),raw.child.sha256);
  const lock=await acquireWorkerLock(path.join(path.dirname(f.syncRoot),'sync-worker.lock'));await lock.release();
});

test('a lost PM2 start acknowledgement cannot release a queued actual Sync worker into publication', async t => {
  const f=await fixture(t);await f.run('prepare-serving');await f.run('start-report');f.loseSyncStartAck=true;
  const head=structuredClone(f.states.get('app-sidi-report-head'));
  await assert.rejects(f.run('held-qualify-source'),/Supabase control stopped/);
  const sync=f.rows.find(row=>row.name==='matter-driver-audit-sync');assert.equal(sync?.pm2_env.status,'stopped');assert.equal(sync?.pid,0);
  assert.equal(f.modelActive(),false);assert.deepEqual(f.states.get('app-sidi-report-head'),head);
  await assert.rejects(fs.access(path.join(f.syncRoot,'work/fixture-builds.private.txt')),{code:'ENOENT'});
});

test('a different existing serving head or incomplete current descriptor rejects selection without replacing records', async t => {
  for(const kind of ['different-previous','missing-object','corrupt-object']){
    const f=await fixture(t);
    if(kind==='different-previous'){
      await f.run('prepare-serving');const row=f.states.get('app-sidi-report-head'),head=JSON.parse(row.body);head.previous=null;
      const changed={revision:row.revision+1,body:JSON.stringify(head)};f.states.set('app-sidi-report-head',changed);
      await assert.rejects(f.run('prepare-serving'),/Supabase control stopped/);assert.deepEqual(f.states.get('app-sidi-report-head'),changed);
    }else{
      const file=path.join(f.syncRoot,'retained/serving-current/audit-objects',f.current.seed.pointer.descriptor.chunks[0].sha256+'.gz');
      if(kind==='missing-object')await fs.unlink(file);else await write(file,'corrupt descriptor object');
      await assert.rejects(f.run('prepare-serving'),/Supabase control stopped/);assert.equal(f.states.has('app-sidi-report-head'),false);
      await assert.rejects(fs.access(path.join(f.syncRoot,'seed.json')),{code:'ENOENT'});
    }
  }
});

test('prepared receipt, private presence masks, dependencies and clean tracked code are all admission guards', async t => {
  for(const kind of ['receipt','mask','dependency','dirty','untracked']){
    const f=await fixture(t);
    if(kind==='receipt')await write(path.join(f.syncRoot,'staging.private.json'),{...f.receipt,sourceManifestSha256:hash('foreign runtime')});
    if(kind==='mask')await write(f.receipt.packages[0].archiveReferences.path,'{"missingArchiveReferences":[]}');
    if(kind==='dependency')await write(path.join(f.server,'node_modules/fictional/index.js'),'independent dependency edit');
    if(['dirty','untracked'].includes(kind)){
      const exec=f.adapters.exec;f.adapters.exec=(file,args,options)=>file==='git'&&args[2]==='status'?Promise.resolve({stdout:kind==='dirty'?' M server/scripts/driverAuditSync.js\n':'?? server/unreviewed.js\n'}):exec(file,args,options);
    }
    await assert.rejects(f.run('prepare-serving'),/Supabase control stopped/);
    assert.equal(f.calls.length,0);assert(!f.commands.some(row=>row.file==='pm2'&&row.args[0]!=='jlist'));
  }
});

test('generated data directories may retain ordinary modes only under the exact private boundary and strict private leaves', async t => {
  const valid=await fixture(t), retained=valid.receipt.packages.find(row=>row.role==='serving-current').root;
  await fs.chmod(retained,0o775);await valid.run('prepare-serving');assert.equal((await fs.stat(retained)).mode&0o777,0o775);
  const open=await fixture(t);await fs.chmod(open.syncRoot,0o755);
  await assert.rejects(open.run('prepare-serving'),/Supabase control stopped at retained-packages/);assert.equal(open.calls.length,0);
  const leaf=await fixture(t), candidate=leaf.receipt.packages.find(row=>row.role==='candidate').root;
  await fs.chmod(path.join(candidate,'maps.private.json'),0o664);
  await assert.rejects(leaf.run('prepare-serving'),/Supabase control stopped at retained-packages/);assert.equal(leaf.calls.length,0);
});

test('an independent isolated settings edit before the rename is retained and prevents service start', async t => {
  const f=await fixture(t);await f.run('prepare-serving');const open=fs.open;let edited=false;
  fs.open=async(name,...args)=>{
    if(String(name).endsWith('app-environment.pending.private.env')&&!edited){
      edited=true;await fs.appendFile(path.join(f.server,'.env.local'),'INDEPENDENT_DISABLED=1\n');
    }
    return open(name,...args);
  };
  try{await assert.rejects(f.run('start-report'),error=>error.phase==='report-enable');}finally{fs.open=open;}
  assert(edited);assert.equal(dotenv.parse(await fs.readFile(path.join(f.server,'.env.local'))).INDEPENDENT_DISABLED,'1');
  assert(!f.rows.some(row=>row.name==='matter-driver-reports-api'));
});

test('failed report health stops only the new service and supports an exact retry without losing its original boot backup', async t => {
  const f=await fixture(t);await f.run('prepare-serving');const fetch=f.adapters.fetch;
  f.adapters.fetch=async()=>new Response('{"ready":false}',{status:503});
  await assert.rejects(f.run('start-report'),error=>error.phase==='report-health');
  const report=f.rows.find(row=>row.name==='matter-driver-reports-api');assert.equal(report.pid,0);assert.equal(report.pm2_env.status,'stopped');
  const backup=await fs.readFile(path.join(f.syncRoot,'controls/before-report-dump.original.private.json'));
  f.adapters.fetch=fetch;assert.equal((await f.run('start-report')).status,'report-started');
  assert.deepEqual(await fs.readFile(path.join(f.syncRoot,'controls/before-report-dump.original.private.json')),backup);
  assert.equal(f.rows.find(row=>row.name==='matter-delivery-api').pid,100);
});

test('lost report-start acknowledgement plus transient observation retains exclusion until the exact created service is stopped and saved', async t => {
  const f=await fixture(t);await f.run('prepare-serving');const original=f.adapters.exec;let created=false,observationFailed=false;
  f.adapters.exec=async(file,args,options)=>{
    if(file==='pm2'&&args[0]==='start'&&args.includes('matter-driver-reports-api')){await original(file,args,options);created=true;throw Error('Fictional lost report start ACK');}
    if(file==='pm2'&&args[0]==='jlist'&&created&&!observationFailed){observationFailed=true;throw Error('Fictional transient post-start observation failure');}
    return original(file,args,options);
  };
  let cleanupWait=false;f.adapters.wait=async()=>{
    cleanupWait=true;await assert.rejects(acquireWorkerLock(path.join(f.baseServer,'.private/driver-report-supabase-handoff/operator.lock')),/Collector already active/);
  };
  const main=structuredClone(f.rows[0]);await assert.rejects(f.run('start-report'),/Supabase control stopped/);
  assert(created&&observationFailed&&cleanupWait);const report=f.rows.find(row=>row.name==='matter-driver-reports-api');
  assert.equal(report.pid,0);assert.equal(report.pm2_env.status,'stopped');assert.deepEqual(f.rows[0],main);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.pm2Home,'dump.pm2'))).find(row=>row.name==='matter-driver-reports-api').pid,0);
});

test('qualification consumes the independently pinned off-host backup and rejects foreign environment evidence before retargeting', async t => {
  const f=await fixture(t);await f.run('prepare-serving');await f.run('start-report');
  const {gunzipSync}=await import('node:zlib'),proof=JSON.parse(gunzipSync(f.objects.get(f.p.backupProof+'.gz')));proof.environmentSha256=hash('foreign environment');
  const packed=gzipSync(Buffer.from(JSON.stringify(proof)));f.p.backupProof=hash(packed);f.objects.set(f.p.backupProof+'.gz',packed);
  await assert.rejects(f.run('held-qualify-source'),error=>error.phase==='qualification-inputs');
  assert.equal(f.rows.find(row=>row.name==='matter-driver-audit-sync').pm_id,2);
  assert(!f.commands.some(row=>row.file==='pm2'&&row.args[0]==='delete'));
});

test('a transient managed stop failure is retried under real exclusion before any queued Sync work can run', async t => {
  const f=await fixture(t);await f.run('prepare-serving');await f.run('start-report');f.failStops=1;
  const result=await f.run('held-qualify-source');assert.equal(result.status,'source-qualified');assert.equal(f.modelActive(),false);
  const stops=f.commands.filter(row=>row.file==='pm2'&&row.args[0]==='stop');assert(stops.length>=3);
  assert.equal(f.calls.filter(row=>row.name==='matter_hosted_state_cas').length,1);
  await assert.rejects(fs.access(path.join(f.syncRoot,'work/fixture-builds.private.txt')),{code:'ENOENT'});
});

test('partial or tampered qualification receipts cannot become a source qualification or release gate', async t => {
  for(const change of [f=>{f.partialQualification=true;},f=>{f.mutateQualification=value=>{value.source.platform='darwin';};},
    f=>{f.mutateQualification=value=>{value.measurements.source.minimumAvailableBytes=0;};},
    f=>{f.mutateQualification=value=>{value.fixtureArchive.objects=1;};}]){
    const f=await fixture(t);await f.run('prepare-serving');await f.run('start-report');change(f);
    await assert.rejects(f.run('held-qualify-source'),/Supabase control stopped/);
    const sync=f.rows.find(row=>row.name==='matter-driver-audit-sync');assert.equal(sync.pid,0);assert.equal(sync.pm2_env.status,'stopped');
    assert.equal(f.modelActive(),false);assert.equal(f.rows.some(row=>row.name==='matter-driver-audit-source'),false);
    assert.equal(f.calls.filter(row=>row.name==='matter_hosted_state_cas').length,1);
  }
});
