import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import XLSX from 'xlsx';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Staff from '../models/ServiceStaffProfile.js';
import Conversation from '../models/ServiceConversation.js';
import Message from '../models/ServiceMessage.js';
import Issue from '../models/ServiceIssue.js';
import Review from '../models/ServiceReview.js';
import Action from '../models/ServiceAction.js';
import CaptureBatch from '../models/ServiceCaptureBatch.js';
import router from '../routes/customerServiceData.js';
import matterApi from '../services/matterApiService.js';
import { ingestServiceBatch } from '../services/customerServiceCapture.js';
import { getServiceSnapshot, summarizeServiceSnapshot, buildServiceWorkbook } from '../services/customerServiceReports.js';

// Remote CI only: never fall back to MONGODB_URI, real staff or a shared database.
const uri = process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI;
const enabled = Boolean(uri && process.env.CUSTOMER_SERVICE_TEST_ISOLATED === 'true');
const dbName = `matter_service_test_${randomUUID().replaceAll('-', '')}`;
const originalJwtSecret = process.env.JWT_SECRET;
let server, origin, supervisor, reviewer, other, ungranted, databaseVerified = false;
let originalGetSubscription;

before(async () => {
  if (!enabled) return;
  assert.match(dbName, /^matter_service_test_[a-f0-9]{32}$/);
  assert.equal(mongoose.connection.readyState, 0, 'Do not take over another runtime connection');
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 5000, autoIndex: false });
  assert.equal(mongoose.connection.name, dbName);
  const identity = await mongoose.connection.db.admin().command({ hello: 1 });
  assert.ok(identity.setName, 'Capture transactions require an explicitly isolated replica set');
  databaseVerified = true;

  await Promise.all([User, Customer, Staff, Conversation, Message, Issue, Review, Action, CaptureBatch].map(model => model.init()));
  // The existing Customer schema declares conflicting legacy email indexes.
  // Exercise the new unique indexes without altering that unrelated schema.
  await Promise.all([User, Staff, Conversation, Message, Issue, Review, Action, CaptureBatch].map(model => model.createIndexes()));
  [supervisor, reviewer, other, ungranted] = await User.create(['supervisor', 'reviewer', 'other', 'ungranted'].map(name => ({
    email: `${name}@fixture.invalid`, password: randomUUID(), role: 'admin', isActive: true,
    profile: { firstName: `Private-${name}`, lastName: 'Fixture-personnel' },
  })));
  await Staff.create([supervisor, reviewer, other].map((user, index) => ({
    userId: user._id, mode: index === 0 ? 'supervisor' : 'reviewer', enabled: true,
    displayName: `Fixture staff ${index}`, availableMinutes: 60,
  })));

  // All provider access is a boundary fixture. No test can reach a live Matter API.
  originalGetSubscription = matterApi.getSubscription;
  matterApi.getSubscription = async () => { throw new Error('Fixture provider unavailable'); };
  process.env.JWT_SECRET = randomUUID();
  const app = express();
  app.use(express.json());
  app.use('/api/customer-service', router);
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}/api/customer-service`;
});

after(async () => {
  if (!enabled) return;
  if (server?.listening) {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (originalGetSubscription) matterApi.getSubscription = originalGetSubscription;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  // Only this invocation's verified, randomly named database may be removed.
  if (databaseVerified && mongoose.connection.name === dbName) {
    for (const collection of await mongoose.connection.db.listCollections().toArray()) {
      await mongoose.connection.db.collection(collection.name).drop();
    }
  }
  await mongoose.disconnect();
});

const run = (name, fn) => test(name, { skip: !enabled, timeout: 30000 }, fn);
const requestId = () => randomUUID();
const str = value => String(value?._id || value);
function rawMessage(overrides = {}) {
  return {
    externalMessageId: requestId(), externalConversationId: requestId(),
    customerId: '', customerName: 'Fixture customer', externalAuthorId: '',
    authorName: 'Fixture customer', authorType: 'customer',
    sentAt: '2026-11-06T06:00:00Z', type: 'text', text: 'Please check my discount code.',
    ...overrides,
  };
}
function batch(messages, overrides = {}) {
  return {
    messages, source: 'fixture_export', scope: requestId(), requestId: requestId(),
    from: new Date('2026-11-05T20:00:00Z'), to: new Date('2026-11-06T20:00:00Z'),
    actor: supervisor, ...overrides,
  };
}
async function http(path, { user = supervisor, method = 'GET', body } = {}) {
  const token = jwt.sign({ id: str(user) }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
  return fetch(`${origin}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
}
async function issueFixture({ owner = reviewer, name = 'Scoped customer', sentAt = '2026-11-06T06:00:00Z', customerId = requestId(), text = 'Scoped customer evidence' } = {}) {
  const conversation = await Conversation.create({
    source: 'fixture_export', scope: requestId(), externalConversationId: requestId(),
    customerId, customerName: name, sourceRevision: 2, lastMessageAt: new Date(sentAt), coverageStatus: 'partial',
  });
  const message = await Message.create({
    source: conversation.source, scope: conversation.scope, externalMessageId: requestId(), externalConversationId: conversation.externalConversationId,
    conversationId: conversation._id, sentAt: new Date(sentAt), authorName: 'Fixture source author', authorType: 'customer', type: 'text', text, mediaState: 'not_applicable',
  });
  const issue = await Issue.create({
    conversationId: conversation._id, customerId, customerName: name, summary: 'Scoped issue',
    categoryIds: ['coupons_discounts'], sourceRevision: 2, boundaryState: 'confirmed',
    evidenceMessageIds: [message._id], outcome: 'open',
  });
  const review = await Review.create({ issueId: issue._id, reviewerId: owner._id, status: 'assigned', sourceRevision: 2 });
  return { conversation, message, issue, review };
}
function workbookRows(book, name) { return XLSX.utils.sheet_to_json(book.Sheets[name], { defval: '' }); }
function visibleNames(book) { return book.SheetNames.filter((name, index) => !book.Workbook?.Sheets?.[index]?.Hidden); }

