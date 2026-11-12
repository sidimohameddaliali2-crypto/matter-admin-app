import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import Reporting from './Reporting';
import api from '../../utils/api';
let mockUser;
let mockSearch;
jest.mock('react-redux',()=>({useSelector:selector=>selector({auth:{user:mockUser}})}));
jest.mock('react-router-dom',()=>({Link:({to,children})=><a href={to}>{children}</a>,useLocation:()=>({search:mockSearch})}),{virtual:true});
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let root,el;
beforeEach(()=>{jest.clearAllMocks();mockSearch='?conversation=111111111111111111111111&request=222222222222222222222222';mockUser={role:'viewer',permissions:{reports:true}};el=document.createElement('div');document.body.appendChild(el);root=createRoot(el);api.get.mockResolvedValue({data:{data:{summary:{requests:1},calendar:{confirmed:false},summaryScope:'Authorized requests',requests:[{requestId:'222222222222222222222222',conversationId:'111111111111111111111111',title:'Saved delivery issue',outcome:'Day credit applied',metrics:{counts:{answered:1,pending:0,unmeasurable:0},followups:[],resolution:{state:'resolved'},reopens:[]}}],nextOffset:null}}});});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();});
test('destination reporting shows retained issue evidence without the unavailable local reporting bridge',async()=>{
 await act(async()=>root.render(<Reporting filters={{from:'2026-11-01'}}/>));
 expect(el.textContent).toContain('Saved delivery issue');expect(el.textContent).toContain('Day credit applied');
 expect(el.querySelector('a[href="/reports"]')).not.toBeNull();
 expect(el.querySelector('a').getAttribute('href')).toContain('request=222222222222222222222222');
 expect(api.get).toHaveBeenCalledWith('/customer-service/request-report',expect.objectContaining({params:expect.objectContaining({from:'2026-11-01'})}));
 expect(el.querySelector('iframe')).toBeNull();
});
test('existing delivery report access remains subject to the original page permission',async()=>{
 mockUser={role:'viewer',permissions:{reports:false}};await act(async()=>root.render(<Reporting/>));
 expect(el.querySelector('a[href="/reports"]')).toBeNull();expect(el.textContent).toContain('Saved delivery issue');
});
test('general reporting returns to the preserved inbox without claiming there is an open request',async()=>{
 mockSearch='?period=all';
 await act(async()=>root.render(<Reporting inboxHref="/customer-service/chats?period=all&status=resolved&conversation=111111111111111111111111"/>));
 const back=el.querySelector('a');
 expect(back.textContent).toBe('Back to inbox');
 expect(back.getAttribute('href')).toContain('status=resolved&conversation=111111111111111111111111');
});
