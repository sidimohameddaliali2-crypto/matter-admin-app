// Automatic zone rules: emirate Abu Dhabi, or zone "Dubai South" -> zone "Abu Dhabi".
import test from 'node:test';
import assert from 'node:assert/strict';
import Delivery from './Delivery.js';
import { applyZoneRules, isAbuDhabiEmirate } from '../config/zoneRules.js';

test('rule: any Abu Dhabi emirate spelling forces the Abu Dhabi zone', () => {
  for (const city of ['Abu Dhabi', 'abu dhabi', 'ABU DHABI', 'Abu Dhabi - Al Reem Island', 'AbuDhabi', '  Abu Dhabi ']) {
    assert.equal(isAbuDhabiEmirate(city), true, city);
    assert.equal(applyZoneRules({ zone: 'Al Reem Island', city }), 'Abu Dhabi', city);
    assert.equal(applyZoneRules({ zone: 'Undefined', city }), 'Abu Dhabi', city);
  }
});

test('rule: zone "Dubai South" becomes Abu Dhabi, whatever the emirate', () => {
  assert.equal(applyZoneRules({ zone: 'Dubai South', city: 'Dubai' }), 'Abu Dhabi');
  assert.equal(applyZoneRules({ zone: 'Dubai South', city: undefined }), 'Abu Dhabi');
  assert.equal(applyZoneRules({ zone: ' dubai south ', city: '' }), 'Abu Dhabi');
});

test('rule: everything else is left alone', () => {
  assert.equal(applyZoneRules({ zone: 'Jumeirah 1', city: 'Dubai' }), 'Jumeirah 1');
  assert.equal(applyZoneRules({ zone: 'Dubai Marina', city: 'DUBAI' }), 'Dubai Marina');
  assert.equal(applyZoneRules({ zone: 'Al Barsha', city: undefined }), 'Al Barsha');
  assert.equal(applyZoneRules({ zone: undefined, city: 'Sharjah' }), undefined);
  assert.equal(isAbuDhabiEmirate('Dubai - Abu Dhabi Road'), false); // must START with Abu Dhabi
  assert.equal(isAbuDhabiEmirate(null), false);
});

const make = (o) => new Delivery({ customerId: 'C1', customerName: 'N', scheduledTime: new Date('2026-10-13T02:00:00Z'), company: 'Matter', address: 'x', ...o });

test('new/bulk-inserted deliveries get the rule applied on validate', async () => {
  const a = make({ zone: 'Al Reem Island', addressDetails: { city: 'Abu Dhabi - Al Reem Island' } });
  await a.validate();
  assert.equal(a.zone, 'Abu Dhabi');

  const b = make({ zone: 'Dubai South' }); // e.g. a CSV upload whose address was auto-detected as Dubai South
  await b.validate();
  assert.equal(b.zone, 'Abu Dhabi');

  const c = make({ zone: 'Jumeirah 1', addressDetails: { city: 'DUBAI' } });
  await c.validate();
  assert.equal(c.zone, 'Jumeirah 1');
});

test('a dispatcher re-editing the zone on an existing delivery is also covered (save path)', async () => {
  const d = make({ zone: 'Jumeirah 1', addressDetails: { city: 'Abu Dhabi' } });
  d.zone = 'Khalifa City';
  await d.validate();
  assert.equal(d.zone, 'Abu Dhabi');
});

async function runUpdateHook(update, { onFile = null, op = 'findOneAndUpdate' } = {}) {
  const origFindOne = Delivery.findOne;
  Delivery.findOne = () => ({ select: () => ({ lean: async () => (onFile ? { addressDetails: { city: onFile } } : null) }) });
  try {
    const query = Delivery.findOneAndUpdate({ _id: '6a1bbd6a925161da6ed226e9' }, update); // built, never executed
    query.op = op;
    await new Promise((resolve, reject) => {
      Delivery.schema.s.hooks.execPre(op, query, [], (err) => (err ? reject(err) : resolve()));
    });
    return query.getUpdate().$set;
  } finally {
    Delivery.findOne = origFindOne;
  }
}

test('update path: setting zone "Dubai South" becomes Abu Dhabi', async () => {
  assert.equal((await runUpdateHook({ $set: { zone: 'Dubai South' } })).zone, 'Abu Dhabi');
});

test('update path: a zone edit on a delivery whose emirate on file is Abu Dhabi is forced to Abu Dhabi', async () => {
  assert.equal((await runUpdateHook({ $set: { zone: 'Al Barsha' } }, { onFile: 'Abu Dhabi - Yas Island' })).zone, 'Abu Dhabi');
  assert.equal((await runUpdateHook({ $set: { zone: 'Al Barsha' } }, { onFile: 'Dubai' })).zone, 'Al Barsha');
});

test('update path: changing the emirate to Abu Dhabi (no zone in the edit) sets the zone; other emirates do not', async () => {
  assert.equal((await runUpdateHook({ $set: { 'addressDetails.city': 'Abu Dhabi' } })).zone, 'Abu Dhabi');
  assert.equal((await runUpdateHook({ $set: { 'addressDetails.city': 'Dubai' } })).zone, undefined);
});

test('update path: unrelated edits and updateMany are untouched / never read the database', async () => {
  const unrelated = await runUpdateHook({ $set: { notes: 'x' } });
  assert.equal(unrelated.zone, undefined);
  let reads = 0;
  const orig = Delivery.findOne;
  Delivery.findOne = () => { reads += 1; return { select: () => ({ lean: async () => null }) }; };
  try {
    const q = Delivery.updateMany({ company: 'Matter' }, { $set: { zone: 'Dubai South' } });
    q.op = 'updateMany';
    await new Promise((res, rej) => Delivery.schema.s.hooks.execPre('updateMany', q, [], (e) => (e ? rej(e) : res())));
    assert.equal(q.getUpdate().$set.zone, 'Abu Dhabi');
    assert.equal(reads, 0);
  } finally { Delivery.findOne = orig; }
});