run('backfilled evidence inside a bounded secondary episode invalidates its saved judgment',async()=>{
 const row=rawMessage({sentAt:'2026-11-06T06:00:00Z'});const args=batch([row]);await ingestServiceBatch(args);
 const conversation=await Conversation.findOne({scope:args.scope}).lean();
 const issue=await Issue.create({conversationId:conversation._id,episodeKey:'secondary',sourceRevision:1,episodeFrom:new Date('2026-11-06T05:00:00Z'),episodeTo:new Date('2026-11-06T07:00:00Z'),boundaryState:'confirmed',outcome:'resolved'});
 const review=await Review.create({issueId:issue._id,reviewerId:reviewer._id,status:'submitted',sourceRevision:1,revisions:[{verdict:'good',sourceRevision:1,summary:'Earlier snapshot',at:new Date()}]});
 await ingestServiceBatch({...args,requestId:requestId(),messages:[{...row,externalMessageId:requestId(),authorType:'staff',externalAuthorId:'unmapped-new-sender',sentAt:'2026-11-06T06:30:00Z'}]});
 const changed=await Issue.findById(issue._id).lean();const saved=await Review.findById(review._id).lean();
 assert.ok(changed.sourceRevision>1);assert.equal(changed.outcome,'open');assert.equal(changed.sourceMetadata.unmappedStaff,true);assert.equal(saved.stale,true);assert.equal(saved.revisions.length,1);
});

