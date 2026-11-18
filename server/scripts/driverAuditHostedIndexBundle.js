import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decryptTransfer, encryptTransfer, transferPlan } from '../services/driverAuditTransferCodec.js';

const kind = 'report-index-stage';
const bindingName = 'hosted-index-stage-binding.private.json';
const candidateName = 'candidate.private.json';
const indexName = 'staged-index.private.json';
const proofName = 'release-proof.private.json';
const inputLimits = new Map([[bindingName, 256], [candidateName, 64 * 1024],
  [indexName, 1024 ** 2], [proofName, 1024 ** 2]]);
const maximumObjects = 2048;
const maximumObjectBytes = 16 * 1024 ** 2;
const maximumObjectsBytes = 32 * 1024 ** 2;
const maximumInventory = 384 * 1024;
const maximumHeader = 4096;
export const maximumDriverAuditHostedIndexBundleBytes = 35 * 1024 ** 2;
const objectName = /^[a-f0-9]{64}\.gz$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const need = condition => { if (!condition) throw Error('Hosted report index bundle verification stopped'); };
const owned = stat => stat.uid === BigInt(process.getuid()) && !(Number(stat.mode) & 0o077);
const identity = stat => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].map(String).join(':');
const signature = stat => [identity(stat), stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;

function json(bytes, maximum) {
  need(Buffer.isBuffer(bytes) && positive(bytes.length, maximum));
  const text = bytes.toString('utf8');
  need(Buffer.from(text).equals(bytes));
  let value;
  try { value = JSON.parse(text); } catch { need(false); }
  need(record(value));
  return value;
}

function credentials(key, releaseSha) {
  need(Buffer.isBuffer(key) && key.length === 32 && typeof releaseSha === 'string' && /^[a-f0-9]{40}$/.test(releaseSha));
  return Buffer.from(key);
}

async function privateDirectory(directory) {
  need(absolute(directory) && await fs.realpath(directory) === directory);
  const stat = await fs.lstat(directory, { bigint: true });
  need(stat.isDirectory() && owned(stat));
  return stat;
}

async function readPrivate(file, maximum) {
  need(absolute(file) && await fs.realpath(file) === file);
  const before = await fs.lstat(file, { bigint: true });
  need(before.isFile() && owned(before) && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum));
  const fileHandle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const expected = signature(before);
    need(signature(await fileHandle.stat({ bigint: true })) === expected);
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await fileHandle.read(bytes, offset, bytes.length - offset, offset);
      need(bytesRead > 0);
      offset += bytesRead;
    }
    need((await fileHandle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0
      && signature(await fileHandle.stat({ bigint: true })) === expected
      && signature(await fs.lstat(file, { bigint: true })) === expected && await fs.realpath(file) === file);
    return bytes;
  } finally { await fileHandle.close(); }
}

function inventory(candidate, stagedIndex) {
  const selected = json(candidate, inputLimits.get(candidateName));
  const staged = json(stagedIndex, inputLimits.get(indexName));
  const light = staged.lightView;
  need(staged.version === 1 && staged.published === false && staged.activated === false
    && staged.originalGpsPhotosReviewsRemainInExistingArchive === true && digest(staged.independentParitySha256)
    && positive(staged.collectorRevision, Number.MAX_SAFE_INTEGER)
    && staged.collectorRevision === selected.servingPackage?.collectorRevision
    && digest(staged.originalDescriptorSha256) && staged.originalDescriptorSha256 === selected.descriptor?.sha256
    && exact(light, ['sha256', 'size']) && digest(light.sha256) && positive(light.size, maximumObjectBytes)
    && selected.lightView?.sha256 === light.sha256 && selected.lightView?.size === light.size
    && Array.isArray(staged.archives) && positive(staged.archives.length, maximumObjects)
    && staged.objectCount === staged.archives.length);
  const objects = new Map();
  let bytes = 0;
  for (const row of staged.archives) {
    need(exact(row, ['key', 'bytes']) && typeof row.key === 'string' && objectName.test(row.key)
      && positive(row.bytes, maximumObjectBytes) && !objects.has(row.key));
    objects.set(row.key, row.bytes);
    bytes += row.bytes;
  }
  need(bytes === staged.objectBytes && bytes <= maximumObjectsBytes && objects.get(light.sha256 + '.gz') === light.size);
  return objects;
}

