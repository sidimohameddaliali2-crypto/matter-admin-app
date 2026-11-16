import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireWorkerLock } from '../vendor/driver-audits/integration/hosted/worker-lock.mjs';

const cancelled = () => Object.assign(new Error('Audit admission cancelled.'), { code: 'AUDIT_ADMISSION_CANCELLED' });

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function wait(pollMs, signal) {
  if (signal?.aborted) throw cancelled();
  await new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(done, pollMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function tryLock(file) {
  try { return await acquireWorkerLock(file); }
  catch (error) { if (error.message === 'Collector already active') return null; throw error; }
}

async function saveQueue(file, queue) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(queue)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}

async function readQueue(file) {
  let queue;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid() || stat.size > 1024 * 1024)
      throw new Error('Unsafe audit admission queue.');
    queue = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(queue) || queue.length > 1024 || queue.some(item =>
    !Number.isSafeInteger(item.pid) || item.pid < 1 || typeof item.id !== 'string' || !['source', 'sync'].includes(item.owner)))
    throw new Error('Invalid audit admission queue.');
  return queue.filter(item => alive(item.pid));
}

// Queue changes use the short guard lock. The long OS-backed lock belongs to
// the process doing the work, and process death releases it automatically.
export async function withDriverAuditHeavyWork({ root, owner, signal, onWaiting = () => {}, pollMs = 250 }, operation) {
  if (!['source', 'sync'].includes(owner) || typeof operation !== 'function' || !path.isAbsolute(root)
    || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('Invalid audit admission configuration.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid() || await fs.realpath(root) !== root)
    throw new Error('Audit admission directory must be owner-private.');
  const queueFile = path.join(root, 'queue.private.json');
  const guardFile = path.join(root, 'queue.lock');
  const ticket = { id: randomUUID(), pid: process.pid, owner };
  let admitted;
  let registered = false;
  const underGuard = async (operation, cancellationSignal = signal) => {
    let guard;
    while (!guard) {
      if (cancellationSignal?.aborted) throw cancelled();
      guard = await tryLock(guardFile);
      if (!guard) await wait(pollMs, cancellationSignal);
    }
    try { return await operation(); } finally { await guard.release(); }
  };
  try {
    while (!admitted) {
      if (signal?.aborted) throw cancelled();
      await underGuard(async () => {
        const queue = await readQueue(queueFile);
        if (!registered) { queue.push(ticket); registered = true; }
        if (queue[0]?.id === ticket.id) {
          admitted = await tryLock(path.join(root, 'work.lock'));
          if (admitted) queue.shift();
        }
        await saveQueue(queueFile, queue);
      });
      if (!admitted) { await onWaiting(); await wait(pollMs, signal); }
    }
    return await operation();
  } finally {
    if (admitted) await admitted.release();
    else if (registered) await underGuard(async () => {
      const queue = await readQueue(queueFile);
      await saveQueue(queueFile, queue.filter(item => item.id !== ticket.id));
    }, null);
  }
}
