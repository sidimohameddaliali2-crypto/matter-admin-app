import React,{act} from 'react';import {createRoot} from 'react-dom/client';import ServiceOperations from './ServiceOperations';
jest.mock('react-router-dom',()=>({Link:({to,children,...props})=><a href={to} {...props}>{children}</a>}),{virtual:true});
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn()}}));
import api from '../../utils/api';
global.IS_REACT_ACT_ENVIRONMENT=true;let root,container;beforeEach(()=>{api.get.mockResolvedValue({data:{data:null}});container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
test('business counts link to the same all-date inbox scope and diagnostics stay collapsed',async()=>{
 await act(async()=>root.render(<><ServiceOperations resource={{data:{backlog:{open:10,unassignedOpen:3},averageSeconds:600,medianSeconds:300,p90Seconds:1200,answeredTurns:25,agents:[{agent_id:'verified',name:'Source staff',replies:25,average_seconds:600,median_seconds:300}],captureQueue:{livePending:50},captureLatency:{samples:0},sync:{mode:'cloud'}}}}/></>));
 const links=[...container.querySelectorAll('a')];expect(links[0].getAttribute('href')).toBe('/customer-service/chats?period=all&status=open&assignment=all');expect(links[1].getAttribute('href')).toBe('/customer-service/chats?period=all&status=open&assignment=unassigned');expect(container.textContent).toContain('superseded daily window');expect(container.textContent).not.toContain('Source staff');expect(container.textContent).not.toContain('Incoming queue');expect(container.textContent).toContain('Not measured — no new arrival samples');expect([...container.querySelectorAll('details')].every(d=>!d.open)).toBe(true);
});
test('missing metrics stay unavailable rather than becoming zero activity',async()=>{
 await act(async()=>root.render(<><ServiceOperations resource={{loading:false,error:'Unavailable',data:null}}/></>));expect(container.textContent).toContain('Unavailable');expect(container.textContent).toContain('Not measured');expect(container.textContent).not.toContain('No verified human replies');expect(container.querySelector('.cs-metric strong').textContent).toBe('—');
});

test('incomplete health response does not crash the operational summary',async()=>{api.get.mockResolvedValue({data:{data:{}}});await act(async()=>root.render(<ServiceOperations resource={{data:null}}/>));expect(container.textContent).toContain('Unavailable');expect(container.textContent).toContain('Not measured capture conflicts');});
