import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AdminMealSelectionV2 from './AdminMealSelectionV2';
import MenuManagement from '../MenuManagement';
import api from '../../utils/api';
import WeeklyCycleBoard from './WeeklyCycleBoard';

let mockPath='/admin/meal-selection-v2/meals';
const mockNavigate=jest.fn();
jest.mock('react-router-dom',()=>({useLocation:()=>({pathname:mockPath}),useNavigate:()=>mockNavigate,Navigate:()=>null,Link:({children,to,...props})=><a href={to} {...props}>{children}</a>}),{virtual:true});
jest.mock('../../utils/api',()=>({get:jest.fn(),post:jest.fn(),put:jest.fn()}));
jest.mock('../../components/SupyRecipeSearch',()=>()=>null);
jest.mock('../../components/IngredientTagEditor',()=>()=>null);
jest.mock('html2canvas',()=>jest.fn());jest.mock('jspdf',()=>jest.fn());jest.mock('xlsx-js-style',()=>({}));

test('accepted server normalization updates the visible cycle when an imported meal changes kind',async()=>{
  global.IS_REACT_ACT_ENVIRONMENT=true;
  const meal={id:'one',name:'Own meal',mealKind:'Main meal',mealType:'Chicken',components:[]};
  const main=Array.from({length:7},()=>Array.from({length:4},()=>[]));main[0][1]=[{mealId:'one',isMatterCore:false}];
  const snack=Array.from({length:7},()=>Array.from({length:4},()=>[]));snack[0][3]=[{mealId:'one',isMatterCore:false}];
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(<WeeklyCycleBoard meals={[meal]} initialBoards={{'Main menu:Week 1':main}} revision={0}/>));
    expect(host.querySelector('[aria-label="Monday Main drop area"]').textContent).toContain('Own meal');
    await act(async()=>root.render(<WeeklyCycleBoard meals={[{...meal,mealKind:'Snack'}]} initialBoards={{'Main menu:Week 1':snack}} revision={1}/>));
    expect(host.querySelector('[aria-label="Monday Main drop area"]').textContent).not.toContain('Own meal');
    expect(host.querySelector('[aria-label="Monday Snack drop area"]').textContent).toContain('Own meal');
  }finally{await act(async()=>root.unmount());host.remove();}
});

test('an old meal save cannot redirect away from a newer unsaved editor',async()=>{
  global.IS_REACT_ACT_ENVIRONMENT=true;
  const state={catalogue:{meals:['one','two'].map(id=>({id,name:id,mealKind:'Main meal',mealType:'Chicken',components:[{id:id+'-p',type:'Protein',name:'Roast',exclusions:[]}]}))},boards:{},revision:0};
  let release;
  api.post.mockImplementation(async()=>({data:{success:true,data:state}}));
  api.put.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({data:{success:true,data:{...state,revision:1}}});}));
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try{
    mockPath='/admin/meal-selection-v2/meals/one';await act(async()=>root.render(<AdminMealSelectionV2/>));
    await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Save draft').click());
    expect(host.querySelector('input[type=radio]').closest('fieldset').parentElement.closest('fieldset').disabled).toBe(true);
    mockPath='/admin/meal-selection-v2/meals/two';await act(async()=>root.render(<AdminMealSelectionV2/>));
    await act(async()=>release());
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Edit Meal');expect([...host.querySelectorAll('input')].some(input=>input.value==='two')).toBe(true);
  }finally{await act(async()=>root.unmount());host.remove();}
});

