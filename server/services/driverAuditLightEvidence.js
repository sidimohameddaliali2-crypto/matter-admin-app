import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createCloudRepository, readManifestBytes } from '../vendor/driver-audits/integration/cloud/repository.mjs';
import { createImmutableEvidenceCache } from '../vendor/driver-audits/integration/cloud/immutable-evidence-cache.mjs';
import { createPreviewGps } from '../vendor/driver-audits/integration/cloud/preview-gps.mjs';
import { decodeGpsEvidenceFile } from '../vendor/driver-audits/integration/cloud/remote-preview-package.mjs';
import { readRows } from '../vendor/driver-audits/integration/cloud/preview-source-history.mjs';

const MiB = 1024 ** 2;
const sha = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const unavailable = message => Object.assign(Error(message), { status: 404 });

export async function readRetainedDriverAuditFile(repository, name, maxBytes) {
  try { return await repository.readFile('state', name, { maxBytes }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return repository.readFile('archive', name, { maxBytes });
  }
}

export function createDriverAuditLightEvidence({ archive } = {}) {
  const cache = createImmutableEvidenceCache({ maxBytes: 20 * MiB, maxEntries: 24 });
  const repositories = new Map();
  function repository(index) {
    const { catalog, generation, reportHash } = index;
    if (!hex(catalog?.sha256)) throw Error('The original report catalogue is required');
    const key = catalog.sha256 + ':' + generation;
    if (!repositories.has(key)) {
      const body = JSON.stringify({ version: 1, catalog, head: {
        reportHash, manifest: { sha256: generation, url: 'report-data/snapshot-' + generation + '.json' },
      } });
      const stateStore = { read: async () => ({ body, revision: 1 }) };
      repositories.set(key, createCloudRepository({ stateStore, transport: archive, cacheBytes: 6 * MiB }).pin());
      if (repositories.size > 2) repositories.delete(repositories.keys().next().value);
    }
    return repositories.get(key);
  }
  async function retained(index, file, maxBytes) {
    return readRetainedDriverAuditFile(await repository(index), file, maxBytes);
  }
  function memo(ref, kind, load) {
    if (!hex(ref?.sha256)) throw Error('The original evidence reference is missing');
    return cache.getOrLoad(kind + ':' + ref.sha256, async () => load(ref));
  }

  return Object.freeze({
    async detail(index, entry) {
      const ref = entry.detail;
      if (!ref) return null;
      if (!hex(ref.sha256) || ref.url !== 'report-data/detail-' + ref.sha256 + '.json') {
        throw Error('The original delivery detail reference differs');
      }
      const saved = await memo(ref, 'detail', async () => {
        const raw = await retained(index, 'assets/' + ref.url.slice('report-data/'.length) + '.gz', 16 * MiB);
        const bytes = gunzipSync(raw, { maxOutputLength: 16 * MiB });
        if (sha(bytes) !== ref.sha256) throw Error('The saved delivery detail failed verification');
        return { value: JSON.parse(bytes), bytes: bytes.length };
      });
      return saved;
    },
    async history(index, entry) {
      const key = entry.row.key;
      const read = (file, maxBytes) => retained(index, file, maxBytes);
      const { staff, source } = entry.history ?? {};
      const staffRows = await readRows(staff, key, read);
      const sourceRows = source?.sha256 === staff?.sha256 ? staffRows : await readRows(source, key, read);
      const seen = new Set(staffRows.map(row => sha(JSON.stringify(row))));
      return { staff: staffRows, additionalSource: sourceRows.filter(row => !seen.has(sha(JSON.stringify(row)))) };
    },
    async gps(index, entry, actor, vehicle) {
      const row = entry.gpsRow, key = row.key;
      const { streams, projections } = entry.gpsFiles;
      const selected = { version: 1, asOf: entry.gpsAsOf, records: entry.gps ? { [key]: entry.gps } : {},
        streamFiles: streams };
      const snapshotFor = async () => ({ snapshotHash: index.reportHash, rows: [row] });
      const reader = createPreviewGps({ snapshotFor, index: selected,
        readStream(name) {
          return memo(streams[name], 'stream', async ref => {
            const bytes = gunzipSync(await readManifestBytes(archive, ref, { maxBytes: 16 * MiB }),
              { maxOutputLength: 32 * MiB });
            return { value: JSON.parse(bytes), bytes: bytes.length };
          });
        },
        async readProjection(name, recordKey) {
          const records = await memo(projections[name], 'gps', async ref => {
            const { records: saved, bytes } = decodeGpsEvidenceFile(await readManifestBytes(archive, ref, { maxBytes: 8 * MiB }));
            return { value: saved, bytes };
          });
          const evidence = records.get(recordKey);
          if (!evidence) throw Error('The original GPS evidence row is missing');
          return evidence;
        },
      });
      const query = new URLSearchParams({ record: key, snapshot: index.reportHash });
      if (vehicle) query.set('vehicle', vehicle);
      const value = await reader.read(query, actor);
      return { ...value, sharedHouseholdStop: entry.policy?.sharedHouseholdStop ?? null, roadDisplayAvailable: false };
    },
    async photo(index, entry) {
      const expected = entry.photo?.sha256;
      if (!hex(expected)) throw unavailable('No verified photo is saved for this delivery');
      const pinned = await repository(index);
      return memo({ sha256: expected }, 'photo', async () => {
        let bytes;
        for (const domain of ['objects', 'legacyObjects']) {
          try { bytes = await pinned.readFile(domain, expected, { maxBytes: 8 * MiB }); break; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (!bytes) {
          try {
            bytes = gunzipSync(await retained(index, 'photos/' + expected + '.gz', 9 * MiB),
              { maxOutputLength: 8 * MiB });
          } catch (error) {
            if (error.code === 'ENOENT') throw unavailable('The saved original photo is currently unavailable');
            throw error;
          }
        }
        if (sha(bytes) !== expected) throw Error('The saved photo failed verification');
        let type;
        if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = 'image/jpeg';
        if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) type = 'image/png';
        if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') type = 'image/webp';
        if (!type) throw Error('The saved photo format is invalid');
        return { value: { body: bytes, type, sha256: expected }, bytes: bytes.length };
      });
    },
  });
}
