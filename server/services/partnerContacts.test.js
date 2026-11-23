import test from 'node:test';
import assert from 'node:assert/strict';
import Partner from '../models/Partner.js';
import PartnerMenuItem from '../models/PartnerMenuItem.js';
import router from '../routes/adminPartners.js';

const base = () => ({businessName: 'Fixture Cafe', businessType: 'cafe', contactName: 'Login Contact',
  email: 'login@example.com', password: 'fixture-password', phone: '+971 50 111 1111'});
const contacts = () => ({
  pointOfContact: {fullName: 'Service Person', email: 'service@example.com', phone: '+971 50 222 2222'},
  financeContact: {fullName: 'Finance Person', email: 'finance@example.com', phone: '+971 50 333 3333'},
  ownerContact: {fullName: 'Business Owner', email: 'owner@example.com', phone: '+971 50 444 4444'}
});
const handler = (method, path) => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const response = () => ({statusCode: 200, status(code) {this.statusCode = code; return this;}, json(body) {this.body = body; return this;}});

test('existing partners and partially populated contacts remain valid', async () => {
  const legacy = new Partner(base()); await legacy.validate();
  assert.equal(legacy.pointOfContact, undefined);
  const partial = new Partner({...base(), pointOfContact: {phone: '+971 50 222 2222'}, financeContact: {email: 'finance@example.com'}, ownerContact: {}});
  await partial.validate();
  assert.equal(partial.pointOfContact.fullName, '');
  assert.equal(partial.ownerContact.email, '');
});

test('contact fields normalize independently and do not change login details', async () => {
  const partner = new Partner({...base(), ...contacts(), financeContact: {fullName: ' Finance Person ', email: ' FINANCE@EXAMPLE.COM ', phone: ' +971 50 333 3333 '}});
  await partner.validate();
  assert.deepEqual(partner.financeContact.toObject(), contacts().financeContact);
  assert.equal(partner.email, base().email); assert.equal(partner.contactName, base().contactName);
  assert.equal(partner.pointOfContact.email, 'service@example.com');
  assert.equal(partner.ownerContact.email, 'owner@example.com');
});

function mockCreate(t) {
  t.mock.method(Partner, 'findOne', async () => null);
  t.mock.method(PartnerMenuItem, 'find', () => ({select() {return this;}, lean: async () => []}));
  return t.mock.method(Partner, 'create', async fields => {
    const partner = new Partner(fields); await partner.validate(); return partner;
  });
}

test('the create route saves all optional contacts and omits the password from its response', async t => {
  mockCreate(t); const res = response();
  await handler('post', '/')({body: {...base(), ...contacts()}, user: {_id: '507f1f77bcf86cd799439011'}}, res);
  assert.equal(res.statusCode, 201);
  for (const role of Object.keys(contacts())) assert.deepEqual(res.body.data[role].toObject(), contacts()[role]);
  assert.equal(res.body.data.password, undefined);
  assert.equal(res.body.data.email, base().email);
});

test('invalid optional contact email is a validation error on creation', async t => {
  mockCreate(t); t.mock.method(console, 'error', () => {}); const res = response();
  await handler('post', '/')({body: {...base(), financeContact: {email: 'invalid'}}, user: {_id: '507f1f77bcf86cd799439011'}}, res);
  assert.equal(res.statusCode, 400); assert.match(res.body.message, /valid contact email/);
});

test('partial contact edits retain sibling fields, other roles and the login identity', async t => {
  let saved;
  t.mock.method(Partner, 'findByIdAndUpdate', (id, update, options) => ({select: async projection => {
    assert.equal(projection, '+financeContact +ownerContact');
    saved = update.$set; assert.equal(options.runValidators, true); assert.equal(options.new, true);
    return {_id: id, ...base(), ...contacts()};
  }}));
  const res = response();
  await handler('patch', '/:id')({params: {id: 'partner'}, body: {
    financeContact: {phone: '+971 50 555 5555', password: 'ignored'}, email: 'ignored@example.com', password: 'ignored'
  }}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(saved, {'financeContact.phone': '+971 50 555 5555'});
});

test('optional contact fields can be cleared, while malformed contact payloads are rejected', async t => {
  let saved;
  const update = t.mock.method(Partner, 'findByIdAndUpdate', (id, fields) => ({select: async () => {saved = fields.$set; return {_id: id};}}));
  const res = response();
  await handler('patch', '/:id')({params: {id: 'partner'}, body: {ownerContact: {fullName: '', email: '', phone: ''}}}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(saved, {'ownerContact.fullName': '', 'ownerContact.email': '', 'ownerContact.phone': ''});
  for (const contact of ['invalid', [], null]) {
    const invalid = response();
    await handler('patch', '/:id')({params: {id: 'partner'}, body: {ownerContact: contact}}, invalid);
    assert.equal(invalid.statusCode, 400);
  }
  assert.equal(update.mock.callCount(), 1);
});

test('null contact roles are rejected on creation before they can block later dotted updates', async t => {
  mockCreate(t); t.mock.method(console, 'error', () => {});
  for (const role of Object.keys(contacts())) {
    const res = response();
    await handler('post', '/')({body: {...base(), [role]: null}, user: {_id: '507f1f77bcf86cd799439011'}}, res);
    assert.equal(res.statusCode, 400, role);
    assert.match(res.body.message, /Contact must be an object/);
  }
});

test('finance and owner contacts are excluded from partner queries by default', () => {
  assert.equal(Partner.schema.path('financeContact').options.select, false);
  assert.equal(Partner.schema.path('ownerContact').options.select, false);
});

for (const role of ['kitchen', 'admin', 'super_admin']) test(`${role} partner list and detail enforce contact visibility`, async t => {
  const stored = {...base(), ...contacts(), _id: 'partner'}; delete stored.password;
  const query = many => {
    let projection = '';
    return {
      select(value) {projection = value; return this;}, sort() {return this;}, skip() {return this;}, limit() {return this;},
      then(resolve, reject) {
        const visible = {...stored};
        // Model select:false behavior, with explicit admin-only opt-in.
        for (const field of ['financeContact', 'ownerContact']) if (!projection.split(' ').includes('+' + field)) delete visible[field];
        return Promise.resolve(many ? [visible] : visible).then(resolve, reject);
      }
    };
  };
  t.mock.method(Partner, 'countDocuments', async () => 1);
  t.mock.method(Partner, 'find', () => query(true));
  t.mock.method(Partner, 'findById', () => query(false));
  for (const path of ['/', '/:id']) {
    const res = response();
    await handler('get', path)({query: {}, params: {id: 'partner'}, user: {role}}, res);
    assert.equal(res.statusCode, 200);
    const partner = path === '/' ? res.body.data[0] : res.body.data;
    assert.deepEqual(partner.pointOfContact, contacts().pointOfContact);
    assert.equal(partner.businessName, base().businessName);
    for (const field of ['financeContact', 'ownerContact']) {
      if (role === 'kitchen') assert.equal(partner[field], undefined);
      else assert.deepEqual(partner[field], contacts()[field]);
    }
  }
});
