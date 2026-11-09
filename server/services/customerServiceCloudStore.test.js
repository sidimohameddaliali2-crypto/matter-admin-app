import test from 'node:test';import assert from 'node:assert/strict';
import {encodeCloudRecord,decodeCloudRecord,cloudSqlText,cloudKinds} from './customerServiceCloudStore.js';
import mongoose from 'mongoose';
test('cloud archive retains BSON identities, dates and nested review history exactly',()=>{const original={_id:new mongoose.Types.ObjectId(),updatedAt:new Date('2026-11-07T00:00:00Z'),revisions:[{actorId:new mongoose.Types.ObjectId(),at:new Date(),note:"O'Brien"}]};const row=encodeCloudRecord('servicereviews',original);assert.equal(String(row.body._id),String(original._id));assert.deepEqual(decodeCloudRecord(row),original);assert.throws(()=>decodeCloudRecord({...row,payload:row.payload+' '}));});
test('only named customer service collections may enter cloud archive',()=>{assert.ok(cloudKinds.includes('servicemessages'));assert.throws(()=>encodeCloudRecord('drivers',{_id:'x'}));assert.throws(()=>encodeCloudRecord('users',{_id:'x',password:'secret'}));});
test('SQL literals escape quote and backslash delimiters',()=>{assert.equal(cloudSqlText("a'b"),"E'a''b'");assert.throws(()=>cloudSqlText('a\0b'),/NUL/);});
