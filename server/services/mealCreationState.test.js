import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkedBoards, changeMealCreationState, recoverMealCreationState, mergeLegacyDraft } from './mealCreationState.js';

const meal = (id, name = id) => ({ id, name, mealKind: 'Main meal', mealType: 'Chicken', carbCombined: 'No', components: [{ id: `${id}-p`, type: 'Protein', name: 'Roast', exclusions: ['Nuts'], notes: 'Keep preparation notes' }] });
const board = () => Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => []));
const initial = () => ({ catalogue: { meals: [meal('one')], source: 'Original.xlsx' }, boards: { 'Main menu:Week 1': board() } });

test('actual workbook parser blank combined flags import and migrate without losing notes or exclusions',async()=>{
  const source=readFileSync(new URL('../../client/src/pages/adminMealSelectionV2/workbookMeals.js',import.meta.url));
  const {parseMealWorkbook}=await import(`data:text/javascript;base64,${source.toString('base64')}`);
  const headers=['Meal ID','Day','Meal category','Temperature','Meal name','Protein / main item','Carb','Vegetable','Sauce','Garnish','Tags','Carb combined with veg','Preparation / option notes'];
  const parsed=parseMealWorkbook({Meals:[headers,['blank','DAY 1','MAIN CHX','WARM','Own meal','Roast','','','','','','','Meal notes']],Components:[['Meal ID','Component type','Component name','Preparation / option notes','Exclusion 1'],['blank','Protein','Roast','Keep notes','Nuts']]});
  assert.equal(parsed[0].carbCombined,'');
  const saved=changeMealCreationState(initial(),{catalogue:{meals:parsed}});
  const imported=saved.catalogue.meals.find(m=>m.id==='blank');assert.equal(imported.carbCombined,'Not specified');assert.equal(imported.notes,'Meal notes');assert.deepEqual(imported.components[0].exclusions,['Nuts']);assert.equal(imported.components[0].notes,'Keep notes');
  assert.equal(mergeLegacyDraft(initial(),{catalogue:{meals:parsed}},false).catalogue.meals.length,2);
  assert.equal(parsed[0].carbCombined,'');
});

test('imports upsert meals without dropping existing library meals, notes, exclusions or cycle placements', () => {
  const state=initial();state.boards['Main menu:Week 1'][0][1].push({mealId:'one',isMatterCore:true});
  const before=JSON.stringify(state);
  const saved=changeMealCreationState(state,{catalogue:{meals:[meal('two')],source:'Next.xlsx'}});
  assert.deepEqual(saved.catalogue.meals.map(m=>m.id),['one','two']);
  assert.deepEqual(saved.catalogue.meals[0],state.catalogue.meals[0]);assert.deepEqual(saved.boards,state.boards);assert.equal(JSON.stringify(state),before);
  const changed=changeMealCreationState(saved,{catalogue:{meals:[meal('one','Renamed')]}});
  assert.equal(changed.catalogue.meals.length,2);assert.equal(changed.catalogue.meals[0].name,'Renamed');
  assert.equal(changed.catalogue.source,'Next.xlsx');
});

test('board changes preserve other weeks and intentionally empty weeks survive',()=>{
  const state=initial(), second=board();second[6][2]=[{mealId:'one',isMatterCore:true}];
  const saved=changeMealCreationState(state,{boards:{'Main menu:Week 2':second}});
  assert.deepEqual(saved.boards['Main menu:Week 1'],board());assert.deepEqual(saved.boards['Main menu:Week 2'][6][2],[{mealId:'one',isMatterCore:true}]);
  assert.throws(()=>checkedBoards({'Main menu:Week 2':[]},state.catalogue.meals),{statusCode:400});
  const invalid=board();invalid[0][0]=[{mealId:'missing',isMatterCore:false}];assert.throws(()=>checkedBoards({'Main menu:Week 2':invalid},state.catalogue.meals),{statusCode:400});
});

