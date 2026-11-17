// Browser observations describe edits and submission attempts. The server alone
// identifies the signed-in person and determines whether a business action saved.
const MASK = '[Not recorded]';
const EDIT_DELAY = 600;
const SEND_DELAY = 900;
const ACTION_LIFETIME = 10000;
const MAX_QUEUE = 100;
const MAX_DURABLE_QUEUE = 5000;
const MAX_BATCH = 20;
const MAX_BATCH_BYTES = 48000;
const MAX_FIELDS = 20;
const VALIDATION_INDICATORS = '[aria-invalid="true"],.Mui-error,.text-red-400,.text-red-500,.text-red-600,.text-red-700,.text-red-800,.text-red-900,[data-validation-error]';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PRIVATE_FIELD = /password|passphrase|credential|secret|token|api.?key|private.?key|service.?role|authorization|csrf|session|recovery|one.?time|verification.?code|security.?code|\botp\b|\bpin.?code\b|passport|emirates.?id|national.?id|identity|id.?document|driv(?:ing|er).?licen[cs]e|\biban\b|\bswift\b|bank|account.?number|routing.?number|credit.?card|debit.?card|card.?number|\bcvv\b|\bcvc\b|salary|deduction|medical|health|diagnos|medicat|allerg|prescription|phone|email|message|comment|body|content|text|notes?|evidence|photo|picture|attachment|signature/i;
const SECRET_VALUE = /\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:sk|pk|rk|sb_secret|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|secret|token|api[_ -]?key|authorization)\s*[=:]\s*\S+|[?&](?:token|key|secret|signature|code)=|\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b|\b784[- ]?\d{4}[- ]?\d{7}[- ]?\d\b|\b(?:\d[ -]?){13,19}\b|(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^\s]+:[^\s]+@|\b(?=[A-Za-z0-9_-]{40,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/i;
let runtime = null;
let previousStatus = { pendingEvents: 0, failedBatches: 0, droppedEvents: 0, lastFailureAt: null, lastSuccessAt: null, sending: false, durableQueueSupported: false, queueIssue: null };

function newId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const shorten = (value, max = 300) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 14)}… [shortened]` : text;
};
const readable = value => shorten(String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\[\].-]+/g, ' ').replace(/\s+/g, ' ').trim(), 120);
const safeLabel = value => SECRET_VALUE.test(String(value || '')) ? 'Private field' : readable(value);
function labelText(element) {
  if (!element) return '';
  const copy = element.cloneNode(true);
  copy.querySelectorAll(`input,textarea,select,[contenteditable],script,style,[role="alert"],.MuiFormHelperText-root,${VALIDATION_INDICATORS}`).forEach(child => child.remove());
  return safeLabel(copy.textContent);
}
function accessibleLabel(element) {
  const refs = element.getAttribute('aria-labelledby');
  const labelled = refs?.split(/\s+/).map(id => labelText(document.getElementById(id))).filter(Boolean).join(' ');
  return safeLabel(labelled || element.getAttribute('aria-label'));
}
function nearbyLabel(field) {
  // Older screens place a visible label beside an input without for/id.
  // Use it only when a small enclosing group contains this single control.
  for (let group = field.parentElement, depth = 0; group && depth < 3 && group !== document.body; group = group.parentElement, depth += 1) {
    const controls = Array.from(group.querySelectorAll('input,textarea,select,[contenteditable]')).filter(candidate => editable(candidate) === candidate);
    if (controls.length !== 1 || controls[0] !== field) continue;
    const label = group.querySelector('label');
    if (label && (!label.htmlFor || label.htmlFor === field.id)) return labelText(label);
  }
  return '';
}
function fieldLabel(field) {
  const captureLabel = safeLabel(field.getAttribute('data-activity-label'));
  if (captureLabel) return captureLabel;
  const associated = Array.from(field.labels || []).map(labelText).filter(Boolean).join(' ');
  return associated || labelText(field.closest('label')) || accessibleLabel(field) || nearbyLabel(field) || safeLabel(field.name) || safeLabel(field.getAttribute('placeholder')) || 'Text field';
}
function containerFor(field) {
  return field.form || field.closest('form,[role="form"],[role="dialog"],fieldset') || document.body;
}
function formTitle(container) {
  const ownHeading = container.querySelector('h1,h2,legend');
  return accessibleLabel(container) || labelText(ownHeading) || labelText(document.querySelector('h1')) || labelText(container.querySelector('h3')) || 'Page details';
}
function editable(target) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  const field = element?.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]');
  if (!field || field.disabled || field.readOnly || field.closest('[contenteditable="false"]')) return null;
  if (field.tagName === 'INPUT' && /^(hidden|button|submit|reset|image)$/i.test(field.type)) return null;
  return field;
}
function snapshot(field, initial = false) {
  const label = fieldLabel(field);
  const description = [label, field.name, field.id, field.getAttribute('autocomplete'), field.getAttribute('data-activity-private')].join(' ');
  if (field.closest('[data-activity-private],[data-no-capture]')) return { value: MASK, redacted: true };
  if (field.type === 'file') return { value: `${initial ? 0 : (field.files?.length || 0)} file${(initial ? 0 : field.files?.length) === 1 ? '' : 's'}`, redacted: false };
  if (/^(password|tel|email)$/.test(field.type) || PRIVATE_FIELD.test(description)) return { value: MASK, redacted: true };
  let value;
  if (field.type === 'checkbox' || field.type === 'radio') value = (initial ? field.defaultChecked : field.checked) ? 'Selected' : 'Not selected';
  else if (field.tagName === 'SELECT') {
    const options = Array.from(field.options).filter(option => initial ? option.defaultSelected : option.selected);
    value = (options.length ? options : initial ? Array.from(field.options).slice(0, 1) : []).map(option => option.textContent || option.value).join(', ');
  } else if (field.matches('[contenteditable]')) value = initial ? '' : field.textContent;
  else value = initial ? field.defaultValue : field.value;
  if (SECRET_VALUE.test(String(value || ''))) return { value: MASK, redacted: true };
  return { value: shorten(value), redacted: false };
}
function customText(value) {
  const text = item => String(item ?? '');
  return Array.isArray(value) ? value.map(item => /[,"\n\r]/.test(text(item)) ? JSON.stringify(text(item)) : text(item)).join(', ') : text(value);
}
function customSnapshot(value, field, isPrivate) {
  if (isPrivate || PRIVATE_FIELD.test(field)) return { value: MASK, redacted: true };
  const scalar = item => item == null || ['string', 'boolean'].includes(typeof item) || (typeof item === 'number' && Number.isFinite(item));
  // Callers supply readable values, never whole records. Unknown structures
  // fail closed rather than serializing credentials or private domain objects.
  if (!(Array.isArray(value) ? value.every(scalar) : scalar(value))) return { value: MASK, redacted: true };
  const text = customText(value);
  return SECRET_VALUE.test(text) ? { value: MASK, redacted: true } : { value: shorten(text), redacted: false };
}
function focusCustomDifference(before, after, a, b) {
  if (a.redacted || b.redacted || (customText(before).length <= 300 && customText(after).length <= 300)) return;
  let start = 0;
  if (Array.isArray(before) && Array.isArray(after)) {
    while (start < Math.min(before.length, after.length) && Object.is(before[start], after[start])) start += 1;
    const oldText = customText(before.slice(start)), newText = customText(after.slice(start));
    let character = 0;
    while (character < Math.min(oldText.length, newText.length) && oldText[character] === newText[character]) character += 1;
    character = Math.max(0, character - 60);
    const excerpt = (value, text) => shorten(`${value.length} items · from position ${start + 1}${character ? `, character ${character + 1}` : ''}: ${text.slice(character) || 'None'}`);
    a.value = excerpt(before, oldText); b.value = excerpt(after, newText);
  } else {
    const oldText = customText(before), newText = customText(after);
    while (start < Math.min(oldText.length, newText.length) && oldText[start] === newText[start]) start += 1;
    start = Math.max(0, start - 60);
    const excerpt = text => shorten(`${start ? `… from character ${start + 1}: ` : ''}${text.slice(start)}`);
    a.value = excerpt(oldText); b.value = excerpt(newText);
  }
}
function sameCustomValue(before, after) {
  return Object.is(before, after) || (Array.isArray(before) && Array.isArray(after) && before.length === after.length && before.every((value, index) => Object.is(value, after[index])));
}
function sameAppOrigin(url) {
  try {
    const resolved = new URL(url, window.location.origin);
    if (resolved.origin === window.location.origin) return true;
    const local = host => host === 'localhost' || host === '127.0.0.1';
    return local(window.location.hostname) && local(resolved.hostname) && resolved.port === '5000' && resolved.protocol === window.location.protocol;
  } catch { return false; }
}
function apiBase() {
  const configured = process.env.REACT_APP_API_URL;
  if (configured && sameAppOrigin(configured)) return configured.replace(/\/$/, '');
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') return `${window.location.protocol}//${window.location.hostname}:5000/api`;
  return `${window.location.origin}/api`;
}
function currentContext(includeExcluded = false) {
  const page = window.location.pathname;
  // Public links can carry credentials in their path and have no verified actor.
  if (!includeExcluded && (/^\/(?:traceability|login|join|menu-select)(?:\/|$)/.test(page) || /^\/partner\/login(?:\/|$)/.test(page))) return null;
  const scheme = /^\/partner(?:\/|$)/.test(page) ? 'partner' : /^\/member(?:\/|$)/.test(page) ? 'member' : 'staff';
  const key = scheme === 'staff' ? 'token' : `${scheme}Token`;
  let token;
  let account;
  try {
    token = window.localStorage.getItem(key);
    account = JSON.parse(window.localStorage.getItem(scheme === 'staff' ? 'user' : `${scheme}User`) || 'null');
  } catch { /* A missing cached account disables durable replay, not live capture. */ }
  if (!token) return null;
  const id = account?._id || account?.id;
  const owner = (typeof id === 'string' || typeof id === 'number') && String(id).length <= 160 ? `${scheme}:${id}` : null;
  return { page: shorten(page, 200), key, token, owner, url: `${apiBase()}/traceability/capture${scheme === 'staff' ? '' : `/${scheme}`}` };
}
function sameSession(auth) {
  try { return window.localStorage.getItem(auth.key) === auth.token; } catch { return false; }
}
function changeFor(label, before, after) {
  const redacted = before.redacted || after.redacted;
  return { field: label, before: redacted ? MASK : before.value, after: redacted ? MASK : after.value, redacted };
}
function visibleValidationIndicator(indicator, container) {
  if (!indicator.isConnected || indicator.closest('[hidden],[aria-hidden="true"],[inert],.hidden') || indicator.closest('button,a,[role="button"]')) return false;
  for (let node = indicator; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    if (node === container) break;
  }
  // Colour alone is not evidence: required asterisks, empty placeholders and
  // red action buttons must not become a rejected submission.
  return indicator.matches('[aria-invalid="true"],.Mui-error,[data-validation-error]') || /[^\s*✱✳:!]/.test(indicator.textContent || '');
}
function validationField(indicator, container) {
  const direct = editable(indicator);
  if (direct) return direct;
  const candidates = Array.from(container.querySelectorAll('input,textarea,select,[contenteditable]')).filter(field => editable(field) === field);
  if (indicator.id) {
    const described = candidates.find(field => `${field.getAttribute('aria-describedby') || ''} ${field.getAttribute('aria-errormessage') || ''}`.split(/\s+/).includes(indicator.id));
    if (described) return described;
  }
  const group = indicator.closest('.MuiFormControl-root,[role="group"],fieldset') || indicator.parentElement;
  if (!group || group === container || !container.contains(group)) return null;
  const grouped = candidates.filter(field => group.contains(field));
  return grouped.length === 1 ? grouped[0] : null;
}

