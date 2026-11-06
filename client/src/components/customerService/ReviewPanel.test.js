import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ReviewPanel from './ReviewPanel';
import api from '../../utils/api';
jest.mock('../../utils/api', () => ({ __esModule: true, default: { post: jest.fn(), put: jest.fn() } }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, onSubmitted;
const review = { _id: 'review', version: 4, sourceRevision: 3, status: 'in_review', reviewerId: 'me', draft: { summary: 'Saved draft summary', verdict: 'good', outcome: 'open', categoryIds: ['renewal'], evidenceMessageIds: ['message'], action: { description: 'Confirm actual change', ownerId: 'me', dueAt: '2026-11-07T10:00:00.000Z' } } };
const detail = { issue: { _id: 'issue', sourceRevision: 3, outcome: 'open' }, messages: [{ _id: 'message', authorName: 'Actual responder', text: 'I will check', authorType: 'staff' }] };
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent.trim() === text);
beforeEach(async () => {
  jest.clearAllMocks(); onSubmitted = jest.fn();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<ReviewPanel review={review} detail={detail} categories={[{ id: 'renewal', label: 'Renewal' }]} owners={[{ userId: 'me', displayName: 'Me' }]} capabilities={{ review: true, workActions: true }} currentUserId="me" onSubmitted={onSubmitted} onReviewChanged={() => {}} />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
test('reload restores saved draft, selected owner and Dubai due time', () => {
  expect(container.querySelector('textarea[aria-label="Review summary"]').value).toBe('Saved draft summary');
  expect(container.querySelector('select[aria-label="Action owner"]').value).toBe('me');
  expect(container.querySelector('input[aria-label="Action due in Dubai"]').value).toBe('2026-11-07T14:00');
  expect(container.textContent).toContain('provisional');
});
test('failed submission keeps draft visible, does not advance and retains retry request id', async () => {
  api.post.mockRejectedValue({ response: { data: { message: 'Source changed. Reload this issue.' } } });
  await act(async () => button('Save review & next').click());
  expect(container.querySelector('[role="alert"]').textContent).toContain('Source changed');
  expect(onSubmitted).not.toHaveBeenCalled();
  expect(container.querySelector('textarea').value).toBe('Saved draft summary');
  const firstId = api.post.mock.calls[0][1].requestId;
  await act(async () => button('Save review & next').click());
  expect(api.post.mock.calls[1][1].requestId).toBe(firstId);
});
test('duplicate clicks cannot submit twice before the first result', async () => {
  let finish; api.post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { button('Save review & next').click(); button('Save review & next').click(); });
  expect(api.post).toHaveBeenCalledTimes(1);
  await act(async () => finish({ data: { data: { review: { ...review, status: 'submitted' } } } }));
  expect(onSubmitted).toHaveBeenCalledTimes(1);
});
test('new evidence warns and blocks submission until the issue is reloaded', async () => {
  await act(async () => root.render(<ReviewPanel review={review} detail={{ ...detail, issue: { ...detail.issue, sourceRevision: 8 } }} categories={[]} owners={[]} capabilities={{ review: true }} currentUserId="me" onSubmitted={onSubmitted} />));
  expect(container.textContent).toContain('New evidence');
  expect(button('Save review & next').disabled).toBe(true);
});
test('unmapped source staff allow an insufficient evidence judgment and never a negative grade', async () => {
  await act(async () => root.render(<ReviewPanel review={review} detail={{ ...detail, issue: { ...detail.issue, sourceMetadata: { unmappedStaff: true } } }} categories={[{ id: 'renewal', label: 'Renewal' }]} owners={[]} capabilities={{ review: true }} currentUserId="me" />));
  expect(container.querySelector('input[value="good"]').disabled).toBe(true);
  expect(container.querySelector('input[value="needs_work"]').disabled).toBe(true);
  expect(container.querySelector('input[value="insufficient"]').disabled).toBe(false);
  expect(button('Save review & next').disabled).toBe(true);
});
test('a captured thread needs a confirmed issue span before a handling grade', async () => {
  await act(async () => root.render(<ReviewPanel review={review} detail={{ ...detail, issue: { ...detail.issue, boundaryState: 'needs_review' } }} categories={[{ id: 'renewal', label: 'Renewal' }]} owners={[]} capabilities={{ review: true }} currentUserId="me"/>));
  expect(button('Save review & next').disabled).toBe(true);
  const confirmation = [...container.querySelectorAll('label')].find(label => label.textContent.includes('The selected messages define this issue episode'));
  await act(async () => confirmation.querySelector('input').click());
  expect(button('Save review & next').disabled).toBe(false);
});
