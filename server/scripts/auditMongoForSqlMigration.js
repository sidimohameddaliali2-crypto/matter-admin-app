// Read-only pre-migration audit: finds data that a SQL schema (foreign keys,
// unique constraints, enums/CHECKs, NOT NULLs, numeric columns) would reject
// but MongoDB tolerated. Uses only find/aggregate/distinct/count — makes NO
// changes.
//
// Severity:
//   BLOCKER  a constraint we plan to add would fail on this data as-is
//   WARN     loads fine but is almost certainly a data bug / needs a decision
//   INFO     sizing or context for the migration
//
// Usage: node scripts/auditMongoForSqlMigration.js
// Output: console summary + scripts/output/mongo-sql-audit.json
// That directory is gitignored. Do not commit the JSON or the CSV exports.

import '../loadEnv.js';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const findings = [];
let passed = 0;
const missingCollections = new Set();

const add = (severity, check, collection, detail, count, samples = []) => {
  if (!count) { passed += 1; return; }
  findings.push({ severity, check, collection, detail, count, samples: samples.slice(0, 10).map(String) });
};

const isObjectId = (v) => v instanceof mongoose.Types.ObjectId;

let db;
let existing;
const has = (coll) => {
  if (existing.has(coll)) return true;
  missingCollections.add(coll);
  return false;
};

const valuesOf = async (coll, field) =>
  (await db.collection(coll).distinct(field)).filter((v) => v !== null && v !== undefined && v !== '');

const targetSetCache = new Map();
const targetSet = async (coll, field) => {
  const key = `${coll}.${field}`;
  if (!targetSetCache.has(key)) {
    const vals = field === '_id'
      ? (await db.collection(coll).find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id)
      : await valuesOf(coll, field);
    targetSetCache.set(key, new Set(vals.map(String)));
  }
  return targetSetCache.get(key);
};

const countIn = async (coll, field, values) => {
  let total = 0;
  for (let i = 0; i < values.length; i += 2000) {
    total += await db.collection(coll).countDocuments({ [field]: { $in: values.slice(i, i + 2000) } });
  }
  return total;
};

// Every value in coll.field must exist as target.targetField.
const refCheck = async ({ coll, field, target, targetField = '_id', severity = 'BLOCKER', note = '', breakdownBy }) => {
  if (!has(coll) || !has(target)) return;
  const values = await valuesOf(coll, field);
  const set = await targetSet(target, targetField);
  const orphans = values.filter((v) => !set.has(String(v)));
  const label = `${coll}.${field} -> ${target}.${targetField}`;
  if (targetField === '_id') {
    const wrongType = values.filter((v) => !isObjectId(v));
    add('BLOCKER', 'ref stored with wrong type (not ObjectId)', coll, label, wrongType.length, wrongType);
  }
  if (orphans.length === 0) { passed += 1; return; }
  const docs = await countIn(coll, field, orphans);
  let detail = `${label}: ${orphans.length} distinct dangling value(s) across ${docs} document(s)${note ? ` — ${note}` : ''}`;
  if (breakdownBy) {
    const rows = await db.collection(coll).aggregate([
      { $match: { [field]: { $in: orphans.slice(0, 5000) } } },
      { $group: { _id: `$${breakdownBy}`, n: { $sum: 1 } } }
    ]).toArray();
    detail += ` | by ${breakdownBy}: ${rows.map((r) => `${r._id ?? 'null'}=${r.n}`).join(', ')}`;
  }
  add(severity, 'dangling reference', coll, detail, docs, orphans);
};

