import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateComponentSelection as evaluate } from '../../client/src/constants/componentSelectionRules/index.js';
import { validateMenuSelections } from './menuSelectionValidation.js';
const c = (id, type, name, exclusions = [], extra = {}) => ({ id, type, name, exclusions, ...extra });
const item = components => ({ _id: 'dish', mealName: 'Fixture', mealType: 'main', itemDate: '2099-11-02', cycleMeal: { components, carbCombined: 'No' } });

test('portion conflicts classify whole-meal warnings while separate carb/veg retain replacement flags', () => {
  assert.equal(evaluate(item([c('p','Protein','Chicken',['Nuts'])]), ['Nuts']).wholeMeal,true);
  assert.equal(evaluate(item([c('p','Protein','Eggplant')]), ['Egg']).wholeMeal,false);
  const r=evaluate(item([c('c','Carb','Rice',['Nuts']),c('v','Vegetable','Peas')]), ['Nuts','Peas']);
  assert.equal(r.wholeMeal,false);assert.equal(r.flags.carbVegAction,'replace');assert.deepEqual(r.flags.carbConflict,['Nuts']);assert.deepEqual(r.flags.vegConflict,['Peas']);
});
test('mixed carb/veg including salad conflicts classify whole-meal warnings', () => {
  for(const type of ['Vegetable','Salad']) {
    const i=item([c('v',type,'Peas')]);i.cycleMeal.carbCombined='Yes';assert.equal(evaluate(i,['Peas']).wholeMeal,true);
  }
});
test('salad/Sauce2 flags are private veg changes even when repeated in legacy descriptions', () => {
  const i={...item([c('v','Salad','Slaw',['Coriander']),c('s','Sauce 2','Dressing',['Nuts'])]),intolerances:'Coriander, Nuts',ingredients:'Slaw, Dressing'};
  const r=evaluate(i,['Coriander','Nuts']);assert.equal(r.wholeMeal,false);assert.deepEqual(r.publicConflicts,[]);assert.deepEqual(r.matchedVeg,[]);assert.deepEqual(r.flags.vegConflict,['Coriander','Nuts']);assert.equal(r.flags.needsSauceChange,false);
});
test('classified legacy carb tags stay replaceable, unclassified general tags classify whole-meal warnings', () => {
  const r=evaluate({carbs:'Rice',carbIngredients:[{name:'Peas',visible:false}],ingredients:'Rice, Peas',intolerances:'Peas'},['Peas']);assert.equal(r.wholeMeal,false);assert.deepEqual(r.flags.carbConflict,['Peas']);
  assert.equal(evaluate({intolerances:'Nuts',proteinSource:'Chicken'},['Nuts']).wholeMeal,true);
});
test('allergy checks include hidden tags and ignore unverified free-option claims', () => {
  assert.deepEqual(evaluate(item([c('s','Sauce 2','Dressing',['Nuts'],{adaptation:'Nut-free option available.'})]),[],['Nuts']).allergies,['Nuts']);
  assert.deepEqual(evaluate({sauceIngredients:[{name:'Milk',visible:false}]},[],['Dairy']).allergies,['Dairy']);
});
test('breakfast/snack sauce and garnish are optional', () => {
  for(const type of ['Breakfast','Snack']) assert.equal(evaluate(item([c('p',type,'Plain item')]),['Nuts']).wholeMeal,false);
});
test('extras follow their attachment; orphaned salad links do not hide generic sauce flags', () => {
  assert.equal(evaluate(item([c('p','Protein','Chicken'),c('s','Extra sauce / topping','Topping',['Nuts'],{attachedComponentId:'p'})]),['Nuts']).wholeMeal,true);
  const r=evaluate(item([c('s','Sauce 2','Dressing',['Nuts'],{saladComponentId:'deleted'})]),['Nuts']);assert.deepEqual(r.flags.sauceConflict,['Nuts']);assert.deepEqual(r.flags.vegConflict,[]);
});
const menu={meals:[{date:'2099-11-02',mealType:'main',items:[item([c('v','Vegetable','Peas')])]}]};
const selection={date:'2099-11-02',mealType:'main',menuItemId:'dish',mealName:'Fixture',carbVegAction:'kept',vegConflict:[],needsSauceChange:true};
test('stored membership/name/date/type are verified and client flags replaced',()=>{
  const [saved]=validateMenuSelections({menu,selections:[selection],exclusions:['Peas']});assert.equal(saved.carbVegAction,'replace');assert.deepEqual(saved.vegConflict,['Peas']);assert.equal(saved.needsSauceChange,false);
  for(const invalid of [{menuItemId:'other'},{date:'2099-11-03'},{mealType:'snack'},{mealName:'Forged'},{quantity:-1}]) assert.throws(()=>validateMenuSelections({menu,selections:[{...selection,...invalid}]}),{statusCode:409});
});
test('name-only legacy selections must resolve uniquely',()=>{
  const {menuItemId,...legacy}=selection;assert.equal(validateMenuSelections({menu,selections:[legacy]})[0].menuItemId,'dish');assert.throws(()=>validateMenuSelections({menu:{meals:[menu.meals[0],menu.meals[0]]},selections:[legacy]}),{statusCode:409});
});
test('whole-meal preference conflicts save as warnings but allergies reject forged replacement actions',()=>{
  const unsafe={meals:[{date:'2099-11-02',mealType:'main',items:[item([c('p','Protein','Peas')])]}]};
  const [saved]=validateMenuSelections({menu:unsafe,selections:[{...selection,exclusionConflict:['Fake']}],exclusions:['Peas']});
  assert.deepEqual(saved.exclusionConflict,['Peas']);assert.equal(saved.carbVegAction,undefined);
  assert.throws(()=>validateMenuSelections({menu,selections:[selection],allergies:['Peas']}),{statusCode:409});
});