run('a date and confirmed episode export cannot disclose other messages in the same conversation',async()=>{
 const f=await issueFixture();
 await Issue.updateOne({_id:f.issue._id},{$set:{episodeFrom:new Date('2026-11-06T05:00:00Z'),episodeTo:new Date('2026-11-06T07:00:00Z')}});
 await Message.create({source:f.conversation.source,scope:f.conversation.scope,externalMessageId:requestId(),conversationId:f.conversation._id,sentAt:new Date('2026-11-07T06:00:00Z'),authorType:'customer',type:'text',text:'OUT-OF-SCOPE SECRET'});
 const snapshot=await getServiceSnapshot({userId:supervisor._id,supervise:true,filters:{from:'2026-11-06',to:'2026-11-06',q:'Scoped customer'}});
 const book=XLSX.read(await buildServiceWorkbook(snapshot),{type:'buffer'});
 assert.ok(!workbookRows(book,'Customer chats').some(m=>m.Text==='OUT-OF-SCOPE SECRET'));
});

run('out-of-order capture sorts chronology and duplicate evidence does not create issues or revisions', async () => {
  const thread = requestId();
  const late = rawMessage({ externalConversationId: thread, sentAt: '2026-11-06T07:00:00Z', text: 'Later evidence' });
  const early = rawMessage({ externalConversationId: thread, sentAt: '2026-11-06T05:00:00Z', text: 'Earlier evidence' });
  const args = batch([late, early]);

  const first = await ingestServiceBatch(args);
  const beforeRetry = await Conversation.findOne({ source: args.source, scope: args.scope }).lean();
  const retry = await ingestServiceBatch({ ...args, requestId: requestId() });
  const saved = await Message.find({ conversationId: beforeRetry._id }).sort({ sentAt: 1 }).lean();

  assert.equal(first.inserted, 2);
  assert.equal(retry.inserted, 0);
  assert.equal(retry.duplicates, 2);
  assert.deepEqual(saved.map(message => message.text), ['Earlier evidence', 'Later evidence']);
  assert.equal((await Conversation.findById(beforeRetry._id)).sourceRevision, beforeRetry.sourceRevision);
  assert.equal(beforeRetry.lastMessageAt.toISOString(), '2026-11-06T07:00:00.000Z');
  assert.equal(await Issue.countDocuments({ conversationId: beforeRetry._id }), 1);
  assert.equal((await Issue.findOne({ conversationId: beforeRetry._id })).boundaryState, 'needs_review');
});

run('same-actor capture retry returns committed counts without multiplying saved evidence', async () => {
  const args = batch([rawMessage()]);

  const first = await ingestServiceBatch(args);
  const retry = await ingestServiceBatch(args);

  assert.equal(first.inserted, 1);
  assert.equal(retry.inserted, 1, 'Return the already committed operation result');
  assert.equal(retry.duplicate, true);
  assert.equal(await Message.countDocuments({ source: args.source, scope: args.scope }), 1);
  assert.equal(await CaptureBatch.countDocuments({ requestId: args.requestId }), 1);
});

run('simultaneous same-request imports commit once and both callers receive the committed result', async () => {
  const args = batch([rawMessage()]);

  const results = await Promise.all([ingestServiceBatch(args), ingestServiceBatch(args)]);

  assert.deepEqual(results.map(result => result.inserted), [1, 1]);
  assert.equal(await Message.countDocuments({ source: args.source, scope: args.scope }), 1);
  assert.equal(await CaptureBatch.countDocuments({ requestId: args.requestId }), 1);
});

run('a request ID cannot be reused by another actor or with changed batch evidence', async () => {
  const args = batch([rawMessage()]);
  await ingestServiceBatch(args);

  await assert.rejects(ingestServiceBatch({ ...args, actor: other }), error => error.statusCode === 409);
  await assert.rejects(ingestServiceBatch({ ...args, messages: [{ ...args.messages[0], text: 'Changed evidence' }] }), error => error.statusCode === 409);
  await assert.rejects(ingestServiceBatch({ ...args, to: new Date('2026-11-07T20:00:00Z') }), error => error.statusCode === 409);

  assert.equal((await Message.findOne({ source: args.source, scope: args.scope })).text, args.messages[0].text);
});

