import test from 'node:test';
import assert from 'node:assert/strict';
import Partner from '../models/Partner.js';
import SpaceOrder from '../models/SpaceOrder.js';
import OrderLine from '../models/OrderLine.js';
import router from '../routes/partnerPortal.js';
import {assertPartnerDelivery, partnerDeliveryWindows, partnerInvoiceName, partnerProfileData} from './partnerDeliverySettings.js';
const base = {businessName:'Cafe',businessType:'cafe',contactName:'Contact',email:'cafe@example.com',password:'fixture'};
const handler = (method,path) => router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const response = () => ({code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}});

test('weekend policy preserves Saturday deliveries unless disabled and keeps Sunday closed', () => {
  assert.doesNotThrow(() => assertPartnerDelivery({},'2099-01-10'));
  assert.throws(() => assertPartnerDelivery({weekendsDisabled:true},'2099-01-10'), /Weekend/);
  assert.throws(() => assertPartnerDelivery({},'2099-01-11'), /Sunday/);
  assert.doesNotThrow(() => assertPartnerDelivery({weekendsDisabled:true},'2099-01-12'));
});
test('custom slots replace defaults and reject times outside the account schedule', () => {
  const partner = {deliveryTimeSlots:['Afternoon · 1–2pm']};
  assert.equal(partnerDeliveryWindows({}).length,2);
  assert.deepEqual(partnerDeliveryWindows(partner),partner.deliveryTimeSlots);
  assert.throws(() => assertPartnerDelivery(partner,'2099-01-05','Morning · 5–6am'), /available delivery times/);
  assert.doesNotThrow(() => assertPartnerDelivery(partner,'2099-01-05',partner.deliveryTimeSlots[0]));
});
test('optional invoice name falls back to the partner name, and profiles exclude private contacts', () => {
  assert.equal(partnerInvoiceName({...base,invoiceBusinessName:' Company LLC '}),'Company LLC');
  assert.equal(partnerInvoiceName({...base,invoiceBusinessName:'  '}),'Cafe');
  const data=partnerProfileData({...base,financeContact:{email:'private@example.com'},invoiceBusinessName:'Company LLC'});
  assert.equal(data.invoiceBusinessName,'Company LLC');assert.equal(data.financeContact,undefined);
});
test('business URLs and delivery slots are validated without requiring optional links', async () => {
  await new Partner(base).validate();
  for(const fields of [{websiteUrl:'javascript:alert(1)'},{instagramUrl:'https://evil.example/user'},{deliveryTimeSlots:[]},{deliveryTimeSlots:['same','same']},{deliveryTimeSlots:['']}]) {
    await assert.rejects(new Partner({...base,...fields}).validate());
  }
  const valid=new Partner({...base,websiteUrl:' https://example.com ',instagramUrl:'https://instagram.com/cafe',deliveryTimeSlots:['Afternoon · 1–2pm']});
  await valid.validate();assert.equal(valid.websiteUrl,'https://example.com');
});
test('weekend rules reject both direct drafts and previously saved draft submission before line writes', async t => {
  t.mock.method(console,'error',()=>{});
  const reads=t.mock.method(OrderLine,'find',()=>assert.fail('No line reads or writes for disabled weekends'));
  t.mock.method(SpaceOrder,'findOne',async()=>({_id:'order',status:'draft',deliveryDate:new Date('2099-01-10'),deliveryTime:'Morning · 5–6am'}));
  const partner={_id:'aaaaaaaaaaaaaaaaaaaaaaaa',weekendsDisabled:true};
  for(const path of ['/orders','/orders/:id/submit']) {
    const res=response();await handler('post',path)({partner,params:{id:'order'},body:{deliveryDate:'2099-01-10',lines:[]}},res);
    assert.equal(res.code,400);assert.match(res.body.message,/Weekend/);
  }
  assert.equal(reads.mock.callCount(),0);
});
test('partners may edit business/delivery details but cannot change admin delivery restrictions', async t => {
  let updates;
  t.mock.method(Partner,'findByIdAndUpdate',async(id,fields,options)=>{
    updates=fields;assert.equal(options.runValidators,true);return {...base,...fields};
  });
  const res=response();await handler('patch','/profile')({partner:{_id:'partner',deliveryTimeSlots:['Afternoon']},body:{invoiceBusinessName:'Company LLC',deliveryAddress:'Unit 1',deliveryRecipientPhone:'+971501234567',instagramUrl:'',weekendsDisabled:false,deliveryTimeSlots:['Any time']}},res);
  assert.equal(res.code,200);assert.equal(updates.weekendsDisabled,undefined);assert.equal(updates.deliveryTimeSlots,undefined);assert.equal(updates.deliveryAddress,'Unit 1');
  const invalid=response();await handler('patch','/profile')({partner:{_id:'partner',deliveryTimeSlots:['Afternoon']},body:{defaultDeliveryTime:'Other'}},invalid);
  assert.equal(invalid.code,400);
});

test('saved drafts must use a current delivery slot before submission', async t => {
  t.mock.method(console,'error',()=>{});
  t.mock.method(SpaceOrder,'findOne',async()=>({_id:'order',status:'draft',deliveryDate:new Date('2099-01-05'),deliveryTime:'Retired time'}));
  t.mock.method(OrderLine,'find',()=>assert.fail('No order line mutation for retired time'));
  const res=response();await handler('post','/orders/:id/submit')({params:{id:'order'},partner:{_id:'partner',deliveryTimeSlots:['Afternoon']}},res);
  assert.equal(res.code,400);assert.match(res.body.message,/available delivery times/);
});
