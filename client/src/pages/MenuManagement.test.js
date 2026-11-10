import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../utils/api';
import MenuManagement from './MenuManagement';
jest.mock('../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn(),put:jest.fn(),delete:jest.fn()}}));
jest.mock('../components/SupyRecipeSearch',()=>()=>null);
jest.mock('../components/IngredientTagEditor',()=>()=>null);
jest.mock('html2canvas',()=>jest.fn());
jest.mock('jspdf',()=>jest.fn());
const mockExcelRows = jest.fn();
jest.mock('xlsx-js-style',()=>({utils:{ book_new: () => ({}), aoa_to_sheet: rows => { mockExcelRows(rows); return {}; }, book_append_sheet: () => {} }, writeFile: jest.fn()}));
global.IS_REACT_ACT_ENVIRONMENT=true;

test('downloaded template includes a TRUE/FALSE Core Plan column and visible guidance', async () => {
  api.get.mockResolvedValue({ data: { success: true, data: [] } });
  mockExcelRows.mockClear();
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<MenuManagement />));
    await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent.trim() === 'New menu').click());
    await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent.trim() === 'Download Template').click());
    const rows = mockExcelRows.mock.calls[0][0];
    expect(rows[0][10]).toBe('CORE PLAN');
    expect(rows[1][10]).toBe('TRUE');
    expect(rows[2][10]).toBe('FALSE');
    expect(rows[3][10]).toBe('FALSE');
    expect(node.textContent).toContain('Older files without this column keep existing Core tags.');
  } finally { await act(async () => root.unmount()); node.remove(); jest.clearAllMocks(); }
});

test.each([true,false])('deletion success=%s preserves other pending customers and failed selections remain openable',async success=>{
  let release;
  const confirm=jest.spyOn(window,'confirm').mockReturnValue(true),alert=jest.spyOn(window,'alert').mockImplementation(()=>{});
  const rows=['a','b'].map(id=>({_id:id,firstName:`Customer ${id}`,email:`${id}@example.invalid`,matterCustomerId:id,selectedMeals:[]}));
  let details=0;
  api.get.mockImplementation(async(url,config)=>{
    if(url==='/menus')return{data:{success:true,data:[{_id:'menu',title:'Fixture',startDate:'2026-11-06',endDate:'2026-11-06',meals:[]}]}};
    if(url.endsWith('/selections'))return{data:{success:true,data:rows}};
    if(url.includes('kitchen-inputs')){
      if(++details===1)return new Promise(resolve=>{release=resolve;});
      return{data:{success:true,data:{customer_id:config.params.customerId,customer_name:'Fresh Detail',customer_email:config.params.email,subscription_id:'sub'}}};
    }
    return{data:{success:true,data:{}}};
  });
  api.delete.mockImplementation(async()=>{if(!success)throw new Error('Delete failed');return{data:{success:true}};});
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(<MenuManagement/>));
    await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent==='View selections').click());
    await act(async()=>node.querySelectorAll('.cursor-pointer.border-2')[0].click());
    await act(async()=>node.querySelectorAll('button[title="Delete selection"]')[success?1:0].click());
    await act(async()=>release({data:{success:true,data:{customer_id:'a',customer_name:'Pending A Detail',customer_email:rows[0].email,subscription_id:'sub'}}}));
    if(success){
      expect(node.textContent).toContain('Pending A Detail');
      expect(node.textContent).not.toContain('Customer b');
    }else{
      expect(node.textContent).not.toContain('Pending A Detail');
      expect(node.textContent).toContain('Customer a');
      expect(alert).toHaveBeenCalledWith('Failed to delete selection');
      await act(async()=>node.querySelectorAll('.cursor-pointer.border-2')[0].click());
      expect(node.textContent).toContain('Fresh Detail');
    }
  }finally{await act(async()=>root.unmount());node.remove();confirm.mockRestore();alert.mockRestore();jest.clearAllMocks();}
});

