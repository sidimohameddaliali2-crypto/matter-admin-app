import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityPlugin, wrapActivitySession } from './activityDatabase.js';

test('a transaction retry never confirms writes from its uncommitted earlier attempt', async () => {
  const events = [];
  const write = async event => { events.push(event); };
  const hooks = {};
  const schema = { options: {}, pre(name, ...args) { if (name === 'save') hooks.before = args.at(-1); }, post(name, ...args) { if (name === 'save') hooks.after = args.at(-1); } };
  createActivityPlugin({ write })(schema);
  let active = false;
  let firstCommit = true;
  const session = wrapActivitySession({
    startTransaction() { active = true; },
    inTransaction() { return active; },
    async commitTransaction() { active = false; if (firstCommit) { firstCommit = false; throw Object.assign(Error('retry fixture'), { errorLabels: ['TransientTransactionError'] }); } },
    async abortTransaction() { active = false; },
  }, write);
  const save = async id => {
    const document = { isNew: true, constructor: { modelName: 'Fixture' }, $locals: {}, $session: () => session, toObject: () => ({ _id: id, label: id }) };
    await hooks.before.call(document);
    await hooks.after.call(document, document);
  };
  session.startTransaction();
  await save('first-attempt');
  await assert.rejects(session.commitTransaction(), /retry fixture/);
  session.startTransaction();
  await save('second-attempt');
  await session.commitTransaction();
  assert.deepEqual(events.filter(event => event.stage === 'record_saved').map(event => event.record.id), ['second-attempt']);
  assert.ok(events.some(event => event.record.id === 'first-attempt' && event.outcome === 'uncertain'));
  assert.ok(events.filter(event => event.stage === 'record_waiting_for_commit').every(event => !event.issue));
});