test('legacy and snapshot protein types classify warnings even with generic recipe names', () => {
  for (const type of ['Chicken', 'Beef', 'Fish']) {
    assert.equal(evaluate({ mealName: 'Roast', portionType: type.toLowerCase() }, [type]).wholeMeal, true);
    assert.equal(evaluate({ mealName: 'Roast', cycleMeal: { mealType: type, components: [c('p', 'Protein', 'Roast')] } }, [type]).wholeMeal, true);
  }
  assert.equal(evaluate({ cycleMeal: { mealType: 'Main', components: [] } }, ['Main']).wholeMeal, false);
  assert.equal(evaluate({ cycleMeal: { mealType: 'Breakfast', components: [] } }, ['Breakfast']).wholeMeal, false);
});
test('dangling populated menu items cannot cause a TypeError or resolve as a meal', () => {
  const dangling = { meals: [null, { date: '2099-11-02', mealType: 'main', items: [null, 'dangling-id', {}, ...menu.meals[0].items] }] };
  assert.equal(validateMenuSelections({ menu: dangling, selections: [selection] })[0].menuItemId, 'dish');
  assert.throws(() => validateMenuSelections({ menu: { meals: [{ date: '2099-11-02', mealType: 'main', items: [null, 'dish', {}] }] }, selections: [selection] }), { statusCode: 409 });
});


const choicesMenu = { meals: [{ date: '2099-11-02', mealType: 'main', items: [{
  _id: 'dish', mealName: 'Fixture', mealType: 'main', itemDate: '2099-11-02', portionType: 'beef',
  proteinSource: 'Beef roast', carbs: 'Rice + Quinoa', veg: 'Steamed vegetables', sauce: 'Lemon sauce',
  cycleMeal: { components: [c('p', 'Protein', 'Beef'), c('c1', 'Carb', 'Rice'), c('c2', 'Carb', 'Quinoa'), c('v', 'Vegetable', 'Broccoli'), c('s', 'Sauce', 'Lemon sauce')] },
}] }] };
test('unchecked component overrides and protein-type overrides cannot bypass exclusions or allergies', () => {
  for (const field of ['proteinChoice', 'carbChoice', 'vegChoice', 'sauceChoice']) {
    for (const [value, profile] of [['Chicken', { exclusions: ['Chicken'] }], ['Nut butter', { allergies: ['Nuts'] }]]) {
      assert.throws(() => validateMenuSelections({ menu: choicesMenu, selections: [{ ...selection, [field]: value }], ...profile }), { statusCode: 409 });
    }
  }
  assert.throws(() => validateMenuSelections({ menu: choicesMenu, selections: [{ ...selection, manualProteinType: 'chicken' }], exclusions: ['Chicken'] }), { statusCode: 409 });
});
test('only exact stored component names or the stored joined field are valid overrides', () => {
  const overrides = { proteinChoice: 'Beef', carbChoice: 'Rice + Quinoa', vegChoice: 'Broccoli', sauceChoice: 'Lemon sauce', manualProteinType: 'beef' };
  const [saved] = validateMenuSelections({ menu: choicesMenu, selections: [{ ...selection, ...overrides, quantity: 2, remark: 'Original kitchen note' }] });
  for (const [field, value] of Object.entries(overrides)) assert.equal(saved[field], value);
  assert.equal(saved.quantity, 2); assert.equal(saved.remark, 'Original kitchen note');
  assert.throws(() => validateMenuSelections({ menu: choicesMenu, selections: [{ ...selection, carbChoice: 'Quinoa + Rice' }] }), { statusCode: 409 });
});
test('empty/omitted overrides remain valid but malformed override types reject', () => {
  const fields = ['proteinChoice', 'carbChoice', 'vegChoice', 'sauceChoice', 'manualProteinType'];
  assert.equal(validateMenuSelections({ menu: choicesMenu, selections: [{ ...selection, ...Object.fromEntries(fields.map(field => [field, ''])) }] }).length, 1);
  for (const field of fields) for (const value of [null, {}, [], 1, false]) {
    assert.throws(() => validateMenuSelections({ menu: choicesMenu, selections: [{ ...selection, [field]: value }] }), { statusCode: 409 });
  }
  const noType = { meals: [{ ...choicesMenu.meals[0], items: [{ ...choicesMenu.meals[0].items[0], portionType: '' }] }] };
  assert.throws(() => validateMenuSelections({ menu: noType, selections: [{ ...selection, manualProteinType: 'beef' }] }), { statusCode: 409 });
});


test('mixed preference conflicts save as kept with actual flags rather than component replacements', () => {
  for (const type of ['Vegetable', 'Salad']) {
    const dish = item([c('p','Protein','Roast'),c('c','Carb','Rice',['Gluten']),c('v',type,'Slaw',['Coriander'])]);
    dish.cycleMeal.carbCombined='Yes';
    const mixed = {meals:[{date:'2099-11-02',mealType:'main',items:[dish]}]};
    const [saved]=validateMenuSelections({menu:mixed,selections:[{...selection,carbVegAction:'replace',exclusionConflict:['Fake']}],exclusions:['Gluten','Coriander']});
    assert.equal(saved.carbVegAction,'kept');assert.deepEqual(saved.exclusionConflict,['Gluten','Coriander']);
    assert.deepEqual(saved.carbConflict,['Gluten']);assert.deepEqual(saved.vegConflict,['Coriander']);
    assert.throws(()=>validateMenuSelections({menu:mixed,selections:[{...selection,exclusionAcknowledged:true}],exclusions:['Gluten','Coriander'],allergies:['Gluten']}),{statusCode:409});
  }
});
