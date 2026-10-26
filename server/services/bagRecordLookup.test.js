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

test('reported BAG-00523 scan resolves existing stock without creating or renaming stock',async()=>{
  const bag={_id:'original-stock',bagId:'BAG-00523'};
  const collection={findOne:async({bagId})=>bagId===bag.bagId?bag:null};
  assert.equal(await findRegisteredBag(collection,'BAG-00523'),bag);
  assert.equal(await findRegisteredBag(collection,'BAG_00523'),bag);
  assert.equal(await findRegisteredBag(collection,'BAG-000523'),null);
  assert.equal(bag.bagId,'BAG-00523');
});
test('a real six-digit registered tag wins over a shorter padded interpretation',async()=>{
  const records={'BAG-000523':{_id:'six',bagId:'BAG-000523'},'BAG-00523':{_id:'five',bagId:'BAG-00523'}};
  assert.equal((await findRegisteredBag({findOne:async({bagId})=>records[bagId]},'BAG_000523'))._id,'six');
});
test('reported scan cannot choose between duplicate stock records',async()=>{
  const records={'BAG-00523':{_id:'one'},'BAG_00523':{_id:'two'}};
  await assert.rejects(()=>findRegisteredBag({findOne:async({bagId})=>records[bagId]},'BAG-00523'),{statusCode:409});
});
