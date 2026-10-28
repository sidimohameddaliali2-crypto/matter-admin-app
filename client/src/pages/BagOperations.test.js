import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import BagOperations from './BagOperations';
import api from '../utils/api';
jest.mock('../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn(),put:jest.fn()}}));
jest.mock('react-redux',()=>({useSelector:fn=>fn({auth:{user:{_id:'staff',role:'admin'}}})}));
jest.mock('react-router-dom',()=>{const React=require('react');return {useSearchParams:()=>{const [params,setParams]=React.useState(new URLSearchParams());return [params,next=>setParams(new URLSearchParams(next))];}};},{virtual:true});
jest.mock('qrcode.react',()=>({QRCodeCanvas:()=> <div>Existing QR</div>}));
let mockScanLabel='BAG_00001';
jest.mock('../components/SimpleQrScanner',()=>({onScan,onError})=> <div>Camera scanner<button onClick={()=>onScan([{rawValue:mockScanLabel}])}>Scan test label</button><button onClick={onError}>Camera fails</button></div>);
jest.mock('../components/bags/bagQrLabels',()=>({downloadBulkQrPdf:jest.fn()}));
global.IS_REACT_ACT_ENVIRONMENT=true;
const fixture=()=>({generatedAt:'2026-10-22T09:00:00Z',summary:{bagRecords:1},canOperate:true,canRetire:true,checks:[{code:'custody_ambiguous',count:1}],unknownCodes:['BAG-9999'],reviewers:[{_id:'staff',name:'Reviewer'}],drivers:[],customers:[],stockCounts:[],bags:[{_id:'b1',bagId:'BAG-00001',status:'assigned',location:'warehouse',condition:'good',lifecycleState:'legacy_unverified',custodyVersion:0,verifiedAt:null,reasons:['custody_ambiguous'],review:null,historyCount:0}]});
let root,container,data;
const button=(text)=>[...container.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
const click=async text=>{expect(button(text)).toBeDefined();await act(async()=>button(text).click());};
const fill=async(element,value)=>{await act(async()=>{const proto=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});};
beforeEach(async()=>{
  mockScanLabel='BAG_00001';data=fixture();api.get.mockReset();api.post.mockReset();api.put.mockReset();
  api.get.mockImplementation(async url=>({data:{success:true,data:url==='/bag-operations'?data:{...data.bags[0],history:[]}}}));
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

test('camera scan with underscore opens the registered hyphen stock record',async()=>{
  await click('Find a bag');await click('Use camera');await click('Scan test label');await click('Open bag');
  expect(api.get).toHaveBeenCalledWith('/bag-operations/bags/b1');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test('the reported BAG-00523 label opens existing stock',async()=>{
  data.bags[0].bagId='BAG-00523';
  await click('Refresh');await click('Find a bag');await fill(container.querySelector('.bo-field input'),'BAG-00523');await click('Open bag');
  expect(api.get).toHaveBeenCalledWith('/bag-operations/bags/b1');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
test('equivalent duplicate labels do not silently open an arbitrary customer association',async()=>{
  data.bags.push({...data.bags[0],_id:'b2',bagId:'BAG_00001'});
  await click('Refresh');await click('Find a bag');await fill(container.querySelector('.bo-field input'),'BAG_00001');await click('Open bag');
  expect(container.querySelector('[role="alert"]').textContent).toContain('Multiple stock records');
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

test('warehouse mode limits navigation and ignores a management view selection',async()=>{
  await click('Audit reviews');
  await act(async()=>root.render(<BagOperations warehouse/>));
  const nav=container.querySelector('[aria-label="Warehouse tasks"]');
  expect([...nav.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['Home','Returns','Clean','Handover','Stock']);
  expect(container.textContent).toContain('Ready for the next shift.');
  expect(container.textContent).not.toContain('Deposit refunds');
  expect(container.textContent).not.toContain('Customer balances');
  expect(api.post).not.toHaveBeenCalled();
});

test('warehouse home lookup reports unknown labels without creating stock',async()=>{
  await act(async()=>root.render(<BagOperations warehouse/>));
  await click('Scan a bag');await click('Start camera');mockScanLabel='BAG-0001';await click('Scan test label');
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]').textContent).toContain('Unregistered ID');
  expect(api.post).not.toHaveBeenCalled();
});

test('warehouse queues show physical stages and preserve driver acceptance',async()=>{
  data.bags[0]={...data.bags[0],lifecycleState:'ready',custodyVersion:7,verifiedAt:'2026-10-26T06:00:00Z'};
  data.drivers=[{_id:'driver-1',name:'Receiving driver'}];
  await act(async()=>root.render(<BagOperations warehouse/>));
  await click('Clean');expect(container.querySelectorAll('.wk-bagcard')).toHaveLength(0);
  await click('Handover');expect(container.querySelectorAll('.wk-bagcard')).toHaveLength(1);
  await act(async()=>container.querySelector('.wk-bagcard').click());
  expect(button('Retire bag')).toBeUndefined();
  await click('Prepare handover');
  const select=container.querySelector('.bo-field select');
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'driver-1');select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(container.querySelector('textarea')).toBeNull();
  await click('Confirm physical action');
  expect(api.post).toHaveBeenCalledWith('/bag-operations/movements',expect.objectContaining({bagId:'BAG-00001',action:'pack',expectedVersion:7,driverId:'driver-1'}));
  expect(api.post.mock.calls.some(([,body])=>body.action==='accept')).toBe(false);
});

test('read-only warehouse staff cannot register bags or submit counts',async()=>{
  data.canOperate=false;
  await act(async()=>root.render(<BagOperations warehouse/>));
  await click('Stock');expect(button('Add bag').disabled).toBe(true);
  await click('Physical counts');expect(button('Start count').disabled).toBe(true);
});

const warehouse=async()=>act(async()=>root.render(<BagOperations warehouse/>));
const noTyping=()=>expect(container.querySelector('input:not([type="checkbox"]):not([type="file"]),textarea')).toBeNull();
const cameraScan=async code=>{mockScanLabel=code;await click('Scan test label');};

test('warehouse camera opens exact stock without writing and has no typing fields',async()=>{
  await warehouse();noTyping();await click('Scan a bag');noTyping();await click('Start camera');await cameraScan('BAG_00001');
  expect(api.get).toHaveBeenCalledWith('/bag-operations/bags/b1');expect(api.post).not.toHaveBeenCalled();
});

test('warehouse blocks duplicate scan identities',async()=>{
  data.bags.push({...data.bags[0],_id:'b2',bagId:'BAG_00001'});await warehouse();
  await click('Scan a bag');await click('Start camera');await cameraScan('BAG-00001');
  expect(container.querySelector('[role="alert"]').textContent).toContain('Multiple stock records');
  expect(api.get.mock.calls.filter(([url])=>url.includes('/bags/'))).toHaveLength(0);
});

test('handheld scan opens a bag without typing into a form',async()=>{
  await warehouse();await click('Scan a bag');
  await act(async()=>{for(const key of [...'BAG_00001','Enter'])document.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));});
  expect(api.get).toHaveBeenCalledWith('/bag-operations/bags/b1');expect(api.post).not.toHaveBeenCalled();
});

test('warehouse registration accepts an unused scanned tag only after confirmation',async()=>{
  await warehouse();await click('Stock');await click('Add bag');noTyping();
  expect(button('Register physical bag').disabled).toBe(true);await click('Start camera');
  await cameraScan('BAG_00001');expect(button('Register physical bag').disabled).toBe(true);
  await cameraScan('BAG_00002');expect(api.post).not.toHaveBeenCalled();expect(button('Register physical bag').disabled).toBe(false);
  await cameraScan('invalid');expect(button('Register physical bag').disabled).toBe(true);
  await cameraScan('BAG_00003');await click('Register physical bag');
  expect(api.post).toHaveBeenCalledWith('/bag-operations/register',{bagId:'BAG-00003'});
});

test('warehouse count deduplicates tag aliases and requires a physical-count confirmation',async()=>{
  api.post.mockResolvedValue({data:{data:{scannedCodes:['BAG-00001','BAG-00002'],missingCodes:[],unexpectedCodes:[]}}});
  await warehouse();await click('Count the bags on the shelfStart a physical stock check');noTyping();
  await click('Start camera');await cameraScan('BAG_00001');await cameraScan('BAG-00001');await cameraScan('BAG-00002');
  expect(container.textContent).toContain('2 unique bags scanned');expect(api.post).not.toHaveBeenCalled();
  expect(button('Submit count for review').disabled).toBe(true);
  await act(async()=>container.querySelector('input[type="checkbox"]').click());await click('Submit count for review');
  expect(api.post).toHaveBeenCalledWith('/bag-operations/stock-counts',expect.objectContaining({scannedCodes:['BAG-00001','BAG-00002'],confirmed:true,note:'Physical stock count recorded by scanning bag tags.'}));
  expect(container.textContent).toContain('Inventory remains unchanged');
});

test('warehouse damage needs a tapped reason and uploaded photo',async()=>{
  data.bags[0].lifecycleState='ready';await warehouse();await click('Scan a bag');await click('Start camera');await cameraScan('BAG-00001');
  await click('Report damage');noTyping();expect(button('Confirm physical action').disabled).toBe(true);
  await click('Zip damaged');expect(button('Confirm physical action').disabled).toBe(true);
  api.post.mockResolvedValueOnce({data:{url:'https://example.com/damage.jpg'}});
  const file=container.querySelector('input[type="file"]');expect(file.getAttribute('capture')).toBe('environment');
  Object.defineProperty(file,'files',{value:[new File(['photo'],'damage.jpg',{type:'image/jpeg'})]});
  await act(async()=>file.dispatchEvent(new Event('change',{bubbles:true})));await click('Confirm physical action');
  expect(api.post).toHaveBeenCalledWith('/bag-operations/movements',expect.objectContaining({action:'quarantine',note:'Zip damaged',proofPhotoUrl:'https://example.com/damage.jpg'}));
});

test('warehouse repair requires an inspection before saving the selected finding',async()=>{
  data.bags[0].lifecycleState='quarantined';await warehouse();await click('Clean');await act(async()=>container.querySelector('.wk-bagcard').click());
  await click('Record repair');await click('Zip repaired');noTyping();expect(button('Confirm physical action').disabled).toBe(true);
  await act(async()=>container.querySelector('input[type="checkbox"]').click());await click('Confirm physical action');
  expect(api.post).toHaveBeenCalledWith('/bag-operations/movements',expect.objectContaining({action:'repair',note:'Zip repaired',inspected:true}));
});

test('warehouse camera failure keeps handheld scanning available',async()=>{
  await warehouse();await click('Scan a bag');await click('Start camera');await click('Camera fails');
  expect(container.querySelector('[role="alert"]').textContent).toContain('handheld scanner');expect(button('Start camera')).toBeDefined();noTyping();
});