// A separate store leaves the driver's delivery/photo queue untouched. Only
// sanitized observations and a local account partition are stored, never auth.
function openCaptureQueue() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('Storage unavailable')); return; }
    const request = window.indexedDB.open('MatterActivityCapture', 1);
    let finished = false;
    const timeout = window.setTimeout(() => { finished = true; reject(new Error('Storage unavailable')); }, 3000);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('queue')) request.result.createObjectStore('queue', { keyPath: 'eventId' });
    };
    request.onerror = request.onblocked = () => { window.clearTimeout(timeout); finished = true; reject(new Error('Storage unavailable')); };
    request.onsuccess = () => {
      window.clearTimeout(timeout);
      if (finished) { request.result.close(); return; }
      finished = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
function updateCaptureQueue(db, mutate) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['queue'], 'readwrite');
    const store = transaction.objectStore('queue');
    let result;
    const timeout = window.setTimeout(() => { transaction.abort?.(); reject(new Error('Storage unavailable')); }, 3000);
    const request = store.getAll();
    request.onsuccess = () => {
      try { result = mutate(request.result || [], store); }
      catch { transaction.abort?.(); window.clearTimeout(timeout); reject(new Error('Storage unavailable')); }
    };
    transaction.oncomplete = () => { window.clearTimeout(timeout); resolve(result); };
    transaction.onerror = transaction.onabort = () => { window.clearTimeout(timeout); reject(new Error('Storage unavailable')); };
  });
}

