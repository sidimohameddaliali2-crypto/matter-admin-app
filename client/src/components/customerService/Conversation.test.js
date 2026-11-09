import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Conversation from './Conversation';
import OwnerSelector from './OwnerSelector';
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
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
test('internal notes retain their author and content but never stop the customer reply clock',async()=>{
 await act(async()=>root.render(<Conversation messages={[
 {_id:'customer',authorType:'customer',sentAt:'2026-11-06T06:00:00Z',text:'Question'},
 {_id:'note',authorType:'staff',authorName:'Recorded colleague',internalNote:true,sentAt:'2026-11-06T06:01:00Z',text:'Private handover'},
 {_id:'reply',authorType:'staff',authorName:'Responder',sentAt:'2026-11-06T06:07:00Z',text:'Customer-facing reply'}
 ]}/>));
 expect(container.textContent).toContain('Recorded colleague');expect(container.textContent).toContain('Internal note');expect(container.textContent).toContain('Private handover');expect(container.textContent).toContain('First captured human reply: 7 min elapsed');expect(container.textContent).not.toContain('1 min elapsed');expect(container.textContent).not.toContain('Next human reply');
});
test('an internal-only reply leaves the customer unanswered in the capture',async()=>{
 await act(async()=>root.render(<Conversation messages={[{_id:'c',authorType:'customer',sentAt:'2026-11-06T06:00:00Z',text:'Question'},{_id:'n',authorType:'staff',internalNote:true,sentAt:'2026-11-06T06:01:00Z',text:'Internal note'}]}/>));expect(container.textContent).toContain('No subsequent human reply');expect(container.querySelector('.cs-wait')).toBeNull();
});
test('system activity is collapsed centrally and never rendered as missing media or customer speech',async()=>{
 await act(async()=>root.render(<Conversation conversationId="thread" issue={{customerName:'One header'}} messages={[{_id:'event',authorType:'system',authorName:'Gallabox system event',type:'other',sentAt:'2026-11-07T13:24:00Z',display:{eventLabel:'Conversation started'}},{_id:'auto',authorType:'unknown',type:'text',sentAt:'2026-11-07T13:24:01Z',text:'Away reply',display:{automatedReply:true}}]}/>));
 expect(container.querySelector('.cs-system-event')).not.toBeNull();expect(container.querySelector('.cs-system-event').open).toBe(false);expect(container.textContent).toContain('Conversation started');expect(container.textContent).not.toContain('other attachment');expect(container.textContent).toContain('Automatic reply');expect(container.textContent).not.toContain('Unknown author');expect(container.textContent).not.toContain('One header');
});
test('native chat uses incoming/outgoing alignment, Dubai day breaks and formatted automatic replies',async()=>{
 await act(async()=>root.render(<Conversation conversationId="thread" messages={[
 {_id:'old',externalConversationId:'old',authorType:'customer',sentAt:'2026-01-26T11:01:00Z',type:'text',text:'Earlier'},
 {_id:'new',externalConversationId:'new',authorType:'customer',sentAt:'2026-11-07T13:24:00Z',type:'text',text:'Hello'},
 {_id:'auto',externalConversationId:'new',authorType:'unknown',display:{automatedReply:true},sentAt:'2026-11-07T13:24:01Z',type:'text',text:'_We are outside working hours._'},
 {_id:'next',externalConversationId:'new',authorType:'customer',sentAt:'2026-11-07T13:25:00Z',type:'text',text:'A **two week** plan'}
 ]}/>));expect(container.querySelector('#cs-message-auto').className).toContain('outgoing');expect(container.querySelector('#cs-message-auto').className).not.toContain('system');expect(container.querySelector('#cs-message-auto em').textContent).toBe('We are outside working hours.');expect(container.querySelector('#cs-message-next strong').textContent).toBe('Customer');expect(container.querySelector('#cs-message-next .cs-bubble strong').textContent).toBe('two week');expect(container.querySelectorAll('.cs-day-divider')).toHaveLength(2);expect(container.querySelector('#cs-message-auto time').textContent).toBe('17:24');expect(container.textContent).not.toContain('Source reference');expect(container.textContent).not.toContain('No subsequent human reply');
});
test('reply clocks do not bridge distinct native conversation IDs',async()=>{await act(async()=>root.render(<Conversation messages={[{_id:'one',externalConversationId:'old',authorType:'customer',sentAt:'2026-01-01T00:00:00Z',text:'Old question'},{_id:'two',externalConversationId:'new',authorType:'staff',sentAt:'2026-11-07T00:00:00Z',text:'Different session'}]}/>));expect(container.querySelector('.cs-wait')).toBeNull();});
test('restored templates display source content on the outgoing side and reactions stay compact',async()=>{await act(async()=>root.render(<Conversation conversationId="c" messages={[{_id:'template',authorType:'unknown',sentAt:'2026-01-01T10:00:00Z',type:'other',text:'',display:{direction:'outgoing',nativeContent:{kind:'template',text:'Original **template**',buttons:['Original option']}}},{_id:'reaction',authorType:'customer',authorName:'Recorded customer',sentAt:'2026-01-01T10:01:00Z',type:'other',display:{nativeContent:{kind:'reaction',emoji:'👍'}}}]} />));expect(container.querySelector('#cs-message-template').className).toContain('outgoing');expect(container.querySelector('#cs-message-template .cs-bubble strong').textContent).toBe('template');expect(container.textContent).toContain('Original option');expect(container.querySelector('#cs-message-reaction').className).toContain('cs-system-event');expect(container.querySelector('#cs-message-reaction .cs-bubble')).toBeNull();expect(container.textContent).not.toContain('details are not available');});