test('recovery keeps newest intact snapshots and reconstructs exact Main/Sub/Core placements without mutating menus',()=>{
  const latest={...meal('one','Newest'),cycleSource:{week:'Week 1',day:7}};
  const menus=[{meals:[{mealType:'main',items:[{cycleMeal:latest,rotationCategory:'sub',usedForCorePlan:true},{cycleMeal:meal('two')},{cycleMeal:{id:'invalid'}}]}]},{meals:[{mealType:'main',items:[{cycleMeal:{...meal('one','Old'),cycleSource:{week:'Week 1',day:1}}}]}]}];
  const before=JSON.stringify(menus), recovered=recoverMealCreationState(menus);
  assert.equal(recovered.catalogue.meals.length,2);assert.equal(recovered.catalogue.meals[0].name,'Newest');
  assert.deepEqual(recovered.catalogue.meals[0].components,latest.components);
  assert.deepEqual(recovered.boards['Main menu:Week 1'][6][2],[{mealId:'one',isMatterCore:true}]);assert.deepEqual(recovered.boards['Main menu:Week 1'][0][1],[]);
  assert.equal(recovered.recovery.skippedSnapshots,1);assert.equal(JSON.stringify(menus),before);
});

test('old browser migrations add missing meals and never overwrite database edits or empty weeks',()=>{
  const current=initial();current.catalogue.meals[0].name='Edited on server';
  const oldBoard=board();oldBoard[0][1]=[{mealId:'one',isMatterCore:false}];
  const legacy={catalogue:{meals:[meal('one','Old browser'),meal('two')],source:'Old.xlsx'},boards:{'Main menu:Week 1':oldBoard}};
  const merged=mergeLegacyDraft(current,legacy);
  assert.equal(merged.catalogue.meals[0].name,'Edited on server');assert.equal(merged.catalogue.meals.length,2);assert.deepEqual(merged.boards['Main menu:Week 1'],board());
  assert.deepEqual(mergeLegacyDraft(merged,legacy),merged);
});

test('a dangling old browser board does not prevent first-run meal recovery or destroy its recovered week',()=>{
  const recovered=initial(), bad=board();bad[0][1]=[{mealId:'gone',isMatterCore:false}];
  const merged=mergeLegacyDraft(recovered,{catalogue:{meals:[meal('two')]},boards:{'Main menu:Week 1':bad}},false);
  assert.equal(merged.catalogue.meals.length,2);assert.deepEqual(merged.boards,recovered.boards);
});

test('dated copies with original cycle-source metadata recover one importable assignment and retain Core',()=>{
  const snapshot={...meal('one'),cycleSource:{week:'Week 1',day:1}};
  const recovered=recoverMealCreationState([{meals:[{date:'2026-11-16',mealType:'main',items:[{cycleMeal:snapshot,rotationCategory:'main'}]},{date:'2026-11-17',mealType:'main',items:[{cycleMeal:snapshot,rotationCategory:'sub',usedForCorePlan:true}]}]}]);
  assert.deepEqual(recovered.boards['Main menu:Week 1'][0][1],[{mealId:'one',isMatterCore:true}]);assert.deepEqual(recovered.boards['Main menu:Week 1'][0][2],[]);
});

test('recovered older weeks and first-run legacy recipes use the retained meal kind without losing placements',()=>{
  const latest={...meal('one'),mealKind:'Snack',cycleSource:{week:'Week 1',day:1}};
  const old={...meal('one'),cycleSource:{week:'Week 2',day:1}};
  const recovered=recoverMealCreationState([{meals:[{mealType:'snack',items:[{cycleMeal:latest}]}]},{meals:[{mealType:'main',items:[{cycleMeal:old,rotationCategory:'sub',usedForCorePlan:true}]}]}]);
  assert.deepEqual(recovered.boards['Main menu:Week 2'][0][3],[{mealId:'one',isMatterCore:true}]);assert.deepEqual(recovered.boards['Main menu:Week 2'][0][2],[]);
  const migrated=mergeLegacyDraft(recovered,{catalogue:{meals:[{...meal('one'),mealKind:'Breakfast'}]}},false);
  assert.equal(migrated.boards['Main menu:Week 1'][0][0][0].mealId,'one');assert.equal(migrated.boards['Main menu:Week 2'][0][0][0].isMatterCore,true);
});
