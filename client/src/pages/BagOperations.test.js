import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import BagOperations from './BagOperations';
import api from '../utils/api';
jest.mock('../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn(),put:jest.fn()}}));
jest.mock('react-redux',()=>({useSelector:fn=>fn({auth:{user:{_id:'staff',role:'admin'}}})}));
jest.mock('react-router-dom',()=>{const React=require('react');return {useSearchParams:()=>{const [params,setParams]=React.useState(new URLSearchParams());return [params,next=>setParams(new URLSearchParams(next))];}};},{virtual:true});
jest.mock('qrcode.react',()=>({QRCodeCanvas:()=> <div>Existing QR</div>}));
jest.mock('../components/SimpleQrScanner',()=>()=> <div>Camera scanner</div>);
jest.mock('../components/bags/bagQrLabels',()=>({downloadBulkQrPdf:jest.fn()}));
global.IS_REACT_ACT_ENVIRONMENT=true;
const fixture=()=>({generatedAt:'2026-10-22T09:00:00Z',summary:{bagRecords:1},canOperate:true,canRetire:true,checks:[{code:'custody_ambiguous',count:1}],unknownCodes:['BAG-9999'],reviewers:[{_id:'staff',name:'Reviewer'}],drivers:[],customers:[],stockCounts:[],bags:[{_id:'b1',bagId:'BAG-00001',status:'assigned',location:'warehouse',condition:'good',lifecycleState:'legacy_unverified',custodyVersion:0,verifiedAt:null,reasons:['custody_ambiguous'],review:null,historyCount:0}]});
let root,container,data;
const button=(text)=>[...container.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
const click=async text=>{expect(button(text)).toBeDefined();await act(async()=>button(text).click());};
const fill=async(element,value)=>{await act(async()=>{const proto=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});};
beforeEach(async()=>{
  data=fixture();api.get.mockReset();api.post.mockReset();api.put.mockReset();
  api.get.mockImplementation(async url=>({data:{success:true,data:url==='/bag-operations'?data:{bagId:'BAG-00001',status:'assigned',location:'warehouse',condition:'good',history:[]}}}));
  api.put.mockResolvedValue({data:{success:true}});api.post.mockResolvedValue({data:{success:true}});
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
  await act(async()=>root.render(<BagOperations/>));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();jest.restoreAllMocks();});
test('workspace loads the side-effect-free endpoint and labels the opening balance unverified',()=>{
  expect(api.get).toHaveBeenCalledWith('/bag-operations');
  expect(api.get.mock.calls.some(([url])=>url==='/bags')).toBe(false);
  expect(container.textContent).toContain('Unverified legacy');
  expect(api.post).not.toHaveBeenCalled();expect(api.put).not.toHaveBeenCalled();
});
test('bag lookup preserves leading zeros and never picks a similar tag',async()=>{
  await click('Find a bag');await fill(container.querySelector('.bo-field input'),'BAG-0001');await click('Open bag');
  expect(container.querySelector('[role="alert"]').textContent).toContain('Unregistered ID');
  expect(api.get.mock.calls.filter(([url])=>url.includes('/bags/'))).toHaveLength(0);
});
test('audit review saves evidence without invoking a stock movement',async()=>{
  await click('Audit reviews');await click('Open');
  await fill(container.querySelector('textarea'),'Confirm physical custody with the warehouse count.');
  await click('Save review');
  expect(api.put).toHaveBeenCalledWith('/bag-operations/reviews',expect.objectContaining({recordId:'b1',version:0,status:'open',note:'Confirm physical custody with the warehouse count.'}));
  expect(api.post).not.toHaveBeenCalled();
});
test('read-only staff cannot save reviews or register stock',async()=>{
  data.canOperate=false;await click('Refresh');
  expect(button('Register a bag').disabled).toBe(true);
  await click('Audit reviews');await click('Open');
  await fill(container.querySelector('textarea'),'Evidence note');expect(button('Save review').disabled).toBe(true);
});
test('failed reconciliation submissions stay open with an error',async()=>{
  api.post.mockRejectedValue({response:{data:{message:'Count could not be saved.'}}});
  await click('Physical count');
  await fill(container.querySelector('textarea'),'BAG-00001');
  await act(async()=>container.querySelector('input[type="checkbox"]').click());
  await click('Submit count for review');
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]').textContent).toContain('Count could not be saved.');
  expect(api.post).toHaveBeenCalledWith('/bag-operations/stock-counts',expect.objectContaining({scannedCodes:['BAG-00001'],confirmed:true}));
});
