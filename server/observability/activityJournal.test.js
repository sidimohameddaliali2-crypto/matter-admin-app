import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createActivityJournal } from './activityJournal.js';
import { formActivity } from './activityForms.js';
import { safeChanges, activityActor } from './activityPolicy.js';

const event = () => ({
  eventId: randomUUID(),
  occurredAt: new Date().toISOString(),
  summary: 'Osman edited a form.',
});
test('disk history survives restart and retries idempotently after database recovery', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'activity-journal-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved = new Map();
  let connected = false;
  const options = {
    directory,
    connected: () => connected,
    persist: async (entry) => {
      saved.set(entry.eventId, entry);
    },
    list: async () => [...saved.values()],
  };
  const first = createActivityJournal(options);
  const original = event();
  await first.append(original);
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  assert.equal((await stat(path.join(directory, names[0]))).mode & 0o777, 0o600);
  const restarted = createActivityJournal(options);
  assert.equal((await restarted.read()).events[0].eventId, original.eventId);
  await restarted.append({
    ...original,
    summary: 'Duplicate delivery must not replace the first event',
  });
  assert.equal((await restarted.read()).events[0].summary, original.summary);
  connected = true;
  await restarted.flush();
  assert.equal(saved.size, 1);
  assert.equal((await restarted.read()).events.length, 1);
  assert.equal((await readdir(directory)).length, 0);
});
test('failed database writes remain on disk and valid interrupted files recover', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'activity-journal-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let fail = true;
  const saved = new Map();
  const journal = createActivityJournal({
    directory,
    connected: () => true,
    persist: async (entry) => {
      if (fail) throw Error('offline fixture');
      saved.set(entry.eventId, entry);
    },
    list: async () => [...saved.values()],
  });
  const original = event();
  await journal.append(original);
  await journal.flush();
  assert.equal((await journal.read()).events.length, 1);
  assert.ok(journal.failure());
  const duplicateFile = path.join(directory, `${randomUUID()}.tmp`);
  await writeFile(
    duplicateFile,
    JSON.stringify({ ...original, summary: 'A retry must not replace the original event.' }),
    { mode: 0o600 },
  );
  await utimes(duplicateFile, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
  const interrupted = event();
  const file = path.join(directory, `${randomUUID()}.tmp`);
  await writeFile(file, JSON.stringify(interrupted), { mode: 0o600 });
  await utimes(file, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
  fail = false;
  await journal.recover();
  assert.equal(saved.size, 2);
  assert.equal(saved.get(original.eventId).summary, original.summary);
  assert.equal((await readdir(directory)).length, 0);
});
test('form events use verified identity, hide secrets, deduplicate within the actor and preserve the draft boundary', () => {
  const input = {
    eventId: randomUUID(),
    actionId: randomUUID(),
    stage: 'form_edited',
    page: '/drivers/create',
    occurredAt: new Date().toISOString(),
    actor: { name: 'Forged' },
    form: { title: 'Add driver', field: 'Password' },
    changes: [{ field: 'Password', before: 'PRIVATE_OLD', after: 'PRIVATE_NEW' }],
  };
  const catalog = { browser: [{ path: '/drivers/create' }] };
  const req = { user: { _id: 'verified-id', name: 'Osman', role: 'admin' } };
  const value = formActivity(req, input, catalog);
  assert.equal(value.actor.name, 'Osman');
  assert.equal(value.actor.id, 'verified-id');
  assert.equal(value.actor.role, 'admin');
  assert.equal(value.outcome, 'draft');
  assert.equal(value.stage, 'form_edited');
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  assert.equal(value.eventId, formActivity(req, input, catalog).eventId);
  assert.notEqual(
    value.eventId,
    formActivity({ user: { _id: 'another', name: 'Another', role: 'admin' } }, input, catalog)
      .eventId,
  );
  assert.throws(() => formActivity(req, { ...input, page: '/traceability' }, catalog));
});
test('filtered disk history resolves completed operations held in the database', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'activity-journal-terminal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operationId = randomUUID();
  const journal = createActivityJournal({
    directory,
    connected: () => true,
    persist: async () => { throw Error('keep pending fixture'); },
    resolveOperations: async ids => ids.includes(operationId) ? [operationId] : [],
    list: async () => [],
  });
  await journal.append({ ...event(), operationId, stage: 'record_waiting_for_commit', issue: 'Waiting for transaction.' });
  assert.equal((await journal.read({ issues: true })).events.length, 0);
  assert.equal((await journal.read({ q: 'edited' })).events.length, 0);
});
test('record changes redact identity, credentials and customer free text while preserving operational changes', () => {
  const changes = safeChanges(
    { status: 'pending', password: 'PRIVATE_OLD' },
    {
      status: 'saved',
      password: 'PRIVATE_NEW',
      profile: { firstName: 'Fixture', nationalId: 'PRIVATE_ID' },
      text: 'PRIVATE_MESSAGE',
    },
  );
  assert.ok(
    changes.some(
      (row) => row.field === 'status' && row.before === 'pending' && row.after === 'saved',
    ),
  );
  assert.ok(!JSON.stringify(changes).includes('PRIVATE'));
  assert.equal(activityActor({ member: { _id: 'm1', name: 'Member' } }).role, 'member');
  assert.equal(activityActor({ partner: { _id: 'p1', name: 'Partner' } }).role, 'partner');
  assert.equal(activityActor().name, 'Automatic process');
});
