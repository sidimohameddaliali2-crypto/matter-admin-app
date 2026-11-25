import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { bootstrapWebsite, sealWebsite, publishWebsite, checkPublicWebsite, publishLiveWebsite, rollbackLiveWebsite } from './website-release.mjs';

test('Nginx keeps serving the snapshot during builds and serves immutable release bundles', {
  skip: process.platform !== 'linux' || !process.env.NGINX_BIN,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matter-nginx-'));
  const id = 'c'.repeat(40) + '-125-1';
  const fixture = async (dir, prefix, name) => {
    await fs.mkdir(path.join(dir, 'static/js'), { recursive: true });
    await fs.writeFile(path.join(dir, `static/js/${name}.js`), `console.log('${name}');`);
    await fs.writeFile(path.join(dir, 'asset-manifest.json'), JSON.stringify({ files: { 'main.js': `${prefix}static/js/${name}.js` } }));
    await fs.writeFile(path.join(dir, 'index.html'), `<script src="${prefix}static/js/${name}.js"></script>`);
  };
  let nginx;
  try {
    await fixture(path.join(root, 'client/build'), '/', 'legacy');
    await bootstrapWebsite(root);
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    await fs.writeFile(path.join(root, 'nginx.conf'), `
      pid ${root}/nginx.pid;
      error_log ${root}/nginx.error.log;
      events {}
      http {
        access_log off;
        client_body_temp_path ${root}/body;
        proxy_temp_path ${root}/proxy;
        fastcgi_temp_path ${root}/fastcgi;
        uwsgi_temp_path ${root}/uwsgi;
        scgi_temp_path ${root}/scgi;
        server {
          listen 127.0.0.1:${port};
          root ${root}/.website/current;
          location / { try_files $uri $uri/ /index.html; }
          location ^~ /website-releases/ { alias ${root}/.website/releases/; }
          location ^~ /static/ { alias ${root}/.website/legacy-static/; }
        }
      }
    `);
    nginx = spawn(process.env.NGINX_BIN, ['-p', root, '-c', path.join(root, 'nginx.conf'), '-g', 'daemon off;'], { stdio: 'inherit' });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { ready = (await fetch(base)).ok; if (ready) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    await fs.unlink(path.join(root, 'client/build/index.html'));
    assert.equal((await fetch(base + '/some-existing-page')).status, 200);
    const source = path.join(root, '.website/incoming/candidate');
    await fixture(source, `/website-releases/${id}/`, 'new');
    await sealWebsite(source, id);
    const localFetch = (url, options) => {
      const parsed = new URL(url);
      return fetch(base + parsed.pathname + parsed.search, options);
    };
    await publishWebsite(root, source, id, {
      checkPublic: dir => checkPublicWebsite(dir, 'https://example.invalid', { fetchImpl: localFetch }),
    });
    assert.ok((await (await fetch(base + '/some-existing-page')).text()).includes(id));
    assert.equal(await (await fetch(base + '/static/js/legacy.js')).text(), "console.log('legacy');");
    assert.equal((await fetch(base + `/website-releases/${id}/static/js/missing.js`)).status, 404);
  } finally {
    if (nginx && nginx.exitCode === null && nginx.signalCode === null) {
      const exited = once(nginx, 'exit');
      nginx.kill('SIGTERM');
      await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the unchanged production Nginx root stays online through preparation, publication and failed health checks', {
  skip: process.platform !== 'linux' || !process.env.NGINX_BIN,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matter-live-nginx-'));
  const live = path.join(root, 'client/build');
  const first = 'd'.repeat(40) + '-126-1', second = 'e'.repeat(40) + '-127-1';
  const fixture = async (dir, id) => {
    await fs.mkdir(path.join(dir, 'static/js'), { recursive: true });
    const prefix = id === 'legacy' ? '/' : `/website-releases/${id}/`;
    await fs.writeFile(path.join(dir, `static/js/${id}.js`), `console.log('${id}');`);
    await fs.writeFile(path.join(dir, 'asset-manifest.json'), JSON.stringify({ files: { 'main.js': `${prefix}static/js/${id}.js` } }));
    await fs.writeFile(path.join(dir, 'index.html'), `<script src="${prefix}static/js/${id}.js"></script>`);
    await fs.writeFile(path.join(dir, 'service-worker.js'), `// ${id}`);
    await fs.mkdir(path.join(dir, 'images'), { recursive: true });
    await fs.writeFile(path.join(dir, 'images/fixture.txt'), id);
    if (id !== 'legacy') await sealWebsite(dir, id);
  };
  let nginx, reading = false, reader;
  try {
    await fixture(live, 'legacy');
    const oldHtml = await fs.readFile(path.join(live, 'index.html'), 'utf8');
    const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    await fs.writeFile(path.join(root, 'nginx.conf'), `
      pid ${root}/nginx.pid; error_log ${root}/error.log; events {}
      http { access_log off; client_body_temp_path ${root}/body; proxy_temp_path ${root}/proxy;
        fastcgi_temp_path ${root}/fastcgi; uwsgi_temp_path ${root}/uwsgi; scgi_temp_path ${root}/scgi;
        server { listen 127.0.0.1:${port}; root ${live}; location / { try_files $uri $uri/ /index.html; } }
      }
    `);
    nginx = spawn(process.env.NGINX_BIN, ['-p', root, '-c', path.join(root, 'nginx.conf'), '-g', 'daemon off;'], { stdio: 'inherit' });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { ready = (await fetch(base)).ok; if (ready) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    let failRootCheck = false, failAssetCheck = false;
    const fetchImpl = (url, options) => {
      const parsed = new URL(url);
      if (failRootCheck && parsed.pathname === '/website-release.json') return Promise.resolve(new Response('unhealthy', { status: 503 }));
      if (failAssetCheck && parsed.pathname.includes('/static/js/')) return Promise.resolve(new Response('<html>fallback</html>'));
      return fetch(base + parsed.pathname + parsed.search, options);
    };
    const candidateA = path.join(root, 'candidate-a'), candidateB = path.join(root, 'candidate-b');
    await fixture(candidateA, first); await fixture(candidateB, second);
    reading = true; let observations = 0;
    reader = (async () => {
      while (reading) {
        const response = await fetch(base + '/driver-mobile');
        assert.equal(response.status, 200);
        const html = await response.text();
        const asset = html.match(/src="([^"]+)"/)[1];
        assert.equal((await fetch(base + asset)).status, 200);
        observations++;
      }
    })();
    await publishLiveWebsite(root, candidateA, first, 'https://example.invalid', { prepareOnly: true, fetchImpl });
    assert.equal(await fs.readFile(path.join(live, 'index.html'), 'utf8'), oldHtml);
    failAssetCheck = true;
    await assert.rejects(publishLiveWebsite(root, candidateA, first, 'https://example.invalid', { fetchImpl }), /candidate asset/);
    assert.equal(await fs.readFile(path.join(live, 'index.html'), 'utf8'), oldHtml);
    failAssetCheck = false;
    await publishLiveWebsite(root, candidateA, first, 'https://example.invalid', { fetchImpl });
    const rollbackReceipt = await fs.readFile(path.join(root, '.website/live-previous.json'), 'utf8');
    await publishLiveWebsite(root, candidateA, first, 'https://example.invalid', { fetchImpl });
    assert.equal(await fs.readFile(path.join(root, '.website/live-previous.json'), 'utf8'), rollbackReceipt);
    failRootCheck = true;
    await assert.rejects(publishLiveWebsite(root, candidateB, second, 'https://example.invalid', { fetchImpl }), /selected website/);
    failRootCheck = false;
    assert.ok((await fs.readFile(path.join(live, 'index.html'), 'utf8')).includes(first));
    assert.equal(await fs.readFile(path.join(root, '.website/live-previous.json'), 'utf8'), rollbackReceipt);
    assert.equal(await fs.readFile(path.join(live, 'service-worker.js'), 'utf8'), `// ${first}`);
    assert.equal(await (await fetch(base + '/images/fixture.txt')).text(), first);
    await rollbackLiveWebsite(root);
    assert.equal(await fs.readFile(path.join(live, 'index.html'), 'utf8'), oldHtml);
    assert.equal(await (await fetch(base + '/images/fixture.txt')).text(), 'legacy');
    await publishLiveWebsite(root, candidateA, first, 'https://example.invalid', { fetchImpl });
    await publishLiveWebsite(root, candidateB, second, 'https://example.invalid', { fetchImpl });
    await rollbackLiveWebsite(root);
    assert.ok((await fs.readFile(path.join(live, 'index.html'), 'utf8')).includes(first));
    assert.equal((await fetch(base + '/static/js/legacy.js')).status, 200);
    assert.equal((await fetch(base + `/website-releases/${second}/static/js/${second}.js`)).status, 200);
    reading = false; await reader; assert.ok(observations > 0);
  } finally {
    reading = false;
    if (reader) await reader;
    if (nginx && nginx.exitCode === null && nginx.signalCode === null) {
      const exited = once(nginx, 'exit'); nginx.kill('SIGTERM'); await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
