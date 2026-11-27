import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import EntryApp, {isPublicMenuPath} from './EntryApp';
import api from './utils/publicMenuApi';

const mockStaffLoaded=jest.fn();
jest.mock('./App',()=>{mockStaffLoaded();global.localStorage.getItem('partnerToken');return {__esModule:true,default:()=> <p>Staff app</p>};});
jest.mock('./utils/publicMenuApi',()=>({get:jest.fn(),post:jest.fn()}));
let host,root,storage,scroll;
beforeEach(()=>{
 global.IS_REACT_ACT_ENVIRONMENT=true;
 storage=Object.getOwnPropertyDescriptor(window,'localStorage');
 scroll=jest.spyOn(window,'scrollTo').mockImplementation(()=>{});
 host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);
 api.get.mockResolvedValue({data:{data:{title:'Customer fixture',startDate:'2099-10-21',endDate:'2099-10-27',meals:[]}}});
});
afterEach(()=>{act(()=>root.unmount());host.remove();Object.defineProperty(window,'localStorage',storage);scroll.mockRestore();window.history.replaceState({},'','/');});
test.each(['/menu-select/long-token','/m/short-code'])('public menu %s renders with storage blocked and never evaluates staff stores',async path=>{
 window.history.replaceState({},'',path);
 Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Blocked','SecurityError');}});
 await act(async()=>{root.render(<EntryApp/>);});
 expect(mockStaffLoaded).not.toHaveBeenCalled();
 expect(host.textContent).toContain('Customer Fixture');
 expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/menus/share/'),expect.objectContaining({timeout:45000}));
});
test.each(['/menus','/menu-select-v2','/m','/m/code/extra'])('%s stays in the staff/normal router',path=>expect(isPublicMenuPath(path)).toBe(false));

test('Accounts links render without staff stores or browser storage',async()=>{
 window.history.replaceState({},'','/refund/complete#'+'a'.repeat(43));
 Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Blocked','SecurityError');}});
 global.fetch=jest.fn().mockResolvedValue({ok:true,json:async()=>({success:true,data:{customerName:'Accounts fixture',customerId:'C001',amount:155,status:'pending',version:0}})});
 await act(async()=>root.render(<EntryApp/>));
 expect(mockStaffLoaded).not.toHaveBeenCalled();
 expect(host.textContent).toContain('Accounts fixture');
 expect(host.textContent).toContain('No staff login is required');
});
test('normal staff pages still load their existing application',async()=>{
 window.history.replaceState({},'','/menus');
 await act(async()=>root.render(<EntryApp/>));
 expect(host.textContent).toContain('Staff app');
 expect(mockStaffLoaded).toHaveBeenCalledTimes(1);
});
