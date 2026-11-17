import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeActivity } from './activityLanguage.js';

const describe = (input) => describeActivity({ actorName: 'Osman', statusCode: 200, ...input });

test('an accepted driver form does not claim the driver was saved', () => {
  const activity = describe({ method: 'POST', path: '/api/drivers/' });
  assert.equal(activity.area, 'Drivers');
  assert.equal(activity.action, 'Add a driver');
  assert.equal(activity.summary, 'Osman submitted a new driver.');
  assert.equal(activity.operationKind, 'change');
  assert.equal(activity.issue, null);
  assert.equal(
    describe({ method: 'POST', path: '/api/drivers', outcome: 'completed' }).summary,
    'Osman submitted a new driver.',
  );
  assert.equal(
    describe({ method: 'POST', path: '/api/users/drivers', outcome: 'saved' }).summary,
    'Osman added a driver.',
  );
});

test('rejections and failures override saved claims and explain the issue in a sentence', () => {
  for (const [statusCode, outcome, issue] of [
    [403, 'saved', 'Permission was denied, so the request was rejected.'],
    [409, 'saved', 'The request conflicted with the current record. Refresh before retrying.'],
    [500, 'saved', 'The server could not complete the request. The result has not been confirmed.'],
    [200, 'failed', 'The operation reported a failure. The result has not been confirmed.'],
    [200, 'partial', 'Only part of the operation completed. Review the result before retrying.'],
    [
      200,
      'degraded',
      'The result is incomplete or using a fallback. Review it before relying on it.',
    ],
    [0, 'disconnected', 'The connection ended before the result was confirmed.'],
  ]) {
    const activity = describe({ method: 'POST', path: '/api/drivers', statusCode, outcome });
    assert.equal(activity.issue, issue);
    assert.match(activity.summary, /^Osman tried to add a driver/);
    assert.doesNotMatch(activity.summary, /Osman added/);
  }
});

test('delivery and refund records do not claim physical handover or money movement', () => {
  const completion = describe({
    method: 'POST',
    path: '/api/deliveries/123/complete',
    outcome: 'saved',
  });
  assert.equal(completion.summary, 'Osman recorded a delivery completion.');
  assert.match(completion.intent, /physical handover/i);
  const refund = describe({
    method: 'POST',
    path: '/api/bag-refunds/123/actions',
    body: { action: 'complete' },
    outcome: 'saved',
  });
  assert.equal(refund.summary, 'Osman recorded a bag refund as completed.');
  assert.match(refund.intent, /payment provider/i);
});

test('route planning and previews remain separate from assigning deliveries', () => {
  const preview = describe({
    method: 'POST',
    path: '/api/deliveries/optimize-routes',
    outcome: 'saved',
  });
  assert.equal(preview.action, 'Preview a route plan');
  assert.equal(preview.operationKind, 'calculation');
  assert.match(preview.summary, /draft route plan/);
  assert.match(preview.intent, /separate/);
  const apply = describe({
    method: 'POST',
    path: '/api/deliveries/optimize-routes/apply',
    outcome: 'saved',
  });
  assert.equal(apply.action, 'Apply a route plan');
  assert.equal(apply.operationKind, 'change');
});

test('lookups, notification requests and acknowledgement-only routes never claim saved business records', () => {
  for (const [path, action, kind] of [
    ['/api/deliveries/geocode-google', 'Look up delivery pins with Google', 'calculation'],
    ['/api/drivers/returns', 'Report a bag return', 'integration'],
    ['/api/alerts/flagged-customer', 'Request a customer alert', 'integration'],
  ]) {
    const activity = describe({ method: 'POST', path, outcome: 'saved' });
    assert.equal(activity.action, action);
    assert.equal(activity.operationKind, kind);
    assert.match(activity.summary, /^Osman requested /);
    assert.doesNotMatch(activity.summary, /saved|recorded|sent|returned a bag/);
  }
  assert.match(describe({ method: 'POST', path: '/api/drivers/returns' }).intent, /does not save/);
});

test('known bag movements and contact link commands identify the operation while retaining evidence boundaries', () => {
  for (const [action, want] of [
    ['offer_transfer', 'Offer a bag transfer'],
    ['accept_transfer', 'Record acceptance of a bag transfer'],
    ['quarantine', 'Record bag damage and quarantine'],
  ])
    assert.equal(
      describe({ method: 'POST', path: '/api/bag-operations/movements', body: { action } }).action,
      want,
    );
  assert.equal(
    describe({
      method: 'POST',
      path: '/api/customer-service/contacts/123/link',
      body: { operation: 'unlink' },
      outcome: 'saved',
    }).summary,
    'Osman removed a contact customer link.',
  );
  assert.equal(
    describe({
      method: 'POST',
      path: '/api/bag-operations/movements',
      body: { action: 'private customer token' },
    }).action,
    'Record a bag movement',
  );
});

