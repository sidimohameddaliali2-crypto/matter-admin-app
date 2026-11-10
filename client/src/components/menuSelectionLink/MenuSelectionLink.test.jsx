import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../../utils/api';
import MenuSelectionLink, { buildRealModel, expandSaturdaySkips } from './MenuSelectionLink';
import { allergenMatchesAny } from '../../constants/exclusionList';

jest.mock('../../utils/api', () => ({ get: jest.fn(), post: jest.fn() }));

test('reopening the menu keeps saved Wednesday, Friday and Saturday skips visible alongside active deliveries', () => {
  const dates = ['2099-10-21', '2099-10-22', '2099-10-23', '2099-10-24'];
  const model = buildRealModel({ meals: dates.map((date) => ({ date, mealType: 'main', items: [] })) }, {
    weekend: false,
    deliveryDates: ['2099-10-22'],
    skippedDays: ['2099-10-21', '2099-10-23', '2099-10-24'].map((date) => ({ date, pauseStatus: 'success' })),
  });
  expect(model.dayKeys).toEqual(dates);
});

test('allergen checking includes declared categories and hidden sauce, portion and garnish ingredients', () => {
  const model = buildRealModel({ meals: [{ date: '2099-10-21', mealType: 'main', items: [{
    _id: 'meal', mealName: 'Fixture', allergens: ['Dairy'],
    portionIngredients: [{ name: 'Whole Milk', visible: false }],
    sauceIngredients: [{ name: 'Peanut Butter', visible: false }],
    garnish: 'Sesame',
  }] }] }, { deliveryDates: ['2099-10-21'] });
  const terms = model.meals[0].allergenMatchTokens;
  expect(allergenMatchesAny('Milk', terms)).toBe(true);
  expect(allergenMatchesAny('Peanuts', terms)).toBe(true);
  expect(allergenMatchesAny('Sesame', terms)).toBe(true);
  expect(model.meals[0].proteinText).not.toContain('Whole Milk');
});

test('Saturday includes an eligible Sunday across menu or month boundaries; Sunday alone does not include Saturday', () => {
  const dates = ['2026-10-31', '2026-11-01'];
  expect(expandSaturdaySkips(['2026-10-31'], dates)).toEqual(dates);
  expect(expandSaturdaySkips(['2026-11-01'], dates)).toEqual(['2026-11-01']);
  expect(expandSaturdaySkips(['2026-10-31', '2026-11-01'], dates)).toEqual(dates);
  expect(expandSaturdaySkips(['2026-10-31'], ['2026-10-31'])).toEqual(['2026-10-31']);
});


const DELIVERY_DATE = '2099-10-21';
const privateComponent = (id, type, exclusions = [], name = id) => ({ id, type, name, exclusions, notes: 'Internal kitchen note' });
const cycleItem = (components, extra = {}) => ({
  _id: 'private-item', mealName: 'Private fixture meal', mealType: 'main', proteinSource: 'Chicken portion', carbs: 'Rice name', veg: 'Vegetable name', sauce: 'Sauce name',
  intolerances: '', allergens: [],
  cycleMeal: { id: 'cycle-meal', name: 'Private fixture meal', mealKind: 'Main meal', carbCombined: 'No', components }, ...extra,
});
const modelFor = item => buildRealModel({ meals: [{ date: DELIVERY_DATE, mealType: item.mealType, items: [item] }] }, { deliveryDates: [DELIVERY_DATE] });

test('private salad and dressing flags participate in allergy checks without changing menu labels or visible tags', () => {
  const item = cycleItem([privateComponent('portion','Protein'),privateComponent('salad','Salad',['Mushroom']),privateComponent('dressing','Sauce 2',['Nuts'])]);
  const rendered = modelFor(item).meals[0];
  expect(rendered.proteinText).toBe('Chicken portion');expect(rendered.carbText).toBe('Rice name');expect(rendered.vegText).toBe('Vegetable name');
  expect(rendered.allergens).toEqual([]);expect(rendered.dietTags).toEqual([]);
  expect(rendered.sub).not.toContain('Internal kitchen note');
  expect(allergenMatchesAny('Nuts', rendered.allergenMatchTokens)).toBe(true);
  expect(rendered.carbText+rendered.vegText).not.toMatch(/Mushroom|Nuts/);
});

