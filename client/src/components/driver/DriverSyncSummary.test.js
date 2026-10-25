import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import DriverSyncSummary from './DriverSyncSummary';
global.IS_REACT_ACT_ENVIRONMENT=true;
test('pending uploads render safely and never claim completed or synced',async()=>{
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);const retry=jest.fn();
 await act(async()=>root.render(<DriverSyncSummary syncStatus={{a:{status:'pending'},b:{status:'failed'}}} onRetry={retry} />));
 expect(node.textContent).toContain('2 delivery updates awaiting server confirmation');
 expect(node.textContent).toContain('1 pending, 1 failed');
 await act(async()=>node.querySelector('button').click());expect(retry).toHaveBeenCalledTimes(1);
 await act(async()=>root.unmount());node.remove();
});