test('the full library and cycle survive creating a weekly menu, navigation and a browser with no tab storage',async()=>{
  mockPath='/admin/meal-selection-v2/meals';
  global.IS_REACT_ACT_ENVIRONMENT=true;
  const make=id=>({id,name:id,day:'',mealKind:'Main meal',mealType:'Chicken',carbCombined:'No',components:[{id:id+'-p',type:'Protein',name:'Roast',exclusions:['Nuts'],notes:'Private preparation'}]});
  const state={catalogue:{meals:[make('Placed meal'),make('Not scheduled')],source:'Recovered from saved menus'},boards:{},revision:0};
  let weekly;
  const ok=data=>({data:{success:true,data:JSON.parse(JSON.stringify(data))}});
  api.get.mockImplementation(async url=>ok(url==='/menus'?weekly?[weekly]:[]:{}));
  api.post.mockImplementation(async(url,body)=>{
    if(url==='/meal-creation/bootstrap')return ok(state);
    expect(url).toBe('/menus');weekly={_id:'weekly',...body};return ok(weekly);
  });
  api.put.mockImplementation(async(url,body)=>{
    expect(url).toBe('/meal-creation');expect(body.revision).toBe(state.revision);
    state.boards={...state.boards,...body.boards};state.revision++;return ok(state);
  });
  const host=document.createElement('div');document.body.appendChild(host);let root=createRoot(host);
  const render=async element=>act(async()=>root.render(element));
  const button=text=>[...host.querySelectorAll('button')].find(element=>element.textContent.trim()===text);
  const click=async element=>act(async()=>{expect(element).toBeDefined();element.click();});
  const fill=async(element,value)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
  try {
    sessionStorage.clear();await render(<AdminMealSelectionV2/>);expect(host.textContent).toContain('Not scheduled');
    mockPath='/admin/meal-selection-v2/weekly-menu';await render(<AdminMealSelectionV2/>);
    await click([...host.querySelectorAll('.av2-library-card')].find(card=>card.textContent.includes('Placed meal')));await click(button('Add to draft'));await click(button('Save draft'));
    expect(state.boards['Main menu:Week 1'][0][1][0].mealId).toBe('Placed meal');
    const before=JSON.stringify(state);
    await act(async()=>root.unmount());root=createRoot(host);await render(<MenuManagement/>);await click(button('New menu'));
    await fill(host.querySelector('input[aria-label="Menu start date"]'),'2026-11-16');await fill(host.querySelector('input[aria-label="Menu end date"]'),'2026-11-22');
    await click(button('Create from Cycle Menu'));expect(host.textContent).toContain('Placed meal');await click(button('Save draft'));
    expect(weekly.days[0].items[0].cycleMeal.components[0].exclusions).toEqual(['Nuts']);expect(JSON.stringify(state)).toBe(before);
    await act(async()=>root.unmount());root=createRoot(host);sessionStorage.clear();
    mockPath='/admin/meal-selection-v2/meals';await render(<AdminMealSelectionV2/>);expect(host.textContent).toContain('Placed meal');expect(host.textContent).toContain('Not scheduled');
    mockPath='/admin/meal-selection-v2/weekly-menu';await render(<AdminMealSelectionV2/>);expect(host.querySelector('[aria-label="Monday Main drop area"]').textContent).toContain('Placed meal');
    expect(JSON.stringify(state)).toBe(before);
  }finally{await act(async()=>root.unmount());host.remove();sessionStorage.clear();}
});


