import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateComponentSelection as evaluate, selectionPreferenceFlags } from '../../client/src/constants/componentSelectionRules/index.js';
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
  const [saved]=validateMenuSelections({menu,selections:[selection],exclusions:['Peas']});assert.equal(saved.carbVegAction,'kept');assert.equal(saved.carbVegPreference,'kept');assert.deepEqual(saved.vegConflict,[]);assert.deepEqual(saved.preferenceConflict,['Peas']);assert.deepEqual(saved.exclusionConflict,[]);assert.equal(saved.needsSauceChange,false);
  for(const invalid of [{menuItemId:'other'},{date:'2099-11-03'},{mealType:'snack'},{mealName:'Forged'},{quantity:-1}]) assert.throws(()=>validateMenuSelections({menu,selections:[{...selection,...invalid}]}),{statusCode:409});
});
test('name-only legacy selections must resolve uniquely',()=>{
  const {menuItemId,...legacy}=selection;assert.equal(validateMenuSelections({menu,selections:[legacy]})[0].menuItemId,'dish');assert.throws(()=>validateMenuSelections({menu:{meals:[menu.meals[0],menu.meals[0]]},selections:[legacy]}),{statusCode:409});
});
test('whole-meal preference conflicts save as warnings but allergies reject forged replacement actions',()=>{
  const unsafe={meals:[{date:'2099-11-02',mealType:'main',items:[item([c('p','Protein','Peas')])]}]};
  const [saved]=validateMenuSelections({menu:unsafe,selections:[{...selection,exclusionConflict:['Fake']}],exclusions:['Peas']});
  assert.deepEqual(saved.preferenceConflict,['Peas']);assert.deepEqual(saved.exclusionConflict,[]);assert.equal(saved.carbVegAction,undefined);
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


test('mixed preference conflicts save warnings without side choices or replacements', () => {
  for (const type of ['Vegetable', 'Salad']) {
    const dish = item([c('p','Protein','Roast'),c('c','Carb','Rice',['Gluten']),c('v',type,'Slaw',['Coriander'])]);
    dish.cycleMeal.carbCombined='Yes';
    const mixed = {meals:[{date:'2099-11-02',mealType:'main',items:[dish]}]};
    const [saved]=validateMenuSelections({menu:mixed,selections:[{...selection,carbVegAction:'replace',exclusionConflict:['Fake']}],exclusions:['Gluten','Coriander']});
    assert.equal(saved.carbVegAction,undefined);assert.equal(saved.carbVegPreference,undefined);assert.deepEqual(saved.keptCarbConflict,[]);assert.deepEqual(saved.keptVegConflict,[]);assert.deepEqual(saved.preferenceConflict,['Gluten','Coriander']);assert.deepEqual(saved.exclusionConflict,[]);
    assert.deepEqual(saved.carbConflict,[]);assert.deepEqual(saved.vegConflict,[]);assert.deepEqual(saved.carbVegConflict,[]);
    assert.throws(()=>validateMenuSelections({menu:mixed,selections:[{...selection,exclusionAcknowledged:true}],exclusions:['Gluten','Coriander'],allergies:['Gluten']}),{statusCode:409});
  }
});


test('Keep as is persists for public carb and vegetable conflicts without trusting supplied conflict arrays', () => {
  for (const type of ['Carb', 'Vegetable']) {
    const dish=item([c('p','Protein','Roast'),c('x',type,'Side',['Dairy'])]);
    const local={meals:[{date:'2099-11-02',mealType:'main',items:[dish]}]};
    for (const request of [{carbVegPreference:'kept',carbVegAction:'replace'},{carbVegAction:'kept'}]) {
      const [saved]=validateMenuSelections({menu:local,selections:[{...selection,...request,carbConflict:['Fake'],vegConflict:['Fake']}],exclusions:['Dairy']});
      assert.equal(saved.carbVegAction,'kept');assert.equal(saved.carbVegPreference,'kept');
      assert.deepEqual(saved.preferenceConflict,['Dairy']);assert.deepEqual(saved.exclusionConflict,[]);assert.deepEqual(saved.carbConflict,[]);assert.deepEqual(saved.vegConflict,[]);assert.deepEqual(saved.carbVegConflict,[]);assert.ok(!JSON.stringify(saved).includes('Fake'));
      assert.deepEqual(saved.keptCarbConflict,type==='Carb'?['Dairy']:[]);
      assert.deepEqual(saved.keptVegConflict,type==='Vegetable'?['Dairy']:[]);
      const [reopened]=validateMenuSelections({menu:local,selections:[saved],exclusions:['Dairy']});
      assert.equal(reopened.carbVegAction,'kept');assert.equal(reopened.carbVegPreference,'kept');
    }
    const [replace]=validateMenuSelections({menu:local,selections:[{...selection,carbVegPreference:'replace'}],exclusions:['Dairy']});
    assert.equal(replace.carbVegAction,'replace');assert.equal(replace.carbVegPreference,'replace');
  }
});

test('keeping a public carb never cancels private salad/dressing replacement, including the same exclusion', () => {
  for (const flag of ['Dairy','Soy']) {
    const dish=item([c('p','Protein','Roast'),c('c','Carb','Rice',['Dairy']),c('v','Salad','Slaw'),c('s','Sauce 2','Dressing',[flag])]);
    const local={meals:[{date:'2099-11-02',mealType:'main',items:[dish]}]};
    const result=evaluate(dish,['Dairy',flag]);assert.deepEqual(result.hiddenVegConflict,[flag]);
    const expected=selectionPreferenceFlags(result,'kept');
    assert.equal(expected.carbVegAction,'replace');assert.deepEqual(expected.carbConflict,[]);assert.deepEqual(expected.vegConflict,[flag]);
    const [saved]=validateMenuSelections({menu:local,selections:[{...selection,carbVegPreference:'kept'}],exclusions:['Dairy',flag]});
    assert.equal(saved.carbVegPreference,'kept');assert.equal(saved.carbVegAction,'replace');
    assert.deepEqual(saved.carbVegConflict,[flag]);assert.deepEqual(saved.carbConflict,[]);assert.deepEqual(saved.vegConflict,[flag]);
    const [reopened]=validateMenuSelections({menu:local,selections:[saved],exclusions:['Dairy',flag]});
    assert.deepEqual(reopened,saved);
  }
});

test('malformed preference values fail but Keep never waives an allergy', () => {
  for (const value of [null, '', 'keep', true, 0, {}, []]) {
    assert.throws(()=>validateMenuSelections({menu,selections:[{...selection,carbVegPreference:value}]}),{statusCode:409});
    assert.throws(()=>validateMenuSelections({menu,selections:[{...selection,carbVegAction:value}]}),{statusCode:409});
  }
  assert.throws(()=>validateMenuSelections({menu,selections:[{...selection,carbVegPreference:'kept'}],allergies:['Peas']}),{statusCode:409});
});


test('kept preferences cannot produce kitchen replacement markers from conflict-list lengths', () => {
  for (const combined of ['No','Yes']) {
    const dish=item([c('c','Carb','Rice',['Gluten']),c('v','Vegetable','Peas',['Coriander'])]);dish.cycleMeal.carbCombined=combined;
    const result=evaluate(dish,['Gluten','Coriander']);const flags=selectionPreferenceFlags(result,'kept');
    assert.equal(flags.carbVegAction,combined==='Yes'?undefined:'kept');
    assert.deepEqual(flags.carbConflict,[]);assert.deepEqual(flags.vegConflict,[]);assert.deepEqual(flags.carbVegConflict,[]);
    assert.deepEqual(flags.preferenceConflict,['Gluten','Coriander']);assert.deepEqual(flags.exclusionConflict,[]);
    assert.deepEqual(result.flags.carbConflict,['Gluten']);assert.deepEqual(result.flags.vegConflict,['Coriander']);
  }
});


test('manual audit preferences are separate from mandatory kitchen-swap conflicts and cannot be forged', () => {
  const [kept] = validateMenuSelections({menu,selections:[{...selection,carbVegPreference:'kept',preferenceConflict:['Fake'],exclusionConflict:['Fake']}],exclusions:['Peas']});
  assert.deepEqual(kept.preferenceConflict,['Peas']);assert.deepEqual(kept.exclusionConflict,[]);
  const [safe] = validateMenuSelections({menu,selections:[{...selection,preferenceConflict:['Fake'],exclusionConflict:['Fake']}]});
  assert.deepEqual(safe.preferenceConflict,[]);assert.deepEqual(safe.exclusionConflict,[]);
});

test('portion warnings drop old or forged side choices and kept-side claims', () => {
  const portionMenu={meals:[{date:'2099-11-02',mealType:'main',items:[item([c('p','Protein','Roast',['Dairy'])])]}]};
  for (const preference of ['kept','replace']) {
    const [saved]=validateMenuSelections({menu:portionMenu,selections:[{...selection,carbVegPreference:preference,keptCarbConflict:['Fake'],keptVegConflict:['Fake']}],exclusions:['Dairy']});
    assert.equal(saved.carbVegPreference,undefined);assert.equal(saved.carbVegAction,undefined);
    assert.deepEqual(saved.keptCarbConflict,[]);assert.deepEqual(saved.keptVegConflict,[]);
    assert.deepEqual(saved.preferenceConflict,['Dairy']);
    assert.deepEqual(validateMenuSelections({menu:portionMenu,selections:[saved],exclusions:['Dairy']})[0],saved);
  }
});
