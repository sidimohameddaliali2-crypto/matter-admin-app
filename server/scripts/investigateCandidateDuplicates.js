// Read-only: for each of the 13 "candidate" customers that turned out to
// already be linked to a DIFFERENT internal Customer record (found while
// trying to link linkage-missing-both-with-candidate.csv), compares both
// sides — deliveries, selections, other references — same diligence as the
// Kelly/Charles merges, so a human can decide which side to keep before
// anything is merged.
//
// Makes NO changes.
//
// Usage: node scripts/investigateCandidateDuplicates.js

import '../loadEnv.js';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Customer from '../models/Customer.js';
import MenuSelectionRecord from '../models/MenuSelectionRecord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PAIRS = [
  ['CUST-000119751', 'alex.yacoub'],
  ['CUST-000122880', 'ttvc94d542'],
  ['CUST-000123211', 'CUST-000124076'],
  ['CUST-000123060', 'jameshovey.contact'],
  ['CUST-000118264', 'CUST-000123599'],
  ['CUST-000121227', 'CUST-000124147'],
  ['CUST-000123213', 'CUST-000124143'],
  ['CUST-000122895', 'CUST-000124037'],
  ['CUST-000122234', 'umar.farooque'],
  ['zutten2233', 'CUST-000118620'],
  ['radhika.shanker.marketing', 'CUST-000120686'],
  ['sarax98', 'CUST-000123490'],
  ['xvw8y2ygh5', 'CUST-000123509']
];

const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const describe = async (customerId) => {
  const c = await Customer.findOne({ customerId });
  if (!c) return null;
  const selections = await MenuSelectionRecord.countDocuments({ customer: c._id });
  const db = mongoose.connection.db;
  const deliveries = await db.collection('deliveries').countDocuments({ customerId });
  const deliveryChanges = await db.collection('deliverychanges').countDocuments({ customerId });
  const bagNotes = await db.collection('bagnotes').countDocuments({ customerId });
  return {
    customerId: c.customerId, mongoId: String(c._id), email: c.email || '', phone: c.phone || '',
    name: `${c.firstName || ''} ${c.lastName || ''}`.trim(), dataSource: c.dataSource || '',
    matterSubscriptionId: c.matterSubscriptionId || '', matterCustomerId: c.matterCustomerId || '',
    deliveries, selections, deliveryChanges, bagNotes,
    totalSignal: deliveries + selections + deliveryChanges + bagNotes
  };
};

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected (read-only).\n');

  const rows = [];
  for (const [a, b] of PAIRS) {
    const da = await describe(a);
    const db_ = await describe(b);
    if (!da || !db_) {
      console.log(`SKIP pair (${a}, ${b}): one side not found (already resolved?)`);
      continue;
    }
    const recommendKeep = da.totalSignal === db_.totalSignal
      ? 'TIE — review manually'
      : (da.totalSignal > db_.totalSignal ? da.customerId : db_.customerId);

    console.log(`--- ${a}  vs  ${b} ---`);
    console.log(`  ${da.customerId}: ${da.name || '(no name)'} | ${da.email || '(no email)'} | ${da.phone || '(no phone)'} | deliveries=${da.deliveries} selections=${da.selections} changes=${da.deliveryChanges} | source=${da.dataSource}`);
    console.log(`  ${db_.customerId}: ${db_.name || '(no name)'} | ${db_.email || '(no email)'} | ${db_.phone || '(no phone)'} | deliveries=${db_.deliveries} selections=${db_.selections} changes=${db_.deliveryChanges} | source=${db_.dataSource}`);
    console.log(`  Recommend keeping: ${recommendKeep}\n`);

    rows.push({
      sideA_customerId: da.customerId, sideA_name: da.name, sideA_email: da.email, sideA_phone: da.phone,
      sideA_deliveries: da.deliveries, sideA_selections: da.selections, sideA_source: da.dataSource,
      sideB_customerId: db_.customerId, sideB_name: db_.name, sideB_email: db_.email, sideB_phone: db_.phone,
      sideB_deliveries: db_.deliveries, sideB_selections: db_.selections, sideB_source: db_.dataSource,
      namesMatch: da.name.toLowerCase() === db_.name.toLowerCase(),
      recommendKeep
    });
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'candidate-duplicate-investigation.csv');
  const headers = Object.keys(rows[0]);
  fs.writeFileSync(outFile, [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n'));
  console.log(`Full report: ${outFile}`);

  await mongoose.disconnect();
};

run().catch((err) => { console.error('Investigation failed:', err); process.exitCode = 1; mongoose.disconnect(); });
