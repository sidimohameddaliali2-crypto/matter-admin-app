const base = '/api/reporting/light/';

export const driverAuditLightHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="matter-driver-reports" content="1">
<title>Driver Reports</title><link rel="stylesheet" href="${base}reader.css">
<script defer src="${base}reader.js"></script></head>
<body><main>
<header><h1>Driver Reports</h1><a id="full-tools" href="/api/reporting/view?screen=reports&amp;view=1&amp;tab=mirror&amp;fullArchive=1" target="_blank" rel="noopener">Full report tools</a></header>
<p id="cutoff"></p>
<div class="filters"><label>Report date <select id="day"></select></label>
<label>Driver <select id="driver"></select></label></div>
<p id="status" role="status" aria-live="polite">Loading saved reports…</p>
<div id="results" class="table-box" hidden><table><thead><tr>
<th scope="col">Delivery</th><th scope="col">Driver</th><th scope="col">Status</th><th scope="col">Result</th>
</tr></thead><tbody id="rows"></tbody></table></div>
<div class="paging"><button id="previous" type="button" hidden>Previous</button>
<button id="next" type="button" hidden>Next</button>
<button id="source-cases" type="button" hidden>Additional saved cases</button></div>
<section id="delivery" aria-label="Delivery evidence" hidden></section>
</main></body></html>`;

export const driverAuditLightCss = `
:root{color:#182520;background:#f3f6f4;font:15px/1.5 system-ui,sans-serif}
body{margin:0}main{max-width:76rem;margin:auto;padding:clamp(.8rem,3vw,2rem)}
header,.filters,.paging,.actions{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
header{justify-content:space-between}h1,h2,h3,p{margin:.45rem 0}
h1{font-size:1.8rem}h2{font-size:1.4rem}h3{font-size:1.15rem}
#cutoff,#status{color:#43574d}.filters{margin:1rem 0}
label{display:grid;gap:.3rem;font-weight:600}
input,textarea,select,button{font:inherit;color:inherit;background:white;border:1px solid #a5b7ad;
border-radius:.35rem;padding:.45rem .65rem;max-width:100%}
button{cursor:pointer}button:disabled{cursor:wait;opacity:.65}
a,.delivery-link{color:#145b3a;text-decoration:underline;text-underline-offset:.18em}
.delivery-link{border:0;background:none;padding:0;text-align:left}
.table-box{background:white;border:1px solid #cbd7d0;border-radius:.4rem;overflow-x:auto;margin:.65rem 0}
table{border-collapse:collapse;width:100%;text-align:left}
th,td{padding:.55rem .7rem;border-bottom:1px solid #e4ebe6;vertical-align:top}
th{background:#eaf0ec}tr:last-child td{border-bottom:0}
.timing{display:block;color:#43574d;font-size:.88em}
section{margin-top:1rem;background:white;border:1px solid #cbd7d0;border-radius:.4rem;padding:1rem}
details,article{margin:.75rem 0}summary{cursor:pointer}
pre{max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6f4;padding:.6rem}
img,canvas{display:block;max-width:100%;height:auto;margin:.5rem 0}
form{display:grid;gap:.6rem;max-width:35rem}form button{justify-self:start}
textarea{min-height:5rem;width:calc(100% - 1.45rem)}
:focus-visible{outline:2px solid #247252;outline-offset:3px}
`;

function runDriverAuditLightPage() {
  'use strict';
  const base = '/api/reporting/light/';
  const byId = id => document.getElementById(id);
  const make = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const date = byId('day'), driver = byId('driver'), status = byId('status');
  const previous = byId('previous'), next = byId('next'), delivery = byId('delivery'), archived = byId('source-cases');
  const drafts = new Map();
  let report, offset = 0, version = 0, opened = 0;
  const text = value => value == null || value === '' ? '—' : String(value);
  const title = value => value == null || value === '' ? '—' : String(value).replaceAll('_', ' ');
  async function call(endpoint, params = {}, options = {}) {
    const query = new URLSearchParams(params);
    const response = await fetch(base + endpoint + (query.size ? '?' + query : ''),
      { credentials: 'same-origin', cache: 'no-store', ...options });
    if (response.status === 401) parent.postMessage('matter-audit-session-expired', location.origin);
    if (!response.ok) {
      const error = Error(response.status === 409 ? 'The report or review changed. Load the latest version, then try again.'
        : 'The saved data could not be loaded. Try again.');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  function option(value, label) {
    const node = make('option', label);
    node.value = value;
    return node;
  }
  function button(label, action) {
    const node = make('button', label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }
  function savedBody(label, value) {
    const node = make('details');
    node.append(make('summary', label), make('pre', JSON.stringify(value, null, 2)));
    return node;
  }
  function saveFilters() {
    const url = new URL(location.href);
    url.searchParams.set('report_day', date.value);
    if (driver.value) url.searchParams.set('report_driver', driver.value);
    else url.searchParams.delete('report_driver');
    history.replaceState(null, '', url);
  }
  async function list() {
    const callId = ++version;
    ++opened;
    delivery.hidden = true;
    archived.hidden = true;
    status.textContent = 'Loading deliveries…';
    const requested = { generation: report.generation, day: date.value, offset };
    if (driver.value) requested.driver = driver.value;
    try {
      const page = await call('deliveries', requested);
      if (callId !== version) return;
      driver.replaceChildren(option('', 'All drivers'), ...page.drivers.map(item =>
        option('driver:' + item.id, (item.name || 'Unassigned') + ' (' + item.records + ')')));
      driver.value = requested.driver ?? '';
      saveFilters();
      byId('rows').replaceChildren(...page.rows.map(row => {
        const tr = make('tr'), first = make('td');
        const control = button(row.customer || row.key.split('/').at(-1), () => openDelivery(row));
        control.className = 'delivery-link';
        first.append(control);
        const result = make('td', title(row.outcome));
        if (row.timing) {
          const timing = make('small', title(row.timing));
          timing.className = 'timing';
          result.append(timing);
        }
        tr.append(first, make('td', text(row.driverName)), make('td', title(row.status)), result);
        return tr;
      }));
      byId('results').hidden = false;
      status.textContent = page.total ? (offset + 1) + '–' + (offset + page.rows.length) + ' of ' + page.total + ' deliveries'
        : 'No deliveries are saved for this date.';
      previous.hidden = offset === 0;
      next.hidden = page.next === null;
      const extra = report.days.find(item => item.day === date.value)?.extraCases;
      archived.hidden = !extra;
      if (extra) archived.textContent = 'Additional saved cases (' + extra + ')';
      next.onclick = () => { offset = page.next; void list(); };
    } catch (error) { if (callId === version) status.textContent = error.message; }
  }
  function gpsView(value, body) {
    body.replaceChildren(make('p', value.message || (value.points.length + ' recorded GPS points')));
    const points = value.points.filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
    if (points.length > 0) {
      const canvas = make('canvas');
      canvas.width = 640;
      canvas.height = 280;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Recorded vehicle GPS trail');
      const ctx = canvas.getContext('2d');
      let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
      for (const { lat, lng } of points) {
        west = Math.min(west, lng); east = Math.max(east, lng);
        south = Math.min(south, lat); north = Math.max(north, lat);
      }
      ctx.fillStyle = '#edf3ef';
      ctx.fillRect(0, 0, 640, 280);
      ctx.strokeStyle = '#176448';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [i, point] of points.entries()) {
        const x = 12 + 616 * (point.lng - west) / (east - west || 1);
        const y = 268 - 256 * (point.lat - south) / (north - south || 1);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        ctx.fillStyle = '#176448';
        ctx.fillRect(x - 1, y - 1, 3, 3);
      }
      ctx.stroke();
      body.append(canvas);
    }
    body.append(savedBody('Recorded GPS evidence', value));
  }
  function showReviews(params, details, body) {
    body.replaceChildren();
    if (!details.issues.length) {
      body.append(make('p', 'No review case is saved for this delivery.'));
      return;
    }
    const choices = make('select'), label = make('label', 'Review case'), content = make('div');
    choices.append(...details.issues.map((item, position) => {
      const label = item.label || (details.issues.length === 1 ? 'Delivery review' : 'Case ' + (position + 1));
      return option(item.id, item.archived ? label + ' (previous evidence)' : label);
    }));
    label.append(choices);
    body.append(label, content);
    let request = 0;
    async function show() {
      const id = ++request, issueId = choices.value;
      const scoped = { ...params, issueId };
      content.replaceChildren(make('p', 'Loading review history…'));
      try {
        const result = await call('reviews', scoped);
        if (id !== request) return;
        content.replaceChildren();
        function reviewArticle(event) {
          const article = make('article');
          article.append(make('strong', event.data.authorName), make('p', event.created_at + ' · ' + title(event.data.status)),
            make('p', event.data.response), savedBody('Saved review details', event));
          return article;
        }
        content.append(...result.history.map(reviewArticle));
        if (result.archivedHistory?.length) content.append(make('h3', 'Reviews on previous evidence'),
          ...result.archivedHistory.map(reviewArticle));
        if (!result.history.length && !result.archivedHistory?.length) content.append(make('p', 'No reviews have been saved for this case.'));
        if (!report.canReview || result.historicalOnly) return;
        const draftKey = params.record + ':' + issueId;
        const draft = drafts.get(draftKey);
        const form = make('form'), response = make('textarea'), findingStatus = make('select');
        for (const value of ['open', 'investigating', 'resolved', 'needs_evidence', 'follow_up', 'explained', 'incorrect_data']) {
          findingStatus.add(option(value, title(value)));
        }
        response.required = true;
        response.maxLength = 4000;
        const person = make('input'), followUp = make('input');
        person.maxLength = 200;
        followUp.type = 'date';
        response.value = draft?.response ?? '';
        findingStatus.value = draft?.status ?? result.history.at(-1)?.data.status ?? 'open';
        person.value = draft?.responsiblePerson ?? '';
        followUp.value = draft?.followUpDate ?? '';
        for (const [name, control] of [['Response', response], ['Status', findingStatus],
          ['Responsible person', person], ['Follow-up date', followUp]]) {
          const field = make('label', name);
          field.append(control);
          form.append(field);
        }
        const save = make('button', 'Save review'), message = make('p');
        message.setAttribute('role', 'status');
        form.append(save, message);
        const readForm = () => ({ response: response.value, status: findingStatus.value,
          responsiblePerson: person.value, followUpDate: followUp.value });
        form.addEventListener('input', () => drafts.set(draftKey, readForm()));
        let submitted = draft?.submitted;
        form.addEventListener('submit', async event => {
          event.preventDefault();
          const fields = readForm();
          const input = { ...fields, issueId, snapshotHash: result.snapshotHash, expectedRevision: result.revision };
          const fingerprint = JSON.stringify(input);
          if (submitted?.fingerprint !== fingerprint) submitted = { fingerprint, eventId: crypto.randomUUID() };
          drafts.set(draftKey, { ...fields, submitted });
          for (const control of form.elements) control.disabled = true;
          message.textContent = 'Saving review…';
          try {
            await call('reviews', scoped, { method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Reporting-Token': report.token },
              body: JSON.stringify({ ...input, eventId: submitted.eventId }) });
            drafts.delete(draftKey);
            await show();
          } catch (error) {
            message.textContent = error.message;
            if (error.status === 409) message.append(' ', button('Load latest history', show));
          } finally { for (const control of form.elements) control.disabled = false; }
        });
        content.append(form);
      } catch (error) { if (id === request) content.replaceChildren(make('p', error.message)); }
    }
    choices.addEventListener('change', show);
    void show();
  }
  async function openDelivery(row) {
    const request = ++opened;
    delivery.hidden = false;
    delivery.replaceChildren(make('h2', row.customer || 'Delivery'), make('p', 'Loading delivery…'));
    const params = { generation: report.generation, record: row.key };
    try {
      const details = await call('case', params);
      if (request !== opened) return;
      const head = make('h2', row.customer || 'Delivery'), actions = make('div'), body = make('div');
      actions.className = 'actions';
      delivery.replaceChildren(head, make('p', text(row.driverName) + ' · ' + title(row.outcome)), actions, body);
      let pane = 0;
      async function load(endpoint, display) {
        const id = ++pane;
        body.replaceChildren(make('p', 'Loading saved evidence…'));
        try {
          const value = await call(endpoint, params);
          if (id === pane) display(value, body);
        } catch (error) { if (id === pane) body.replaceChildren(make('p', error.message)); }
      }
      actions.append(
        button('Delivery details', () => void load('detail', (value, node) => {
          const saved = savedBody('Saved delivery details', value);
          saved.open = true;
          node.replaceChildren(saved);
        })),
        button('GPS', () => void load('gps', gpsView)),
        button('Photo', () => {
          ++pane;
          if (!details.photo) { body.replaceChildren(make('p', 'No verified photo is saved for this delivery.')); return; }
          const img = make('img');
          img.alt = 'Original delivery photo';
          img.src = base + 'photo?' + new URLSearchParams(params);
          img.addEventListener('error', () => { if (img.isConnected) body.replaceChildren(make('p', 'The saved photo is unavailable.')); });
          body.replaceChildren(img);
        }),
        button('Assessment history', () => void load('history', (value, node) => {
          node.replaceChildren(savedBody('Saved assessments (' + value.staff.length + ')', value.staff),
            savedBody('Additional source assessments (' + value.additionalSource.length + ')', value.additionalSource));
        })),
        button('Reviews', () => { ++pane; showReviews(params, details, body); }),
      );
      delivery.scrollIntoView({ block: 'nearest' });
    } catch (error) { if (request === opened) delivery.replaceChildren(make('h2', 'Delivery'), make('p', error.message)); }
  }
  archived.onclick = async () => {
    const request = ++opened;
    delivery.hidden = false;
    delivery.replaceChildren(make('h2', 'Additional saved source cases'), make('p', 'Loading cases…'));
    const params = { generation: report.generation, day: date.value };
    try {
      const cases = await call('source-cases', params);
      if (request !== opened) return;
      const list = make('ul'), detail = make('div');
      for (const saved of cases) {
        const item = make('li');
        item.append(button(saved.record.split('/').at(-1) + ' (' + saved.versions + ')', async () => {
          detail.replaceChildren(make('p', 'Loading saved assessments…'));
          try {
            const value = await call('source-history', { generation: report.generation, record: saved.record });
            const shown = savedBody('Saved assessments (' + value.staff.length + ')', value.staff);
            const source = savedBody('Additional source assessments (' + value.additionalSource.length + ')', value.additionalSource);
            shown.open = value.staff.length > 0;
            source.open = value.additionalSource.length > 0;
            detail.replaceChildren(shown, source);
          } catch (error) { detail.replaceChildren(make('p', error.message)); }
        }));
        list.append(item);
      }
      delivery.replaceChildren(make('h2', 'Additional saved source cases'), list, detail);
    } catch (error) { if (request === opened) delivery.replaceChildren(make('p', error.message)); }
  };
  previous.onclick = () => { offset = Math.max(0, offset - report.pageSize); void list(); };
  date.addEventListener('change', () => { offset = 0; driver.value = ''; void list(); });
  driver.addEventListener('change', () => { offset = 0; void list(); });
  window.addEventListener('beforeunload', event => {
    if (drafts.size) { event.preventDefault(); event.returnValue = ''; }
  });
  void (async () => {
    try {
      report = await call('dates');
      if (report.archiveReadOnly) byId('full-tools').textContent = 'Saved report archive';
      if (report.visibleCutoffAt) {
        const format = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai' });
        byId('cutoff').textContent = (report.stale ? 'Last verified evidence through ' : 'Evidence checked through ')
          + format.format(new Date(report.visibleCutoffAt)) + ' Dubai';
      }
      const filters = new URL(location.href).searchParams;
      date.replaceChildren(...report.days.map(item => option(item.day, item.day
        + (item.records ? ' (' + item.records + ')' : ' · saved assessments'))));
      if (report.days.some(item => item.day === filters.get('report_day'))) date.value = filters.get('report_day');
      if (!date.value) { status.textContent = 'No report dates are saved.'; return; }
      const savedDriver = filters.get('report_driver');
      if (savedDriver?.startsWith('driver:')) { driver.add(option(savedDriver, 'Saved driver')); driver.value = savedDriver; }
      await list();
    } catch (error) { status.textContent = error.message; }
  })();
}

export const driverAuditLightJs = '(' + runDriverAuditLightPage.toString() + ')();';
