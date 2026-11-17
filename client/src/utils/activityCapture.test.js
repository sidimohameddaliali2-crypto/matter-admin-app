import { attachActivityContext, installActivityCapture, readCaptureStatus, recordActivityChange } from './activityCapture';
let cleanup;
let fetchMock;
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const sent = () => fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events);
const focus = field => field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
function edit(field, value, kind = 'input') {
  if (field.matches('[contenteditable]')) field.textContent = value;
  else field.value = value;
  field.dispatchEvent(new Event(kind, { bubbles: true }));
}
async function deliver() { jest.advanceTimersByTime(2000); await settle(); }
function interceptor() {
  let handler;
  attachActivityContext({ interceptors: { request: { use(fn) { handler = fn; } } } });
  return handler;
}
beforeEach(() => {
  jest.useFakeTimers(); jest.spyOn(console, 'warn').mockImplementation(() => {}); Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }); localStorage.clear(); localStorage.setItem('token', 'staff-session');
  window.history.replaceState({}, '', '/customers');
  document.body.innerHTML = '<h1>Customer records</h1><form aria-label="Delivery details"><label for="delivery-address">Delivery address</label><input id="delivery-address" name="address" value="Building A"><button type="submit">Save</button></form>';
  fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) });
  window.fetch = fetchMock; cleanup = installActivityCapture();
});
afterEach(() => { cleanup(); jest.clearAllTimers(); jest.useRealTimers(); document.body.innerHTML = ''; localStorage.clear(); jest.restoreAllMocks(); });
test('captures debounced drafts with readable labels and before/after values', async () => {
  const field = document.querySelector('input'); focus(field); edit(field, 'Building B'); edit(field, 'Building C');
  expect(fetchMock).not.toHaveBeenCalled(); await deliver();
  expect(sent()).toEqual([expect.objectContaining({ stage: 'form_edited', page: '/customers', form: { title: 'Delivery details', field: 'Delivery address' }, changes: [{ field: 'Delivery address', before: 'Building A', after: 'Building C', redacted: false }] })]);
  expect(sent()[0]).not.toHaveProperty('actor'); expect(sent()[0].eventId).toMatch(/^[a-f0-9-]{36}$/);
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer staff-session');
  expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('keepalive');
});
test('records each custom selection before submission and correlates its business request', async () => {
  const request = interceptor();
  recordActivityChange({ field: 'Assigned driver', before: 'Not assigned', after: 'Fixture driver', form: 'Assign deliveries' });
  const write = request({ method: 'post', url: '/deliveries/assign', headers: {} });
  recordActivityChange({ field: 'Assigned driver', before: 'Fixture driver', after: 'Not assigned', form: 'Assign deliveries' });
  await deliver();
  expect(sent().map(event => ({ stage: event.stage, form: event.form, changes: event.changes }))).toEqual([
    { stage: 'form_edited', form: { title: 'Assign deliveries', field: 'Assigned driver' }, changes: [{ field: 'Assigned driver', before: 'Not assigned', after: 'Fixture driver', redacted: false }] },
    { stage: 'form_edited', form: { title: 'Assign deliveries', field: 'Assigned driver' }, changes: [{ field: 'Assigned driver', before: 'Fixture driver', after: 'Not assigned', redacted: false }] },
  ]);
  expect(write.headers['X-Matter-Activity-ID']).toBe(sent()[0].actionId);
  expect(sent().every(event => !event.actor && !event.outcome)).toBe(true);
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer staff-session');
});
test('custom control events redact private values before the durable queue and survive reload', async () => {
  const storage = await useDurableQueue();
  fetchMock.mockRejectedValue(new Error('offline'));
  recordActivityChange({ field: 'Selected dates', before: ['2026-11-17'], after: ['2026-11-17', '2026-11-18'], form: 'Delivery change' });
  recordActivityChange({ field: 'Private notes', before: 'Prior private note', after: 'New private note', form: 'Customer Service' });
  const element = document.createElement('div'); element.setAttribute('data-activity-private', ''); document.body.appendChild(element);
  recordActivityChange({ field: 'A protected choice', before: 'Private option A', after: 'Private option B', element });
  for (let i = 0; i < 10; i += 1) await settle();
  const stored = JSON.stringify(Array.from(storage.tables.get('queue').values()));
  expect(stored).toContain('2026-11-17, 2026-11-18');
  for (const secret of ['Prior private note', 'New private note', 'Private option A', 'Private option B', 'staff-session']) expect(stored).not.toContain(secret);
  expect(stored).toContain('[Not recorded]');
  cleanup(); fetchMock.mockReset().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) });
  cleanup = installActivityCapture(); for (let i = 0; i < 5; i += 1) await settle(); await deliver();
  expect(sent()).toHaveLength(3);
  expect(sent()[0].changes[0]).toEqual({ field: 'Selected dates', before: '2026-11-17', after: '2026-11-17, 2026-11-18', redacted: false });
  expect(sent()[1].changes[0].redacted).toBe(true);
});
test('unchanged custom selections and initial render do not claim a user edit', async () => {
  recordActivityChange({ field: 'Driver', before: 'Fixture driver', after: 'Fixture driver' });
  recordActivityChange({ field: 'Days', before: ['Monday', 'Tuesday'], after: ['Monday', 'Tuesday'] });
  await deliver(); expect(sent()).toHaveLength(0);
});
test.each(['/traceability', '/login', '/menu-select/private-token'])('custom controls respect excluded credential and history pages at %s', async path => {
  window.history.replaceState({}, '', path);
  recordActivityChange({ field: 'Choice', before: 'Old', after: 'New' });
  await deliver(); expect(fetchMock).not.toHaveBeenCalled();
});
test('custom events use the matching portal session and stop after capture cleanup', async () => {
  window.history.replaceState({}, '', '/partner/portal'); localStorage.setItem('partnerToken', 'partner-session');
  recordActivityChange({ field: 'Order quantity', before: 1, after: 2, form: 'Daily order' }); await deliver();
  expect(fetchMock.mock.calls[0][0]).toContain('/api/traceability/capture/partner');
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer partner-session');
  expect(sent()[0].changes[0].after).toBe('2');
  cleanup(); recordActivityChange({ field: 'Order quantity', before: 2, after: 3 }); await deliver();
  expect(sent()).toHaveLength(1);
});
test('custom selection logs cannot expose credentials through unlabelled values or nested objects', async () => {
  recordActivityChange({ field: 'Choice', before: 'Old', after: 'Bearer private-credential', form: 'Options' });
  recordActivityChange({ field: 'Selection', before: null, after: { password: 'hidden-nested-password' }, form: 'Options' });
  await deliver(); expect(sent()).toHaveLength(2);
  expect(sent().every(event => event.changes[0].redacted)).toBe(true);
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('private-credential');
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('hidden-nested-password');
});
test('a custom search label identifies query typing separately from the selected issue', async () => {
  const field = document.querySelector('input'); field.setAttribute('data-activity-label', 'Issue search');
  focus(field); edit(field, 'delivery', 'change'); await deliver();
  expect(sent()[0].form.field).toBe('Issue search');
  expect(sent()[0].changes[0].field).toBe('Issue search');
});
test('custom list changes after a long unchanged prefix are retained with the changed portion', async () => {
  const stops = Array.from({ length: 40 }, (_, index) => `Fixture stop ${index + 1}`);
  recordActivityChange({ field: 'Stop order', before: stops, after: [...stops.slice(0, 39), 'Replacement last stop'], form: 'Arrange stops' });
  await deliver(); expect(sent()).toHaveLength(1);
  expect(sent()[0].changes[0].before).toContain('Fixture stop 40');
  expect(sent()[0].changes[0].after).toContain('Replacement last stop');
});
test('a long changed list item retains its changed suffix, not only its unchanged name', async () => {
  const name = 'A long ingredient name '.repeat(24);
  recordActivityChange({ field: 'Ingredients', before: [`${name} (shown to customer)`], after: [`${name} (backend only)`] });
  await deliver(); expect(sent()).toHaveLength(1);
  expect(sent()[0].changes[0].before).toContain('(shown to customer)');
  expect(sent()[0].changes[0].after).toContain('(backend only)');
  expect(sent()[0].changes[0].before).not.toBe(sent()[0].changes[0].after);
});
test('comma-containing custom choices do not collapse distinct selections', async () => {
  recordActivityChange({ field: 'Options', before: ['A', 'B'], after: ['A, B'] });
  await deliver(); expect(sent()).toHaveLength(1);
  expect(sent()[0].changes[0].before).not.toBe(sent()[0].changes[0].after);
});
test('unlinked visible labels identify native controls and protect private fields', async () => {
  document.body.innerHTML = '<h1>Options</h1><form><div><label>Status</label><select><option value="pending">Pending</option><option value="ready">Ready</option></select></div><div><label>Allergies</label><textarea></textarea></div></form>';
  const status = document.querySelector('select'); focus(status); edit(status, 'ready', 'change');
  const allergies = document.querySelector('textarea'); focus(allergies); edit(allergies, 'Private medical information', 'change');
  await deliver();
  expect(sent()[0].changes[0]).toEqual({ field: 'Status', before: 'Pending', after: 'Ready', redacted: false });
  expect(sent()[1].changes[0]).toEqual({ field: 'Allergies', before: '[Not recorded]', after: '[Not recorded]', redacted: true });
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Private medical information');
});
test('blur flushes the last edit and submit records an attempt with the same action', async () => {
  const field = document.querySelector('input'); focus(field); edit(field, 'Building B'); field.dispatchEvent(new FocusEvent('blur'));
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await deliver();
  const [draft, submitted] = sent(); expect(draft.stage).toBe('form_edited'); expect(submitted.stage).toBe('form_submitted');
  expect(submitted.actionId).toBe(draft.actionId); expect(submitted.changes).toEqual(draft.changes);
  expect(JSON.stringify(sent())).not.toMatch(/saved|completed/i);
});
test('observes native validation failures which do not bubble', async () => {
  const field = document.querySelector('input'); field.value = ''; field.dispatchEvent(new Event('invalid')); await deliver();
  expect(sent()).toEqual([expect.objectContaining({ stage: 'form_validation_failed', form: { title: 'Delivery details', field: 'Delivery address' } })]);
});
test('redacts credentials, identity, banking, medical fields and obvious secret values', async () => {
  document.body.innerHTML = '<h1>Settings</h1><form><label>Password<input type="password"></label><label>Emirates ID<input name="emiratesId"></label><label>IBAN<input name="iban"></label><label>Allergies<textarea></textarea></label><label>Notes<textarea></textarea></label><label>Credential<input name="api_key"></label></form>';
  const secrets = ['Private-password-123', '784-1980-1234567-1', 'AE070331234567890123456', 'Peanut allergy details', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature', 'private-key-123'];
  document.querySelectorAll('input,textarea').forEach((field, i) => { focus(field); edit(field, secrets[i], 'change'); }); await deliver();
  expect(sent()).toHaveLength(6); sent().forEach(event => expect(event.changes[0]).toMatchObject({ redacted: true, after: '[Not recorded]' }));
  secrets.forEach(secret => expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(secret));
});
test('captures selections, checkboxes, file counts and contenteditable text without file names', async () => {
  document.body.innerHTML = '<h1>Delivery planning</h1><form><label>Route<select><option value="a">Route A</option><option value="b">Route B</option></select></label><label>Call first<input type="checkbox"></label><label>Photos<input type="file" multiple></label><div role="textbox" contenteditable="true" aria-label="Delivery notes">Old note</div></form>';
  const select = document.querySelector('select'); focus(select); edit(select, 'b', 'change');
  const box = document.querySelector('[type=checkbox]'); focus(box); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
  const file = document.querySelector('[type=file]'); Object.defineProperty(file, 'files', { value: [new File(['a'], 'customer-passport.png'), new File(['b'], 'photo.jpg')] }); file.dispatchEvent(new Event('change', { bubbles: true }));
  const note = document.querySelector('[contenteditable]'); focus(note); edit(note, 'New note', 'change'); await deliver();
  expect(sent().map(event => event.changes[0].after)).toEqual(['Route B', 'Selected', '2 files', '[Not recorded]']);
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('customer-passport.png');
});
test.each([['/partner/portal', 'partnerToken', 'partner-session', '/api/traceability/capture/partner'], ['/member/portal', 'memberToken', 'member-session', '/api/traceability/capture/member']])('uses the matching portal authentication at %s', async (path, key, token, endpoint) => {
  window.history.replaceState({}, '', path); localStorage.setItem(key, token); edit(document.querySelector('input'), 'Changed', 'change'); await deliver();
  expect(fetchMock.mock.calls[0][0]).toContain(endpoint); expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
});
test('never uses a staff session for a signed-out partner', async () => {
  window.history.replaceState({}, '', '/partner/portal'); edit(document.querySelector('input'), 'Changed', 'change'); await deliver(); expect(fetchMock).not.toHaveBeenCalled();
});
test('pagehide flushes pending input with keepalive without persisting form contents', async () => {
  const storage = jest.spyOn(Storage.prototype, 'setItem'); edit(document.querySelector('input'), 'Unsent delivery note'); window.dispatchEvent(new Event('pagehide')); await settle();
  expect(sent()[0].changes[0].after).toBe('Unsent delivery note'); expect(fetchMock.mock.calls[0][1].keepalive).toBe(true); expect(storage).not.toHaveBeenCalled(); storage.mockRestore();
});
test.each(['/traceability', '/traceability/details', '/login', '/partner/login', '/menu-select/private-token', '/join/private-token'])('excludes diagnostic and public credential pages at %s', async path => {
  window.history.replaceState({}, '', path); edit(document.querySelector('input'), 'Private text', 'change'); document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true })); await deliver(); expect(fetchMock).not.toHaveBeenCalled();
});
test('drops queued edits after a session switch', async () => {
  edit(document.querySelector('input'), 'Account A draft', 'change'); localStorage.setItem('token', 'another-staff-session'); await deliver();
  expect(fetchMock).not.toHaveBeenCalled(); expect(readCaptureStatus().droppedEvents).toBe(1);
});
test('reports failed delivery and retries using the same event identity', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline')); edit(document.querySelector('input'), 'Changed', 'change'); await deliver();
  expect(readCaptureStatus()).toMatchObject({ failedBatches: 1, pendingEvents: 1 }); const id = sent()[0].eventId;
  await deliver(); expect(sent()[1].eventId).toBe(id); expect(readCaptureStatus()).toMatchObject({ pendingEvents: 0, failedBatches: 1 }); expect(readCaptureStatus().lastSuccessAt).toEqual(expect.any(String));
});
test('cleanup removes listeners and installing twice does not duplicate capture', async () => {
  const secondCleanup = installActivityCapture(); edit(document.querySelector('input'), 'Changed', 'change'); await deliver(); expect(sent()).toHaveLength(1);
  secondCleanup(); cleanup(); edit(document.querySelector('input'), 'After cleanup', 'change'); await deliver(); expect(sent()).toHaveLength(1);
});
test('correlates only recent app writes and retains a retry context after expiry', () => {
  const request = interceptor(); edit(document.querySelector('input'), 'Changed'); const config = request({ method: 'post', url: '/customers', headers: {} }); const id = config.headers['X-Matter-Activity-ID']; expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(request({ method: 'get', url: '/customers', headers: {} }).headers['X-Matter-Activity-ID']).toBeUndefined();
  expect(request({ method: 'post', url: '/traceability/capture', headers: {} }).headers['X-Matter-Activity-ID']).toBeUndefined();
  expect(request({ method: 'post', url: 'https://other-service.example/orders', headers: {} }).headers['X-Matter-Activity-ID']).toBeUndefined();
  jest.advanceTimersByTime(11000); expect(request({ method: 'patch', url: '/customers', headers: {} }).headers['X-Matter-Activity-ID']).toBeUndefined(); expect(request(config).headers['X-Matter-Activity-ID']).toBe(id);
});
test('button and keyboard gestures also provide write correlation', () => {
  const request = interceptor(); document.querySelector('button').type = 'button'; document.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true })); expect(request({ method: 'delete', url: '/customers/fixture', headers: {} }).headers['X-Matter-Activity-ID']).toMatch(/^[a-f0-9-]{36}$/);
  document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); expect(request({ method: 'put', url: '/customers/fixture', headers: {} }).headers['X-Matter-Activity-ID']).toMatch(/^[a-f0-9-]{36}$/);
});

