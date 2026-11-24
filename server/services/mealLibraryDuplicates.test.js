import test from 'node:test';
import assert from 'node:assert/strict';
import { mealFingerprint, deduplicateMeals } from './mealLibraryDuplicates.js';
import { changeMealCreationState, checkedBoards, mergeLegacyDraft } from './mealCreationState.js';
import { evaluateComponentSelection } from '../../client/src/constants/componentSelectionRules/index.js';

const recipe = (id, extra = {}) => ({id,name:'House Roast',day:'DAY 1',category:'MAIN CHX',temperature:'WARM',carbCombined:'No',notes:'Keep meal notes',components:[
  {id:id+'-p',type:'Protein',name:'Roast',exclusions:['Dairy','Soy'],notes:'Keep preparation',adaptation:'Not reviewed'},
  {id:id+'-c',type:'Carb',name:'Rice',exclusions:['Beans'],notes:'',adaptation:'Not reviewed'},
],...extra});
const empty = () => Array.from({length:7},()=>Array.from({length:4},()=>[]));
const state = meals => ({catalogue:{meals,source:'Original.xlsx'},boards:{}});

test('recipe duplicates ignore IDs, case, whitespace, component/flag order and workbook positions',()=>{
  const a=recipe('a'),b=recipe('b',{name:'  HOUSE   ROAST ',day:'DAY 6 & 7',workbookRow:27,cycleSource:{week:'Week 2',day:7}});
  b.components.reverse();b.components.find(c=>c.type==='Protein').exclusions=['soy','DAIRY'];
  b.components.find(c=>c.type==='Protein').type='Breakfast';
  assert.equal(mealFingerprint(a),mealFingerprint(b));
  const unique=deduplicateMeals([a,b]);assert.equal(unique.meals.length,1);assert.equal(unique.meals[0].id,'a');assert.deepEqual(unique.aliases,[{from:'b',to:'a'}]);
  assert.deepEqual(unique.meals[0].cycleDays,['DAY 1','DAY 6 & 7']);assert.deepEqual(unique.meals[0].components,a.components);
});

test('different exclusions, components, notes, adaptations and protein kinds remain separate',()=>{
  const original=recipe('a');
  for(const change of [b=>b.components[0].exclusions.push('Nuts'),b=>b.components[1].name='Potato',b=>b.components[0].notes='Do not replace',b=>b.components[0].adaptation='No dairy-free option.',b=>b.mealType='Fish',b=>b.mealKind='Snack',b=>b.carbCombined='Yes']){
    const variant=recipe('b');change(variant);assert.equal(deduplicateMeals([original,variant]).meals.length,2);
  }
});

test('fixed and adaptable recipes stay distinct, while an absent fixed setting equals false', () => {
  const ordinary = recipe('a'), unchecked = recipe('b', { isFixedMeal: false }), fixed = recipe('c', { isFixedMeal: true });
  assert.equal(mealFingerprint(ordinary), mealFingerprint(unchecked));
  assert.equal(deduplicateMeals([ordinary, unchecked, fixed]).meals.length, 2);
  const saved = changeMealCreationState(state([ordinary]), { catalogue: { meals: [fixed] }, skipDuplicates: true });
  assert.equal(saved.catalogue.meals.find(meal => meal.id === 'c').isFixedMeal, true);
  assert.throws(() => changeMealCreationState(state([]), { catalogue: { meals: [recipe('bad', { isFixedMeal: 'true' })] } }), { statusCode: 400 });
});

test('attachment IDs are normalized by component meaning, while a different attachment is a different recipe',()=>{
  const a=recipe('a'),b=recipe('b');
  for(const meal of [a,b])meal.components.push({id:meal.id+'-extra',type:'Extra sauce / topping',name:'Topping',exclusions:['Nuts'],attachedComponentId:meal.id+'-c'});
  assert.equal(mealFingerprint(a),mealFingerprint(b));b.components[2].attachedComponentId='b-p';assert.notEqual(mealFingerprint(a),mealFingerprint(b));
});

test('existing duplicates and alias chains clean up while preserving weekdays, Main/Sub placements and Core',()=>{
  const original=state([recipe('a'),recipe('b',{day:'DAY 6 & 7'})]);original.aliases=[{from:'old',to:'b'}];
  const week=empty();week[0][1]=[{mealId:'b',isMatterCore:false}];week[0][2]=[{mealId:'a',isMatterCore:true}];week[6][2]=[{mealId:'b',isMatterCore:true}];original.boards={'Main menu:Week 1':week};
  const before=JSON.stringify(original),saved=changeMealCreationState(original,{});assert.equal(saved.catalogue.meals.length,1);assert.deepEqual(saved.boards['Main menu:Week 1'][0][1],[{mealId:'a',isMatterCore:true}]);assert.deepEqual(saved.boards['Main menu:Week 1'][0][2],[]);assert.equal(saved.boards['Main menu:Week 1'][6][2][0].mealId,'a');
  assert.deepEqual(checkedBoards({'Main menu:Week 1':week},saved.catalogue.meals,saved.aliases)['Main menu:Week 1'][6][2],[{mealId:'a',isMatterCore:true}]);assert.ok(saved.aliases.some(alias=>alias.from==='old'&&alias.to==='a'));assert.equal(JSON.stringify(original),before);assert.deepEqual(changeMealCreationState(saved,{}),saved);
});

