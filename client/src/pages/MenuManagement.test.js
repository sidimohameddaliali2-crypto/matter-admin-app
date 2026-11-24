import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TextDecoder, TextEncoder } from 'util';
import api from '../utils/api';
import MenuManagement from './MenuManagement';
import jsPDF from 'jspdf';
import { mealCreationStore } from '../utils/mealCreationStore';
import { recordActivityChange } from '../utils/activityCapture';
jest.mock('../utils/activityCapture',()=>({...jest.requireActual('../utils/activityCapture'),recordActivityChange:jest.fn()}));
jest.mock('../utils/mealCreationStore',()=>({mealCreationStore:{flush:jest.fn(async()=>{}),getSnapshot:()=>({error:''}),load:jest.fn()}}));
jest.mock('../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn(),put:jest.fn(),delete:jest.fn()}}));
jest.mock('../components/SupyRecipeSearch',()=>()=>null);
jest.mock('../components/IngredientTagEditor',()=>()=>null);
jest.mock('html2canvas',()=>jest.fn());
jest.mock('jspdf',()=>jest.fn());
const mockExcelRows = jest.fn();
const mockUploadRows = jest.fn();
jest.mock('xlsx-js-style',()=>({read:()=>({Sheets:{Meals:{}},SheetNames:['Meals']}),utils:{sheet_to_json:()=>mockUploadRows(),book_new: () => ({}), aoa_to_sheet: rows => { mockExcelRows(rows); return {}; }, book_append_sheet: () => {} }, writeFile: jest.fn()}));
global.IS_REACT_ACT_ENVIRONMENT=true;
global.TextEncoder ??= TextEncoder;
global.TextDecoder ??= TextDecoder;

test.each([false,true])('publishing immediately updates Preview to the copied short link (clipboard blocked: %s)',async blocked=>{
  const shortToken='Ab3dE6fG9hJ2kL5m',shareUrl=`https://matterapp.online/m/${shortToken}`;
  const menu={_id:'published-fixture',title:'Published fixture',startDate:'2099-01-05',endDate:'2099-01-11',isPublished:true,meals:[],shareLink:{token:'original-long-token',isActive:true}};
  api.get.mockImplementation(async url=>({data:{success:true,data:url==='/menus'?[]:{shareUrl,shortToken}}}));
  api.post.mockResolvedValue({data:{success:true,data:menu}});
  const clipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');
  const writeText=blocked?jest.fn().mockRejectedValue(new Error('Not allowed')):jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  const click=async label=>act(async()=>[...node.querySelectorAll('button')].find(button=>button.textContent.trim()===label).click());
  try{
    await act(async()=>root.render(<MenuManagement/>));await click('New menu');
    await act(async()=>{const input=node.querySelector('input[placeholder="Menu Title"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Published fixture');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await click('Publish & copy link');
    expect(writeText).toHaveBeenCalledWith(shareUrl);
    const preview=[...node.querySelectorAll('a')].find(link=>link.textContent.trim()==='Preview');
    expect(preview.getAttribute('href')).toBe(`/m/${shortToken}`);
    expect(api.get.mock.calls.filter(([url])=>url.endsWith('/share-link'))).toHaveLength(1);
    if(blocked)expect(node.textContent).toContain('Menu saved. Use Copy link');
  }finally{
    await act(async()=>root.unmount());node.remove();
    if(clipboard)Object.defineProperty(navigator,'clipboard',clipboard);else delete navigator.clipboard;
    jest.clearAllMocks();
  }
});

test('Copy link uses the short URL and updates Preview without rotating the original link', async()=>{
  const code='Ab3dE6fG9hJ2kL5m', shareUrl=`https://matterapp.online/m/${code}`;
  const menu={_id:'short-link-menu',title:'Short link fixture',startDate:'2099-01-05',endDate:'2099-01-11',isPublished:true,meals:[],shareLink:{token:'original-long-token',isActive:true}};
  api.get.mockImplementation(async url=>({data:{success:true,data:url==='/menus'?[menu]:{shareUrl,shortToken:code,shareLink:menu.shareLink.token}}}));
  const clipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');
  const writeText=jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  try{
    await act(async()=>root.render(<MenuManagement/>));
    expect(node.querySelector('a[target="_blank"]').getAttribute('href')).toBe('/menu-select/original-long-token');
    await act(async()=>[...node.querySelectorAll('button')].find(button=>button.textContent.trim()==='Copy link').click());
    expect(writeText).toHaveBeenCalledWith(shareUrl);
    expect(node.textContent).toContain('Copied!');
    expect(node.querySelector('a[target="_blank"]').getAttribute('href')).toBe(`/m/${code}`);
    expect(menu.shareLink.token).toBe('original-long-token');
  }finally{
    await act(async()=>root.unmount());node.remove();
    if(clipboard)Object.defineProperty(navigator,'clipboard',clipboard);else delete navigator.clipboard;
    jest.clearAllMocks();
  }
});

test('menu meal duplication, removal and allergen choices are observed before saving', async()=>{
  const date='2099-01-05', menu={_id:'week',title:'Fixture menu',startDate:date,endDate:date,meals:[{date,mealType:'main',items:[{_id:'meal',mealName:'Roast chicken',mealType:'main',allergens:''}]}]};
  api.get.mockImplementation(async url=>({data:{success:true,data:url==='/menus'?[menu]:menu}}));
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  const click=async label=>act(async()=>[...node.querySelectorAll('button')].find(button=>button.textContent.trim()===label).click());
  try{
    await act(async()=>root.render(<MenuManagement/>));await click('Edit');
    expect(recordActivityChange).not.toHaveBeenCalled();
    act(()=>[...node.querySelectorAll('.cursor-pointer')].find(element=>element.textContent.includes('Roast chicken')).click());
    await click('Nuts');
    expect(recordActivityChange.mock.calls.some(([change])=>change.field.includes('Allergens')&&change.after.includes('Nuts'))).toBe(true);
    await click('Duplicate');await click('Remove meal');
    expect(recordActivityChange.mock.calls.filter(([change])=>change.field.includes('Menu meals'))).toHaveLength(2);
    expect(api.post).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());node.remove();jest.clearAllMocks();}
});

test('customer meal replacement and removal observe the unsaved selected slot',async()=>{
  const date='2099-01-05',customer={_id:'customer',firstName:'Aster',email:'fixture@example.invalid',mealPerDay:1,selectedMeals:[{date,mealType:'main',mealName:'Original meal',menuItemId:'old',quantity:1}]};
  const menu={_id:'menu',title:'Fixture',startDate:date,endDate:date,meals:[{date,mealType:'main',items:[{_id:'new',mealName:'Replacement meal',mealType:'main'}]}]};
  api.get.mockImplementation(async url=>({data:{success:true,data:url==='/menus'?[menu]:url.endsWith('/selections')?[customer]:url==='/menus/menu'?menu:url.includes('subscription-profile')?{mealPerDay:1,breakfastInclude:false}:{customer_name:'Aster',customer_email:customer.email}}}));
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  const click=async label=>act(async()=>[...node.querySelectorAll('button')].find(button=>button.textContent.trim()===label).click());
  try{
    await act(async()=>root.render(<MenuManagement/>));await click('View selections');
    await act(async()=>node.querySelector('.cursor-pointer.border-2').click());await click('Edit Selections');
    act(()=>[...node.querySelectorAll('.cursor-pointer')].find(element=>element.textContent.includes('Original meal')&&element.textContent.includes('▼ change')).click());
    act(()=>[...node.querySelectorAll('button')].find(button=>button.textContent.includes('Replacement meal')).click());
    expect(recordActivityChange.mock.calls.some(([change])=>change.before==='Original meal (old)'&&change.after==='Replacement meal (new)')).toBe(true);
    act(()=>node.querySelector('button[title="Remove"]').click());
    expect(recordActivityChange.mock.calls.some(([change])=>change.before==='Replacement meal (new)'&&change.after==='Empty slot')).toBe(true);
    expect(api.put).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());node.remove();jest.clearAllMocks();}
});

test.each([false,true])('pending cycle import checks newly uploaded draft and respects replacement confirmation=%s',async replace=>{
  let releaseCycle,releaseUpload;
  const confirm=jest.spyOn(window,'confirm').mockReturnValue(replace);
  const meal={id:'cycle',name:'Cycle dish',mealKind:'Main meal',mealType:'Chicken',components:[{id:'p',type:'Protein',name:'Roast',exclusions:[]}]};
  const board=Array.from({length:7},()=>Array.from({length:4},()=>[]));board[0][1]=[{mealId:'cycle',isMatterCore:false}];
  mealCreationStore.load.mockImplementationOnce(()=>new Promise(resolve=>{releaseCycle=()=>resolve({catalogue:{meals:[meal]},boards:{'Main menu:Week 1':board},revision:1});}));
  api.get.mockResolvedValue({data:{success:true,data:[]}});
  api.post.mockImplementation(async(url,payload)=>({data:{success:true,data:{_id:'saved',...payload}}}));
  mockUploadRows.mockReturnValue([['MEAL TYPE','INTOLERANCES','DAY','MEAL NAME','CARB','VEG'],['Main','Dairy',1,'Uploaded while loading','Rice','Slaw']]);
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  const click=async text=>act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent.trim()===text).click());
  const fill=async(input,value)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  try{
    await act(async()=>root.render(<MenuManagement/>));await click('New menu');
    await fill(node.querySelector('input[placeholder="Menu Title"]'),'Race test');
    await fill(node.querySelector('input[aria-label="Menu start date"]'),'2026-11-16');await fill(node.querySelector('input[aria-label="Menu end date"]'),'2026-11-22');
    await click('Create from Cycle Menu');expect(releaseCycle).toBeDefined();expect(confirm).not.toHaveBeenCalled();
    const file=node.querySelector('input[type=file]');Object.defineProperty(file,'files',{value:[{arrayBuffer:()=>new Promise(resolve=>{releaseUpload=resolve;})}]});
    await act(async()=>file.dispatchEvent(new Event('change',{bubbles:true})));
    // Both operations complete in one batch: the import must see even a draft
    // update which React has not rendered yet.
    await act(async()=>{releaseUpload(new ArrayBuffer(0));releaseCycle();});
    expect(confirm).toHaveBeenCalledTimes(1);expect(confirm).toHaveBeenCalledWith('Replace the meals in this unsaved menu draft?');
    await click('Save draft');
    const items=api.post.mock.calls.at(-1)[1].days.flatMap(day=>day.items);
    expect(items.map(item=>item.mealName)).toEqual([replace?'Cycle dish':'Uploaded while loading']);
    if(!replace)expect(items[0].intolerances).toBe('Dairy');
  }finally{await act(async()=>root.unmount());node.remove();confirm.mockRestore();jest.clearAllMocks();}
});