export function readCaptureStatus() {
  return runtime ? runtime.status() : { ...previousStatus };
}

// Custom widgets call this at the user-change boundary, including when the
// value never reaches Save. Initial rendering and remote loads do not call it.
// Actor identity is deliberately absent; capture authentication supplies it.
export function recordActivityChange(change) {
  return runtime?.recordChange(change) || false;
}

export function installActivityCapture() {
  if (runtime || typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const fields = new WeakMap();
  const sessions = new WeakMap();
  const pending = new Map();
  const queue = [];
  const activeBatches = new Set();
  const cancelRequests = new Set();
  const validationChecks = new Map();
  const diskRecords = new Map();
  const counts = { failedBatches: 0, droppedEvents: 0, lastFailureAt: null, lastSuccessAt: null };
  let database = null;
  let durableQueueSupported = false;
  let queueIssue = window.indexedDB ? null : 'storage-unavailable';
  let diskChain;
  let activeAction = null;
  let sendTimer = null;
  let stopped = false;
  let unloading = false;
  const status = () => {
    const ids = new Set(queue.map(item => item.event.eventId));
    for (const batch of activeBatches) for (const item of batch) ids.add(item.event.eventId);
    const owner = currentContext(true)?.owner;
    for (const item of diskRecords.values()) if (item.owner === owner) ids.add(item.eventId);
    return { ...counts, pendingEvents: pending.size + ids.size, sending: activeBatches.size > 0, durableQueueSupported, queueIssue };
  };
  const notify = () => {
    if (stopped) return;
    previousStatus = status();
    window.dispatchEvent(new CustomEvent('matter:activity-capture-status', { detail: { ...previousStatus } }));
  };
  const warn = () => console.warn('Some activity details could not be recorded.', { failedBatches: counts.failedBatches, droppedEvents: counts.droppedEvents });
  const drop = count => { if (count) { counts.droppedEvents += count; warn(); notify(); } };
  const schedule = (delay = SEND_DELAY) => {
    if (stopped || unloading || sendTimer !== null || !queue.length) return;
    sendTimer = window.setTimeout(() => { sendTimer = null; void send(); }, delay);
  };
  function restore(context = currentContext(true)) {
    if (stopped || !context?.owner) return;
    if (queueIssue === 'identity-unavailable') queueIssue = null;
    const known = new Set(queue.map(item => item.event.eventId));
    for (const batch of activeBatches) for (const item of batch) known.add(item.event.eventId);
    for (const record of diskRecords.values()) {
      if (record.owner !== context.owner || known.has(record.eventId) || queue.length >= MAX_QUEUE) continue;
      queue.push({ event: record.event, auth: { ...context }, attempts: 0, persisted: true });
      known.add(record.eventId);
    }
    notify(); schedule();
  }
  function storageFailed() {
    durableQueueSupported = false;
    queueIssue = 'storage-unavailable';
    if (!stopped) { warn(); notify(); }
  }
  function diskOperation(operation) {
    diskChain = diskChain.then(async () => {
      if (!database || !durableQueueSupported) return;
      await operation();
    }).catch(storageFailed);
  }
  function forgetAccepted(ids) {
    if (!ids.size) return;
    ids.forEach(id => diskRecords.delete(id));
    diskOperation(() => updateCaptureQueue(database, (rows, store) => { ids.forEach(id => store.delete(id)); }));
  }
  function persist(item) {
    if (!item.auth.owner) { queueIssue = queueIssue || 'identity-unavailable'; notify(); return; }
    // Stored records deliberately omit auth, names and browser actor claims.
    const record = { eventId: item.event.eventId, owner: item.auth.owner, event: item.event, queuedAt: Date.now() };
    diskOperation(async () => {
      const result = await updateCaptureQueue(database, (rows, store) => {
        const meta = rows.find(row => row.eventId === '_gaps') || { eventId: '_gaps', count: 0 };
        const records = rows.filter(row => row.eventId !== '_gaps' && row.eventId !== record.eventId);
        records.push(record);
        records.sort((a, b) => a.queuedAt - b.queuedAt);
        const retained = records;
        const removed = retained.splice(0, Math.max(0, retained.length - MAX_DURABLE_QUEUE));
        removed.forEach(row => store.delete(row.eventId));
        store.put(record);
        if (removed.some(row => row.eventId === record.eventId)) store.delete(record.eventId);
        if (removed.length) store.put({ ...meta, count: meta.count + removed.length, issue: 'capacity-exceeded' });
        return { retained, removed };
      });
      diskRecords.clear(); result.retained.forEach(row => diskRecords.set(row.eventId, row));
      item.persisted = diskRecords.has(record.eventId);
      if (result.removed.length) {
        const ids = new Set(result.removed.map(row => row.eventId));
        for (let i = queue.length - 1; i >= 0; i -= 1) if (ids.has(queue[i].event.eventId)) queue.splice(i, 1);
        queueIssue = 'capacity-exceeded'; drop(result.removed.length);
      }
      notify();
    });
  }
  diskChain = openCaptureQueue().then(async db => {
    database = db;
    const rows = await updateCaptureQueue(db, records => records);
    const meta = rows.find(row => row.eventId === '_gaps');
    counts.droppedEvents += Number(meta?.count) || 0;
    if (meta?.issue) queueIssue = meta.issue;
    rows.filter(row => UUID.test(row.eventId) && row.event && row.owner).forEach(row => diskRecords.set(row.eventId, row));
    durableQueueSupported = true;
    if (!currentContext(true)?.owner) queueIssue = queueIssue || 'identity-unavailable';
    restore(); notify();
  }).catch(storageFailed);
  function enqueue(event, auth) {
    if (stopped) return;
    const item = { event, auth: { ...auth }, attempts: 0 };
    if (queue.length >= MAX_QUEUE) {
      if (durableQueueSupported && auth.owner) { persist(item); notify(); schedule(); return; }
      const displaced = queue.shift();
      if (!durableQueueSupported || !displaced.auth.owner) { queueIssue = 'capacity-exceeded'; drop(1); }
    }
    queue.push(item); persist(item);
    notify(); schedule();
  }
  function sessionFor(container, context, freshAfterSubmit = false, scope) {
    let session = sessions.get(container);
    if (!session || session.scope !== scope || session.page !== context.page || session.token !== context.token || session.key !== context.key || (freshAfterSubmit && session.submitted)) {
      session = { id: newId(), scope, page: context.page, token: context.token, key: context.key, changes: new Map(), submitted: false, validationFields: new Set(), nativeValidationObserved: false };
      sessions.set(container, session);
    }
    activeAction = { id: session.id, at: Date.now(), page: context.page, key: context.key, token: context.token };
    return session;
  }
  function eventFor(stage, context, container, session, changes = [], field) {
    return { eventId: newId(), actionId: session.id, stage, page: context.page, form: { title: formTitle(container), ...(field ? { field } : {}) }, changes, occurredAt: new Date().toISOString() };
  }
  function recordChange(input) {
    if (stopped || !input || typeof input.field !== 'string' || sameCustomValue(input.before, input.after)) return false;
    const context = currentContext();
    const field = safeLabel(input.field);
    if (!context || !field) return false;
    const element = input.element?.nodeType === 1 ? input.element : null;
    const container = element ? containerFor(element) : document.body;
    const isPrivate = input.private === true || !!element?.closest('[data-activity-private],[data-no-capture]');
    const before = customSnapshot(input.before, field, isPrivate);
    const after = customSnapshot(input.after, field, isPrivate);
    focusCustomDifference(input.before, input.after, before, after);
    const title = typeof input.form === 'string' && input.form.trim() ? safeLabel(input.form) : formTitle(container);
    const session = sessionFor(container, context, true, title);
    const change = changeFor(field, before, after);
    const earlier = session.changes.get(field);
    const combined = earlier ? { ...change, before: earlier.before, redacted: earlier.redacted || change.redacted } : change;
    if (combined.redacted) { combined.before = MASK; combined.after = MASK; }
    if (session.changes.size >= MAX_FIELDS && !session.changes.has(field)) session.changes.delete(session.changes.keys().next().value);
    session.changes.set(field, combined);
    const event = eventFor('form_edited', context, container, session, [change], field);
    event.form.title = title;
    restore(context);
    enqueue(event, context);
    return true;
  }
  function checkRenderedValidation(container, context, session) {
    window.clearTimeout(validationChecks.get(container));
    // React finishes its discrete submit/click update before this next task.
    // Read only this form's visible validation state, without retaining the
    // application's error text or any rejected values.
    const timer = window.setTimeout(() => {
      validationChecks.delete(container);
      if (stopped || !container.isConnected || !sameSession(context) || currentContext()?.page !== context.page || sessions.get(container) !== session) return;
      for (const indicator of container.querySelectorAll(VALIDATION_INDICATORS)) {
        if (!visibleValidationIndicator(indicator, container)) continue;
        const field = validationField(indicator, container);
        const label = field ? fieldLabel(field) : 'Required information';
        if (session.validationFields.has(label) || (!field && session.nativeValidationObserved)) continue;
        session.validationFields.add(label);
        enqueue(eventFor('form_validation_failed', context, container, session, [], label), context);
        if (session.validationFields.size >= MAX_FIELDS) break;
      }
    }, 0);
    validationChecks.set(container, timer);
  }
  function flushField(field) {
    const observation = pending.get(field);
    if (!observation) return;
    window.clearTimeout(observation.timer);
    pending.delete(field);
    const change = changeFor(observation.label, observation.before, observation.after);
    if (observation.session.changes.size >= MAX_FIELDS && !observation.session.changes.has(observation.label)) observation.session.changes.delete(observation.session.changes.keys().next().value);
    const earlier = observation.session.changes.get(observation.label);
    const combined = earlier ? { ...change, before: earlier.before, redacted: earlier.redacted || change.redacted } : change;
    if (combined.redacted) { combined.before = MASK; combined.after = MASK; }
    observation.session.changes.set(observation.label, combined);
    enqueue({ ...eventFor('form_edited', observation.auth, observation.container, observation.session, [change], observation.label), occurredAt: observation.occurredAt }, observation.auth);
  }
  const focusIn = event => {
    const field = editable(event.target);
    const context = currentContext();
    if (!field || !context) return;
    if (!pending.has(field)) fields.set(field, { ...snapshot(field), token: context.token, page: context.page });
  };
  const edit = event => {
    const field = editable(event.target);
    const context = currentContext();
    if (!field || !context) return;
    const previous = fields.get(field);
    const before = previous && previous.token === context.token && previous.page === context.page ? previous : snapshot(field, true);
    const after = snapshot(field);
    const container = containerFor(field);
    const session = sessionFor(container, context, true);
    fields.set(field, { ...after, token: context.token, page: context.page });
    restore(context);
    if (before.value === after.value && !after.redacted && !before.redacted) {
      if (event.type === 'change') flushField(field);
      return;
    }
    let observation = pending.get(field);
    if (observation && (observation.auth.token !== context.token || observation.auth.page !== context.page)) { flushField(field); observation = null; }
    if (!observation) {
      if (pending.size >= MAX_QUEUE) flushField(pending.keys().next().value);
      observation = { before, after, container, session, label: fieldLabel(field), auth: { ...context } };
    }
    window.clearTimeout(observation.timer);
    observation.after = after;
    observation.occurredAt = new Date().toISOString();
    pending.set(field, observation);
    if (event.type === 'change') flushField(field);
    else observation.timer = window.setTimeout(() => flushField(field), EDIT_DELAY);
    notify();
  };
  const blur = event => { const field = editable(event.target); if (field) flushField(field); };
  const submit = event => {
    const container = event.target?.closest?.('form,[role="form"]');
    const context = currentContext();
    if (!container || !context) return;
    const session = sessionFor(container, context);
    for (const [field, observation] of pending) if (observation.container === container) flushField(field);
    enqueue(eventFor('form_submitted', context, container, session, Array.from(session.changes.values())), context);
    session.submitted = true;
    checkRenderedValidation(container, context, session);
  };
  const invalid = event => {
    const field = editable(event.target);
    const context = currentContext();
    if (!field || !context) return;
    flushField(field);
    const container = containerFor(field);
    const session = sessionFor(container, context);
    const label = fieldLabel(field);
    session.nativeValidationObserved = true;
    if (!session.validationFields.has(label)) {
      session.validationFields.add(label);
      enqueue(eventFor('form_validation_failed', context, container, session, [], label), context);
    }
  };
  const gesture = event => {
    const element = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const field = editable(element);
    const target = field || element?.closest('button,a,[role="button"],input[type="submit"],input[type="button"]');
    const context = currentContext();
    if (!target || !context || (event.type === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(event.key))) return;
    restore(context);
    const session = sessionFor(containerFor(target), context, true);
    if (!field && event.type === 'click') {
      session.submitted = true;
      const form = target.form || target.closest('form,[role="form"]');
      if (form && target.matches('button,input[type="submit"],input[type="button"],[role="button"]')) checkRenderedValidation(form, context, session);
    }
  };
  function rotateSession(response, auth) {
    const rotated = response.headers?.get?.('x-customer-service-session');
    if (auth.key !== 'token' || !auth.token.startsWith('cs-sb.') || typeof rotated !== 'string' || !rotated.startsWith('cs-sb.') || !sameSession(auth)) return;
    try { window.localStorage.setItem('token', rotated); } catch { return; }
    for (const item of queue) if (item.auth.key === auth.key && item.auth.token === auth.token) item.auth.token = rotated;
    for (const observation of pending.values()) if (observation.auth.key === auth.key && observation.auth.token === auth.token) observation.auth.token = rotated;
    for (const batch of activeBatches) for (const item of batch) if (item.auth.key === auth.key && item.auth.token === auth.token) item.auth.token = rotated;
  }
  async function send(keepalive = false) {
    if (stopped || (!keepalive && activeBatches.size)) return;
    if (sendTimer !== null) { window.clearTimeout(sendTimer); sendTimer = null; }
    const stale = queue.filter(item => !sameSession(item.auth));
    for (const item of stale) queue.splice(queue.indexOf(item), 1);
    drop(stale.filter(item => !item.persisted).length);
    restore();
    if (!queue.length) return;
    const auth = queue[0].auth;
    const batch = [];
    for (const item of queue) {
      if (batch.length >= MAX_BATCH || item.auth.url !== auth.url || item.auth.token !== auth.token) break;
      const body = JSON.stringify({ events: [...batch, item].map(entry => entry.event) });
      if (new Blob([body]).size > MAX_BATCH_BYTES) break;
      batch.push(item);
    }
    if (!batch.length) { queue.shift(); drop(1); schedule(); return; }
    queue.splice(0, batch.length);
    activeBatches.add(batch); notify();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timeout;
    let cancel;
    let accepted = new Set();
    try {
      const request = (async () => {
        const response = await window.fetch(auth.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` }, body: JSON.stringify({ events: batch.map(item => item.event) }), ...(controller ? { signal: controller.signal } : {}), ...(keepalive ? { keepalive: true } : {}), credentials: 'same-origin' });
        const result = await response.json();
        return { response, result };
      })();
      const { response, result } = await Promise.race([request, new Promise((resolve, reject) => {
        timeout = window.setTimeout(() => { controller?.abort(); reject(new Error('Activity delivery timed out')); }, 10000);
        cancel = () => { controller?.abort(); reject(new Error('Activity capture stopped')); };
        cancelRequests.add(cancel);
      })]);
      const reported = Array.isArray(result?.accepted) ? result.accepted : response.ok && result?.success === true ? batch.map(item => item.event.eventId) : [];
      accepted = new Set(reported.filter(id => batch.some(item => item.event.eventId === id)));
      if (stopped) return;
      forgetAccepted(accepted);
      rotateSession(response, auth);
      if (accepted.size) counts.lastSuccessAt = new Date().toISOString();
      if (!response.ok || result?.success !== true || accepted.size !== batch.length) throw new Error('Activity delivery was incomplete');
    } catch {
      if (stopped) return;
      counts.failedBatches += 1;
      counts.lastFailureAt = new Date().toISOString();
      const retry = batch.filter(item => !accepted.has(item.event.eventId));
      let dropped = 0;
      for (const item of retry) {
        item.attempts += 1;
        if (sameSession(item.auth)) queue.push(item);
        else if (!item.persisted) dropped += 1;
      }
      if (queue.length > MAX_QUEUE) { dropped += queue.length - MAX_QUEUE; queue.splice(0, queue.length - MAX_QUEUE); }
      counts.droppedEvents += dropped;
      warn();
    } finally {
      window.clearTimeout(timeout);
      activeBatches.delete(batch);
      restore();
      notify();
      cancelRequests.delete(cancel);
      const attempts = Math.max(0, ...queue.map(item => item.attempts));
      schedule(attempts ? Math.min(30000, 1500 * (2 ** (attempts - 1))) : SEND_DELAY);
    }
  }
  const pagehide = () => {
    unloading = true;
    for (const field of Array.from(pending.keys())) flushField(field);
    void send(true);
  };
  const resume = () => {
    unloading = false;
    if (sendTimer !== null) { window.clearTimeout(sendTimer); sendTimer = null; }
    restore(); schedule(0);
  };
  const listeners = { focusin: focusIn, input: edit, change: edit, blur, submit, invalid, pointerdown: gesture, click: gesture, keydown: gesture };
  Object.entries(listeners).forEach(([name, handler]) => document.addEventListener(name, handler, true));
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', resume);
  window.addEventListener('online', resume);
  window.addEventListener('storage', resume);
  runtime = { status, action: () => activeAction, recordChange };
  notify();
  return () => {
    if (stopped) return;
    stopped = true;
    Object.entries(listeners).forEach(([name, handler]) => document.removeEventListener(name, handler, true));
    window.removeEventListener('pagehide', pagehide);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('online', resume);
    window.removeEventListener('storage', resume);
    window.clearTimeout(sendTimer);
    for (const observation of pending.values()) window.clearTimeout(observation.timer);
    for (const timer of validationChecks.values()) window.clearTimeout(timer);
    validationChecks.clear();
    for (const cancel of cancelRequests) cancel();
    pending.clear(); queue.length = 0; activeAction = null;
    previousStatus = status(); runtime = null;
    void diskChain.then(() => database?.close());
  };
}

// This header is a correlation label only. It never identifies or authorizes a
// person. Keep it on a retried operation, but leave polling and capture alone.
export function attachActivityContext(client) {
  client.interceptors.request.use(config => {
    const method = String(config.method || 'get').toLowerCase();
    if (!['post', 'put', 'patch', 'delete'].includes(method) || typeof window === 'undefined') return config;
    const rawUrl = String(config.url || '');
    if (/(^|\/)traceability\/capture(?:\/|$|\?)/i.test(rawUrl) || !sameAppOrigin(config.baseURL || '/') || !sameAppOrigin(rawUrl)) return config;
    const context = currentContext();
    if (!context) return config;
    const action = runtime?.action();
    const existing = config.__matterActivityId;
    const recent = action && Date.now() - action.at < ACTION_LIFETIME && action.page === context.page && action.key === context.key && action.token === context.token;
    const id = UUID.test(existing || '') ? existing : recent ? action.id : null;
    if (id) {
      config.__matterActivityId = id;
      if (!config.headers) config.headers = {};
      if (typeof config.headers.set === 'function') config.headers.set('X-Matter-Activity-ID', id);
      else config.headers['X-Matter-Activity-ID'] = id;
    }
    return config;
  });
}