run('impossible message dates fail the whole import without a partial batch or source write', async () => {
  const args = batch([rawMessage(), rawMessage({ sentAt: '2026-02-30T06:00:00Z' })]);

  await assert.rejects(ingestServiceBatch(args), /date|time/i);

  assert.equal(await Message.countDocuments({ source: args.source, scope: args.scope }), 0);
  assert.equal(await Conversation.countDocuments({ source: args.source, scope: args.scope }), 0);
  assert.equal(await CaptureBatch.countDocuments({ requestId: args.requestId }), 0);
});

run('conflicting saved source IDs roll back other new rows in the same import', async () => {
  const original = rawMessage();
  const args = batch([original]);
  await ingestServiceBatch(args);
  const before = await Conversation.findOne({ source: args.source, scope: args.scope }).lean();
  const secondId = requestId();

  await assert.rejects(ingestServiceBatch({
    ...args, requestId: secondId,
    messages: [rawMessage({ externalConversationId: original.externalConversationId }), { ...original, text: 'Replacement source text' }],
  }), error => error.statusCode === 409);

  assert.equal(await Message.countDocuments({ source: args.source, scope: args.scope }), 1);
  assert.equal(await CaptureBatch.countDocuments({ requestId: secondId }), 0);
  assert.equal((await Conversation.findById(before._id)).sourceRevision, before.sourceRevision);
});

run('source identity conflicts include sender and message type rather than only text and timestamp', async () => {
  const original = rawMessage({ authorType: 'staff', externalAuthorId: 'unmapped-source-agent' });
  const args = batch([original]);
  await ingestServiceBatch(args);

  for (const patch of [{ externalAuthorId: 'different-source-agent' }, { authorType: 'customer' }, { type: 'audio' }, { externalConversationId: requestId() }]) {
    await assert.rejects(ingestServiceBatch({ ...args, requestId: requestId(), messages: [{ ...original, ...patch }] }), error => error.statusCode === 409);
  }

  assert.equal(await Conversation.countDocuments({ source: args.source, scope: args.scope }), 1);
});

run('staff attribution uses verified external IDs and never infers a sender from a matching display name', async () => {
  const scope = requestId();
  const key = `fixture_export:${scope}:verified-agent`;
  await Staff.updateOne({ userId: reviewer._id }, { $addToSet: { externalAuthorIds: key } });
  const thread = requestId();
  const args = batch([
    rawMessage({ externalConversationId: thread, authorType: 'staff', authorName: 'Fixture staff 1', externalAuthorId: 'verified-agent' }),
    rawMessage({ externalConversationId: thread, authorType: 'staff', authorName: 'Fixture staff 1', externalAuthorId: 'unverified-agent' }),
    rawMessage({ externalConversationId: thread, authorType: 'unknown', authorName: 'Fixture staff 1' }),
  ], { scope });

  await ingestServiceBatch(args);
  const messages = await Message.find({ source: args.source, scope }).sort({ externalAuthorId: 1 }).lean();
  const issue = await Issue.findOne({ conversationId: messages[0].conversationId }).lean();

  assert.equal(str(messages.find(message => message.externalAuthorId === 'verified-agent').authorId), str(reviewer));
  assert.equal(messages.find(message => message.externalAuthorId === 'unverified-agent').authorId, null);
  assert.equal(messages.find(message => message.authorType === 'unknown').authorId, null);
  assert.deepEqual(issue.contributorIds.map(str), [str(reviewer)]);
  assert.equal(issue.sourceMetadata.unmappedStaff, true);
});

run('ambiguous external staff mappings block capture instead of choosing an arbitrary employee', async () => {
  const scope = requestId();
  const key = `fixture_export:${scope}:ambiguous-agent`;
  await Staff.updateMany({ userId: { $in: [reviewer._id, other._id] } }, { $addToSet: { externalAuthorIds: key } });
  const args = batch([rawMessage({ authorType: 'staff', externalAuthorId: 'ambiguous-agent' })], { scope });
  try {
    await assert.rejects(ingestServiceBatch(args), error => error.statusCode === 409);

    assert.equal(await Message.countDocuments({ source: args.source, scope }), 0);
    assert.equal(await CaptureBatch.countDocuments({ requestId: args.requestId }), 0);
  } finally {
    await Staff.updateMany({ userId: { $in: [reviewer._id, other._id] } }, { $pull: { externalAuthorIds: key } });
  }
});