// Implements only native asynchronous storage boundaries; events still flow
// through the real capture listeners, serializer, queue, reload and replay.
function indexedDbFixture() {
  const tables = new Map();
  const keys = new Map();
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const db = {
    objectStoreNames: { contains: name => tables.has(name) },
    createObjectStore(name, { keyPath }) { tables.set(name, new Map()); keys.set(name, keyPath); },
    close() {},
    transaction(names) {
      const tx = { pending: 0 };
      tx.objectStore = name => {
        const request = operation => {
          const result = {}; tx.pending += 1;
          Promise.resolve().then(() => {
            result.result = operation(); result.onsuccess?.({ target: result }); tx.pending -= 1;
            Promise.resolve().then(() => { if (!tx.pending) tx.oncomplete?.(); });
          });
          return result;
        };
        return {
          getAll: () => request(() => Array.from(tables.get(name).values()).map(copy)),
          get: key => request(() => copy(tables.get(name).get(key))),
          put: item => request(() => { tables.get(name).set(item[keys.get(name)], copy(item)); return item[keys.get(name)]; }),
          delete: key => request(() => tables.get(name).delete(key)),
        };
      };
      return tx;
    },
  };
  return { tables, open() { const request = {}; Promise.resolve().then(() => { request.result = db; request.onupgradeneeded?.({ target: request }); request.onsuccess?.({ target: request }); }); return request; } };
}
async function useDurableQueue() {
  cleanup(); const fixture = indexedDbFixture();
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: fixture });
  localStorage.setItem('user', JSON.stringify({ _id: 'staff-account-a', name: 'Not an actor claim' }));
  cleanup = installActivityCapture();
  for (let i = 0; i < 5; i += 1) await settle();
  return fixture;
}
test('safe drafts survive reload and replay without persisting tokens or actor claims', async () => {
  const storage = await useDurableQueue();
  fetchMock.mockRejectedValue(new Error('offline'));
  edit(document.querySelector('input'), 'Building B', 'change');
  for (let i = 0; i < 5; i += 1) await settle();
  await deliver(); const originalId = sent()[0].eventId;
  expect(readCaptureStatus().durableQueueSupported).toBe(true);
  const disk = JSON.stringify(Array.from(storage.tables.values(), table => Array.from(table.values())));
  expect(disk).toContain('Building B'); expect(disk).not.toContain('staff-session'); expect(disk).not.toContain('Not an actor claim');
  cleanup(); fetchMock.mockReset().mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) });
  cleanup = installActivityCapture(); for (let i = 0; i < 5; i += 1) await settle(); await deliver();
  expect(sent()[0].eventId).toBe(originalId);
  for (let i = 0; i < 5; i += 1) await settle();
  expect(JSON.stringify(Array.from(storage.tables.values(), table => Array.from(table.values())))).not.toContain('Building B');
});
test('durable drafts wait for the same account to sign in again', async () => {
  await useDurableQueue(); fetchMock.mockRejectedValue(new Error('offline')); edit(document.querySelector('input'), 'Account A safe draft', 'change');
  for (let i = 0; i < 5; i += 1) await settle(); await deliver(); cleanup();
  localStorage.setItem('token', 'staff-session-b'); localStorage.setItem('user', JSON.stringify({ _id: 'staff-account-b' })); fetchMock.mockClear();
  cleanup = installActivityCapture(); for (let i = 0; i < 5; i += 1) await settle(); await deliver(); expect(fetchMock).not.toHaveBeenCalled();
  cleanup(); localStorage.setItem('token', 'staff-session-a-new'); localStorage.setItem('user', JSON.stringify({ _id: 'staff-account-a' }));
  fetchMock.mockResolvedValue({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({ success: true }) });
  cleanup = installActivityCapture(); for (let i = 0; i < 5; i += 1) await settle(); await deliver();
  expect(sent()[0].changes[0].after).toBe('Account A safe draft'); expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer staff-session-a-new');
});
test('an unavailable durable store is explicit instead of promising reload recovery', () => {
  expect(readCaptureStatus()).toMatchObject({ durableQueueSupported: false, queueIssue: 'storage-unavailable' });
});
test('partial acknowledgments retry only events that were not accepted', async () => {
  fetchMock.mockImplementationOnce(async (url, options) => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({ success: false, accepted: [JSON.parse(options.body).events[0].eventId] }) }));
  edit(document.querySelector('input'), 'First', 'change'); edit(document.querySelector('input'), 'Second', 'change'); await deliver();
  const ids = sent().map(event => event.eventId); expect(readCaptureStatus().pendingEvents).toBe(1); await deliver(); expect(sent().map(event => event.eventId)).toEqual([...ids, ids[1]]);
});
test('a stalled request aborts and the same pending event can recover', async () => {
  fetchMock.mockImplementationOnce(() => new Promise(() => {})); edit(document.querySelector('input'), 'Waiting draft', 'change'); await deliver();
  const signal = fetchMock.mock.calls[0][1].signal; jest.advanceTimersByTime(11000); await settle(); expect(signal.aborted).toBe(true);
  expect(readCaptureStatus()).toMatchObject({ failedBatches: 1, pendingEvents: 1 }); await deliver(); expect(readCaptureStatus().pendingEvents).toBe(0);
});
test('separate button operations receive separate action identities', () => {
  const request = interceptor(); const button = document.querySelector('button'); button.type = 'button';
  button.dispatchEvent(new MouseEvent('click', { bubbles: true })); const first = request({ method: 'delete', url: '/customers/a', headers: {} });
  button.dispatchEvent(new MouseEvent('click', { bubbles: true })); const second = request({ method: 'delete', url: '/customers/b', headers: {} });
  expect(second.headers['X-Matter-Activity-ID']).not.toBe(first.headers['X-Matter-Activity-ID']);
});
test('the durable store keeps drafts beyond the memory buffer and drains every batch', async () => {
  const storage = await useDurableQueue();
  for (let i = 0; i < 105; i += 1) edit(document.querySelector('input'), `Draft ${i}`, 'change');
  for (let i = 0; i < 100; i += 1) await settle();
  expect(Array.from(storage.tables.get('queue').values()).filter(row => row.event)).toHaveLength(105);
  expect(readCaptureStatus().droppedEvents).toBe(0);
  for (let i = 0; i < 8; i += 1) { await deliver(); for (let j = 0; j < 5; j += 1) await settle(); }
  expect(new Set(sent().map(event => event.eventId)).size).toBe(105);
  expect(readCaptureStatus().pendingEvents).toBe(0);
});
test('the durable cap reports a persistent gap without expiring old activity', async () => {
  const storage = await useDurableQueue();
  const table = storage.tables.get('queue');
  for (let i = 0; i < 4999; i += 1) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    table.set(id, { eventId: id, owner: 'staff:another-account', queuedAt: 1, event: { eventId: id, stage: 'form_edited', changes: [] } });
  }
  edit(document.querySelector('input'), 'At capacity', 'change'); edit(document.querySelector('input'), 'Beyond capacity', 'change');
  for (let i = 0; i < 20; i += 1) await settle();
  expect(Array.from(table.values()).filter(row => row.event)).toHaveLength(5000);
  expect(readCaptureStatus()).toMatchObject({ queueIssue: 'capacity-exceeded', droppedEvents: 1 });
  cleanup(); cleanup = installActivityCapture(); for (let i = 0; i < 5; i += 1) await settle();
  expect(readCaptureStatus()).toMatchObject({ queueIssue: 'capacity-exceeded', droppedEvents: 1 });
  expect(Array.from(table.values()).filter(row => row.queuedAt === 1)).toHaveLength(4998);
});
test('credentials, contact details and private free text are redacted before any durable write', async () => {
  const storage = await useDurableQueue();
  document.body.innerHTML = '<h1>Driver</h1><form><label>Password<input type="password"></label><label>Phone<input type="tel"></label><label>Email<input type="email"></label><label>Private notes<textarea></textarea></label><label>Message<textarea></textarea></label><label>Full name<input name="fullName"></label></form>';
  const privateValues = ['Private-password-only', '+971501234567', 'private@example.invalid', 'Customer has severe diabetes', 'A private customer message'];
  document.querySelectorAll('input,textarea').forEach((field, index) => edit(field, privateValues[index] || 'Visible driver', 'change'));
  for (let i = 0; i < 10; i += 1) await settle();
  const rows = JSON.stringify(Array.from(storage.tables.get('queue').values()));
  expect(rows).toContain('[Not recorded]'); privateValues.forEach(value => expect(rows).not.toContain(value)); expect(rows).not.toContain('staff-session');
  expect(rows).toContain('Visible driver');
});
test('records custom validation rendered after submit without a business request or raw error text', async () => {
  const form = document.querySelector('form'); const field = document.querySelector('input'); field.value = '';
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!field.value.trim()) {
      const error = document.createElement('p'); error.className = 'text-red-600'; error.textContent = 'Private-specific rejection detail'; form.appendChild(error); return;
    }
    window.fetch('/api/drivers', { method: 'POST' });
  });
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await deliver();
  expect(sent().map(event => event.stage)).toEqual(['form_submitted', 'form_validation_failed']);
  expect(sent()[1].form.field).toBe('Required information'); expect(sent()[1].actionId).toBe(sent()[0].actionId);
  expect(sent()[1].changes).toEqual([]); expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('Private-specific rejection detail');
  expect(fetchMock.mock.calls.every(([url]) => url.includes('/traceability/capture'))).toBe(true);
});
test('associates custom error indicators with a real field without copying helper text', async () => {
  document.body.innerHTML = '<h1>Driver records</h1><form><div><label for="driver-name">Full name</label><input id="driver-name" name="fullName"></div></form>';
  const form = document.querySelector('form'); form.addEventListener('submit', event => {
    event.preventDefault(); const error = document.createElement('p'); error.className = 'text-red-500'; error.textContent = 'Do not copy this error'; document.querySelector('input').parentElement.appendChild(error);
  });
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await deliver();
  expect(sent().filter(event => event.stage === 'form_validation_failed')).toEqual([expect.objectContaining({ form: { title: 'Driver records', field: 'Full name' }, changes: [] })]);
  expect(JSON.stringify(sent())).not.toContain('Do not copy this error');
});
test('custom type-button validation is limited to its associated form', async () => {
  const button = document.querySelector('button'); button.type = 'button';
  button.addEventListener('click', () => {
    const error = document.createElement('p'); error.className = 'text-red-700'; error.textContent = 'Missing details'; document.querySelector('form').appendChild(error);
  });
  button.dispatchEvent(new MouseEvent('click', { bubbles: true })); await deliver();
  expect(sent().filter(event => event.stage === 'form_validation_failed')).toHaveLength(1);
  const outside = document.createElement('button'); outside.type = 'button'; document.body.appendChild(outside);
  outside.dispatchEvent(new MouseEvent('click', { bubbles: true })); await deliver();
  expect(sent().filter(event => event.stage === 'form_validation_failed')).toHaveLength(1);
});
test('custom checks ignore hidden errors, other forms and red action buttons', async () => {
  const form = document.querySelector('form');
  form.insertAdjacentHTML('beforeend', '<p hidden class="text-red-600">Hidden validation detail</p><p style="display:none" class="text-red-500">Also hidden</p><button type="button" class="text-red-600">Remove item</button><span class="text-red-600">*</span>');
  document.body.insertAdjacentHTML('beforeend', '<form><p class="text-red-600">Another form</p></form>');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await deliver();
  expect(sent().map(event => event.stage)).toEqual(['form_submitted']);
});
test('custom inspection does not duplicate an already observed native invalid event', async () => {
  const form = document.querySelector('form'); const field = document.querySelector('input');
  field.setAttribute('aria-invalid', 'true'); field.dispatchEvent(new Event('invalid'));
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await deliver();
  expect(sent().filter(event => event.stage === 'form_validation_failed')).toHaveLength(1);
});
