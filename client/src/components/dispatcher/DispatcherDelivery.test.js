import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {DispatcherDeliveryForm,DeliveryDetails} from './DispatcherDelivery';
import api from '../../utils/api';
jest.mock('../../utils/api',()=>({__esModule:true,default:{post:jest.fn(),put:jest.fn(),defaults:{baseURL:'https://fixture-api.example/api'}}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let root,el,delivery;
const named=label=>[...el.querySelectorAll('label')].find(n=>n.firstChild?.textContent===label)?.querySelector('input');
const fill=async(label,value)=>act(async()=>{const input=named(label);expect(input).toBeDefined();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
const submit=()=>act(async()=>el.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
const render=()=>act(async()=>root.render(<DispatcherDeliveryForm delivery={delivery} onClose={()=>{}} onSaved={()=>{}}/>));
beforeEach(async()=>{delivery={_id:'delivery-1',customerId:'C1',customerName:'Fixture customer',address:'Old building, Marina',zone:'Marina',scheduledTime:'2026-11-23T03:00:00Z',type:'Delivery',gpsLocation:{lat:25,lng:55},addressDetails:{city:'Dubai',area:'Marina',building:'Old building',floor:'4',unit:'401',additional_details:'Use the old gate',coordinates:{lat:25,lng:55}}};api.put.mockReset();api.put.mockResolvedValue({data:{success:true}});el=document.createElement('div');document.body.append(el);root=createRoot(el);await render();});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();});
test('changing destination discards old building, unit, area, instructions and saved pin',async()=>{
 await fill('Address','New villa, JVC');await fill('Zone','JVC');await submit();
 const body=api.put.mock.calls[0][1];expect(body.address).toBe('New villa, JVC');expect(body.addressDetails).toEqual({city:'Dubai',coordinates:null});expect(body.gpsLocation).toBeNull();expect(body.lat).toBeNull();expect(body.lng).toBeNull();
});
test('address edit can supply a fresh exact pin without retaining the previous breakdown',async()=>{
 await fill('Address','New villa, JVC');await fill('Saved latitude (optional)','25.1');await fill('Saved longitude (optional)','55.2');await submit();
 const body=api.put.mock.calls[0][1];expect(body.addressDetails).toEqual({city:'Dubai',coordinates:{lat:25.1,lng:55.2}});expect(body.gpsLocation).toEqual({lat:25.1,lng:55.2});
});
test('editing only the phone retains unchanged destination breakdown and coordinates',async()=>{
 await fill('Phone number',' +971 50 000 0000 ');await submit();const body=api.put.mock.calls[0][1];expect(body.customerPhone).toBe('+971 50 000 0000');expect(body.addressDetails).toEqual(delivery.addressDetails);expect(body).not.toHaveProperty('gpsLocation');
});


test('delivery and collection proof renders supported upload paths, filenames and CDN URLs, with normalized deduplication',async()=>{
 delivery.proof={images:['/uploads/proofImage-fixture.jpg','proofImages-fixture.jpg','https://cdn.example/proof.jpg','uploads/proofImage-fixture.jpg','javascript:alert(1)','//other.example/proof.jpg','/uploads/../private.jpg']};
 delivery.collectionDetails={collectedPhotoUrl:'/uploads/collection-fixture.jpg'};
 await act(async()=>root.render(<DeliveryDetails delivery={delivery} drivers={[]} onEdit={()=>{}} onAssign={()=>{}} onUnassign={()=>{}}/>));
 const sources=[...el.querySelectorAll('.dp-proof img')].map(image=>image.getAttribute('src'));
 expect(sources).toEqual(['https://fixture-api.example/uploads/proofImage-fixture.jpg','https://fixture-api.example/uploads/proofImages-fixture.jpg','https://cdn.example/proof.jpg','https://fixture-api.example/uploads/collection-fixture.jpg']);
 await act(async()=>el.querySelector('.dp-proof button').click());
 expect(el.querySelector('.dp-large-proof').getAttribute('src')).toBe(sources[0]);
});