run('same-name customers remain unlinked and unavailable media stays explicit without creating customer records', async () => {
  const customer = await Customer.create({ customerId: requestId(), firstName: 'Same', lastName: 'Name' });
  const countBefore = await Customer.countDocuments();
  const args = batch([rawMessage({ customerName: 'Same Name', customerId: 'missing-fixture-id', type: 'audio', text: '' })]);

  const result = await ingestServiceBatch(args);
  const conversation = await Conversation.findOne({ source: args.source, scope: args.scope }).lean();
  const message = await Message.findOne({ conversationId: conversation._id }).lean();

  assert.equal(result.unlinked, 1);
  assert.ok(!conversation.customerId);
  assert.equal(conversation.customerName, 'Same Name');
  assert.equal(message.type, 'audio');
  assert.equal(message.mediaState, 'unavailable');
  assert.equal(await Customer.countDocuments(), countBefore);
  assert.equal((await Customer.findById(customer._id)).customerId, customer.customerId);
});

run('new source evidence marks submitted reviews stale while preserving revisions and existing actions', async () => {
  const message = rawMessage();
  const args = batch([message]);
  await ingestServiceBatch(args);
  const conversation = await Conversation.findOne({ source: args.source, scope: args.scope });
  const issue = await Issue.findOne({ conversationId: conversation._id });
  const review = await Review.create({
    issueId: issue._id, reviewerId: reviewer._id, status: 'submitted', sourceRevision: issue.sourceRevision,
    revisions: [{ actorId: reviewer._id, at: new Date(), sourceRevision: issue.sourceRevision, verdict: 'insufficient', summary: 'Preserve the initial evidence judgment' }],
  });
  const action = await Action.create({ issueId: issue._id, reviewId: review._id, description: 'Get missing source evidence', ownerId: reviewer._id, status: 'assigned' });

  await ingestServiceBatch({ ...args, requestId: requestId(), messages: [rawMessage({ externalConversationId: message.externalConversationId, sentAt: '2026-11-06T07:00:00Z' })] });
  const saved = await Review.findById(review._id).lean();

  assert.equal(saved.status, 'submitted');
  assert.equal(saved.stale, true);
  assert.equal(saved.revisions.length, 1);
  assert.equal(saved.revisions[0].summary, 'Preserve the initial evidence judgment');
  assert.ok((await Issue.findById(issue._id)).sourceRevision > saved.sourceRevision);
  assert.equal(await Action.countDocuments({ issueId: issue._id }), 1);
  assert.equal((await Action.findById(action._id)).status, 'assigned');
});

