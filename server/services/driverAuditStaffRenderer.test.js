import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadStaffAuditRenderer} from './driverAuditStaffRenderer.js';

test('loads a private renderer only with the reviewed digest and falls back on corruption', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'staff-renderer-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const html = '<html><head></head><body></body></html>';
  const sha256 = createHash('sha256').update(html).digest('hex');
  const templateSnapshotSha256 = 'a'.repeat(64);
  const manifest = {version:1,sha256,bytes:Buffer.byteLength(html),templateSnapshotSha256};
  const renderer = path.join(directory,'renderer.private.html');
  await fs.writeFile(path.join(directory,'manifest.private.json'),JSON.stringify(manifest),{mode:0o600});
  await fs.writeFile(renderer,html,{mode:0o600});
  assert.deepEqual(await loadStaffAuditRenderer(directory,sha256),{html,templateSnapshotSha256});
  assert.equal(await loadStaffAuditRenderer(directory,'b'.repeat(64)),undefined);
  await fs.writeFile(renderer,html.replace('body','head'));
  assert.equal(await loadStaffAuditRenderer(directory,sha256),undefined);
  assert.equal(await loadStaffAuditRenderer(),undefined);
});
