import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function configureActivityHistoryAccess({ serverRoot, emails, findAccounts, releaseSha }) {
  const selected = String(emails || '').split(',').map(value => value.trim().toLowerCase());
  if (selected.length !== 1 || new Set(selected).size !== selected.length ||
    selected.some(value => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value)))
    throw Error('Exactly one approved sign-in email is required.');
  const accounts = await findAccounts(selected);
  const ids = accounts.map(account => String(account._id));
  if (accounts.length !== selected.length || new Set(ids).size !== selected.length ||
    accounts.some(account => account.isActive !== true || !/^[a-f\d]{24}$/.test(String(account._id)) || !selected.includes(String(account.email).trim().toLowerCase())))
    throw Error('Every selected reader must resolve to one approved active account.');
  let directory = path.resolve(serverRoot);
  for (const segment of ['.private', 'activity-history']) {
    directory = path.join(directory, segment);
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw Error('Private activity configuration directory is unsafe.');
  }
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, 'readers.json');
  const existing = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw Error('Private activity configuration file is unsafe.');
  const previous = existing ? await fs.readFile(file, 'utf8') : null;
  const configuredAt = new Date().toISOString();
  const value = { version: 1, readerIds: ids, configuredAt, ...(/^[a-f\d]{40}$/.test(releaseSha || '') ? { releaseSha } : {}) };
  const receipt = path.join(directory, `access-${Date.now()}-${randomUUID()}.json`);
  await fs.writeFile(receipt, JSON.stringify({ configuredAt, previous: previous ? JSON.parse(previous) : null, next: value }), { mode: 0o600, flag: 'wx' });
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const parent = await fs.open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  return { readers: ids.length, mode: 'private-account-list' };
}
