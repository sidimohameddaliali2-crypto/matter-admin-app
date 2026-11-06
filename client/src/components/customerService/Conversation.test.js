import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Conversation from './Conversation';
import OwnerSelector from './OwnerSelector';
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
test('unavailable audio stays explicit and recorded author attribution is preserved', async () => {
  await act(async () => root.render(<Conversation issue={{ customerName: 'Captured customer' }} messages={[{ _id: 'm1', externalMessageId: 'source1', authorName: 'Recorded customer author', authorType: 'customer', sentAt: '2026-11-06T06:00:00Z', type: 'audio', mediaState: 'unavailable' }, { _id: 'm2', authorName: 'Source responder', authorType: 'staff', sentAt: '2026-11-06T06:03:00Z', type: 'text', text: 'Recorded reply' }]} />));
  expect(container.textContent).toContain('audio attachment · unavailable');
  expect(container.querySelector('audio')).toBeNull();
  expect(container.textContent).toContain('Source responder');
  expect(container.textContent).toContain('3 min elapsed');
  expect(container.textContent).toContain('10:03');
});
test('an automated acknowledgement is not counted as a human response', async () => {
  await act(async () => root.render(<Conversation messages={[{ _id: 'm1', authorType: 'customer', sentAt: '2026-11-06T06:00:00Z', text: 'Question' }, { _id: 'm2', authorType: 'bot', sentAt: '2026-11-06T06:01:00Z', text: 'Automated acknowledgement' }]} />));
  expect(container.textContent).not.toContain('min elapsed');
  expect(container.textContent).toContain('No subsequent human reply is present');
});
test('a reviewer can choose only self or a supervisor assignment request', async () => {
  await act(async () => root.render(<OwnerSelector value="me" onChange={() => {}} owners={[{ userId: 'me', displayName: 'Reviewer' }, { userId: 'other', displayName: 'Another colleague' }]} capabilities={{ workActions: true }} currentUserId="me"/>));
  expect([...container.querySelectorAll('option')].map(option => option.value)).toEqual(['', 'me']);
  expect(container.textContent).toContain('Ask supervisor');
  expect(container.textContent).not.toContain('Another colleague');
});