run('two confirmed issue episodes retain distinct boundaries and shared context after a thread update', async () => {
  const first = rawMessage({ text: 'My coupon does not work.' });
  const second = rawMessage({ externalConversationId: first.externalConversationId, text: 'The meal is also wrong.', sentAt: '2026-11-06T06:01:00Z' });
  const args = batch([first, second]);
  await ingestServiceBatch(args);
  const conversation = await Conversation.findOne({ source: args.source, scope: args.scope });
  const messages = await Message.find({ conversationId: conversation._id }).sort({ sentAt: 1 });
  const primary = await Issue.findOne({ conversationId: conversation._id });
  await Issue.updateOne({ _id: primary._id }, { $set: {
    episodeKey: 'coupon', categoryIds: ['coupons_discounts'], boundaryState: 'confirmed',
    episodeFrom: messages[0].sentAt, episodeTo: messages[0].sentAt, evidenceMessageIds: [messages[0]._id],
  } });
  const meal = await Issue.create({
    conversationId: conversation._id, episodeKey: 'meal', categoryIds: ['wrong_meals'], boundaryState: 'confirmed',
    episodeFrom: messages[1].sentAt, episodeTo: messages[1].sentAt, evidenceMessageIds: [messages[0]._id, messages[1]._id], sourceRevision: conversation.sourceRevision,
  });

  await ingestServiceBatch({ ...args, requestId: requestId(), messages: [rawMessage({ externalConversationId: first.externalConversationId, text: 'Thank you for checking.', sentAt: '2026-11-06T06:02:00Z' })] });
  const savedCoupon = await Issue.findById(primary._id).lean();
  const savedMeal = await Issue.findById(meal._id).lean();

  assert.equal(await Issue.countDocuments({ conversationId: conversation._id }), 2);
  assert.equal(savedCoupon.boundaryState, 'confirmed');
  assert.equal(savedMeal.boundaryState, 'confirmed');
  assert.deepEqual(savedCoupon.categoryIds, ['coupons_discounts']);
  assert.deepEqual(savedMeal.categoryIds, ['wrong_meals']);
  assert.deepEqual(savedCoupon.evidenceMessageIds.map(str), [str(messages[0])]);
  assert.deepEqual(savedMeal.evidenceMessageIds.map(str), [str(messages[0]), str(messages[1])]);
  assert.equal(+savedCoupon.episodeTo, +messages[0].sentAt);
  assert.equal(+savedMeal.episodeFrom, +messages[1].sentAt);
});

run('reviewer snapshots include only assigned reviews and own actions without team review leakage', async () => {
  const own = await issueFixture({ owner: reviewer, name: 'My scoped customer' });
  const hidden = await issueFixture({ owner: other, name: 'Other reviewer private customer' });
  const actionOnly = await issueFixture({ owner: other, name: 'My action customer' });
  await Action.create({ issueId: actionOnly.issue._id, ownerId: reviewer._id, description: 'My own action', status: 'assigned' });
  await Action.create({ issueId: own.issue._id, ownerId: other._id, description: 'Other owner private action', status: 'assigned' });

  const snapshot = await getServiceSnapshot({ userId: reviewer._id, supervise: false });
  const issueIds = snapshot.issues.map(str);

  assert.ok(issueIds.includes(str(own.issue)));
  assert.ok(issueIds.includes(str(actionOnly.issue)));
  assert.ok(!issueIds.includes(str(hidden.issue)));
  assert.ok(snapshot.reviews.every(review => str(review.reviewerId) === str(reviewer)));
  assert.ok(snapshot.actions.every(action => str(action.ownerId) === str(reviewer)));
  assert.ok(snapshot.profiles.every(profile => str(profile.userId) === str(reviewer)));
  assert.equal(snapshot.capture, null);
});

run('Dubai report boundaries include exact midnight and exclude the next service day across summary and export', async () => {
  const beforeDay = await issueFixture({ owner: reviewer, sentAt: '2027-03-28T19:59:59.999Z', name: 'Before Dubai day' });
  const first = await issueFixture({ owner: reviewer, sentAt: '2027-03-28T20:00:00Z', name: 'At Dubai midnight' });
  const last = await issueFixture({ owner: reviewer, sentAt: '2027-03-29T19:59:59.999Z', name: 'End of Dubai day' });
  const afterDay = await issueFixture({ owner: reviewer, sentAt: '2027-03-29T20:00:00Z', name: 'Next Dubai day' });

  const snapshot = await getServiceSnapshot({ userId: supervisor._id, supervise: true, filters: { from: '2027-03-29', to: '2027-03-29' } });
  const report = summarizeServiceSnapshot(snapshot);
  const workbook = XLSX.read(await buildServiceWorkbook(snapshot), { type: 'buffer' });
  const problemIds = workbookRows(workbook, 'Problems').map(row => row.Issue);

  assert.deepEqual(snapshot.issues.map(str).sort(), [str(first.issue), str(last.issue)].sort());
  assert.equal(report.coverage.eligible, 2);
  assert.deepEqual(problemIds.sort(), [str(first.issue), str(last.issue)].sort());
  assert.ok(!problemIds.includes(str(beforeDay.issue)));
  assert.ok(!problemIds.includes(str(afterDay.issue)));
  assert.equal(workbookRows(workbook, 'Customer chats').length, 2);
  const summary = workbookRows(workbook, 'Summary');
  assert.equal(summary.find(row => row.Metric === 'Unique issues').Value, 2);
});

