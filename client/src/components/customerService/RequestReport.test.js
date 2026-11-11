import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import RequestReport from './RequestReport';
import api from '../../utils/api';
jest.mock('react-router-dom',()=>({Link:({to,children})=><a href={to}>{children}</a>}),{virtual:true});
jest.mock('../../utils/api',()=>({__esModule:true,default:{get:jest.fn()}}));
global.IS_REACT_ACT_ENVIRONMENT=true;
let root,el;
const row={requestId:'request-one',conversationId:'conversation-one',title:'Correct paid renewal dates',excerpt:'Hello',metrics:{counts:{answered:0,pending:1,unmeasurable:0},followups:[],resolution:{state:'pending'},reopens:[]}};
const data=rows=>({summary:{requests:rows.length},calendar:{confirmed:false},requests:rows,nextOffset:null,summaryScope:'This page',asOf:'2026-11-10T08:00:00Z'});
beforeEach(()=>{jest.clearAllMocks();el=document.createElement('div');document.body.appendChild(el);root=createRoot(el);});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();});
const render=async rows=>{api.get.mockResolvedValue({data:{data:data(rows)}});await act(async()=>root.render(<RequestReport filters={{}} epoch={rows.length}/>));};
test('report identifies a registered issue by its summary and preserves legacy excerpt fallback',async()=>{
 await render([row,{...row,requestId:'legacy',title:undefined,excerpt:'Retained legacy issue excerpt'}]);
 const cells=[...el.querySelectorAll('tbody tr')].map(tr=>tr.cells[0].textContent);expect(cells).toEqual(['Correct paid renewal dates','Retained legacy issue excerpt']);expect(el.querySelector('tbody').textContent).not.toContain('Hello');
});
test('report retains the selected topic and exact issue detail next to its saved issue',async()=>{
 await render([{...row,topicLabel:'Website & Account',issueDetailLabel:'Login Issue'}]);
 const cell=el.querySelector('tbody tr').cells[0];expect(cell.textContent).toContain('Correct paid renewal dates');expect(cell.textContent).toContain('Website & Account · Login Issue');
 expect(el.querySelector('tbody a').getAttribute('href')).toContain('request=request-one');
});
