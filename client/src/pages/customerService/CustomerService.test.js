import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import CustomerService from './CustomerService';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn() } }));
let mockPathname = '/customer-service/chats';
let mockSearch = '';
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => {
  const React = require('react');
  return { Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>, useLocation: () => ({ pathname: mockPathname, search: mockSearch }), useNavigate: () => mockNavigate };
}, { virtual: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent.trim() === text);
async function render(user = { _id: 'reviewer', role: 'admin' }, route = '/customer-service/chats') {
  mockPathname = route;
  const store = configureStore({ reducer: { auth: () => ({ user }) } });
  await act(async () => root.render(<Provider store={store}><CustomerService /></Provider>));
}
beforeEach(() => {
  jest.clearAllMocks(); mockSearch = ''; mockNavigate.mockImplementation(url => { mockSearch = url.includes('?') ? url.slice(url.indexOf('?')) : ''; });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  api.get.mockImplementation(async url => ({ data: { success: true, data: url.endsWith('/me') ? { capabilities: { review: true, workActions: true }, profile: { displayName: 'Reviewer', userId: 'reviewer' } } : url.endsWith('/categories') ? [] : url.endsWith('/reviews') ? { reviews: [] } : url.endsWith('/team') ? { members: [], candidates: [{ _id: 'candidate', displayName: 'Existing staff' }] } : { issues: [], actions: [] } } }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
test('inbox is primary and reviews remain a separate deliberate workflow', async () => {
  await render();
  expect([...container.querySelectorAll('nav[aria-label="Customer service pages"] a')].map(a => a.textContent)).toEqual(['Inbox', 'Follow-ups', 'Customers', 'Reviews', 'Summary', 'Reporting']);
  expect(container.textContent).toContain('Select a conversation');
  expect(api.post).not.toHaveBeenCalled();
  expect(button('Start next review')).toBeUndefined();
  await render(undefined,'/customer-service/reviews');
  expect(container.textContent).toContain('No reviews assigned');
  expect(button('Start next review')).toBeDefined();
});
test('ordinary admin without an explicit service grant sees access state and no issue data is fetched', async () => {
  api.get.mockResolvedValue({ data: { success: true, data: { capabilities: { review: false, supervise: false, workActions: false, setup: false }, profile: null } } });
  await render();
  expect(container.textContent).toContain('Customer service access is not configured');
  expect(api.get.mock.calls.some(([url]) => url.endsWith('/issues') || url.endsWith('/reviews'))).toBe(false);
});
test('setup-only super admin receives an existing-staff setup form', async () => {
  const original = api.get.getMockImplementation();
  api.get.mockImplementation(async url => url.endsWith('/me') ? { data: { success: true, data: { capabilities: { setup: true }, profile: null } } } : original(url));
  await render({ _id: 'super', role: 'super_admin' });
  expect(container.textContent).toContain('Set up a supervisor');
  expect(container.querySelector('select[aria-label="Supervisor account"]')).toBeTruthy();
  expect(container.textContent).toContain('Existing staff');
});
test('review capacity retains the selected service date when editing a reviewer', async () => {
  const original = api.get.getMockImplementation();
  api.get.mockImplementation(async url => url.endsWith('/me') ? { data: { data: { capabilities: { review: true, supervise: true, workActions: true }, profile: { displayName: 'Supervisor', userId: 'supervisor' } } } } : url.endsWith('/team') ? { data: { data: { candidates: [{ _id: 'candidate', displayName: 'Existing staff' }], members: [{ userId: 'candidate', mode: 'reviewer', availableMinutes: 90, availabilityDate: '2026-11-07', enabled: true }] } } } : original(url));
  api.put.mockResolvedValue({ data: { data: { profile: {} } } });
  await render({ _id: 'supervisor', role: 'admin' }, '/customer-service/summary');
  const select = container.querySelector('select[aria-label="Reviewer account"]');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'candidate'); select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('[aria-label="Review availability service date"]').value).toBe('2026-11-07');
  await act(async () => button('Save reviewer availability').click());
  expect(api.put).toHaveBeenCalledWith('/customer-service/team', expect.objectContaining({ userId: 'candidate', availableMinutes: 90, availabilityDate: '2026-11-07' }));
});

test('Today is the Dubai default on all pages and date choices survive navigation and reload', async () => {
  await render();
  const today = new Date(Date.now()+14400000).toISOString().slice(0,10);
  expect(container.querySelector('[aria-label="From date in Dubai"]').value).toBe(today);
  expect(container.querySelector('[aria-label="To date in Dubai"]').value).toBe(today);
  expect(api.get).toHaveBeenCalledWith('/customer-service/conversations',expect.objectContaining({params:expect.objectContaining({status:'open',assignment:'all'})}));
  await act(async()=>button('All time').click());
  expect(mockNavigate).toHaveBeenLastCalledWith('/customer-service/chats?period=all',{replace:true});
  expect(container.querySelector('nav a[href*="customers"]').getAttribute('href')).toContain('period=all');
  await render(undefined,'/customer-service/customers');expect(container.querySelector('[aria-label="From date in Dubai"]').value).toBe('');
  expect(api.get).toHaveBeenCalledWith('/customer-service/customers',expect.objectContaining({params:expect.not.objectContaining({from:today})}));
  await act(async()=>root.unmount());root=createRoot(container);await render(undefined,'/customer-service/customers');expect(container.querySelector('[aria-label="From date in Dubai"]').value).toBe('');
  mockSearch='?from=2026-10-01&to=2026-10-03';await render(undefined,'/customer-service/problems');expect(container.querySelector('[aria-label="From date in Dubai"]').value).toBe('2026-10-01');expect(container.querySelector('nav a[href*="summary"]').getAttribute('href')).toContain('from=2026-10-01');
  await act(async()=>button('Today').click());expect(container.querySelector('[aria-label="From date in Dubai"]').value).toBe(today);
  expect(mockNavigate).toHaveBeenLastCalledWith('/customer-service/problems?period=today',{replace:true});
});
test('a fresh opening resets to Today and source settings stay collapsed',async()=>{
 await render(undefined,'/customer-service/summary');expect(container.querySelector('[aria-label="From date in Dubai"]').value).toBe(new Date(Date.now()+14400000).toISOString().slice(0,10));
 const details=[...container.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Sources and settings');expect(details.open).toBe(false);
});

test('claiming a review sends the selected day and uses a new request after changing date scope',async()=>{
 api.post.mockRejectedValueOnce(new Error('Finish your open review or choose All time.')).mockResolvedValueOnce({data:{data:{review:null}}});
 await render(undefined,'/customer-service/reviews');await act(async()=>button('Start next review').click());
 const first=api.post.mock.calls[0][1];expect(first.filters.from).toBe(new Date(Date.now()+14400000).toISOString().slice(0,10));expect(first.filters.to).toBe(first.filters.from);
 await act(async()=>button('All time').click());await act(async()=>button('Start next review').click());expect(api.post.mock.calls[1][1].filters).toEqual({});expect(api.post.mock.calls[1][1].requestId).not.toBe(first.requestId);
});
test('changing dates hides an out-of-range active review while preserving its draft',async()=>{
 mockSearch='?period=all';const original=api.get.getMockImplementation();
 api.get.mockImplementation(async(url,options)=>url.endsWith('/reviews')?{data:{data:{reviews:options.params.from?[]:[{_id:'review1',issueId:'issue1',reviewerId:'reviewer',status:'in_review',sourceRevision:1,version:1,draft:{summary:'Saved draft'}}]}}}:url.endsWith('/issues/issue1')?{data:{data:{issue:{_id:'issue1',sourceRevision:1,customerName:'Older review'},messages:[],reviews:[]}}}:original(url,options));
 await render(undefined,'/customer-service/reviews');const summary=container.querySelector('[aria-label="Review summary"]');expect(summary).toBeTruthy();
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(summary,'Unsaved draft preserved');summary.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>button('Today').click());expect(container.querySelector('.cs-grid[hidden]')).toBeTruthy();expect(container.textContent).toContain('outside these filters');
 await act(async()=>button('All time').click());expect(container.querySelector('.cs-grid[hidden]')).toBeNull();expect(container.querySelector('[aria-label="Review summary"]').value).toBe('Unsaved draft preserved');
});
test('a custom range can be entered for resolved chats from All time one date at a time',async()=>{
 await render();
 await act(async()=>{const select=container.querySelector('[aria-label="Conversation status"]');select.value='resolved';select.dispatchEvent(new Event('change',{bubbles:true}));});await act(async()=>button('All time').click());
 const setDate=async(label,value)=>{const input=container.querySelector(`[aria-label="${label}"]`);await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});};
 await setDate('From date in Dubai','2026-08-08');
 expect(container.querySelector('[aria-label="From date in Dubai"]').value).toBe('2026-08-08');
 expect(container.querySelector('[aria-label="To date in Dubai"]').value).toBe('');
 await setDate('To date in Dubai','2026-08-31');
 expect(container.querySelector('[aria-label="From date in Dubai"]').value).toBe('2026-08-08');
 expect(container.querySelector('[aria-label="To date in Dubai"]').value).toBe('2026-08-31');
 expect(mockSearch).toBe('?from=2026-08-08&to=2026-08-31');
 expect(api.get).toHaveBeenCalledWith('/customer-service/conversations',expect.objectContaining({params:expect.objectContaining({from:'2026-08-08',to:'2026-08-31'})}));
});