test('each menu has a whole-menu non-selector button that checks only the clicked menu', async () => {
  api.get.mockImplementation(async url => ({ data: { success: true, data: url === '/menus'
    ? [{ _id: 'week-a', title: 'Week A', startDate: '2026-11-16', endDate: '2026-11-22', meals: [] }, { _id: 'week-b', title: 'Week B', startDate: '2026-11-23', endDate: '2026-11-29', meals: [] }]
    : { customers: [], startDate: '2026-11-23', endDate: '2026-11-29', checkedAt: '2026-11-16T08:00:00Z' } } }));
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<MenuManagement />));
    const buttons = [...node.querySelectorAll('button')].filter(button => button.textContent === 'Customers who did not select');
    expect(buttons).toHaveLength(2);
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/did-not-select'), expect.anything());
    await act(async () => buttons[1].click());
    expect(api.get).toHaveBeenCalledWith('/menus/week-b/did-not-select', expect.anything());
    expect(node.querySelector('[role="dialog"]').textContent).toContain('Week B');
  } finally { await act(async () => root.unmount()); node.remove(); jest.clearAllMocks(); }
});

test.each([
  [{preferenceConflict:['Coriander'],carbVegAction:'kept'},[]],
  [{carbVegAction:'replace',carbConflict:['DAIRY'],vegConflict:['MUSHROOM']},['Replace carb: Dairy','Replace veg: Mushroom']],
  [{carbVegAction:'kept',preferenceConflict:['Dairy'],keptCarbConflict:['DAIRY']},['Keep carb: Dairy']],
])('saved selection views scope side tags and highlight portion warnings (%s)', async (flags, labels) => {
  const date='2099-11-02';
  const meal={date,mealName:'Fixture dish',mealType:'main',menuItemId:'dish',quantity:1,...flags};
  const customer={_id:'person',firstName:'Test',email:'test@example.invalid',matterCustomerId:'person',selectedMeals:[meal]};
  api.get.mockImplementation(async url=>({data:{success:true,data:url==='/menus'
    ?[{_id:'menu',title:'Fixture',startDate:date,endDate:date,meals:[{date,mealType:'main',items:[]}]}]
    :url.endsWith('/selections')?[customer]:{customer_id:'person',customer_name:'Test',customer_email:customer.email,subscription_id:'sub'}}}));
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  const verify=()=>{
    for(const label of labels)expect(node.textContent).toContain(label);
    expect(node.textContent).not.toMatch(/Keep carb\/veg|Replace carb\/veg/);
    if(flags.preferenceConflict?.length)expect(node.querySelector('.bg-yellow-50.ring-yellow-400')).not.toBeNull();
    if(!labels.length)expect(node.textContent).not.toMatch(/Keep carb|Keep veg|Replace carb|Replace veg/);
  };
  try {
    await act(async()=>root.render(<MenuManagement/>));
    await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent==='View selections').click());
    verify();
    await act(async()=>node.querySelector('.cursor-pointer.border-2').click());
    verify();
  } finally {await act(async()=>root.unmount());node.remove();jest.clearAllMocks();}
});