test('selected named cycles and all meals survive copying and saving a dated menu',async()=>{
  mockPath='/admin/meal-selection-v2/meals';global.IS_REACT_ACT_ENVIRONMENT=true;
  const meal={id:'NOV3-004',name:'Shared chicken recipe',mealKind:'Main meal',mealType:'Chicken',carbCombined:'No',components:[{id:'p',type:'Protein',name:'Chicken',exclusions:['Nuts']}]};
  const week=day=>{const value=Array.from({length:7},()=>Array.from({length:4},()=>[]));value[day][1]=[{mealId:meal.id,isMatterCore:day===0}];return value;};
  const state={catalogue:{meals:[meal],source:'November4.xlsx'},boards:{},cycles:[
    {id:'NOV3',name:'NOV3',source:'November3.xlsx',meals:[{mealId:meal.id,sourceMealId:'NOV3-004',day:'DAY 1'}],boards:{'Main menu:Week 1':week(0)}},
    {id:'NOV4',name:'NOV4',source:'November4.xlsx',meals:[{mealId:meal.id,sourceMealId:'NOV4-020',day:'DAY 4'}],boards:{'Main menu:Week 1':week(3)}},
  ],revision:5};
  const before=JSON.stringify(state);let weekly;
  const ok=data=>({data:{success:true,data:JSON.parse(JSON.stringify(data))}});
  api.get.mockImplementation(async url=>ok(url==='/meal-creation'?state:url==='/menus'?weekly?[weekly]:[]:{}));
  api.post.mockImplementation(async(url,body)=>{if(url==='/meal-creation/bootstrap')return ok(state);expect(url).toBe('/menus');weekly={_id:'named-weekly',...body};return ok(weekly);});
  api.put.mockClear();
  const host=document.createElement('div');document.body.appendChild(host);let root=createRoot(host);
  const render=async view=>act(async()=>root.render(view));
  const click=async text=>act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent.trim()===text).click());
  const select=async value=>act(async()=>{const element=host.querySelector('select[aria-label="Saved cycle"]');element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));});
  const fill=async(selector,value)=>act(async()=>{const element=host.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
  try{
    await render(<AdminMealSelectionV2/>);expect(host.querySelectorAll('.av2-meal-id')).toHaveLength(1);
    await select('NOV4');expect(host.querySelector('.av2-meal-id').textContent).toBe('NOV4-020');expect(host.querySelector('.av2-meal-id').parentElement.textContent).toContain('DAY 4');
    mockPath='/admin/meal-selection-v2/weekly-menu';await render(<AdminMealSelectionV2/>);
    expect(host.querySelector('[aria-label="Thursday Main drop area"]').textContent).toContain(meal.name);
    expect(host.querySelector('[aria-label="Monday Main drop area"]').textContent).not.toContain(meal.name);
    await act(async()=>root.unmount());root=createRoot(host);await render(<MenuManagement/>);await click('New menu');await select('NOV4');
    await fill('input[aria-label="Menu start date"]','2026-11-16');await fill('input[aria-label="Menu end date"]','2026-11-22');
    await click('Create from Cycle Menu');await click('Save draft');
    expect(weekly.days[3].items[0].cycleMeal.cycleSource).toMatchObject({cycleId:'NOV4',sourceMealId:'NOV4-020'});
    expect(api.put).not.toHaveBeenCalled();expect(JSON.stringify(state)).toBe(before);
    await act(async()=>root.unmount());root=createRoot(host);sessionStorage.clear();mockPath='/admin/meal-selection-v2/weekly-menu';await render(<AdminMealSelectionV2/>);
    await select('NOV3');expect(host.querySelector('[aria-label="Monday Main drop area"]').textContent).toContain(meal.name);
    await select('NOV4');expect(host.querySelector('[aria-label="Thursday Main drop area"]').textContent).toContain(meal.name);expect(JSON.stringify(state)).toBe(before);
  }finally{await act(async()=>root.unmount());host.remove();}
});


test('a new unscheduled recipe remains visible after saving from a selected cycle',async()=>{
  global.IS_REACT_ACT_ENVIRONMENT=true;
  mockPath='/admin/meal-selection-v2/meals';
  const state={catalogue:{meals:[{id:'NOV3-001',name:'Existing dish',day:'DAY 1',mealKind:'Main meal',mealType:'Chicken',components:[{id:'p',type:'Protein',name:'Chicken',exclusions:[]}]}],source:'NOV3.xlsx'},boards:{},cycles:[{id:'NOV3',name:'NOV3',source:'NOV3.xlsx',meals:[{mealId:'NOV3-001',sourceMealId:'NOV3-001',day:'DAY 1'}],boards:{}}],revision:0};
  const ok=data=>({data:{success:true,data:JSON.parse(JSON.stringify(data))}});
  api.post.mockReset().mockImplementation(async()=>ok(state));
  api.put.mockReset().mockImplementation(async(url,body)=>{state.catalogue.meals.push(...body.catalogue.meals);state.revision++;return ok(state);});
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  const click=async text=>act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent.trim()===text).click());
  try{
    await act(async()=>root.render(<AdminMealSelectionV2/>));
    await act(async()=>{const select=host.querySelector('select[aria-label="Saved cycle"]');select.value='NOV3';select.dispatchEvent(new Event('change',{bubbles:true}));});
    mockPath='/admin/meal-selection-v2/meals/new';await act(async()=>root.render(<AdminMealSelectionV2/>));
    await act(async()=>[...host.querySelectorAll('input[type=radio]')].find(input=>input.parentElement.textContent==='Snack').click());
    await act(async()=>{const input=host.querySelector('label.av2-field input:not([type])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'New unscheduled snack');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await click('Save draft');
    expect(api.put).toHaveBeenCalledTimes(1);
    mockPath='/admin/meal-selection-v2/meals';await act(async()=>root.render(<AdminMealSelectionV2/>));
    expect(host.querySelector('select[aria-label="Saved cycle"]').value).toBe('');
    expect(host.textContent).toContain('New unscheduled snack');
    expect(state.cycles[0].meals).toHaveLength(1);
  }finally{await act(async()=>root.unmount());host.remove();}
});
