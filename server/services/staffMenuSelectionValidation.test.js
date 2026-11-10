import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMenuSelections, validateStaffMenuSelections } from './menuSelectionValidation.js';

const date='2099-11-02';
const dish={_id:'dish',mealName:'Roast',mealType:'main',itemDate:date,portionType:'beef',proteinSource:'Roast'};
const menu={meals:[{date,mealType:'main',items:[dish]}]};
const main={date,mealType:'main',mealName:'Roast',menuItemId:'dish',quantity:1};
const pools=[
  {date:new Date(date),mealType:'snack',mealName:'Pool snack',quantity:1,snackMacros:{C:12,P:3,F:4},isAutoAssigned:true},
  {date:new Date(date),mealType:'breakfast',mealName:'Pool breakfast',quantity:1,isAutoAssigned:true},
  {date:new Date(date),mealType:'main',mealName:'Fallback dish',menuItemId:'pool-dish',slotNumber:2,quantity:1,isAutoAssigned:true,exclusionConflict:['Coriander'],remark:'veg',carbConflict:['Dairy']},
];

test('staff correction keeps verified unrelated pool assignments and their preparation data intact', () => {
  const selections=[{...main,manualProteinType:'fish'},...pools.map(row=>({...row,date,manualProteinType:'',exclusionConflict:[],snackMacros:{C:999},isAutoAssigned:false}))];
  const saved=validateStaffMenuSelections({menu,selections,existingSelections:pools});
  assert.equal(saved[0].manualProteinType,'fish');
  for(let i=0;i<pools.length;i++)assert.deepEqual(saved[i+1],{...pools[i],manualProteinType:''});
});

test('pool carry-forward requires a saved auto-assignment, stable identity, components and quantity', () => {
  for (const patch of [{mealName:'Forged'},{date:'2099-11-03'},{mealType:'main'},{menuItemId:'other'},{quantity:2},{slotNumber:3},{proteinChoice:'Fish'}]) {
    assert.throws(()=>validateStaffMenuSelections({menu,selections:[{...pools[0],...patch}],existingSelections:pools}),{statusCode:409});
  }
  assert.throws(()=>validateStaffMenuSelections({menu,selections:[pools[0]],existingSelections:[]}),{statusCode:409});
  assert.throws(()=>validateStaffMenuSelections({menu,selections:[pools[0]],existingSelections:[{...pools[0],isAutoAssigned:false}]}),{statusCode:409});
  assert.throws(()=>validateStaffMenuSelections({menu,selections:[pools[0],pools[0]],existingSelections:[pools[0]]}),{statusCode:409});
});

test('only staff may correct a missing or incorrect classification and clear the correction', () => {
  for(const stored of ['', 'beef'])for(const manualProteinType of ['chicken','fish','']){
    const source={meals:[{date,mealType:'main',items:[{...dish,portionType:stored}]}]};
    const [saved]=validateStaffMenuSelections({menu:source,selections:[{...main,manualProteinType}]});
    assert.equal(saved.manualProteinType,manualProteinType);
    if(manualProteinType)assert.throws(()=>validateMenuSelections({menu:source,selections:[{...main,manualProteinType}]}),{statusCode:409});
  }
  for(const manualProteinType of [null,{},[],1,'pork'])assert.throws(()=>validateStaffMenuSelections({menu,selections:[{...main,manualProteinType}]}),{statusCode:409});
});

test('staff classification changes do not authorize new components, auto-assignments, or allergy bypasses', () => {
  assert.throws(()=>validateStaffMenuSelections({menu,selections:[{...main,proteinChoice:'Fish'}]}),{statusCode:409});
  assert.equal(validateStaffMenuSelections({menu,selections:[{...main,isAutoAssigned:true}]} )[0].isAutoAssigned,false);
  assert.throws(()=>validateStaffMenuSelections({menu,selections:[{...main,manualProteinType:'fish'}],allergies:['All Fish']}),{statusCode:409});
  const peanutMenu={meals:[{date,mealType:'main',items:[{...dish,sauceIngredients:[{name:'Peanut Butter'}]}]}]};
  assert.throws(()=>validateStaffMenuSelections({menu:peanutMenu,selections:[{...main,manualProteinType:'fish'}],allergies:['All Nuts']}),{statusCode:409});
  assert.throws(()=>validateStaffMenuSelections({menu,selections:[{...pools[2],manualProteinType:'fish'}],existingSelections:pools,allergies:['All Fish']}),{statusCode:409});
});
