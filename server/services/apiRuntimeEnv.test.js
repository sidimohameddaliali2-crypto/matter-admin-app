import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('shared .env overrides cannot move a candidate to the live port or start its background jobs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matter-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const release = path.join(root, 'release'), shared = path.join(root, 'shared');
  await fs.mkdir(path.join(release, 'services'), { recursive: true }); await fs.mkdir(shared);
  await fs.writeFile(path.join(release, 'package.json'), '{"type":"module"}');
  await fs.copyFile(path.join(source, 'loadEnv.js'), path.join(release, 'loadEnv.js'));
  await fs.copyFile(path.join(source, 'services/apiRuntime.js'), path.join(release, 'services/apiRuntime.js'));
  await fs.mkdir(path.join(root, '.github/scripts'), { recursive: true });
  await fs.copyFile(path.join(source, '../.github/scripts/private-socket.mjs'), path.join(root, '.github/scripts/private-socket.mjs'));
  await fs.cp(path.join(source, 'node_modules/dotenv'), path.join(release, 'node_modules/dotenv'), { recursive: true });
  const local = 'PORT=5000\nJWT_SECRET=fixture-local\nMATTER_API_RELEASE=stale\nMATTER_API_WEB_ONLY=0\nMATTER_API_CONTROL_SOCKET=/wrong.sock\nMATTER_ACTIVITY_JOURNAL_DIR=/shared/journal\n';
  await fs.writeFile(path.join(shared, '.env'), 'JWT_SECRET=fixture-base\n');
  await fs.writeFile(path.join(shared, '.env.local'), local);
  const releaseId = 'a'.repeat(40) + '-1-1', socket = path.join(root, 'control.sock');
  const code = `await import(${JSON.stringify(pathToFileURL(path.join(release, 'loadEnv.js')).href)}); console.log(JSON.stringify({port:process.env.PORT,role:process.env.MATTER_API_WEB_ONLY,release:process.env.MATTER_API_RELEASE,socket:process.env.MATTER_API_CONTROL_SOCKET,journal:process.env.MATTER_ACTIVITY_JOURNAL_DIR,configLoaded:process.env.JWT_SECRET==='fixture-local'}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env: {
    ...process.env, MATTER_API_RELEASE: releaseId, MATTER_API_PORT: '35000', MATTER_API_WEB_ONLY: '1', MATTER_SHARED_SERVER_ROOT: shared, MATTER_API_CONTROL_SOCKET: socket,
  } });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(result, { port: '35000', role: '1', release: releaseId, socket, journal: path.join(release, '.activity-journal'), configLoaded: true });
  assert.equal(await fs.readFile(path.join(shared, '.env.local'), 'utf8'), local);
});