run('category filters use the same issue population in summary and workbook routes', async () => {
  const coupon = await issueFixture({ sentAt: '2027-04-05T06:00:00Z', name: 'Coupon filter fixture' });
  const delivery = await issueFixture({ sentAt: '2027-04-05T06:00:00Z', name: 'Delivery filter fixture' });
  await Issue.updateOne({ _id: delivery.issue._id }, { $set: { categoryIds: ['delivery'] } });
  const query = '?from=2027-04-05&to=2027-04-05&categoryId=coupons_discounts';

  const summaryResponse = await http(`/summary${query}`);
  const exportResponse = await http(`/export.xlsx${query}`);
  const summary = await summaryResponse.json();
  const workbook = XLSX.read(Buffer.from(await exportResponse.arrayBuffer()), { type: 'buffer' });

  assert.equal(summaryResponse.status, 200);
  assert.equal(exportResponse.status, 200);
  assert.equal(summary.data.coverage.eligible, 1);
  assert.deepEqual(workbookRows(workbook, 'Problems').map(row => row.Issue), [str(coupon.issue)]);
  assert.equal(workbookRows(workbook, 'Summary').find(row => row.Metric === 'Unique issues').Value, 1);
  assert.equal(workbookRows(workbook, 'Customer chats').length, 1);
});

run('workbook has exactly four visible pages, source coverage, taxonomy and Dubai time metadata', async () => {
  const fixture = await issueFixture({ sentAt: '2027-04-01T06:00:00Z' });
  const snapshot = await getServiceSnapshot({ userId: supervisor._id, supervise: true, filters: { from: '2027-04-01', to: '2027-04-01' } });
  snapshot.capture = { createdAt: new Date('2027-04-01T08:00:00Z'), from: new Date('2027-03-31T20:00:00Z'), to: new Date('2027-04-01T20:00:00Z'), status: 'completed' };

  const workbook = XLSX.read(await buildServiceWorkbook(snapshot), { type: 'buffer' });
  const values = workbook.SheetNames.flatMap(name => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1 }).flat()).join('\n');
  const chat = workbookRows(workbook, 'Customer chats').find(row => row.MessageID === fixture.message.externalMessageId);

  assert.deepEqual(visibleNames(workbook), ['Summary', 'Problems', 'Customers', 'Customer chats']);
  assert.match(values, /2026-11-06\.1/, 'Workbook records the shared taxonomy version');
  assert.match(values, /Asia\/Dubai|\+04:00/, 'Export declares the time presentation boundary');
  assert.match(values, /2027-03-31T20:00|2027-04-01/, 'Dated source coverage is visible');
  assert.equal(Date.parse(chat.SentAt), Date.parse('2027-04-01T06:00:00Z'));
  assert.match(values, /partial|unknown|not verified|unavailable/i, 'Capture gaps must remain explicit');
});

run('untrusted customer, summary, author and message values cannot become workbook formulas', async () => {
  const fixture = await issueFixture({ name: '=HYPERLINK("https://fixture.invalid","customer")', text: ' \t=1+1', sentAt: '2027-04-02T06:00:00Z' });
  await Issue.updateOne({ _id: fixture.issue._id }, { $set: { summary: '+SUM(1,2)' } });
  await Message.updateOne({ _id: fixture.message._id }, { $set: { authorName: '@SUM(1,2)' } });
  const snapshot = await getServiceSnapshot({ userId: supervisor._id, supervise: true, filters: { from: '2027-04-02', to: '2027-04-02' } });

  const workbook = XLSX.read(await buildServiceWorkbook(snapshot), { type: 'buffer' });
  const problem = workbookRows(workbook, 'Problems')[0];
  const chat = workbookRows(workbook, 'Customer chats')[0];

  assert.equal(problem.Customer, '\'=HYPERLINK("https://fixture.invalid","customer")');
  assert.equal(problem.Summary, "'+SUM(1,2)");
  assert.equal(chat.Author, "'@SUM(1,2)");
  assert.equal(chat.Text, "' \t=1+1");
  for (const name of workbook.SheetNames) {
    for (const [address, cell] of Object.entries(workbook.Sheets[name])) {
      if (!address.startsWith('!')) assert.equal(cell.f, undefined, `${name}!${address} must remain data`);
    }
  }
});

