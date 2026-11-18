import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip, gunzipSync } from 'node:zlib';

const route = '/api/reporting/history-archive';
const browserLimit = 128 * 1024 ** 2;
const decodedBrowserLimit = 512 * 1024 ** 2;
const indexLimit = 8 * 1024 ** 2;
const caseLimit = 16 * 1024 ** 2;
const indexPath = ['matter', 'lazyQueries', 'reporting_validated_history', 'cases'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = status => Object.assign(Error('Saved assessment history unavailable'), { status });
const escaped = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// The original browser snapshot can be much larger than its case index. Hash
// the full decoded stream, but retain only the object at the index path.
async function historyIndex(bytes, manifest) {
  const hash = createHash('sha256');
  const stack = [];
  const parts = [];
  let decoded = 0, collected = 0, captureDepth = 0, complete = false;
  let inString = false, escapedByte = false, key = null;
  for await (const chunk of Readable.from([bytes]).pipe(createGunzip())) {
    decoded += chunk.length;
    if (decoded > decodedBrowserLimit) throw Error('History browser snapshot exceeds its size bound');
    hash.update(chunk);
    if (complete) continue;
    let start = captureDepth ? 0 : -1, end = chunk.length;
    for (let offset = 0; offset < chunk.length; offset++) {
      const byte = chunk[offset], parent = stack.at(-1);
      if (inString) {
        if (escapedByte) { escapedByte = false; continue; }
        if (byte === 92) { escapedByte = true; key = null; continue; }
        if (byte === 34) {
          inString = false;
          if (parent?.needsKey) { parent.key = key; parent.needsKey = false; }
          key = null;
        } else if (key !== null) key = key.length < 40 ? key + String.fromCharCode(byte) : null;
        continue;
      }
      if (byte === 34) {
        inString = true;
        key = parent?.needsKey && parent.depth >= 0 ? '' : null;
      } else if (byte === 123 || byte === 91) {
        const object = byte === 123;
        const depth = object && !parent ? 0 : object && parent?.depth >= 0 && parent.key === indexPath[parent.depth]
          ? parent.depth + 1 : -1;
        if (stack.length >= 128) throw Error('History browser snapshot nesting exceeds its bound');
        stack.push({ depth, object, needsKey: object, key: null });
        if (depth === indexPath.length) { captureDepth = stack.length; start = offset; }
      } else if (byte === 125 || byte === 93) {
        if (captureDepth && stack.length === captureDepth) { complete = true; end = offset + 1; break; }
        stack.pop();
      } else if (byte === 44 && parent?.object) {
        parent.needsKey = true;
        parent.key = null;
      }
    }
    if (start !== -1) {
      const part = chunk.subarray(start, end);
      collected += part.length;
      if (collected > indexLimit) throw Error('History case index exceeds its size bound');
      parts.push(part);
    }
  }
  if (hash.digest('hex') !== manifest.sha256) throw Error('History browser snapshot failed verification');
  if (!complete) throw Error('History case index unavailable');
  const cases = JSON.parse(Buffer.concat(parts, collected));
  if (!cases || typeof cases !== 'object' || Array.isArray(cases)) throw Error('History case index unavailable');
  return new Map(Object.entries(cases));
}

async function readRows(ref, key, readRetained) {
  if (!ref) return [];
  if (!validDigest(ref.sha256) || ref.url !== 'report-data/history-' + ref.sha256 + '.json'
    || !Number.isSafeInteger(ref.count) || ref.count < 0) throw Error('Invalid history case reference');
  const body = await readRetained('assets/' + ref.url.slice('report-data/'.length) + '.gz', caseLimit);
  const plain = gunzipSync(body, { maxOutputLength: caseLimit });
  if (digest(plain) !== ref.sha256) throw Error('History case failed verification');
  const { rows } = JSON.parse(plain);
  if (!Array.isArray(rows) || rows.length !== ref.count || rows.some(row => row?.key !== key)) {
    throw Error('History case did not match its saved record');
  }
  return rows;
}

function page(dayOptions, caseOptions, versions) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Saved source assessments · Driver Reports</title>
    <style>
      body { font: 16px system-ui, sans-serif; color: #192423; background: #f5f7f6; max-width: 56rem; margin: 2rem auto; padding: 0 1.25rem; }
      h1 { font-size: 1.75rem; }
      form, article { padding: 1rem; background: white; border: 1px solid #d5ded9; border-radius: .5rem; margin: 1rem 0; }
      label { display: block; margin-bottom: .5rem; font-weight: 600; }
      select, button { font: inherit; padding: .45rem; max-width: 100%; }
      pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 20rem; }
    </style></head><body><main>
      <a href="/driver-reports">Driver Reports</a>
      <h1>Saved source assessments</h1>
      <p>Look up additional recorded assessment versions by delivery day and case.</p>
      <form action="${route}" method="get">
        <label for="day">Delivery day</label><select name="day" id="day" required>${dayOptions}</select> <button>Show cases</button>
      </form>
      ${caseOptions}${versions}
    </main></body></html>`;
}

export const previewSourceHistoryLink = `<nav aria-label="Driver Reports archive" style="padding:.5rem 1rem">
  <a href="${route}" target="_blank" rel="noopener">Saved source assessments</a>
</nav>`;

// The selected report and its catalogue pin both generations. Opening this
// view lazily reads the original case objects and never writes derived rows.
export function createPreviewSourceHistory({ sourceManifest, staffManifest, rows, readStaffBrowser, readRetained }) {
  if (!validDigest(sourceManifest?.sha256) || sourceManifest.url !== 'report-data/snapshot-' + sourceManifest.sha256 + '.json') {
    return undefined;
  }
  const cases = new Map(rows.map(row => [row.key, row]));
  const days = [...new Set(rows.map(row => row.date).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)))].sort().reverse();
  let indexes;
  function readIndexes() {
    indexes ??= Promise.resolve().then(async () => {
      const sourceBytes = await readRetained('assets/' + sourceManifest.url.slice('report-data/'.length) + '.gz', browserLimit);
      const source = await historyIndex(sourceBytes, sourceManifest);
      const staff = await historyIndex(await readStaffBrowser(), staffManifest);
      return { source, staff };
    }).catch(error => { indexes = undefined; throw error; });
    return indexes;
  }

  return async params => {
    const entries = [...params.keys()];
    if (entries.some(key => key !== 'day' && key !== 'case') || new Set(entries).size !== entries.length) throw fail(400);
    const day = params.get('day'), key = params.get('case');
    if (day !== null && !days.includes(day)) throw fail(400);
    if (key !== null && (!day || cases.get(key)?.date !== day)) throw fail(404);
    const dayOptions = ['<option value="">Choose a day</option>', ...days.map(value =>
      `<option value="${value}"${value === day ? ' selected' : ''}>${value}</option>`)].join('');
    if (day === null) return page(dayOptions, '', '');

    const { source, staff } = await readIndexes();
    const changed = rows.filter(row => row.date === day && source.has(row.key)
      && source.get(row.key).sha256 !== staff.get(row.key)?.sha256);
    const options = changed.map(row => {
      const deliveryId = String(row.delivery?.id ?? row.key.slice(day.length + 1));
      const driver = typeof row.delivery?.driver === 'string' ? row.delivery.driver.trim() : '';
      const label = driver ? driver + ' · ' + deliveryId : deliveryId;
      return `<option value="${escaped(row.key)}"${row.key === key ? ' selected' : ''}>${escaped(label)}</option>`;
    }).join('');
    const caseOptions = options
      ? `<form action="${route}" method="get"><input type="hidden" name="day" value="${day}">
         <label for="case">Delivery case</label><select name="case" id="case">${options}</select> <button>Show assessments</button></form>`
      : '<p>All saved source assessment versions for this day are available in Driver Reports.</p>';
    if (!key) return page(dayOptions, caseOptions, '');
    if (!changed.some(row => row.key === key)) throw fail(404);

    const [original, shown] = await Promise.all([
      readRows(source.get(key), key, readRetained),
      readRows(staff.get(key), key, readRetained),
    ]);
    const seen = new Set(shown.map(row => digest(JSON.stringify(row))));
    const extra = original.filter(row => !seen.has(digest(JSON.stringify(row))));
    const versions = `<h2>Additional assessment versions (${extra.length})</h2>` + extra.map((row, index) => {
      const grade = typeof row.photo?.grade === 'string' ? `<p>Photo grade ${escaped(row.photo.grade)}</p>` : '';
      return `<article><h3>Saved assessment ${index + 1}</h3>${grade}<details>
        <summary>Saved evidence</summary><pre>${escaped(JSON.stringify(row, null, 2))}</pre>
      </details></article>`;
    }).join('');
    return page(dayOptions, caseOptions, versions);
  };
}
