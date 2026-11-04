import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import MenuManagement from './MenuManagement';
jest.mock('../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn(),put:jest.fn(),delete:jest.fn()}}));
jest.mock('../components/SupyRecipeSearch',()=>()=>null);
jest.mock('../components/IngredientTagEditor',()=>()=>null);
jest.mock('html2canvas',()=>jest.fn());
jest.mock('jspdf',()=>jest.fn());
jest.mock('xlsx-js-style',()=>({utils:{}}));
global.IS_REACT_ACT_ENVIRONMENT=true;

test('an old menu response cannot replace the newly selected menu', async()=>{
  const pending={};
  api.get.mockImplementation(async url=>{
    if(url==='/menus')return{data:{success:true,data:['a','b'].map(_id=>({_id,title:_id,startDate:'2026-11-06',endDate:'2026-11-06',meals:[]}))}};
    if(url.endsWith('/selections'))return new Promise(resolve=>{pending[url]=resolve;});
    return{data:{success:true,data:{}}};
  });
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(<MenuManagement/>));
    await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent==='View selections').click());
    await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent==='View selections').click());
    await act(async()=>pending['/menus/b/selections']({data:{success:true,data:[{_id:'b-person',firstName:'Current menu customer',selectedMeals:[]}]}}));
    await act(async()=>pending['/menus/a/selections']({data:{success:true,data:[{_id:'a-person',firstName:'Obsolete menu customer',selectedMeals:[]}]}}));
    expect(node.textContent).toContain('Current menu customer');
    expect(node.textContent).not.toContain('Obsolete menu customer');
  }finally{await act(async()=>root.unmount());node.remove();jest.clearAllMocks();}
});

test('menu browser loads saved choices without nutrition fan-out; opening a customer verifies current Matter details', async()=>{
  const date='2026-11-06';
  const raw={_id:'person',firstName:'Saved',lastName:'Name',email:'person@example.invalid',matterCustomerId:'person',selectedMeals:[{date,mealName:'Chosen chicken',mealType:'main',quantity:2,remark:'veg'}]};
  const before=JSON.stringify(raw);
  api.get.mockImplementation(async(url)=>{
    if(url==='/menus')return{data:{success:true,data:[{_id:'menu',title:'Fixture menu',startDate:date,endDate:date,isPublished:true,selectionCount:1,meals:[]}]}};
    if(url.endsWith('/selections'))return{data:{success:true,data:[raw]}};
    if(url.includes('kitchen-inputs'))return{data:{success:true,data:{customer_id:'person',customer_name:'Current Name',customer_email:raw.email,subscription_id:'sub',plan_name:'Custom',exclusions:[]}}};
    return{data:{success:true,data:{}}};
  });
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(<MenuManagement/>));
    await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent==='View selections').click());
    expect(node.textContent).toContain('Saved Name');
    expect(node.textContent).toContain('Chosen chicken');
    expect(api.get.mock.calls.filter(([url])=>url.includes('kitchen-inputs'))).toHaveLength(0);
    await act(async()=>node.querySelector('[aria-label="Search customers"]').closest('div').querySelector('.cursor-pointer').click());
    expect(api.get.mock.calls.filter(([url])=>url.includes('kitchen-inputs'))).toHaveLength(1);
    expect(node.textContent).toContain('Current Name');
    expect(JSON.stringify(raw)).toBe(before);
  }finally{await act(async()=>root.unmount());node.remove();jest.clearAllMocks();}
});
