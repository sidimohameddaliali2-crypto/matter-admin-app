import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDriverAuditMongoArchive } from './driverAuditMongoArchive.js';

const migration = await import('../scripts/driverAuditMongoMigrate.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const contents = new Map(), tables = new Map(), queries = [], originalReads = [];
  const table = name => { if (!tables.has(name)) tables.set(name, []); return tables.get(name); };
  let fullChunkReads = 0;
  const db = { collection(name) { return {
    find(filter, options) {
      queries.push({ name, filter, options });
      const ids = new Set(filter._id.$in), projection = options.projection;
      assert.equal(projection.bytes, undefined, 'Metadata inspection must not request chunk payloads');
      return { toArray: async () => table(name).filter(row => ids.has(row._id)).map(row =>
        Object.fromEntries(Object.keys(projection).filter(key => projection[key] && Object.hasOwn(row, key)).map(key => [key, row[key]]))) };
    },
    async findOne(query) {
      if (name === 'driverAuditNativeChunks') fullChunkReads++;
      return table(name).find(row => row._id === query._id) ?? null;
    },
    async insertOne(row) { table(name).push(row); },
    async updateOne(query, update) {
      const row = table(name).find(value => value._id === query._id);
      if (!row || query.limitBytes !== row.limitBytes || row.usedBytes > query.usedBytes.$lte) return { matchedCount: 0 };
      for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
      return { matchedCount: 1 };
    },
  }; } };
  const capacityBytes = 1024 * 1024;
  table('driverAuditNativeControl').push({ _id: 'capacity', limitBytes: capacityBytes, usedBytes: 0 });
  const client = { startSession() { return { async withTransaction(work) { return work(); }, async endSession() {} }; } };
  const archive = createDriverAuditMongoArchive({ db, client, capacityBytes });
  function original(text, present = true) {
    const bytes = Buffer.from(text), sha256 = hash(bytes), key = sha256 + '.gz'; contents.set(key, bytes);
    if (present) {
      table('driverAuditNativeChunks').push({ _id: sha256, size: bytes.length, bytes: Buffer.from(bytes) });
      table('driverAuditNativeFiles').push({ _id: key, reference: { version: 1, sha256, size: bytes.length,
        chunks: [{ sha256, size: bytes.length }] } });
    }
    return { key, bytes: bytes.length };
  }
  const readOriginal = async row => { originalReads.push(row.key); return contents.get(row.key); };
  return { db, archive, table, contents, queries, originalReads, original, readOriginal, get fullChunkReads() { return fullChunkReads; } };
}

test('stage reuses immutable archive metadata without rereading existing evidence bytes', async () => {
  assert.equal(typeof migration.stageDriverAuditMongoArchiveObjects, 'function', 'Metadata staging is not implemented');
  const f = fixture(), rows = [f.original('fictional photograph'), f.original('fictional GPS original')];
  const result = await migration.stageDriverAuditMongoArchiveObjects({ ...f, objectIndex: rows });
  assert.deepEqual(result, { existingObjects: 2, importedObjects: 0, fullByteVerificationPending: true });
  assert.equal(f.fullChunkReads, 0); assert.deepEqual(f.originalReads, []);
  assert(f.queries.some(query => query.name === 'driverAuditNativeChunks' && query.options.projection.size === 1));
});

test('missing originals still use the real verified native put and immediate readback', async () => {
  const f = fixture(), row = f.original('fictional newly received original', false);
  const result = await migration.stageDriverAuditMongoArchiveObjects({ ...f, objectIndex: [row] });
  assert.equal(result.importedObjects, 1); assert.deepEqual(f.originalReads, [row.key]);
  assert(f.fullChunkReads > 0);
  assert.deepEqual(Buffer.concat(await f.archive.readObject(row.key, { maxBytes: row.bytes })), f.contents.get(row.key));
});

