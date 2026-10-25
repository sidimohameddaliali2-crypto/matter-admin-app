import test from 'node:test';
import assert from 'node:assert/strict';
import {findRegisteredBag} from './bagRecordLookup.js';
import {normalizeBagId} from './bagInventoryAudit.js';

test('printed underscore and stored hyphen identify the same bag without losing zeros',async()=>{
  const bag={_id:'stock1',bagId:'BAG-00001'};
  const collection={findOne:async({bagId})=>bagId===bag.bagId?bag:null};
  assert.equal(await findRegisteredBag(collection,' bag_00001 '),bag);
  assert.equal(await findRegisteredBag(collection,'BAG-0001'),null);
  assert.equal(normalizeBagId('bag_00001'),'BAG-00001');
});
test('legacy underscore stock remains usable without renaming its document',async()=>{
  const bag={_id:'legacy',bagId:'BAG_0123'};
  assert.equal(await findRegisteredBag({findOne:async({bagId})=>bagId===bag.bagId?bag:null},'BAG-0123'),bag);
});
test('equivalent IDs on distinct stock records require reconciliation instead of arbitrary assignment',async()=>{
  const records={'BAG-0001':{_id:'one'},'BAG_0001':{_id:'two'}};
  await assert.rejects(()=>findRegisteredBag({findOne:async({bagId})=>records[bagId]},'BAG_0001'),{statusCode:409});
});