test.each(['during deletion','after deletion'])('a deleted selection cannot reopen from details arriving %s',async timing=>{
  let releaseDetails,releaseDelete;
  const confirm=jest.spyOn(window,'confirm').mockReturnValue(true);
  const raw={_id:'person',firstName:'Saved',email:'person@example.invalid',matterCustomerId:'person',selectedMeals:[{mealName:'Obsolete choice',quantity:2,remark:'veg'}]};
  api.get.mockImplementation(async url=>{
    if(url==='/menus')return{data:{success:true,data:[{_id:'menu',title:'Fixture',startDate:'2026-11-06',endDate:'2026-11-06',meals:[]}]}};
    if(url.endsWith('/selections'))return{data:{success:true,data:[raw]}};
    if(url.includes('kitchen-inputs'))return new Promise(resolve=>{releaseDetails=resolve;});
    return{data:{success:true,data:{}}};
  });
  api.delete.mockImplementation(()=>new Promise(resolve=>{releaseDelete=resolve;}));
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(<MenuManagement/>));
    await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent==='View selections').click());
    await act(async()=>node.querySelector('[aria-label="Search customers"]').closest('div').querySelector('.cursor-pointer').click());
    await act(async()=>node.querySelector('button[title="Delete selection"]').click());
    expect(api.delete).toHaveBeenCalledWith('/menus/menu/selections/person%40example.invalid');
    if(timing==='after deletion')await act(async()=>releaseDelete({data:{success:true}}));
    await act(async()=>releaseDetails({data:{success:true,data:{customer_id:'person',customer_name:'Deleted Customer Detail',customer_email:raw.email,subscription_id:'sub'}}}));
    expect(node.textContent).not.toContain('Deleted Customer Detail');
    expect(node.querySelector('.fixed.inset-0.bg-opacity-50')).toBeNull();
    expect(node.textContent).not.toContain('Checking current Matter customer details');
    if(timing==='during deletion')await act(async()=>releaseDelete({data:{success:true}}));
    expect(node.textContent).not.toContain('Obsolete choice');
  }finally{await act(async()=>root.unmount());node.remove();confirm.mockRestore();jest.clearAllMocks();}
});

test.each(['close button','outside overlay','hide selections'])('closing through %s cancels pending details and clears loading without reopening a modal',async closePath=>{
  let release;
  const raw={_id:'person',firstName:'Saved',email:'person@example.invalid',matterCustomerId:'person',selectedMeals:[{mealName:'Chosen chicken',quantity:2,remark:'veg'}]};
  const before=JSON.stringify(raw);
  api.get.mockImplementation(async url=>{
    if(url==='/menus')return{data:{success:true,data:[{_id:'menu',title:'Fixture',startDate:'2026-11-06',endDate:'2026-11-06',meals:[]}]}};
    if(url.endsWith('/selections'))return{data:{success:true,data:[raw]}};
    if(url.includes('kitchen-inputs'))return new Promise(resolve=>{release=resolve;});
    return{data:{success:true,data:{}}};
  });
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(<MenuManagement/>));
    await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent==='View selections').click());
    await act(async()=>node.querySelector('[aria-label="Search customers"]').closest('div').querySelector('.cursor-pointer').click());
    expect(release).toBeDefined();
    expect(node.textContent).toContain('Checking current Matter customer details');
    await act(async()=>{
      if(closePath==='close button')node.querySelector('button[title="Close"]').click();
      else if(closePath==='outside overlay')node.querySelector('.fixed.inset-0.bg-black\\/50').click();
      else [...node.querySelectorAll('button')].find(b=>b.textContent==='Hide selections').click();
    });
    expect(node.querySelector('[aria-label="Search customers"]')).toBeNull();
    // Open again before the old request returns: it must not open a stale
    // customer's modal or leave the new panel's loading state active.
    await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent==='View selections').click());
    expect(node.textContent).not.toContain('Checking current Matter customer details');
    await act(async()=>release({data:{success:true,data:{customer_id:'person',customer_name:'Late Matter Name',customer_email:raw.email,subscription_id:'sub'}}}));
    expect(node.textContent).not.toContain('Late Matter Name');
    expect(node.querySelector('.fixed.inset-0.bg-opacity-50')).toBeNull();
    expect(JSON.stringify(raw)).toBe(before);
    expect(api.put).not.toHaveBeenCalled();expect(api.delete).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());node.remove();jest.clearAllMocks();}
});

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


