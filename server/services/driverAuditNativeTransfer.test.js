import assert from 'node:assert/strict';
import test from 'node:test';
import * as transfer from '../scripts/driverAuditNativeTransfer.js';

test('a migration cannot put archive files into Mongo when external storage is not prepared', async () => {
  let writes = 0;
  const archive = { async putVerifiedObject() { writes++; } };
  const guarded = transfer.createDriverAuditTransferArchive({ archive });
  await assert.rejects(guarded.putVerifiedObject('a'.repeat(64) + '.gz', Buffer.from('original photo')),
    { code: 'AUDIT_EXTERNAL_ARCHIVE_REQUIRED' });
  assert.equal(writes, 0);
});

test('a prepared hybrid transfer keeps the exact archive object and completion receipt', async () => {
  const bytes = Buffer.from('exact original GPS/photo bytes'), key = 'a'.repeat(64) + '.gz';
  const receipt = { key, verified: true, bytes: bytes.length };
  let writes = 0;
  const guarded = transfer.createDriverAuditTransferArchive({ objectStore: { identitySha256: 'b'.repeat(64) },
    archive: { async putVerifiedObject(givenKey, givenBytes) {
      writes++; assert.equal(givenKey, key); assert.strictEqual(givenBytes, bytes); return receipt;
    } } });
  assert.strictEqual(await guarded.putVerifiedObject(key, bytes), receipt);
  assert.equal(writes, 1);
});