let node, root, scroll;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  scroll = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
  node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
  api.get.mockReset();api.post.mockReset();
});
afterEach(() => {act(()=>root.unmount());node.remove();scroll.mockRestore();});
const button = (text, scope = node) => [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === text);
const click = async element => {expect(element).toBeDefined();await act(async()=>element.click());};
const card = () => [...node.querySelectorAll('div')].find(element => element.textContent === 'Private fixture meal').closest('.card');
const setText = async (input, value) => act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
const signIn = async (item, profile = {}) => {
  const menu={_id:'menu-private',title:'Saved menu',startDate:DELIVERY_DATE,endDate:DELIVERY_DATE,meals:[{date:DELIVERY_DATE,mealType:item.mealType,items:[item]}]};
  api.get.mockImplementation(async url=>({data:{success:true,data:url.includes('/share/')?menu:{
    firstName:'Test',lastName:'Subscriber',email:'subscriber@example.invalid',matterCustomerId:'customer',subscriptionId:'subscription',mealPerDay:1,
    allergies:[],allergiesAvailable:true,deliveryDates:[DELIVERY_DATE],mealExclusion:'', ...profile,
  }}}));
  api.post.mockResolvedValue({data:{success:true,pauseResults:[]}});
  await act(async()=>root.render(<MenuSelectionLink token="private-real-token"/>));
  await setText(node.querySelector('#msl-email'),'subscriber@example.invalid');await click(button('Continue'));
  expect(node.textContent).toContain('Sign out');
};

test('a portion exclusion cannot be added using the existing modal acknowledgement', async () => {
  await signIn(cycleItem([privateComponent('portion','Protein',['Coriander'])]),{mealExclusion:'Coriander'});
  expect(button('+',card()).disabled).toBe(true);
  await act(async()=>[...card().querySelectorAll('div')].find(element=>element.textContent==='Private fixture meal').click());
  expect(button('Keep selection').disabled).toBe(true);
  await click(button('Keep selection'));await click(button('Submit my week'));
  expect(api.post).not.toHaveBeenCalled();
});

test.each(['portion','mixed'])('restored %s conflicts cannot submit an already selected meal', async scenario => {
  const components=scenario==='portion'?[privateComponent('portion','Protein',['Coriander'])]:[privateComponent('portion','Protein'),privateComponent('carb','Carb',['Coriander']),privateComponent('veg','Vegetable')];
  const item=cycleItem(components);if(scenario==='mixed')item.cycleMeal.carbCombined='Yes';
  await signIn(item,{mealExclusion:'Coriander',hasSubmittedForRequestedMenu:true,selectedMeals:[{date:DELIVERY_DATE,mealType:'main',menuItemId:'private-item',quantity:1}]});
  await click(button('Submit my week'));
  expect(api.post).not.toHaveBeenCalled();expect(node.textContent).toContain('Could not save your selections.');
});

test('separate carb and vegetable conflicts retain existing messages and submit replacement flags', async () => {
  await signIn(cycleItem([privateComponent('portion','Protein'),privateComponent('carb','Carb',['Coriander']),privateComponent('veg','Vegetable',['Mushroom'])]),{mealExclusion:'Coriander; Mushroom'});
  await click(button('+',card()));
  expect(node.querySelector('.dialog-title').textContent).toContain('This meal includes');
  expect(button('Replace it')).toBeDefined();expect(button('Keep as is').disabled).toBe(true);
  await click(button('Replace it'));await click(button('Submit my week'));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post.mock.calls[0][1].selections[0]).toMatchObject({carbVegAction:'replace',carbConflict:['Coriander'],vegConflict:['Mushroom']});
});

test.each(['salad','dressing'])('a private %s conflict adds silently and submits the replace-veg flag', async source => {
  const components=[privateComponent('portion','Protein'),privateComponent('salad','Salad',source==='salad'?['Mushroom']:[]),privateComponent('dressing','Sauce 2',source==='dressing'?['Mushroom']:[])];
  const item=cycleItem(components);item.cycleMeal.isSaladBase=true;
  await signIn(item,{mealExclusion:'Mushroom'});
  expect(card().textContent).not.toContain('Mushroom');expect(card().textContent).not.toContain('Against your plan');
  await click(button('+',card()));expect(node.querySelector('.dialog')).toBeNull();
  await click(button('Submit my week'));
  expect(api.post.mock.calls[0][1].selections[0]).toMatchObject({carbVegAction:'replace',vegConflict:['Mushroom'],needsSauceChange:false});
});

test('private salad-sauce allergens still hard-block through the real customer flow', async () => {
  const item=cycleItem([privateComponent('portion','Protein'),privateComponent('salad','Salad'),privateComponent('dressing','Sauce 2',['Nuts'])]);item.cycleMeal.isSaladBase=true;
  await signIn(item,{allergies:['Nuts']});expect(card().textContent).toContain('Blocked · allergen');expect(button('+',card())).toBeUndefined();
  await click(button('Ask customer service',card()));expect(node.querySelector('.dialog-title').textContent).toBe('Contains Nuts');
  expect(api.post).not.toHaveBeenCalled();
});

test('a breakfast with no sauce or garnish remains selectable and submits normally', async () => {
  const item=cycleItem([privateComponent('breakfast','Breakfast')],{mealType:'breakfast',proteinSource:'Breakfast portion',carbs:'',veg:'',sauce:''});item.cycleMeal.mealKind='Breakfast';
  await signIn(item);await click(button('+',card()));await click(button('Submit my week'));
  expect(api.post).toHaveBeenCalledTimes(1);expect(api.post.mock.calls[0][1].selections[0]).toMatchObject({mealType:'breakfast',needsSauceChange:false,needsGarnishChange:false});
});
