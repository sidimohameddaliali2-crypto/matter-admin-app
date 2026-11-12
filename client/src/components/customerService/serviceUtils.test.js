import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { inboxStateFromSearch, isActionOverdue, updateServiceFilterSearch, useServiceResource } from './serviceUtils';
import api from '../../utils/api';
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
function Evidence({ path, category = '' }) {
  const resource = useServiceResource(path, { categoryId: category });
  return <div>{resource.data?.text}{resource.loading && <p>Loading</p>}{resource.error && <p role="alert">{resource.error}</p>}<button onClick={resource.refresh}>Refresh</button></div>;
}
beforeEach(() => { jest.clearAllMocks(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
test('switching issue identity immediately hides prior evidence and a failed fetch never restores it', async () => {
  api.get.mockResolvedValueOnce({ data: { data: { text: 'Previous customer private evidence' } } });
  await act(async () => root.render(<Evidence path="/issues/one"/>));
  expect(container.textContent).toContain('Previous customer private evidence');
  let reject;
  api.get.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  await act(async () => root.render(<Evidence path="/issues/two"/>));
  expect(container.textContent).not.toContain('Previous customer private evidence');
  await act(async () => reject({ response: { data: { message: 'New issue unavailable' } } }));
  expect(container.textContent).not.toContain('Previous customer private evidence');
  expect(container.querySelector('[role="alert"]').textContent).toContain('New issue unavailable');
});
test('same-identity failed refresh retains that records last successful evidence', async () => {
  api.get.mockResolvedValueOnce({ data: { data: { text: 'Current customer evidence' } } });
  await act(async () => root.render(<Evidence path="/issues/one"/>));
  api.get.mockRejectedValueOnce({ response: { data: { message: 'Refresh unavailable' } } });
  await act(async () => container.querySelector('button').click());
  expect(container.textContent).toContain('Current customer evidence');
  expect(container.textContent).toContain('Refresh unavailable');
});
test('a changed filter is a new data identity and cannot retain another scope', async () => {
  api.get.mockResolvedValueOnce({ data: { data: { text: 'Delivery-only cases' } } });
  await act(async () => root.render(<Evidence path="/issues" category="delivery"/>));
  api.get.mockRejectedValueOnce({ response: { data: { message: 'Filtered scope unavailable' } } });
  await act(async () => root.render(<Evidence path="/issues" category="renewal"/>));
  expect(container.textContent).not.toContain('Delivery-only cases');
});
test('an overdue customer promise remains overdue when an internal due time is later', () => {
  const now = new Date('2026-11-06T10:00:00Z');
  expect(isActionOverdue({ status: 'waiting', dueAt: '2026-11-06T12:00:00Z', promisedDueAt: '2026-11-06T09:00:00Z' }, now)).toBe(true);
  expect(isActionOverdue({ status: 'assigned', dueAt: '2026-11-06T12:00:00Z' }, now)).toBe(false);
  expect(isActionOverdue({ status: 'completed', promisedDueAt: '2026-11-06T09:00:00Z' }, now)).toBe(false);
});

test('filter edits preserve inbox source and work context, while malformed queue choices use safe defaults',()=>{
 const result=updateServiceFilterSearch({from:'',to:'',search:'sample',categoryId:''},'?status=resolved&assignment=mine&conversation=chat&request=work&source=history&view=work');
 expect(Object.fromEntries(new URLSearchParams(result))).toMatchObject({period:'all',q:'sample',status:'resolved',assignment:'mine',conversation:'chat',request:'work',source:'history',view:'work'});
 expect(inboxStateFromSearch('?status=anything&assignment=anything&source=anything&view=anything')).toEqual({status:'open',assignment:'all',source:'native',workQueue:false,conversation:''});
 expect(inboxStateFromSearch(result)).toMatchObject({status:'resolved',source:'history',workQueue:true,conversation:'chat'});
});