run('reviewers and generic admins cannot download supervisory exports or import messages', async () => {
  for (const user of [reviewer, ungranted]) {
    const exportResponse = await http('/export.xlsx', { user });
    const importResponse = await http('/import', { user, method: 'POST', body: { requestId: requestId(), messages: [rawMessage()] } });

    assert.equal(exportResponse.status, 403);
    assert.equal(importResponse.status, 403);
    assert.ok(!(exportResponse.headers.get('content-type') || '').includes('spreadsheetml'));
  }
});

run('supervisor export excludes unrelated customer contact fields and personnel credentials', async () => {
  const customerId = requestId();
  await Customer.create({ customerId, firstName: 'Export', lastName: 'Fixture', email: 'private-customer@fixture.invalid', phone: 'private-phone-fixture', address: 'Private address fixture', matterSubscriptionId: requestId() });
  await issueFixture({ customerId, sentAt: '2027-04-03T06:00:00Z' });

  const response = await http('/export.xlsx?from=2027-04-03&to=2027-04-03');
  const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
  const data = JSON.stringify(workbook.SheetNames.map(name => workbookRows(workbook, name)));

  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.deepEqual(visibleNames(workbook), ['Summary', 'Problems', 'Customers', 'Customer chats']);
  for (const forbidden of ['private-customer@fixture.invalid', 'private-phone-fixture', 'Private address fixture', '@fixture.invalid', 'Private-supervisor', 'Fixture-personnel', 'password', 'externalAuthorIds']) {
    assert.ok(!data.includes(forbidden), `Export must not include ${forbidden}`);
  }
});

run('unlinked or unavailable customer context stays usable and guessed customer IDs remain denied', async () => {
  const unlinked = await issueFixture({ owner: reviewer });
  const unavailableId = requestId();
  const customer = await Customer.create({ customerId: unavailableId, firstName: 'Context', lastName: 'Fixture', matterSubscriptionId: requestId() });
  await issueFixture({ customerId: unavailableId, owner: reviewer });
  const forbidden = await issueFixture({ owner: other });
  const before = await Customer.findById(customer._id).lean();

  const unlinkedResponse = await http(`/customers/${unlinked.issue.customerId}/context`, { user: reviewer });
  const unavailableResponse = await http(`/customers/${unavailableId}/context`, { user: reviewer });
  const forbiddenResponse = await http(`/customers/${forbidden.issue.customerId}/context`, { user: reviewer });
  const missing = await unlinkedResponse.json();
  const unavailable = await unavailableResponse.json();

  assert.equal(unlinkedResponse.status, 200);
  assert.equal(missing.data.sourceState, 'not_linked');
  assert.equal(missing.data.subscription, null);
  assert.equal(unavailableResponse.status, 200);
  assert.equal(unavailable.data.sourceState, 'unavailable');
  assert.equal(unavailable.data.subscription, null);
  assert.equal(forbiddenResponse.status, 403);
  const afterRead = await Customer.findById(customer._id).lean();
  assert.equal(afterRead.matterSubscriptionId, before.matterSubscriptionId);
  assert.equal(+afterRead.updatedAt, +before.updatedAt, 'Read failure must not relink or mutate source context');
});

run('invalid export dates return an explicit JSON error instead of a complete-looking workbook', async () => {
  const response = await http('/export.xlsx?from=2026-02-30&to=2026-03-01');

  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type') || '', /json/);
  assert.equal((await response.json()).success, false);
});
