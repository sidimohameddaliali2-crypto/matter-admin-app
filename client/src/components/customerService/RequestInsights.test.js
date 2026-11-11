import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import RequestInsights from './RequestInsights';
import {useServiceResource} from './serviceUtils';
jest.mock('./serviceUtils',()=>({useServiceResource:jest.fn(),formatDubai:value=>value||'Not recorded',idOf:value=>String(value||'')}));
global.IS_REACT_ACT_ENVIRONMENT=true;
test('unmeasurable assignment never displays a duration while interval evidence remains inspectable',async()=>{
 const container=document.createElement('div'),root=createRoot(container);
 useServiceResource.mockReturnValue({data:{requests:[{metrics:{coverage:'Linked only',calendar:{status:'Provisional',window:'Confirmed weekly'},counts:{},episodes:[],assignment:{state:'unmeasurable',windowOnlySeconds:7200},resolution:{state:'pending',windowOnlySeconds:600,activeTimePolicy:'Waiting shown separately'},waitingIntervals:[{team:'Delivery',from:'start',to:'end',windowOnlySeconds:60}],ownershipIntervals:[{ownerId:'staff-reference',from:'start',to:'end',windowOnlySeconds:120}],ownershipCoverage:'Recorded changes only',reopens:[{at:'yesterday',reason:'Customer supplied more evidence'}],followups:[]},suggestions:{coverage:'Linked only',candidates:[]}}]}});
 await act(async()=>root.render(<RequestInsights request={{_id:'isolated'}}/>));
 expect(container.textContent).not.toContain('120.0 min');expect(container.textContent).toContain('Assignment: unmeasurable · Unmeasurable');expect(container.textContent).toContain('Waiting so far · 10.0 min');expect(container.textContent).toContain('Waiting on Delivery');expect(container.textContent).toContain('Owner: Recorded staff (name unavailable)');expect(container.textContent).toContain('Customer supplied more evidence');
 await act(async()=>root.unmount());
});
