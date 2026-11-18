import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createPreviewSourceHistory } from '../vendor/driver-audits/integration/cloud/preview-source-history.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const params = values => new URLSearchParams(values);
const day = '2026-11-18';
const key = day + '/delivery-a';

function fixture() {
  const objects = new Map();
  const reads = [];
  function save(type, value) {
    const plain = Buffer.from(JSON.stringify(value));
    const sha256 = sha(plain);
    const url = 'report-data/' + type + '-' + sha256 + '.json';
    const packed = gzipSync(plain);
    objects.set('assets/' + url.slice('report-data/'.length) + '.gz', packed);
    return { ref: { sha256, url }, packed };
  }
  const prior = { key, assessmentHash: sha('staff'), photo: { grade: 'A' }, savedGpsAssessment: { recorded: true } };
  const extra = { key, assessmentHash: sha('source'), photo: { grade: '<script>not executable</script>' },
    savedGpsAssessment: { moreEvidence: true } };
  function makeStudy(rows) {
    const { ref } = save('history', { rows });
    return save('snapshot', { matter: { lazyQueries: { reporting_validated_history: {
      cases: { [key]: { ...ref, count: rows.length } },
    } } } });
  }
  const staff = makeStudy([prior]), source = makeStudy([prior, extra]);
  const render = createPreviewSourceHistory({ sourceManifest: source.ref, staffManifest: staff.ref,
    rows: [{ key, date: day, delivery: { driver: 'Example <Driver>', id: 'delivery-a' } }],
    readStaffBrowser: () => staff.packed, async readRetained(file) {
      reads.push(file);
      return objects.get(file);
    } });
  return { render, reads, objects, source };
}

test('source history reads only the selected cases and keeps the exact staff versions in the report', async () => {
  const { render, reads } = fixture();
  assert.match(await render(params()), /Saved source assessments/);
  assert.deepEqual(reads, []);
  const choices = await render(params({ day }));
  assert.match(choices, /Example &lt;Driver&gt;/);
  assert.equal(reads.length, 1, 'Day selection reads only the saved browser index');
  const report = await render(params({ day, case: key }));
  assert.match(report, /Additional assessment versions \(1\)/);
  assert.match(report, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.match(report, /moreEvidence/);
  assert.doesNotMatch(report, /<script>|&quot;recorded&quot;/);
  assert.equal(reads.length, 3, 'Only the two selected case histories are read');
  await render(params({ day }));
  assert.equal(reads.length, 3, 'The verified indexes remain cached in the report runtime');
});

test('source history rejects other days, unknown cases and an altered saved index', async () => {
  const { render, reads, objects, source } = fixture();
  await assert.rejects(render(params({ day: '2026-11-17', case: key })), error => error.status === 400);
  await assert.rejects(render(params({ day, case: day + '/unrelated' })), error => error.status === 404);
  assert.equal(reads.length, 0);
  objects.set('assets/' + source.ref.url.slice('report-data/'.length) + '.gz', gzipSync('{}'));
  await assert.rejects(render(params({ day })), /failed verification/);
});
