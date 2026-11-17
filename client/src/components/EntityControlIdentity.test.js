import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {installActivityCapture} from '../utils/activityCapture';
import api from '../utils/api';
import SupyRecipeSearch from './SupyRecipeSearch';
import WeeklyCycleBoard from '../pages/adminMealSelectionV2/WeeklyCycleBoard';
import MenuManagement from '../pages/MenuManagement';
import AddDelivery from '../pages/AddDelivery';
import {MealComposer} from '../pages/adminMealSelectionV2/WorkbookMealPages';
import EventDetailModal from './events/EventDetailModal';
jest.mock('../utils/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn(),put:jest.fn(),delete:jest.fn()}}));
jest.mock('react-router-dom',()=>({Link:({children})=><span>{children}</span>,useNavigate:()=>jest.fn()}),{virtual:true});
const mockEvent={_id:'event-a',status:'pending',eventName:'Fixture event',companyName:'Matter',eventDate:'2099-01-05',logistics:{food:[{_id:'food-a',name:'Rice',quantity:1},{_id:'food-b',name:'Rice',quantity:1}]},venue:{},pointOfContact:{},disassembly:{}};
jest.mock('react-redux',()=>({useDispatch:()=>jest.fn(),useSelector:fn=>fn({auth:{user:{role:'admin'}},events:{isLoading:false,selectedEvent:mockEvent}})}));
jest.mock('../utils/mealCreationStore',()=>({mealCreationStore:{flush:jest.fn(),getSnapshot:()=>({error:''}),load:jest.fn()}}));
jest.mock('html2canvas',()=>jest.fn());jest.mock('jspdf',()=>jest.fn());jest.mock('xlsx-js-style',()=>({}));
let host,root,cleanup,fetchMock;
const render=node=>act(async()=>root.render(node));
const click=text=>act(async()=>[...host.querySelectorAll('button')].find(node=>node.textContent.trim()===text).click());
const input=(node,value)=>act(()=>{node.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});
const advance=ms=>act(async()=>{jest.advanceTimersByTime(ms);for(let i=0;i<8;i++)await Promise.resolve();});
const changes=()=>fetchMock.mock.calls.flatMap(([,options])=>JSON.parse(options.body).events).filter(event=>event.stage==='form_edited').flatMap(event=>event.changes);
beforeEach(()=>{
  global.IS_REACT_ACT_ENVIRONMENT=true;jest.useFakeTimers();jest.clearAllMocks();jest.spyOn(console,'warn').mockImplementation(()=>{});
  Object.defineProperty(window,'indexedDB',{configurable:true,value:undefined});localStorage.clear();localStorage.setItem('token','fixture-actor');window.history.replaceState({},'','/menus');
  fetchMock=jest.fn().mockResolvedValue({ok:true,status:202,headers:{get:()=>null},json:async()=>({success:true})});window.fetch=fetchMock;
  api.get.mockResolvedValue({data:{success:true,data:[]}});host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);cleanup=installActivityCapture();
});
afterEach(()=>{act(()=>root.unmount());cleanup();host.remove();jest.clearAllTimers();jest.useRealTimers();jest.restoreAllMocks();});

test('same-name Supy recipe choices retain each source ID in the real capture queue',async()=>{
  let recipeId='supy-a';api.get.mockImplementation(async()=>({data:{data:[{id:recipeId,name:'Shared recipe',ingredients:[]}]}}));
  function Recipes(){const [name,setName]=useState('Shared recipe');return <SupyRecipeSearch value={name} onChangeText={setName} onSelect={recipe=>setName(recipe.name)}/>;}
  await render(<Recipes/>);
  const choose=async()=>{const field=host.querySelector('input');input(field,'Shared recipe ');input(field,'Shared recipe');await advance(300);await click('Shared recipe');await advance(2000);};
  await choose();recipeId='supy-b';await choose();
  const selections=changes().filter(change=>change.field==='Recipe'&&(/supy-a|supy-b/.test(change.after)));
  expect(selections).toHaveLength(2);expect(selections[1].before).toContain('supy-a');expect(selections[1].after).toContain('supy-b');
});

test('Supy source identity does not carry into a different edited meal scope with the same name',async()=>{
  let recipeId='supy-a';api.get.mockImplementation(async()=>({data:{data:[{id:recipeId,name:'Shared recipe',ingredients:[]}]}}));
  const show=scope=>render(<SupyRecipeSearch value="Shared recipe" activityScope={scope} onSelect={jest.fn()}/>);
  const choose=async()=>{const field=host.querySelector('input');input(field,'Shared recipe ');input(field,'Shared recipe');await advance(300);await click('Shared recipe');await advance(2000);};
  await show('meal-a');await choose();recipeId='supy-b';await show('meal-b');await choose();
  const selected=changes().find(change=>change.after.includes('supy-b'));
  expect(selected.before).not.toContain('supy-a');expect(selected.before).toBe('Shared recipe');
});

test('duplicate-week replacement records different meal IDs even when names are identical',async()=>{
  const board=id=>Array.from({length:7},(_,day)=>Array.from({length:4},(_,group)=>day===0&&group===1?[{mealId:id,isMatterCore:false}]:[]));
  const meals=['meal-a','meal-b'].map(id=>({id,name:'Shared meal',mealKind:'Main meal',components:[]}));
  await render(<WeeklyCycleBoard meals={meals} initialBoards={{'Main menu:Week 1':board('meal-a'),'Main menu:Week 2':board('meal-b')}} onSaveBoards={jest.fn()}/>);
  await click('Duplicate week');await advance(2000);
  const replacement=changes().find(change=>change.field.includes('Week 2')&&change.field.includes('Monday'));
  expect(replacement).toBeDefined();expect(replacement.before).toContain('meal-b');expect(replacement.after).toContain('meal-a');
});