test('Menu Management Kitchen Paper marks only automatically assigned meals in the downloaded PDF', async () => {
  const date = '2026-11-06';
  const email = 'fixture@example.invalid';
  const selectedMeals = [
    { date, mealType: 'main', mealName: 'Fixture Bowl', isAutoAssigned: true },
    { date, mealType: 'main', mealName: 'Manual Bowl', isAutoAssigned: false },
  ];
  const customer = { _id: 'person', matterCustomerId: 'person', firstName: 'Fixture', email, selectedMeals };
  const nutrition = { customer_id: 'person', customer_name: 'Fixture Customer', customer_email: email, subscription_id: 'sub',
    source_fetched_at: new Date().toISOString(), plan_name: 'Custom', meal_frequency: 2, breakfast_included: false, snacks_per_day: 0,
    macros: { carbohydrates: 90, protein: 90, fat: 20 }, active_delivery_dates: [date], exclusions: ['Capsicum'],
    allergyProfile: { allergiesAvailable: true, allergies: ['Shellfish'] },
    delivery_address_resolution: { status: 'resolved', reason: 'current', address: { id: 'address' } } };
  api.get.mockImplementation(async path => {
    if (path === '/menus') return { data: { success: true, data: [{ _id: 'menu', title: 'Fixture', startDate: date, endDate: date, meals: [] }] } };
    if (path.endsWith('/selections')) return { data: { success: true, data: [customer] } };
    if (path.includes('kitchen-inputs')) return { data: { success: true, data: nutrition } };
    if (path.endsWith('/kitchen-state')) return { data: { state: 'ready', data: { success: true, data: {
      kitchenSelections: [customer], kitchenInputs: [nutrition], rosterComplete: true,
      kitchenRoster: [{ customer_id: 'person', email, subscription_id: 'sub', plan_name: 'Custom', meal_frequency: 2 }],
      kitchenBreakfastPreset: {}, kitchenSnackPreset: {},
    } } } };
    return { data: { success: true, data: {} } };
  });
  const PDF = jest.requireActual('jspdf').jsPDF;
  const pdf = new PDF();
  pdf.save = jest.fn();
  jsPDF.mockImplementationOnce(() => pdf);
  const node = document.createElement('div'); document.body.appendChild(node);
  const root = createRoot(node);
  const click = label => act(async () => [...node.querySelectorAll('button')].find(button => button.textContent.trim() === label).click());
  try {
    await act(async () => root.render(<MenuManagement />));
    await click('View selections');
    await act(async () => node.querySelector('.cursor-pointer.border-2').click());
    await click('Kitchen Paper');
    expect(pdf.save).toHaveBeenCalledWith(expect.stringMatching(/^Fixture_Customer_Kitchen_Paper_.*\.pdf$/));
    const bytes = pdf.output();
    expect(bytes).toContain('Fixture Bowl \\(main\\) [AUTO]');
    expect(bytes).toContain('Manual Bowl \\(main\\)');
    expect(bytes.match(/\[AUTO\]/g)).toHaveLength(1);
    expect(bytes.indexOf('Allergies: Shellfish')).toBeGreaterThan(bytes.indexOf('Meal exclusion: Capsicum'));
  } finally { await act(async () => root.unmount()); node.remove(); jest.clearAllMocks(); }
});

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
  mealCreationStore.load.mockResolvedValue({catalogue:{meals,source:'Own.xlsx'},boards:{'Main menu:Week 1':board},revision:1});
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
  mealCreationStore.load.mockResolvedValue({catalogue:{meals:[meal]},boards:{'Main menu:Week 1':board},revision:1});
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


