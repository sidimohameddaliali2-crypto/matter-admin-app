import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrapWebsite, sealWebsite, verifyWebsite, publishWebsite, rollbackWebsite, checkPublicWebsite } from './website-release.mjs';

const id = 'a'.repeat(40) + '-123-1';
const second = 'b'.repeat(40) + '-124-1';
async function fixture(directory, releaseId, legacy = false) {
  await fs.mkdir(path.join(directory, 'static/js'), { recursive: true });
  const name = legacy ? 'legacy' : releaseId;
  const bundle = `static/js/main.${name}.js`;
  const main = (legacy ? '/' : `/website-releases/${releaseId}/`) + bundle;
  await fs.writeFile(path.join(directory, bundle), `console.log('${name}');`);
  await fs.writeFile(path.join(directory, 'index.html'), `<html><script src="${main}"></script></html>`);
  await fs.writeFile(path.join(directory, 'asset-manifest.json'), JSON.stringify({ files: { 'main.js': main, 'index.html': (legacy ? '/' : `/website-releases/${releaseId}/`) + 'index.html' } }));
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matter-website-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('a sealed artifact rejects changed bytes, missing files and the wrong release prefix', async t => {
  const root = await temporary(t);
  await fixture(root, id);
  await sealWebsite(root, id);
  assert.equal((await verifyWebsite(root, id)).releaseId, id);
  await fs.appendFile(path.join(root, `static/js/main.${id}.js`), 'changed');
  await assert.rejects(verifyWebsite(root, id), /integrity/);
  await fs.unlink(path.join(root, `static/js/main.${id}.js`));
  await assert.rejects(verifyWebsite(root, id), /unavailable/);
  await assert.rejects(sealWebsite(root, second), /prefix/);
});

test('sealing rejects traversal and symlink assets', async t => {
  const root = await temporary(t);
  await fixture(root, id);
  await fs.writeFile(path.join(root, 'asset-manifest.json'), JSON.stringify({ files: { 'main.js': `/website-releases/${id}/../secret` } }));
  await fs.writeFile(path.join(root, 'index.html'), `<script src="/website-releases/${id}/../secret"></script>`);
  await assert.rejects(sealWebsite(root, id), /Unsafe/);
  await fixture(root, id);
  const outside = await temporary(t);
  await fs.symlink(outside, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(sealWebsite(root, id), /links/);
});

test('public checks require both the correct release and exact main bundle bytes', async t => {
  const root = await temporary(t);
  await fixture(root, id);
  await sealWebsite(root, id);
  const good = async url => url.includes('website-release.json') ? Response.json({ releaseId: id })
    : new Response(await fs.readFile(path.join(root, `static/js/main.${id}.js`)));
  await checkPublicWebsite(root, 'https://example.invalid', { fetchImpl: good });
  await assert.rejects(checkPublicWebsite(root, 'https://example.invalid', { fetchImpl: async () => Response.json({ releaseId: second }) }), /selected/);
  await assert.rejects(checkPublicWebsite(root, 'https://example.invalid', {
    fetchImpl: async url => url.includes('website-release.json') ? Response.json({ releaseId: id }) : new Response('<html>fallback</html>'),
  }), /routing/);
});

test('Linux publishing preserves the old website until verification and supports rollback', { skip: process.platform !== 'linux' }, async t => {
  const root = await temporary(t);
  const live = path.join(root, 'client/build');
  await fixture(live, 'legacy', true);
  const original = await fs.readFile(path.join(live, 'index.html'), 'utf8');
  const bootstrap = await bootstrapWebsite(root);
  assert.equal(await fs.readFile(path.join(live, 'index.html'), 'utf8'), original);
  const current = path.join(root, '.website/current');
  const first = path.join(root, '.website/incoming/first');
  await fixture(first, id);
  await sealWebsite(first, id);
  await fs.appendFile(path.join(first, 'index.html'), 'broken');
  await assert.rejects(publishWebsite(root, first, id), /integrity/);
  assert.equal(await fs.readFile(path.join(current, 'index.html'), 'utf8'), original);
  await fs.rm(first, { recursive: true });
  await fixture(first, id);
  await sealWebsite(first, id);
  let observations = 0;
  const reader = (async () => {
    while (observations < 150) {
      const html = await fs.readFile(path.join(current, 'index.html'), 'utf8');
      assert.ok(html === original || html.includes(`/website-releases/${id}/`));
      observations++;
    }
  })();
  await publishWebsite(root, first, id);
  await reader;
  assert.equal(observations, 150);
  assert.ok((await fs.readFile(path.join(current, 'index.html'), 'utf8')).includes(id));
  assert.ok((await fs.readFile(path.join(root, '.website/legacy-static/js/main.legacy.js'), 'utf8')).includes('legacy'));
  const next = path.join(root, '.website/incoming/second');
  await fixture(next, second);
  await sealWebsite(next, second);
  await assert.rejects(publishWebsite(root, next, second, { checkPublic: async () => { throw Error('public check failed'); } }), /public check/);
  assert.equal(await fs.readlink(current), `releases/${id}`);
  await publishWebsite(root, next, second);
  assert.equal(await fs.readlink(current), `releases/${second}`);
  assert.equal((await rollbackWebsite(root)).releaseId, id);
  assert.equal(await fs.readlink(current), `releases/${id}`);
  assert.ok(await fs.stat(path.join(root, '.website/releases', second, `static/js/main.${second}.js`)));
  assert.ok(await fs.stat(path.join(root, '.website/releases', bootstrap.releaseId, 'index.html')));
  await fs.mkdir(path.join(root, '.website/publish.lock'));
  await assert.rejects(publishWebsite(root, first, id));
  assert.equal(await fs.readlink(current), `releases/${id}`);
});