const rowsFor = (inputs, objects) => [
  ...Array.from(inputs, ([name, bytes]) => ({ key: hash(bytes) + '.json', bytes: bytes.length, kind: 'input', name })),
  ...[...objects.keys()].sort().map(key => ({ key, bytes: objects.get(key) })),
];

export async function sealDriverAuditHostedIndexBundle({ stageRoot, proof, key, releaseSha, signal } = {}) {
  const privateKey = credentials(key, releaseSha);
  try {
    signal?.throwIfAborted();
    json(proof, inputLimits.get(proofName));
    proof = Buffer.from(proof);
    const rootBefore = await privateDirectory(stageRoot);
    const objectsRoot = path.join(stageRoot, 'objects');
    const objectsBefore = await privateDirectory(objectsRoot);
    const candidate = await readPrivate(path.join(stageRoot, candidateName), inputLimits.get(candidateName));
    const stagedIndex = await readPrivate(path.join(stageRoot, indexName), inputLimits.get(indexName));
    const objects = inventory(candidate, stagedIndex);
    const names = (await fs.readdir(objectsRoot)).sort();
    need(names.length === objects.size && names.every(name => objects.has(name)));
    const binding = Buffer.from(JSON.stringify({ version: 1, kind, releaseSha }));
    const inputs = new Map([[bindingName, binding], [candidateName, candidate], [indexName, stagedIndex], [proofName, proof]]);
    const rows = rowsFor(inputs, objects);
    const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    need(raw.length <= maximumInventory);
    const plan = transferPlan(raw), baseNonce = randomBytes(8), sessionId = randomUUID();
    const header = Buffer.from(JSON.stringify({ version: 1, kind, sessionId, baseNonce: baseNonce.toString('base64'), plan }));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(header.length);
    const frames = [size, header];
    const context = { sessionId, targetDatabase: kind, inventorySha256: plan.inventorySha256 };
    for await (const frame of encryptTransfer({ inventory: raw, key: privateKey, baseNonce, context, async readObject(row) {
      signal?.throwIfAborted();
      return row.kind === 'input' ? inputs.get(row.name) : readPrivate(path.join(objectsRoot, row.key), row.bytes);
    } })) frames.push(frame);
    signal?.throwIfAborted();
    need(signature(await privateDirectory(stageRoot)) === signature(rootBefore)
      && signature(await privateDirectory(objectsRoot)) === signature(objectsBefore));
    const ciphertext = Buffer.concat(frames);
    need(ciphertext.length <= maximumDriverAuditHostedIndexBundleBytes);
    return ciphertext;
  } finally { privateKey.fill(0); }
}