test('stage rejects incomplete or conflicting native metadata without reading or overwriting original bytes', async t => {
  for (const reason of ['version', 'hash', 'size', 'coverage', 'part-hash', 'part-size', 'missing-chunk', 'chunk-size']) await t.test(reason, async () => {
    const f = fixture(), row = f.original('fictional retained original'), file = f.table('driverAuditNativeFiles')[0];
    if (reason === 'version') file.reference.version = 2;
    if (reason === 'hash') file.reference.sha256 = '0'.repeat(64);
    if (reason === 'size') file.reference.size++;
    if (reason === 'coverage') file.reference.chunks = [];
    if (reason === 'part-hash') file.reference.chunks[0].sha256 = 'bad';
    if (reason === 'part-size') file.reference.chunks[0].size++;
    if (reason === 'missing-chunk') f.table('driverAuditNativeChunks').pop();
    if (reason === 'chunk-size') f.table('driverAuditNativeChunks')[0].size++;
    const before = JSON.stringify(f.table('driverAuditNativeFiles'));
    await assert.rejects(migration.stageDriverAuditMongoArchiveObjects({ ...f, objectIndex: [row] }));
    assert.equal(f.fullChunkReads, 0); assert.deepEqual(f.originalReads, []);
    assert.equal(JSON.stringify(f.table('driverAuditNativeFiles')), before);
  });
});

test('metadata staging defers payload corruption to the mandatory full verification pass', async () => {
  const f = fixture(), row = f.original('fictional original whose stored payload is corrupted');
  f.table('driverAuditNativeChunks')[0].bytes[0] ^= 1;
  const staged = await migration.stageDriverAuditMongoArchiveObjects({ ...f, objectIndex: [row] });
  assert.equal(staged.fullByteVerificationPending, true); assert.equal(f.fullChunkReads, 0);
  await assert.rejects(migration.verifyDriverAuditMongoArchiveObjects({ archive: f.archive, objectIndex: [row] }), /integrity/);
  assert.equal(f.table('driverAuditNativeFiles').length, 1);
});

test('full verification reads every declared original and rejects a wrong missing-source binding', async () => {
  const f = fixture(), rows = [f.original('first original'), f.original('second original')];
  const result = await migration.verifyDriverAuditMongoArchiveObjects({ archive: f.archive, objectIndex: rows });
  assert.equal(result.objects, 2); assert.equal(result.bytesRead, rows[0].bytes + rows[1].bytes);
  const missing = f.original('missing original', false);
  await assert.rejects(migration.stageDriverAuditMongoArchiveObjects({ ...f, objectIndex: [missing],
    readOriginal: async () => Buffer.alloc(missing.bytes, 'x') }), /binding|integrity/);
  assert.equal(f.table('driverAuditNativeFiles').length, 2);
});

test('metadata checks stay batched beyond one page and reuse the planner index without fetching payloads', async () => {
  const f = fixture(), rows = Array.from({ length: 501 }, (_, index) => f.original('fictional immutable original ' + index));
  const fileIndex = new Map(f.table('driverAuditNativeFiles').map(row => [row._id, row]));
  const result = await migration.stageDriverAuditMongoArchiveObjects({ ...f, objectIndex: rows, fileIndex });
  assert.equal(result.existingObjects, 501); assert.equal(f.fullChunkReads, 0);
  assert.equal(f.queries.filter(query => query.name === 'driverAuditNativeFiles').length, 0);
  assert.equal(f.queries.filter(query => query.name === 'driverAuditNativeChunks').length, 2);
});

test('the guarded module still executes the real CLI and redacts invalid command failures', async () => {
  const file = fileURLToPath(new URL('../scripts/driverAuditMongoMigrate.js', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [file, 'stage', 'not-an-absolute-profile', 'a'.repeat(64)],
    { timeout: 5000, maxBuffer: 4096 }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Native Driver Reports migration stopped/);
    assert(!error.stderr.includes('not-an-absolute-profile'));
    return true;
  });
});