test('Customer Service commands use allowlisted operations without exposing free text', () => {
  for (const [operation, action, summary] of [
    ['assign', 'Assign a customer issue', 'Osman assigned a customer issue.'],
    ['resolve', 'Record an issue resolution', 'Osman recorded a customer issue resolution.'],
    ['split', 'Separate a customer issue', 'Osman recorded a separate customer issue.'],
    ['read', 'Mark a customer issue as read', 'Osman marked a customer issue as read.'],
  ]) {
    const activity = describe({
      method: 'POST',
      path: '/api/customer-service/requests/123/commands',
      body: { operation, title: 'Private Customer', reason: 'secret-token' },
      outcome: 'saved',
    });
    assert.equal(activity.action, action);
    assert.equal(activity.summary, summary);
  }
  const fallback = describe({
    method: 'POST',
    path: '/api/customer-service/requests/123/commands',
    body: { operation: 'Private Customer secret-token', action: 'resolve' },
  });
  assert.equal(fallback.action, 'Update a customer issue');
  assert.doesNotMatch(JSON.stringify(fallback), /Private Customer|secret-token/);
  assert.equal(
    describe({
      method: 'POST',
      path: '/api/customer-service/requests/123/commands',
      body: { action: 'followup' },
    }).action,
    'Add an issue follow-up',
  );
});

test('known actions cover forms in the operational, kitchen, portal and integration areas', () => {
  for (const [method, path, action] of [
    ['PUT', '/api/drivers/123', 'Update a driver'],
    ['PUT', '/api/users/drivers/123/location', 'Record a driver position'],
    ['PATCH', '/api/deliveries/assign-driver', 'Assign deliveries to a driver'],
    ['POST', '/api/delivery-changes/123/apply', 'Apply a delivery change'],
    ['POST', '/api/bag-operations/stock-counts', 'Record a bag stock count'],
    ['POST', '/api/store-keeper-scans', 'Record a warehouse scan'],
    ['POST', '/api/menus/123/kitchen-customers/customer/meal-editor', 'Edit a kitchen meal'],
    [
      'POST',
      '/api/menus/customers/private@example.com/skip-pause-preview',
      'Preview meal skips and pauses',
    ],
    ['PUT', '/api/meal-creation', 'Save the meal library'],
    ['POST', '/api/partner/orders/123/submit', 'Submit a partner order'],
    ['POST', '/api/member/orders/123/submit', 'Submit a member order'],
    ['PUT', '/api/employees/leave-requests/123/approve', 'Approve a leave request'],
    ['POST', '/api/matter/import-deliveries', 'Import Matter deliveries'],
    ['PUT', '/api/truckoom/vehicles/123/driver', 'Link a tracker vehicle to a driver'],
    ['POST', '/api/xero/invoices/from-subscription/123', 'Request an accounting invoice'],
    ['POST', '/api/yellowblock/third-party-assignments', 'Assign an external delivery company'],
  ])
    assert.equal(describe({ method, path }).action, action, path);
});

test('read descriptions use business language and never copy path values or body fields', () => {
  const activity = describe({
    method: 'GET',
    path: '/api/menus/customers/private@example.com/subscription-profile?token=secret-token',
    body: { actorName: 'Forged actor', customerName: 'Private Customer' },
  });
  assert.equal(activity.area, 'Menus and kitchen');
  assert.equal(activity.operationKind, 'read');
  assert.match(activity.action, /^View /);
  assert.doesNotMatch(
    JSON.stringify(activity),
    /private@example|secret-token|Forged actor|Private Customer|\/api\//,
  );
});

test('all catalogued API families have a business area', () => {
  const catalog = JSON.parse(
    readFileSync(new URL('../../docs/traceability/routes.json', import.meta.url), 'utf8'),
  );
  for (const route of catalog.api.filter((route) => route.path.startsWith('/api/'))) {
    const activity = describe({ method: route.method, path: route.path });
    assert.notEqual(activity.area, 'App', route.path);
    assert.ok(activity.action && activity.intent, route.path);
    assert.doesNotMatch(JSON.stringify(activity), /\/api\//, route.path);
  }
});

test('every declared mutation has an operation label rather than a generic area change', () => {
  const catalog = JSON.parse(
    readFileSync(new URL('../../docs/traceability/routes.json', import.meta.url), 'utf8'),
  );
  for (const route of catalog.api.filter((route) =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method),
  )) {
    assert.doesNotMatch(
      describe(route).action,
      /^Submit a change/,
      `${route.method} ${route.path}`,
    );
  }
});

test('unknown routes and malformed optional input produce honest safe wording', () => {
  assert.equal(
    describe({
      method: 'POST',
      path: '/api/new/private@example.com',
      body: { action: 'secret-token' },
    }).summary,
    'Osman submitted a change in the app.',
  );
  assert.equal(describeActivity().summary, 'An unidentified actor requested app information.');
  assert.equal(
    describe({ method: 'POST', path: '/api/customers/future-action', body: null }).summary,
    'Osman submitted a change in customer records.',
  );
});