test('first cycle migration asks staff to choose instead of silently copying the first cycle',async()=>{
  const meal={id:'NOV3-004',name:'Shared dish',mealKind:'Main meal',mealType:'Chicken',components:[{id:'p',type:'Protein',name:'Chicken',exclusions:[]}]};
  const board=Array.from({length:7},()=>Array.from({length:4},()=>[]));board[0][1]=[{mealId:meal.id,isMatterCore:false}];
  const cycles=['NOV3','NOV4'].map(id=>({id,name:id,meals:[{mealId:meal.id,sourceMealId:id+'-004',day:'DAY 1'}],boards:{'Main menu:Week 1':board}}));
  mealCreationStore.load.mockResolvedValue({catalogue:{meals:[meal]},boards:{},cycles,revision:1});
  api.get.mockResolvedValue({data:{success:true,data:[]}});api.post.mockClear();
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
  const click=async text=>act(async()=>[...node.querySelectorAll('button')].find(button=>button.textContent.trim()===text).click());
  const fill=async(label,value)=>act(async()=>{const input=node.querySelector(`input[aria-label="${label}"]`);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  try{
    await act(async()=>root.render(<MenuManagement/>));await click('New menu');await fill('Menu start date','2026-11-16');await fill('Menu end date','2026-11-22');
    await click('Create from Cycle Menu');expect(node.textContent).toContain('Saved cycles loaded. Choose the cycle and week');
    expect(node.querySelector('select[aria-label="Saved cycle"]')).not.toBeNull();
    expect(node.querySelector('input[placeholder="Menu Title"]').value).toBe('');expect(api.post).not.toHaveBeenCalled();
    await act(async()=>{const select=node.querySelector('select[aria-label="Saved cycle"]');select.value='NOV4';select.dispatchEvent(new Event('change',{bubbles:true}));});
    await click('Create from Cycle Menu');expect(node.querySelector('input[placeholder="Menu Title"]').value).toContain('NOV4');
  }finally{await act(async()=>root.unmount());node.remove();jest.clearAllMocks();}
});