test('Cycle import saves a new dated draft and reopening preserves its private snapshot', async () => {
  const meals = [{ id:'own-meal',name:'Own Chicken',mealKind:'Main meal',mealType:'Chicken',temperature:'WARM',carbCombined:'No',components:[{id:'p',type:'Protein',name:'Chicken portion',exclusions:['Nuts'],notes:'Private preparation'}] }];
  const board=Array.from({length:7},()=>Array.from({length:4},()=>[]));board[0][1]=[{mealId:'own-meal',isMatterCore:true}];
  sessionStorage.setItem('matter-admin-v2:workbook-cycle-v2',JSON.stringify({meals,source:'Own.xlsx'}));
  sessionStorage.setItem('matter-admin-v2:weekly-board-v1',JSON.stringify({'Main menu:Week 1':board}));
  const before=[sessionStorage.getItem('matter-admin-v2:workbook-cycle-v2'),sessionStorage.getItem('matter-admin-v2:weekly-board-v1')];
  let saved;
  api.get.mockImplementation(async url=>({data:{success:true,data:url==='/menus'?[]:saved}}));
  api.post.mockImplementation(async (_url,payload)=>{
    saved={_id:'saved-menu',...payload,meals:payload.days.flatMap(day=>day.items.map((item,index)=>({date:day.date,mealType:item.mealType,items:[{...item,_id:`saved-${index}`}]})))};
    return {data:{success:true,data:saved}};
  });
  api.put.mockImplementation(async (_url,payload)=>({data:{success:true,data:{...saved,...payload}}}));
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  const click=async text=>act(async()=>[...node.querySelectorAll('button')].find(button=>button.textContent.trim()===text).click());
  const fill=async(input,value)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  try {
    await act(async()=>root.render(<MenuManagement/>));await click('New menu');
    await fill(node.querySelector('input[placeholder="Menu Title"]'),'Imported menu');
    await fill(node.querySelector('input[aria-label="Menu start date"]'),'2026-11-09');
    await fill(node.querySelector('input[aria-label="Menu end date"]'),'2026-11-15');
    await click('Create from Cycle Menu');expect(node.textContent).toContain('Own Chicken');
    await click('Save draft');
    const payload=api.post.mock.calls.at(-1)[1];expect(payload.title).toBe('Imported menu');const imported=payload.days[0].items[0];
    expect(imported.cycleMeal.components).toEqual(meals[0].components);expect(imported).toMatchObject({rotationCategory:'main',usedForCorePlan:true,intolerances:'',allergens:''});
    await click('Edit');expect([...node.querySelectorAll('button')].some(button=>button.textContent.trim()==='Create from Cycle Menu')).toBe(false);
    await act(async()=>node.querySelector('.cursor-pointer.bg-white.rounded-lg').click());
    const combined=node.querySelector('input[aria-label="Carb combined with veg"]');expect(combined).not.toBeNull();
    await act(async()=>combined.click());await click('Close');
    await click('Save draft');expect(api.put.mock.calls.at(-1)[1].days[0].items[0].cycleMeal).toEqual({...imported.cycleMeal,carbCombined:'Yes'});
    expect([sessionStorage.getItem('matter-admin-v2:workbook-cycle-v2'),sessionStorage.getItem('matter-admin-v2:weekly-board-v1')]).toEqual(before);
  } finally {await act(async()=>root.unmount());node.remove();sessionStorage.clear();jest.clearAllMocks();}
});


test.each(['Save draft','Publish & copy link'])('%s with a whitespace title never calls the API',async action=>{
  api.get.mockResolvedValue({data:{success:true,data:[]}});api.post.mockClear();api.put.mockClear();
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  const click=async text=>act(async()=>[...node.querySelectorAll('button')].find(button=>button.textContent.trim()===text).click());
  try{
    await act(async()=>root.render(<MenuManagement/>));await click('New menu');
    const input=node.querySelector('input[placeholder="Menu Title"]');
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'   ');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await click(action);
    expect(api.post).not.toHaveBeenCalled();expect(api.put).not.toHaveBeenCalled();
    expect(node.textContent).toContain('Enter a menu title before saving or publishing.');expect(document.activeElement).toBe(input);
  }finally{await act(async()=>root.unmount());node.remove();jest.clearAllMocks();}
});

test('Cycle import supplies a dated title when no title was entered',async()=>{
  const meal={id:'cycle',name:'Chicken',mealKind:'Main meal',mealType:'Chicken',components:[{id:'p',type:'Protein',name:'Chicken',exclusions:[]}]};
  const board=Array.from({length:7},()=>Array.from({length:4},()=>[]));board[0][1]=[{mealId:'cycle'}];
  sessionStorage.setItem('matter-admin-v2:workbook-cycle-v2',JSON.stringify({meals:[meal]}));sessionStorage.setItem('matter-admin-v2:weekly-board-v1',JSON.stringify({'Main menu:Week 1':board}));
  api.get.mockResolvedValue({data:{success:true,data:[]}});
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  const click=async text=>act(async()=>[...node.querySelectorAll('button')].find(button=>button.textContent.trim()===text).click());
  const fill=async(input,value)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  try{
    await act(async()=>root.render(<MenuManagement/>));await click('New menu');
    await fill(node.querySelector('input[aria-label="Menu start date"]'),'2026-11-16');await fill(node.querySelector('input[aria-label="Menu end date"]'),'2026-11-22');
    await click('Create from Cycle Menu');expect(node.querySelector('input[placeholder="Menu Title"]').value).toBe('Week 1 · 2026-11-16 – 2026-11-22');
  }finally{await act(async()=>root.unmount());node.remove();sessionStorage.clear();jest.clearAllMocks();}
});