// Values that must be unique once the constraint exists (case-insensitive when `ci`).
const dupCheck = async ({ coll, label, key, match, severity = 'BLOCKER' }) => {
  if (!has(coll)) return;
  const [res] = await db.collection(coll).aggregate([
    { $match: match },
    { $group: { _id: key, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $facet: {
      groups: [{ $count: 'c' }],
      extra: [{ $group: { _id: null, e: { $sum: { $subtract: ['$n', 1] } } } }],
      sample: [{ $limit: 10 }]
    } }
  ], { allowDiskUse: true }).toArray();
  const groups = res.groups[0]?.c || 0;
  const extra = res.extra[0]?.e || 0;
  add(severity, 'duplicate values (unique constraint would fail)', coll,
    `${label}: ${groups} duplicated key(s), ${extra} surplus document(s)`,
    groups, res.sample.map((s) => `${JSON.stringify(s._id)} x${s.n}`));
};

const lowerTrim = (f) => ({ $toLower: { $trim: { input: { $toString: `$${f}` } } } });
const nonEmpty = (f) => ({ [f]: { $nin: [null, ''] } });

const enumCheck = async (coll, field, allowed, { unwind, severity = 'BLOCKER' } = {}) => {
  if (!has(coll)) return;
  const pipeline = [];
  if (unwind) pipeline.push({ $unwind: `$${unwind}` });
  pipeline.push({ $group: { _id: `$${field}`, n: { $sum: 1 } } });
  const rows = await db.collection(coll).aggregate(pipeline, { allowDiskUse: true }).toArray();
  const bad = rows.filter((r) => r._id !== null && r._id !== undefined && !allowed.includes(r._id));
  add(severity, 'value outside enum/CHECK list', coll,
    `${field}: ${bad.map((b) => `${JSON.stringify(b._id)}(${b.n})`).join(', ')}`,
    bad.reduce((s, b) => s + b.n, 0), bad.map((b) => b._id));
};

const requiredCheck = async (coll, fields, severity = 'BLOCKER') => {
  if (!has(coll)) return;
  for (const f of fields) {
    const n = await db.collection(coll).countDocuments({ $or: [{ [f]: { $exists: false } }, { [f]: null }, { [f]: '' }] });
    add(severity, 'missing value for planned NOT NULL column', coll, f, n);
  }
};

const numericStringCheck = async (coll, fields) => {
  if (!has(coll)) return;
  for (const f of fields) {
    const bad = await db.collection(coll).find(
      { [f]: { $type: 'string', $ne: '', $not: /^\s*-?\d+(\.\d+)?\s*$/ } },
      { projection: { [f]: 1 } }
    ).limit(10).toArray();
    const n = await db.collection(coll).countDocuments({ [f]: { $type: 'string', $ne: '', $not: /^\s*-?\d+(\.\d+)?\s*$/ } });
    add('WARN', 'string that will not parse as a number (planned numeric column)', coll, f, n, bad.map((b) => b[f]));
  }
};

const arraySizes = async (coll, field) => {
  if (!has(coll)) return;
  const [r] = await db.collection(coll).aggregate([
    { $group: { _id: null, docs: { $sum: 1 }, total: { $sum: { $size: { $ifNull: [`$${field}`, []] } } }, max: { $max: { $size: { $ifNull: [`$${field}`, []] } } } } }
  ], { allowDiskUse: true }).toArray();
  if (r) findings.push({ severity: 'INFO', check: 'child-table sizing', collection: coll, detail: `${field}: ${r.total} rows total across ${r.docs} docs (max ${r.max} in one doc)`, count: r.total, samples: [] });
};

const MEAL_PLANS = ['Standard', 'Customized', 'Premium', 'Vegan', 'Keto', 'Paleo', 'Bodybuilder', 'Lean 2 Meal', 'Lean 3 Meal', 'Thrive 2 Meal', 'Thrive 3 Meal', 'Perform 2 Meal', 'Perform 3 Meal'];
const MEAL_TYPES = ['breakfast', 'main', 'snack'];

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);
  db = mongoose.connection.db;
  existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

  console.log('Connected (read-only audit). Running checks...\n');

  // ---- Sizing ---------------------------------------------------------
  const sizes = [];
  for (const name of [...existing].sort()) sizes.push([name, await db.collection(name).estimatedDocumentCount()]);
  findings.push({ severity: 'INFO', check: 'collection sizes', collection: '*', detail: sizes.map(([n, c]) => `${n}=${c}`).join(', '), count: sizes.length, samples: [] });
  await arraySizes('deliveries', 'timeline');
  await arraySizes('bags', 'history');
  await arraySizes('bags', 'quantityHistory');
  await arraySizes('menuselectionrecords', 'selectedMeals');
  await arraySizes('menuselectionrecords', 'dayNotes');
  await arraySizes('customers', 'selectedMeals');
  await arraySizes('weeklymenus', 'meals');
  await arraySizes('users', 'pushTokens');
  await arraySizes('events', 'logistics.assetsUsed');

  // ---- Business-key duplicates (unique constraints) ---------------------
  await dupCheck({ coll: 'customers', label: 'customerId', key: '$customerId', match: nonEmpty('customerId') });
  await dupCheck({ coll: 'customers', label: 'lower(email)', key: lowerTrim('email'), match: { email: { $type: 'string', $ne: '' } } });
  await dupCheck({ coll: 'customers', label: 'matterSubscriptionId', key: '$matterSubscriptionId', match: nonEmpty('matterSubscriptionId') });
  await dupCheck({ coll: 'customers', label: 'cpf (planned non-unique index; informational)', key: '$cpf', match: nonEmpty('cpf'), severity: 'INFO' });
  await dupCheck({ coll: 'users', label: 'lower(email)', key: lowerTrim('email'), match: { email: { $type: 'string', $ne: '' } } });
  await dupCheck({ coll: 'partners', label: 'lower(email)', key: lowerTrim('email'), match: { email: { $type: 'string', $ne: '' } } });
  await dupCheck({ coll: 'partners', label: 'memberInviteToken', key: '$memberInviteToken', match: nonEmpty('memberInviteToken') });
  await dupCheck({ coll: 'members', label: '(partner, lower(email))', key: { p: '$partner', e: lowerTrim('email') }, match: { email: { $type: 'string', $ne: '' } } });
  await dupCheck({ coll: 'bags', label: 'upper(trim(bagId))', key: { $toUpper: { $trim: { input: { $toString: '$bagId' } } } }, match: nonEmpty('bagId') });
  await dupCheck({ coll: 'weeklymenus', label: 'shareLink.token', key: '$shareLink.token', match: nonEmpty('shareLink.token') });
  await dupCheck({ coll: 'menuselectionrecords', label: '(weeklyMenuId, customer)', key: { w: '$weeklyMenuId', c: '$customer' }, match: { customer: { $type: 'objectId' } } });
  await dupCheck({ coll: 'menuselectionrecords', label: '(weeklyMenuId, lower(email)) — legacy uniqueness', key: { w: '$weeklyMenuId', e: lowerTrim('email') }, match: { email: { $type: 'string', $ne: '' } }, severity: 'WARN' });
  await dupCheck({ coll: 'invoices', label: 'invoiceNumber', key: '$invoiceNumber', match: nonEmpty('invoiceNumber') });
  await dupCheck({ coll: 'partnerorders', label: 'invoiceNumber', key: '$invoiceNumber', match: nonEmpty('invoiceNumber') });
  await dupCheck({ coll: 'thirdpartydeliveryassignments', label: 'shopifyOrderId', key: '$shopifyOrderId', match: nonEmpty('shopifyOrderId') });
  await dupCheck({ coll: 'employees', label: 'userId', key: '$userId', match: { userId: { $type: 'objectId' } } });
  await dupCheck({ coll: 'vehicles', label: 'vehicleId', key: '$vehicleId', match: nonEmpty('vehicleId') });
  await dupCheck({ coll: 'orderlines', label: '(order, menuItem)', key: { o: '$order', m: '$menuItem' }, match: { order: { $type: 'objectId' } } });
  await dupCheck({ coll: 'memberorderlines', label: '(order, menuItem)', key: { o: '$order', m: '$menuItem' }, match: { order: { $type: 'objectId' } } });
  await dupCheck({ coll: 'spacemenus', label: '(space, menuItem)', key: { s: '$space', m: '$menuItem' }, match: { space: { $type: 'objectId' } } });

  // ---- Customer linkage (customers.customer_id NOT NULL on selections) ----
  if (has('menuselectionrecords')) {
    const noCustomer = await db.collection('menuselectionrecords').countDocuments({ $or: [{ customer: { $exists: false } }, { customer: null }] });
    add('BLOCKER', 'selection has no customer link (planned NOT NULL FK)', 'menuselectionrecords', 'customer', noCustomer);
  }
  if (has('customers')) {
    const noEmailNoSub = await db.collection('customers').countDocuments({
      $and: [{ $or: [{ email: null }, { email: '' }, { email: { $exists: false } }] }, { $or: [{ matterSubscriptionId: null }, { matterSubscriptionId: '' }, { matterSubscriptionId: { $exists: false } }] }]
    });
    add('WARN', 'customer has neither email nor Matter subscription id (hard to ever match)', 'customers', 'email + matterSubscriptionId', noEmailNoSub);
  }

  // ---- String business-key joins -> customers.customerId ---------------
  await refCheck({ coll: 'deliveries', field: 'customerId', target: 'customers', targetField: 'customerId', breakdownBy: 'type', note: 'decide: nullable FK + snapshot columns, or backfill missing customers' });
  await refCheck({ coll: 'deliveryissues', field: 'customerId', target: 'customers', targetField: 'customerId' });
  await refCheck({ coll: 'bagnotes', field: 'customerId', target: 'customers', targetField: 'customerId' });
  await refCheck({ coll: 'deliverychanges', field: 'customerId', target: 'customers', targetField: 'customerId' });
  await refCheck({ coll: 'menuselectionrecords', field: 'customerId', target: 'customers', targetField: 'customerId', severity: 'WARN' });
  await refCheck({ coll: 'bags', field: 'assignedTo.customer.customerId', target: 'customers', targetField: 'customerId', severity: 'WARN' });
  await refCheck({ coll: 'storekeeperscans', field: 'bagId', target: 'bags', targetField: 'bagId', severity: 'INFO', note: 'scans of unknown bags are expected; keep bag_code as text' });

  // ---- ObjectId references (foreign keys) --------------------------------
  const refs = [
    ['deliveries', 'driver', 'users'], ['deliveries', 'handoff', 'handoffs'], ['deliveries', 'bagAssignment.assignedBy', 'users'],
    ['deliveries', 'changeFlag.acknowledgedBy', 'users'],
    ['handoffs', 'van', 'users'], ['handoffs', 'bike', 'users'], ['handoffs', 'deliveryIds', 'deliveries'],
    ['deliverychanges', 'appliedToDelivery', 'deliveries'], ['deliverychanges', 'uploadedBy', 'users'],
    ['deliveryissues', 'resolvedBy', 'users'], ['deliveryissues', 'reportedBy', 'users'],
    ['menuselectionrecords', 'weeklyMenuId', 'weeklymenus'], ['menuselectionrecords', 'customer', 'customers'],
    ['menuselectionrecords', 'selectedMeals.menuItemId', 'menuitems'],
    ['customers', 'partner', 'partners'], ['customers', 'currentWeekMenu', 'weeklymenus'], ['customers', 'selectedMeals.menuItemId', 'menuitems'],
    ['weeklymenus', 'meals.items', 'menuitems'], ['weeklymenus', 'createdBy', 'users'],
    ['members', 'partner', 'partners'], ['memberorders', 'member', 'members'], ['memberorders', 'partner', 'partners'],
    ['memberorderlines', 'order', 'memberorders'], ['memberorderlines', 'menuItem', 'partnermenuitems'],
    ['spaceorders', 'space', 'partners'], ['orderlines', 'order', 'spaceorders'], ['orderlines', 'menuItem', 'partnermenuitems'],
    ['spacemenus', 'space', 'partners'], ['spacemenus', 'menuItem', 'partnermenuitems'],
    ['spaceprices', 'space', 'partners'], ['spaceprices', 'menuItem', 'partnermenuitems'], ['itemcosts', 'menuItem', 'partnermenuitems'],
    ['partnerorders', 'partner', 'partners'], ['partnerorders', 'weeklyMenu', 'weeklymenus'], ['partnerorders', 'items.partnerMenuItem', 'partnermenuitems'],
    ['invoices', 'order', 'spaceorders'], ['invoices', 'space', 'partners'], ['invoicelines', 'invoice', 'invoices'], ['invoicelines', 'menuItem', 'partnermenuitems'],
    ['wastelogs', 'space', 'partners'], ['wastelogs', 'menuItem', 'partnermenuitems'],
    ['fuellogs', 'vehicle', 'vehicles'], ['vehicles', 'assignedDriver', 'users'],
    ['employees', 'userId', 'users'], ['leaverequests', 'employee', 'employees'],
    ['bags', 'currentDelivery', 'deliveries'], ['bags', 'assignedTo.driver', 'users'], ['bags', 'returnedBy', 'users'],
    ['thirdpartydeliveryassignments', 'company', 'thirdpartydeliverycompanies'], ['thirdpartydeliveryassignments', 'assignedBy', 'users'],
    ['events', 'company', 'users'], ['events', 'assignedDriver', 'users'], ['events', 'logistics.assetsUsed.assetId', 'yellowblockassets'],
    ['yellowblockassetusages', 'assetId', 'yellowblockassets'], ['yellowblockassetusages', 'eventId', 'events'], ['yellowblockassetusages', 'usedBy', 'users'],
    ['slacklogs', 'deliveryId', 'deliveries'], ['slacklogs', 'communicationId', 'communications'],
    ['mattercorepdfs', 'uploadedBy', 'users']
  ];
  for (const [coll, field, target] of refs) {
    console.log(`  ref ${coll}.${field}`);
    await refCheck({ coll, field, target });
  }

  // ---- Enum / CHECK values -----------------------------------------------
  await enumCheck('deliveries', 'status', ['pending', 'assigned', 'on_route', 'picked_up', 'delivered', 'failed', 'completed', 'collected']);
  await enumCheck('deliveries', 'type', ['Delivery', 'Task', 'Collection']);
  await enumCheck('deliveries', 'taskType', ['Bag Collection', 'Purchase', 'Inspection']);
  await enumCheck('deliveries', 'deliveryType', ['early', 'on-time', 'late']);
  await enumCheck('deliveries', 'addressDetails.locationType', ['Villa', 'Apartment']);
  await enumCheck('deliveries', 'bagAssignment.status', ['assigned', 'delivered', 'returned']);
  await enumCheck('customers', 'mealPlan', MEAL_PLANS);
  await enumCheck('menuitems', 'mealPlan', MEAL_PLANS);
  await enumCheck('menuitems', 'mealType', MEAL_TYPES);
  await enumCheck('menuitems', 'category', ['WARM', 'COLD', '']);
  await enumCheck('menuitems', 'portionType', ['chicken', 'beef', 'fish', '']);
  await enumCheck('menuitems', 'rotationCategory', ['main', 'sub', '']);
  await enumCheck('weeklymenus', 'mealPlans', MEAL_PLANS, { unwind: 'mealPlans' });
  await enumCheck('weeklymenus', 'meals.mealType', MEAL_TYPES, { unwind: 'meals' });
  await enumCheck('menuselectionrecords', 'selectedMeals.mealType', MEAL_TYPES, { unwind: 'selectedMeals' });
  await enumCheck('menuselectionrecords', 'selectedMeals.manualProteinType', ['', 'chicken', 'beef', 'fish'], { unwind: 'selectedMeals' });
  await enumCheck('menuselectionrecords', 'selectedMeals.carbVegAction', ['kept', 'replace'], { unwind: 'selectedMeals' });
  await enumCheck('menuselectionrecords', 'skippedDays.pauseStatus', ['pending', 'success', 'already_paused', 'failed'], { unwind: 'skippedDays' });
  await enumCheck('users', 'role', ['super_admin', 'admin', 'manager', 'dispatcher', 'driver', 'store_keeper', 'viewer', 'yellowblock_user', 'kitchen']);
  await enumCheck('users', 'profile.vehicleType', ['bike', 'van', 'car']);
  await enumCheck('users', 'profile.contractType', ['full_time', 'part_time', 'contract', 'temporary']);
  await enumCheck('bags', 'status', ['available', 'assigned', 'in_use', 'maintenance', 'retired']);
  await enumCheck('bags', 'bagType', ['standard', 'on_time_use']);
  await enumCheck('bags', 'condition', ['excellent', 'good', 'fair', 'poor']);
  await enumCheck('bags', 'location', ['warehouse', 'driver', 'customer']);
  await enumCheck('partners', 'businessType', ['cafe', 'gym', 'restaurant', 'other']);
  await enumCheck('memberorders', 'status', ['draft', 'submitted', 'locked', 'cancelled']);
  await enumCheck('spaceorders', 'status', ['draft', 'submitted', 'locked', 'cancelled']);
  await enumCheck('partnerorders', 'status', ['pending', 'confirmed', 'delivered', 'cancelled']);
  await enumCheck('invoices', 'type', ['partner', 'matter']);
  await enumCheck('invoices', 'status', ['draft', 'locked']);
  await enumCheck('handoffs', 'status', ['planned', 'van_arrived', 'bike_arrived', 'completed', 'cancelled']);
  await enumCheck('handoffs', 'type', ['van_handoff', 'kitchen_return']);
  await enumCheck('vehicles', 'status', ['active', 'maintenance', 'idle', 'inactive']);
  await enumCheck('vehicles', 'type', ['truck', 'van', 'car', 'bike']);
  await enumCheck('deliveryissues', 'status', ['open', 'resolved']);
  await enumCheck('deliveryissues', 'issueType', ['wrong_item', 'missing_item', 'late_delivery', 'damaged', 'not_delivered', 'other']);
  await enumCheck('leaverequests', 'status', ['pending', 'approved', 'rejected']);
  await enumCheck('leaverequests', 'type', ['vacation', 'publicHoliday', 'sick']);
  await enumCheck('wastelogs', 'reason', ['over-order', 'spoilage', 'returns', 'prep-error']);
  await enumCheck('wastelogs', 'party', ['partner', 'matter']);
  await enumCheck('events', 'emirate', ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah']);

  // ---- NOT NULL candidates ------------------------------------------------
  await requiredCheck('deliveries', ['customerId', 'customerName', 'scheduledTime', 'company']);
  await requiredCheck('customers', ['customerId']);
  await requiredCheck('menuselectionrecords', ['email', 'weeklyMenuId']);
  await requiredCheck('weeklymenus', ['title', 'startDate', 'endDate']);
  await requiredCheck('menuitems', ['mealType', 'mealName']);
  await requiredCheck('users', ['email', 'password', 'role']);
  await requiredCheck('bags', ['bagId']);
  await requiredCheck('partners', ['businessName', 'email', 'password']);
  await requiredCheck('members', ['partner', 'name', 'email']);
  await requiredCheck('partnermenuitems', ['name', 'mealType', 'price']);
  await requiredCheck('invoices', ['order', 'space', 'type']);

  // ---- Type drift / numeric strings ----------------------------------------
  await numericStringCheck('customers', ['amountPaid', 'discount']);
  await numericStringCheck('menuitems', ['carbs']);
  await numericStringCheck('communications', ['price', 'deliveryFee', 'bagDeposit', 'discountRate']);

  if (has('deliveries')) {
    const badTime = await db.collection('deliveries').countDocuments({ scheduledTime: { $exists: true, $not: { $type: 'date' } } });
    add('BLOCKER', 'scheduledTime is not a Date', 'deliveries', 'scheduledTime', badTime);
    const noGps = await db.collection('deliveries').countDocuments({ $or: [{ 'gpsLocation.lat': null }, { 'gpsLocation.lat': { $exists: false } }] });
    findings.push({ severity: 'INFO', check: 'context', collection: 'deliveries', detail: 'deliveries with no gpsLocation.lat (lat/lng columns will be nullable)', count: noGps, samples: [] });
  }
  if (has('customers')) {
    const upperEmail = await db.collection('customers').countDocuments({ email: { $type: 'string', $regex: /[A-Z\s]/ } });
    add('WARN', 'email has uppercase/whitespace (will be normalised for citext)', 'customers', 'email', upperEmail);
  }

  // ---- Report -----------------------------------------------------------------
  const order = { BLOCKER: 0, WARN: 1, INFO: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'mongo-sql-audit.json');
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), passedChecks: passed, missingCollections: [...missingCollections], findings }, null, 2));

  console.log('\n================ AUDIT RESULT ================');
  for (const sev of ['BLOCKER', 'WARN', 'INFO']) {
    const group = findings.filter((f) => f.severity === sev);
    console.log(`\n--- ${sev} (${group.length}) ---`);
    group.forEach((f) => {
      console.log(`[${f.collection}] ${f.check}: ${f.detail}`);
      if (sev !== 'INFO' && f.samples.length) console.log(`    e.g. ${f.samples.slice(0, 5).join(' | ')}`);
    });
  }
  console.log(`\nChecks passed clean: ${passed}`);
  if (missingCollections.size) console.log(`Collections not present (skipped): ${[...missingCollections].join(', ')}`);
  console.log(`Full report: ${outFile}`);
};

run()
  .catch((err) => { console.error('Audit failed:', err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
