import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import Problems from './Problems';
import {useServiceResource} from '../../components/customerService/serviceUtils';
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn()}}));
jest.mock('../../components/customerService/serviceUtils',()=>({...jest.requireActual('../../components/customerService/serviceUtils'),useServiceResource:jest.fn()}));
global.IS_REACT_ACT_ENVIRONMENT=true;
test('a saved next step is actionable from Follow-ups across all source dates',async()=>{
 useServiceResource.mockImplementation(path=>({loading:false,error:'',data:path==='/request-follow-ups'?{followups:[{id:'next-action:r',requestId:'r',conversationId:'old-thread',customerName:'Synthetic customer',responsibleId:'staff',action:'Confirm the requested change',status:'waiting',dueAt:'2026-11-12T06:00Z',source:'next_action'}]}:path==='/owners'?{owners:[{userId:'staff',displayName:'Recorded handler'}]}:{issues:[],actions:[]}}));
 const el=document.createElement('div');document.body.appendChild(el);const root=createRoot(el);
 try{await act(async()=>root.render(<Problems me={{profile:{userId:'staff'}}} user={{_id:'staff'}} capabilities={{workActions:true}} categories={[]} filters={{}} epoch={0} onRefresh={jest.fn()}/>));expect(el.textContent).toContain('Confirm the requested change');expect(el.textContent).toContain('Recorded handler');expect(el.textContent).toContain('1 loaded actions');expect(el.textContent).not.toContain('No actions in this queue');expect(el.querySelector('a').getAttribute('href')).toBe('/customer-service/chats?period=all&conversation=old-thread&request=r');}finally{await act(async()=>root.unmount());el.remove();}
});
test('changing follow-up search returns to page one',async()=>{
 useServiceResource.mockImplementation((path,params)=>({loading:false,error:'',data:path==='/request-follow-ups'?{followups:[],nextOffset:params.offset?null:50}:path==='/owners'?{owners:[]}:{issues:[],actions:[]}}));
 const el=document.createElement('div');document.body.appendChild(el);const root=createRoot(el),props={me:{profile:{userId:'staff'}},user:{_id:'staff'},capabilities:{workActions:true},categories:[],epoch:0,onRefresh:jest.fn()};
 try{await act(async()=>root.render(<Problems {...props} filters={{search:''}}/>));await act(async()=>[...el.querySelectorAll('button')].find(b=>b.textContent==='More request follow-ups').click());expect(useServiceResource.mock.calls.filter(([p])=>p==='/request-follow-ups').at(-1)[1].offset).toBe(50);await act(async()=>root.render(<Problems {...props} filters={{search:'a different customer'}}/>));expect(useServiceResource.mock.calls.filter(([p])=>p==='/request-follow-ups').at(-1)[1].offset).toBe(0);}finally{await act(async()=>root.unmount());el.remove();}
});
