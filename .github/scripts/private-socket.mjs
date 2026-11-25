import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

export async function listenPrivate(server, socketPath) {
  if (process.platform !== 'linux' || Buffer.byteLength(socketPath) > 100) throw Error('A short Linux control socket path is required');
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(path.dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || directory.mode & 0o077) throw Error('Control directory must be owner-private');
  const old = await fs.lstat(socketPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (old) {
    if (!old.isSocket() || old.uid !== process.getuid()) throw Error('Unsafe control socket path');
    const alive = await new Promise((resolve, reject) => {
      const probe = net.createConnection(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', error => ['ECONNREFUSED', 'ENOENT'].includes(error.code) ? resolve(false) : reject(error));
      probe.setTimeout(1000, () => probe.destroy(Error('Control probe timed out')));
    });
    if (alive) throw Error('This control socket is already running');
    const current = await fs.lstat(socketPath);
    if (current.ino !== old.ino || current.dev !== old.dev) throw Error('Control socket changed during recovery');
    await fs.unlink(socketPath);
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  return async () => { await new Promise(resolve => server.close(resolve)); await fs.unlink(socketPath).catch(() => {}); };
}
