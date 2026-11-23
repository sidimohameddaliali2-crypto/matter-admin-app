import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {DispatcherEvents} from './DispatcherActions';
import api from '../../utils/api';
import {businessToday} from '../../utils/dispatcher';
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let root,el,events;
const date=day=>businessToday().slice(0,8)+String(day).padStart(2,'0');
const fixture=(id,day,companyName,extra={})=>({_id:id,eventName:id,companyName,eventDate:date(day)+'T08:00:00Z',arrivalTime:'12:00',status:'pending',venue:{area:'Dubai'},...extra});
const day=number=>[...el.querySelectorAll('.dp-calendar button')].find(b=>b.textContent===String(number));
const click=async button=>act(async()=>button.click());
beforeEach(async()=>{
 events=[fixture('Matter event',2,'Matter'),fixture('Yellow Block event',3,'Yellow Block',{driverProvider:'matter'}),fixture('Matter on mixed day',4,'Matter'),fixture('Yellow Block on mixed day',4,'Yellow Block'),fixture('Joint event',5,'Matter & Yellow Block'),fixture('Another company',6,'Other company')];
 api.get.mockReset();api.get.mockResolvedValue({data:{events}});el=document.createElement('div');document.body.append(el);root=createRoot(el);await act(async()=>root.render(<div className="dp-workspace"><DispatcherEvents onClose={()=>{}}/></div>));
});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();});
test('day cells distinguish Matter, Yellow Block, both brands and days without events',()=>{
 expect(day(2).className).toBe('dp-day-matter');expect(day(3).className).toBe('dp-day-yellow-block');expect(day(4).className).toBe('dp-day-both');expect(day(5).className).toBe('dp-day-both');expect(day(6).className).toBe('dp-day-other');expect(day(7).className).toBe('');expect(el.querySelectorAll('.has-event')).toHaveLength(0);
 expect(day(4).getAttribute('aria-label')).toContain('MATTER and Yellow Block');
});
test('selecting a mixed day lists each event with its own visible brand label',async()=>{
 await click(day(4));const rows=[...el.querySelectorAll('.dp-event')];expect(rows).toHaveLength(2);expect(rows[0].querySelector('.dp-event-brand').textContent).toBe('MATTER');expect(rows[0].textContent).toContain('Matter on mixed day');expect(rows[1].querySelector('.dp-event-brand').textContent).toBe('Yellow Block');expect(rows[1].textContent).toContain('Yellow Block on mixed day');expect(day(4).getAttribute('aria-pressed')).toBe('true');expect(day(4).className).toBe('dp-day-both');
});
test('a joint event retains both visible brand labels and the company in its details',async()=>{
 await click(day(5));expect([...el.querySelectorAll('.dp-event-brand')].map(n=>n.textContent)).toEqual(['MATTER','Yellow Block']);await click(el.querySelector('.dp-event'));expect(el.textContent).toContain('Company');expect(el.textContent).toContain('Matter & Yellow Block');
});
test('Yellow Block event ownership stays pink when its driver provider is Matter',async()=>{
 await click(day(3));expect(day(3).className).toBe('dp-day-yellow-block');expect(el.querySelector('.dp-event-brand').textContent).toBe('Yellow Block');expect(el.querySelector('.dp-event-brand-matter')).toBeNull();
});