test('repeat imports ignore identical recipes and keep the existing canonical record',()=>{
  const original=recipe('a'),incoming=recipe('b',{name:'HOUSE ROAST',workbookRow:90});
  const saved=changeMealCreationState(state([original]),{catalogue:{meals:[incoming]},skipDuplicates:true});assert.equal(saved.catalogue.meals.length,1);assert.deepEqual(saved.catalogue.meals[0],original);
  const repeated=changeMealCreationState(saved,{catalogue:{meals:[incoming,recipe('c')]},skipDuplicates:true});assert.equal(repeated.catalogue.meals.length,1);assert.deepEqual(repeated.catalogue.meals[0],original);
});

test('reused import IDs with different dietary data keep both variants; later editor changes still update by ID',()=>{
  const original=recipe('a'),incoming=recipe('a');incoming.components[0].exclusions.push('Nuts');
  const saved=changeMealCreationState(state([original]),{catalogue:{meals:[incoming]},skipDuplicates:true});assert.equal(saved.catalogue.meals.length,2);assert.deepEqual(saved.catalogue.meals[0],original);assert.notEqual(saved.catalogue.meals[1].id,'a');
  assert.equal(changeMealCreationState(saved,{catalogue:{meals:[incoming]},skipDuplicates:true}).catalogue.meals.length,2);
  const edited=recipe('a');edited.notes='Updated in editor';assert.equal(changeMealCreationState(state([original]),{catalogue:{meals:[edited]}}).catalogue.meals[0].notes,edited.notes);
});

test('legacy duplicate aliases retain unpublished placements instead of dropping the old board',()=>{
  const week=empty();week[3][2]=[{mealId:'old-import',isMatterCore:true}];
  const saved=mergeLegacyDraft(state([recipe('a')]),{catalogue:{meals:[recipe('old-import')]},boards:{'Main menu:Week 2':week}});
  assert.equal(saved.catalogue.meals.length,1);assert.deepEqual(saved.boards['Main menu:Week 2'][3][2],[{mealId:'a',isMatterCore:true}]);
});

test('a first imported occurrence is retained when the matching saved manual meal has no source day',()=>{
  const saved=changeMealCreationState(state([recipe('manual',{day:''})]),{catalogue:{meals:[recipe('upload')]},skipDuplicates:true});
  assert.equal(saved.catalogue.meals.length,1);assert.deepEqual(saved.catalogue.meals[0].cycleDays,['DAY 1']);
});

test('explicit protein classification overrides source categories case-insensitively',()=>{
  const beef=recipe('beef',{mealType:'beef'}),chicken=recipe('chicken',{mealType:'chicken'});
  assert.notEqual(mealFingerprint(beef),mealFingerprint(chicken));assert.equal(deduplicateMeals([beef,chicken]).meals.length,2);
  assert.equal(mealFingerprint(beef),mealFingerprint(recipe('other',{mealType:' Beef '})));
});

test('nested extras preserve their transitive portion/carb routing and cyclic links terminate safely',()=>{
  const a=recipe('a');a.components.push(
    {id:'x',type:'Extra sauce / topping',name:'Base topping',exclusions:[],attachedComponentId:'a-p'},
    {id:'y',type:'Extra sauce / topping',name:'Base topping',exclusions:[],attachedComponentId:'a-c'},
    {id:'z',type:'Extra sauce / topping',name:'Nut topping',exclusions:['Nuts'],attachedComponentId:'x'},
  );
  const b=structuredClone(a);b.id='b';b.components.find(c=>c.id==='z').attachedComponentId='y';
  assert.equal(evaluateComponentSelection({cycleMeal:a},['Nuts']).wholeMeal,true);assert.equal(evaluateComponentSelection({cycleMeal:b},['Nuts']).wholeMeal,false);
  assert.notEqual(mealFingerprint(a),mealFingerprint(b));assert.equal(deduplicateMeals([a,b]).meals.length,2);
  b.components.find(c=>c.id==='x').attachedComponentId='y';b.components.find(c=>c.id==='y').attachedComponentId='x';assert.doesNotThrow(()=>mealFingerprint(b));
});
