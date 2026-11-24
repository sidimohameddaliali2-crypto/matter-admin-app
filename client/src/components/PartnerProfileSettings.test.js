import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import Settings from './PartnerProfileSettings';
import api from '../utils/partnerApi';
jest.mock('../utils/partnerApi',()=>({__esModule:true,default:{patch:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
test('partners edit invoice/delivery/web details using permitted slots, with Instagram optional',async()=>{
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);const saved=jest.fn();
 api.patch.mockResolvedValue({data:{data:{invoiceBusinessName:'Cafe LLC'}}});
 try {
  await act(async()=>root.render(<Settings partner={{businessName:'Cafe',deliveryTimeSlots:['Afternoon','Evening'],defaultDeliveryTime:'Evening'}} onSaved={saved}/>));
  const select=container.querySelector('select');expect(select.value).toBe('Evening');expect([...select.options].map(o=>o.value)).toEqual(['Afternoon','Evening']);
  const input=container.querySelector('[name="invoiceBusinessName"]');
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Cafe LLC');input.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(container.querySelector('[name="instagramUrl"]').required).toBe(false);
  await act(async()=>container.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(api.patch).toHaveBeenCalledWith('/partner/profile',{invoiceBusinessName:'Cafe LLC'});expect(saved).toHaveBeenCalledWith({invoiceBusinessName:'Cafe LLC'});
 } finally {await act(async()=>root.unmount());container.remove();}
});
