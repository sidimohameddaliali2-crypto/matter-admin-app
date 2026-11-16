import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync } from 'node:zlib';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const maximumTextBytes = 32 * 1024 * 1024;
const maximumPackBytes = 64 * 1024 * 1024;

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
