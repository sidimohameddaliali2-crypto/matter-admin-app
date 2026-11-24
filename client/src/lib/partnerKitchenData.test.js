import {loadPartnerKitchenOrders, partnerPaperHtml} from './partnerKitchenData';

const date = '2026-11-16';
test.each([false, true])('partner export refuses unsuccessful or wrong-date data (%s)', async wrongDate => {
  const api = {get: jest.fn().mockResolvedValue({data: {success: wrongDate, data: {date: wrongDate ? '2026-11-17' : date, orders: [], counts: []}}})};
  await expect(loadPartnerKitchenOrders(api, date)).rejects.toThrow('could not be verified');
});

test('Word partner sections escape all names and notes', () => {
  const html = partnerPaperHtml({orders: [{partnerName: '<Cafe>', reference: 'PO&1', notes: '<Note>', deliveryTime: 'Morning', lines: [{mealType: 'main', name: 'Rice & Chicken', quantity: 2}]}]});
  expect(html).toContain('<h2>Partner</h2>');
  expect(html).toContain('&lt;Cafe&gt;');
  expect(html).toContain('&lt;Note&gt;');
  expect(html).toContain('Rice &amp; Chicken');
  expect(html).not.toContain('<Cafe>');
});

test('partner paper includes escaped delivery address and recipient phone',()=>{
 const html=partnerPaperHtml({orders:[{partnerName:'Cafe',reference:'PO-1',deliveryTime:'Afternoon',deliveryAddress:'Unit <2>',deliveryRecipientPhone:'+971501234567',lines:[]}]});
 expect(html).toContain('Unit &lt;2&gt;');expect(html).toContain('+971501234567');expect(html).not.toContain('Unit <2>');
});