test('an account switch clears the prior review draft and checks the new account before showing work',async()=>{
 const store=configureStore({reducer:{auth:(state={user:{_id:'reviewer',role:'admin'}},action)=>action.type==='switch-account'?{user:action.user}:state}});
 mockPathname='/customer-service/reviews';
 const original=api.get.getMockImplementation();let resolveSecond;
 api.get.mockImplementation(async(url,options)=>url.endsWith('/me')&&store.getState().auth.user._id==='other'?new Promise(resolve=>{resolveSecond=resolve;}):url.endsWith('/reviews')?{data:{data:{reviews:[{_id:'review1',issueId:'issue1',reviewerId:'reviewer',status:'in_review',sourceRevision:1,version:1,draft:{summary:'Private saved draft'}}]}}}:url.endsWith('/issues/issue1')?{data:{data:{issue:{_id:'issue1',sourceRevision:1,customerName:'Prior customer'},messages:[],reviews:[]}}}:original(url,options));
 await act(async()=>root.render(<Provider store={store}><CustomerService/></Provider>));
 expect(container.querySelector('[aria-label="Review summary"]').value).toBe('Private saved draft');
 await act(async()=>store.dispatch({type:'switch-account',user:{_id:'other',role:'admin'}}));
 expect(container.querySelector('[aria-label="Review summary"]')).toBeNull();expect(container.textContent).not.toContain('Prior customer');expect(container.textContent).toContain('Checking customer service access');
 await act(async()=>resolveSecond({data:{data:{capabilities:{},profile:null}}}));
 expect(container.textContent).toContain('Customer service access is not configured');expect(container.querySelector('[aria-label="Review summary"]')).toBeNull();
});
test('a late access response from a previous account cannot restore its permissions',async()=>{
 const store=configureStore({reducer:{auth:(state={user:{_id:'first',role:'admin'}},action)=>action.type==='switch-account'?{user:action.user}:state}});
 let resolveFirst,firstSignal;const original=api.get.getMockImplementation();
 api.get.mockImplementation((url,options)=>url.endsWith('/me')?(store.getState().auth.user._id==='first'?new Promise(resolve=>{resolveFirst=resolve;firstSignal=options.signal;}):Promise.resolve({data:{data:{capabilities:{},profile:null}}})):original(url,options));
 await act(async()=>root.render(<Provider store={store}><CustomerService/></Provider>));
 await act(async()=>store.dispatch({type:'switch-account',user:{_id:'second',role:'admin'}}));expect(firstSignal.aborted).toBe(true);
 await act(async()=>resolveFirst({data:{data:{capabilities:{supervise:true},profile:{displayName:'Previous supervisor'}}}}));
 expect(container.textContent).toContain('Customer service access is not configured');expect(container.textContent).not.toContain('Previous supervisor');
});
