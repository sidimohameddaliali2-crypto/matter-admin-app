import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from 'node:zlib';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const maximumTextBytes = 32 * 1024 * 1024;
const maximumPackBytes = 64 * 1024 * 1024;
const minimumPieceBytes = 16 * 1024;
const maximumPieceBytes = 64 * 1024;
const gear = Uint32Array.from({ length: 256 }, (_, index) =>
  createHash('sha256').update(Buffer.from([index])).digest().readUInt32LE(0));

// Keep publication revisions addressable, but share unchanged byte ranges even
// when a small insertion moves their positions. No JSON reserialization occurs.
export async function storeDriverAuditMongoText({ objects, text, session }) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximumTextBytes) throw Error('Invalid native reporting text');
  const bytes = Buffer.from(text);
  if (bytes.length < 128 * 1024) return objects.putBytes(gzipSync(bytes), { session });
  const chunks = [], saved = new Map();
  let start = 0, fingerprint = 0;
  async function add(end) {
    const plain = bytes.subarray(start, end), sha256 = hash(plain);
    let packed = saved.get(sha256);
    if (!packed) {
      packed = await objects.putBytes(gzipSync(plain), { session });
      saved.set(sha256, packed);
    }
    chunks.push({ size: plain.length, sha256, packed });
    start = end;
    fingerprint = 0;
  }
  for (let index = 0; index < bytes.length; index++) {
    fingerprint = ((fingerprint << 1) + gear[bytes[index]]) >>> 0;
    const size = index + 1 - start;
    if (size >= minimumPieceBytes && ((fingerprint & 0x7fff) === 0 || size >= maximumPieceBytes)) await add(index + 1);
  }
  if (start < bytes.length) await add(bytes.length);
  return { version: 3, encoding: 'chunked-gzip-text-v1', plainBytes: bytes.length,
    size: chunks.reduce((sum, part) => sum + part.packed.size, 0), sha256: hash(bytes), chunks };
}

// Historical receipts often repeat a large checkpoint. Compress a bounded
// group together so the original text stays recoverable without another full
// compressed copy per update. Offsets name original UTF-8 bytes, not characters.
export async function packDriverAuditMongoTexts({ objects, texts, session }) {
  const values = texts.map(text => {
    if (typeof text !== 'string' || Buffer.byteLength(text) > maximumTextBytes) {
      throw Error('Invalid native reporting text pack');
    }
    return Buffer.from(text);
  });
  const size = values.reduce((total, bytes) => total + bytes.length, 0);
  if (!values.length || size > maximumPackBytes) throw Error('Native reporting text pack exceeds its bound');
  const bytes = Buffer.concat(values, size);
  const compressed = brotliCompressSync(bytes, { params: {
    [constants.BROTLI_PARAM_QUALITY]: 4,
    [constants.BROTLI_PARAM_LGWIN]: 22,
  } });
  const pack = await objects.putBytes(compressed, { session });
  const saved = await objects.readBytes(pack, { maxBytes: maximumPackBytes, session });
  if (!saved.equals(compressed)) throw Error('Native reporting text pack readback differs');
  let offset = 0;
  return values.map(value => {
    const reference = { version: 2, encoding: 'br-text-pack-v1', pack,
      plainBytes: size, offset, size: value.length, sha256: hash(value) };
    offset += value.length;
    return reference;
  });
}

export function createDriverAuditMongoTextReader(objects) {
  // One most-recent pack is enough for sequential receipt history reads. Keep
  // transactional reads fresh and bound retained decoded memory to 8 MiB.
  let cached;
  return async function read(reference, { session } = {}) {
    if (reference?.version === 3) {
      if (reference.encoding !== 'chunked-gzip-text-v1' || !Number.isSafeInteger(reference.plainBytes)
          || reference.plainBytes < 1 || reference.plainBytes > maximumTextBytes
          || !Number.isSafeInteger(reference.size) || reference.size < 1
          || reference.size > maximumTextBytes + 128 * (maximumTextBytes / minimumPieceBytes + 1)
          || !/^[a-f0-9]{64}$/.test(reference.sha256 || '') || !Array.isArray(reference.chunks)
          || !reference.chunks.length || reference.chunks.length > maximumTextBytes / minimumPieceBytes + 1) {
        throw Error('Invalid native text chunk reference');
      }
      const parts = [], local = new Map();
      let size = 0, packedSize = 0;
      for (const [index, part] of reference.chunks.entries()) {
        if (!Number.isSafeInteger(part?.size) || part.size < 1 || part.size > maximumPieceBytes
            || index < reference.chunks.length - 1 && part.size < minimumPieceBytes
            || !/^[a-f0-9]{64}$/.test(part.sha256 || '')) throw Error('Invalid native text piece');
        const identity = JSON.stringify(part.packed);
        let plain = local.get(identity);
        if (!plain) {
          plain = gunzipSync(await objects.readBytes(part.packed, { maxBytes: 128 * 1024, session }),
            { maxOutputLength: maximumPieceBytes });
          local.set(identity, plain);
        }
        if (plain.length !== part.size || hash(plain) !== part.sha256) throw Error('Native text piece integrity failure');
        size += plain.length;
        packedSize += part.packed.size;
        if (size > reference.plainBytes) throw Error('Native text chunk size differs');
        parts.push(plain);
      }
      const text = Buffer.concat(parts, size);
      if (size !== reference.plainBytes || packedSize !== reference.size || hash(text) !== reference.sha256) throw Error('Native text integrity failure');
      return text.toString('utf8');
    }
    if (reference?.version !== 2) {
      return gunzipSync(await objects.readBytes(reference,
        { maxBytes: maximumTextBytes + 1024 * 1024, session }),
      { maxOutputLength: maximumTextBytes }).toString('utf8');
    }
    if (reference.encoding !== 'br-text-pack-v1'
        || !Number.isSafeInteger(reference.plainBytes) || reference.plainBytes < 0
        || reference.plainBytes > maximumPackBytes
        || !Number.isSafeInteger(reference.offset) || reference.offset < 0
        || !Number.isSafeInteger(reference.size) || reference.size < 0 || reference.size > maximumTextBytes
        || reference.offset + reference.size > reference.plainBytes
        || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')) {
      throw Error('Invalid native reporting text reference');
    }
    const identity = JSON.stringify(reference.pack);
    let bytes;
    if (!session && cached?.identity === identity) bytes = cached.bytes;
    else {
      bytes = brotliDecompressSync(await objects.readBytes(reference.pack,
        { maxBytes: maximumPackBytes, session }), { maxOutputLength: reference.plainBytes });
      if (!session) cached = bytes.length <= 8 * 1024 * 1024 ? { identity, bytes } : undefined;
    }
    if (bytes.length !== reference.plainBytes) throw Error('Native reporting text pack size differs');
    const text = bytes.subarray(reference.offset, reference.offset + reference.size);
    if (hash(text) !== reference.sha256) throw Error('Native reporting text integrity failure');
    return text.toString('utf8');
  };
}
