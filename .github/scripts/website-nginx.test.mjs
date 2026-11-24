import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { bootstrapWebsite, sealWebsite, publishWebsite, checkPublicWebsite } from './website-release.mjs';

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
