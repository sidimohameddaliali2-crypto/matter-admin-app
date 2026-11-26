import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionListFilter, collectionSearchFilter, collectionDuplicateFilter, buildRefundAssignment, collectionCsv, openCollectionStatuses } from './collectionOperations.js';
test('open work is the default, history is separate and literal search cannot inject a regex', () => {
  assert.deepEqual(collectionListFilter().status.$in, openCollectionStatuses);
  assert.ok(collectionListFilter({view:'history'}).status.$in.includes('delivered'));
  assert.equal(collectionListFilter({view:'all'}).status, undefined);
  assert.equal(collectionSearchFilter({search:'Sara.*'}).$or[0].customerName.$regex, 'Sara\\.\\*');
  assert.equal(collectionListFilter({driver:'unassigned'}).driver, null);
  assert.throws(() => collectionSearchFilter({search:{$ne:null}}), /search/);
  assert.throws(() => collectionListFilter({driver:'invalid'}), /driver/);
  assert.throws(() => collectionListFilter({view:'invented'}), /Choose/);
});
test('collection and refund date filters include whole Dubai days and reject invalid ranges', () => {
  const range = collectionSearchFilter({dateFrom:'2026-11-27',dateTo:'2026-11-27'}).scheduledTime;
  assert.equal(range.$gte.toISOString(),'2026-11-26T20:00:00.000Z');
  assert.equal(range.$lt.toISOString(),'2026-11-27T20:00:00.000Z');
  assert.throws(() => collectionSearchFilter({dateFrom:'2026-02-30'}), /valid/);
  assert.throws(() => collectionSearchFilter({dateFrom:'2026-11-28',dateTo:'2026-11-27'}), /End date/);
});
test('possible duplicates compare active requests on the Dubai day using identity, phone or literal name', () => {
  const filter = collectionDuplicateFilter({customerId:'C001',customerName:'Sara Ahmed',scheduledTime:new Date('2026-11-26T20:00:00Z'),collectionRequest:{customerSource:'internal',phone:'+971500000001'}});
  assert.equal(filter.scheduledTime.$gte.toISOString(),'2026-11-26T20:00:00.000Z');
  assert.ok(filter.$or.some(item=>item.customerId==='C001'));
  assert.equal(new RegExp(filter.$or[0].customerName.$regex,'i').test('sara  ahmed'),true);
  assert.ok(filter.status.$in.includes('pending'));
  assert.ok(!filter.status.$in.includes('collected'));
});
test('refund assignment is audited, versioned and cannot mark payment or overwrite its evidence', () => {
  const actor={_id:'a',role:'manager',email:'manager@test'}, owner={_id:'o',email:'owner@test'}, record={collectionRefund:{version:2}};
  const input={version:2,eventId:'assignment-123',dueDate:'2026-12-01'};
  const update=buildRefundAssignment(record,input,owner,actor);
  assert.equal(update.$set['collectionRefund.owner'],'o');
  assert.equal(update.$set['collectionRefund.status'],undefined);
  assert.equal(update.$set['collectionRefund.reference'],undefined);
  assert.equal(update.$push['collectionRefund.assignmentHistory'].actor,'a');
  assert.equal(update.$inc['collectionRefund.version'],1);
  assert.throws(()=>buildRefundAssignment(record,{...input,version:1},owner,actor),/changed/);
  assert.throws(()=>buildRefundAssignment({collectionRefund:{version:2,status:'refunded'}},input,owner,actor),/completed/);
  assert.throws(()=>buildRefundAssignment(record,input,owner,{...actor,role:'dispatcher'}),/Management/);
  assert.throws(()=>buildRefundAssignment(record,{...input,dueDate:'2026-02-30'},owner,actor),/valid/);
});
test('Excel-compatible CSV quotes values and neutralizes formula cells', () => {
  const csv=collectionCsv(['Customer','Note'],[['=HYPERLINK("x")','line1\nline2'],['Sara, Ahmed','+123']]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'));
  assert.ok(csv.includes('"Sara, Ahmed"'));
  assert.ok(csv.includes('"\'+123"'));
});
