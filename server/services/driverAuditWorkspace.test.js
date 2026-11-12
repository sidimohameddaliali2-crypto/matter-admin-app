import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pruneDriverAuditWorkspace} from './driverAuditWorkspace.js';

test('workspace retention protects current, previous, staged and unverified data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-retention-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const write = (file, value) => fs.writeFile(file, JSON.stringify(value), {mode:0o600});
  const directories = [];
  for (let i=1; i<=6; i++) {
    const directory = path.join(root, 'attempts', String(i).padStart(8,'0')+'-0000-4000-8000-000000000000');
    await fs.mkdir(path.join(directory,'server-data'), {recursive:true});
    const hash = String(i).repeat(64), descriptor = 'a'.repeat(64);
    await write(path.join(directory,'accepted.private.json'), {privateRoot:path.join(directory,'server-data'), manifestSha256:hash,sourceBasis:hash,collectorRevision:i});
    const pointer={version:1,generation:hash,reportHash:hash,descriptor:{version:1,domain:'previewPackage',path:'descriptor.json',kind:'immutable-evidence',size:1,sha256:descriptor,chunks:[{offset:0,size:1,sha256:descriptor}]}};
    const binding={manifestSha256:hash,generation:hash,reportHash:hash,descriptorSha256:descriptor};
    await write(path.join(directory,'direct-seed.private.json'), {
      version:1,mode:'sync',bundleRoot:path.join(directory,'audit-objects'),collectorRevision:i,sourceBasis:hash,visibleCutoffAt:null,
      manifestSha256:hash,pointer,
      closureReceipt:{version:1,status:'verified',sourceBasis:hash,...binding,checkedAt:'2026-11-12T00:00:00.000Z',checks:{archive:true,photos:true,reviewHistory:true}},
      restore:{version:1,verified:i!==5,archive:'matter-report-archive',...binding},
    });
    await fs.writeFile(path.join(directory,'automatic-validation.private.json'),'x'.repeat(1024*1024),{mode:0o600});
    directories.push(directory);
  }
  await fs.unlink(path.join(directories[5],'direct-seed.private.json'));
  await write(path.join(root,'current.private.json'), {privateRoot:path.join(directories[0],'server-data'), previous:{privateRoot:path.join(directories[1],'server-data')}});
  const result = await pruneDriverAuditWorkspace({root, protectedManifests:['3'.repeat(64)]});
  assert.equal(result.attemptsCompacted,1);
  await assert.rejects(fs.stat(path.join(directories[3],'automatic-validation.private.json')), {code:'ENOENT'});
  assert.equal((await fs.stat(path.join(directories[3],'automatic-validation.private.json.retained.gz'))).isFile(),true);
  assert.equal((await fs.stat(path.join(directories[3],'direct-seed.private.json'))).isFile(),true);
  for (const i of [0,1,2,4,5]) assert.equal((await fs.stat(directories[i])).isDirectory(),true);
  const savedJournal=JSON.parse(await fs.readFile(path.join(directories[3],'compacted-files.private.json'),'utf8'));
  await write(path.join(directories[3],'compacted-files.private.json'),{...savedJournal,complete:false});
  await pruneDriverAuditWorkspace({root,protectedManifests:['3'.repeat(64)]});
  assert.equal(JSON.parse(await fs.readFile(path.join(directories[3],'compacted-files.private.json'),'utf8')).complete,true);
  const seedFile=path.join(directories[4],'direct-seed.private.json');
  const seed=JSON.parse(await fs.readFile(seedFile,'utf8'));
  seed.restore.verified=true;
  await write(seedFile,seed);
  await fs.symlink(path.join(directories[3],'automatic-validation.private.json.retained.gz'),path.join(directories[4],'automatic-validation.private.json.retained.gz'));
  await assert.rejects(pruneDriverAuditWorkspace({root,protectedManifests:['3'.repeat(64)]}),/regular file/);
  assert.equal((await fs.stat(path.join(directories[4],'automatic-validation.private.json'))).size,1024*1024);
});

test('archive cache retention is bounded and preserves unrelated files and symlinks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-cache-retention-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const cache = path.join(root,'archive-cache');
  await fs.mkdir(cache);
  const first = path.join(cache,'a'.repeat(64)+'.gz'), second = path.join(cache,'b'.repeat(64)+'.gz');
  await fs.writeFile(first,'12345');
  await fs.utimes(first,new Date(0),new Date(0));
  await fs.writeFile(second,'67890');
  await fs.writeFile(path.join(cache,'keep.private'),'keep');
  await fs.symlink(path.join(cache,'keep.private'),path.join(cache,'c'.repeat(64)+'.gz'));
  const result = await pruneDriverAuditWorkspace({root,maxCacheBytes:5});
  assert.equal(result.cacheBytesRemoved,5);
  assert.equal(await fs.readFile(second,'utf8'),'67890');
  assert.equal(await fs.readFile(path.join(cache,'keep.private'),'utf8'),'keep');
  assert.equal((await fs.lstat(path.join(cache,'c'.repeat(64)+'.gz'))).isSymbolicLink(),true);
});