test('native Core checks identify the selected meal when both slot meals have the same name',async()=>{
  const meals=['meal-a','meal-b'].map(id=>({id,name:'Shared meal',mealKind:'Main meal',components:[]}));
  const board=Array.from({length:7},(_,day)=>Array.from({length:4},(_,group)=>day===0&&group===1?meals.map(meal=>({mealId:meal.id,isMatterCore:false})):[]));
  await render(<WeeklyCycleBoard meals={meals} initialBoards={{'Main menu:Week 1':board}}/>);
  act(()=>host.querySelectorAll('.av2-core-label input')[1].click());await advance(2000);
  expect(changes()).toHaveLength(1);expect(changes()[0].field).toContain('meal-b');
});

test('a customer slot replacement records old and new meal IDs with an unchanged meal name',async()=>{
  const date='2099-01-05',customer={_id:'customer-a',firstName:'Aster',email:'fixture@example.invalid',mealPerDay:1,selectedMeals:[{date,mealType:'main',mealName:'Shared meal',menuItemId:'meal-a',quantity:1}]};
  const menu={_id:'menu',title:'Fixture',startDate:date,endDate:date,meals:[{date,mealType:'main',items:[{_id:'meal-b',mealName:'Shared meal',mealType:'main'}]}]};
  api.get.mockImplementation(async url=>({data:{success:true,data:url==='/menus'?[menu]:url.endsWith('/selections')?[customer]:url==='/menus/menu'?menu:url.includes('subscription-profile')?{mealPerDay:1,breakfastInclude:false}:{customer_name:'Aster',customer_email:customer.email}}}));
  await render(<MenuManagement/>);await click('View selections');await act(async()=>host.querySelector('.cursor-pointer.border-2').click());await click('Edit Selections');
  act(()=>[...host.querySelectorAll('.cursor-pointer')].find(node=>node.textContent.includes('Shared meal')&&node.textContent.includes('▼ change')).click());
  act(()=>[...host.querySelectorAll('button')].find(node=>node.textContent.includes('Shared meal')).click());await advance(2000);
  const replacement=changes().find(change=>change.field.includes('main slot 1'));
  expect(replacement).toBeDefined();expect(replacement.before).toContain('meal-a');expect(replacement.after).toContain('meal-b');expect(api.put).not.toHaveBeenCalled();
});

test('long same-name collection customers retain their accepted customer IDs',async()=>{
  const longName='Shared customer '.repeat(30);
  api.get.mockImplementation(async url=>({data:{data:url==='/customers'?[{customerId:'CUST-A',firstName:longName},{customerId:'CUST-B',firstName:longName}]:null}}));
  window.history.replaceState({},'','/add-delivery');await render(<AddDelivery/>);await click('Collection');
  const choose=async id=>{input(host.querySelector('[placeholder="Type customer name or ID to search..."]'),'Shared');await advance(150);await act(async()=>[...host.querySelectorAll('button')].find(node=>node.textContent.includes(id)).dispatchEvent(new MouseEvent('mousedown',{bubbles:true})));await advance(2000);};
  await choose('CUST-A');await choose('CUST-B');
  const selections=changes().filter(change=>change.field==='Collection customer');
  expect(selections).toHaveLength(2);expect(selections[1].before).toContain('CUST-A');expect(selections[1].after).toContain('CUST-B');
});

test('removing one same-name meal component retains the actual component references',async()=>{
  await render(<MealComposer meal={{id:'meal',name:'Fixture meal',mealKind:'Main meal',mealType:'Chicken',components:[{id:'component-a',type:'Protein',name:'Roast'},{id:'component-b',type:'Protein',name:'Roast'}]}} onSave={jest.fn()}/>);
  act(()=>host.querySelectorAll('[aria-label="Remove Protein component"]')[0].click());await advance(2000);
  const removal=changes().find(change=>change.field.includes('Components for'));
  expect(removal.before).toContain('component-a');expect(removal.before).toContain('component-b');expect(removal.after).not.toContain('component-a');expect(removal.after).toContain('component-b');
});

test('same-name component exclusion controls identify their actual component',async()=>{
  await render(<MealComposer meal={{id:'meal',name:'Fixture meal',mealKind:'Main meal',mealType:'Chicken',components:[{id:'component-a',type:'Protein',name:'Roast',exclusions:['Nuts']},{id:'component-b',type:'Protein',name:'Roast',exclusions:['Nuts']}]}} onSave={jest.fn()}/>);
  act(()=>host.querySelectorAll('[aria-label="Remove exclusion Nuts"]')[0].click());await advance(2000);
  expect(changes()).toHaveLength(1);expect(changes()[0].field).toContain('component-a');expect(changes()[0].before).toBe('Nuts');expect(changes()[0].after).toBe('');
});

test('event food removal retains same-name saved food row references',async()=>{
  await render(<EventDetailModal isOpen onClose={jest.fn()}/>);await click('Edit');await click('Remove');await advance(2000);
  const removal=changes().find(change=>change.field==='Event food');
  expect(removal.before).toContain('food-a');expect(removal.before).toContain('food-b');expect(removal.after).not.toContain('food-a');expect(removal.after).toContain('food-b');
});