export async function openDriverAuditHostedIndexBundle({ bundle, key, releaseSha, signal } = {}) {
  const privateKey = credentials(key, releaseSha);
  try {
    signal?.throwIfAborted();
    need(Buffer.isBuffer(bundle) && bundle.length > 4 && bundle.length <= maximumDriverAuditHostedIndexBundleBytes);
    bundle = Buffer.from(bundle);
    const headerSize = bundle.readUInt32BE();
    need(positive(headerSize, maximumHeader) && headerSize + 4 < bundle.length);
    const header = json(bundle.subarray(4, 4 + headerSize), maximumHeader);
    need(exact(header, ['version', 'kind', 'sessionId', 'baseNonce', 'plan']) && header.version === 1 && header.kind === kind
      && typeof header.sessionId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(header.sessionId)
      && typeof header.baseNonce === 'string' && /^[A-Za-z0-9+/]{11}=$/.test(header.baseNonce));
    const baseNonce = Buffer.from(header.baseNonce, 'base64'), plan = header.plan;
    const cipher = bundle.subarray(4 + headerSize);
    need(baseNonce.length === 8 && baseNonce.toString('base64') === header.baseNonce
      && exact(plan, ['version', 'inventorySha256', 'inventoryBytes', 'objectCount', 'objectBytes', 'cipherBytes'])
      && plan.version === 1 && digest(plan.inventorySha256) && positive(plan.inventoryBytes, maximumInventory)
      && plan.objectCount > inputLimits.size && positive(plan.objectCount, maximumObjects + inputLimits.size)
      && positive(plan.objectBytes, maximumObjectsBytes + [...inputLimits.values()].reduce((sum, size) => sum + size, 0))
      && plan.cipherBytes === cipher.length);
    const context = { sessionId: header.sessionId, targetDatabase: kind, inventorySha256: plan.inventorySha256 };
    const inputs = new Map(), objects = new Map(), received = [];
    const result = await decryptTransfer({ stream: (async function* () { yield cipher; })(), key: privateKey,
      baseNonce, context, plan, signal, async receive(row, value) {
        need(received.length < plan.objectCount);
        if (row.kind === 'input') {
          need(exact(row, ['key', 'bytes', 'kind', 'name']) && row.key.endsWith('.json')
            && inputLimits.has(row.name) && positive(value.length, inputLimits.get(row.name)));
          inputs.set(row.name, value);
        } else {
          need(exact(row, ['key', 'bytes']) && objectName.test(row.key) && positive(value.length, maximumObjectBytes));
          objects.set(row.key, value);
        }
        received.push(row);
      } });
    signal?.throwIfAborted();
    need(result.verified === true && inputs.size === inputLimits.size);
    const binding = json(inputs.get(bindingName), inputLimits.get(bindingName));
    need(exact(binding, ['version', 'kind', 'releaseSha']) && binding.version === 1
      && binding.kind === kind && binding.releaseSha === releaseSha);
    const candidate = inputs.get(candidateName), stagedIndex = inputs.get(indexName), proof = inputs.get(proofName);
    json(proof, inputLimits.get(proofName));
    const declared = inventory(candidate, stagedIndex);
    need(objects.size === declared.size && [...objects].every(([name, bytes]) => declared.get(name) === bytes.length)
      && JSON.stringify(received) === JSON.stringify(rowsFor(inputs, declared))
      && JSON.stringify([...inputs.keys()]) === JSON.stringify([...inputLimits.keys()]));
    return { candidate, stagedIndex, proof, objects };
  } finally { privateKey.fill(0); }
}

async function cliKey() {
  let value = process.env.DRIVER_AUDIT_INDEX_BUNDLE_KEY;
  if (value === undefined) {
    need(!process.stdin.isTTY);
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length; need(size <= 46); chunks.push(chunk);
    }
    value = Buffer.concat(chunks, size).toString('utf8').replace(/\r?\n$/, '');
  }
  need(/^[A-Za-z0-9+/]{43}=$/.test(value));
  const key = Buffer.from(value, 'base64');
  need(key.length === 32 && key.toString('base64') === value);
  return key;
}

async function writeNewPrivate(file, bytes) {
  need(absolute(file));
  const directory = path.dirname(file), before = await privateDirectory(directory);
  const temporary = path.join(directory, '.hosted-index-' + randomUUID() + '.tmp');
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    need(identity(await privateDirectory(directory)) === identity(before));
    await fs.link(temporary, file);
    const dir = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await handle.close(); await fs.unlink(temporary); }
}

async function main(args) {
  const [operation, input, proofOrRelease, releaseSha, output] = args;
  need(operation === 'seal' && args.length === 5 || operation === 'open' && args.length === 3);
  const key = await cliKey();
  try {
    if (operation === 'seal') {
      const proof = await readPrivate(proofOrRelease, inputLimits.get(proofName));
      const bundle = await sealDriverAuditHostedIndexBundle({ stageRoot: input, proof, key, releaseSha });
      await writeNewPrivate(output, bundle);
      process.stdout.write(JSON.stringify({ status: 'sealed', bytes: bundle.length }) + '\n');
    } else {
      const bundle = await readPrivate(input, maximumDriverAuditHostedIndexBundleBytes);
      const result = await openDriverAuditHostedIndexBundle({ bundle, key, releaseSha: proofOrRelease });
      process.stdout.write(JSON.stringify({ status: 'verified', objects: result.objects.size }) + '\n');
    }
  } finally { key.fill(0); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch { process.stderr.write('Hosted report index bundle operation stopped.\n'); process.exitCode = 1; }
}
