import test from 'node:test';
import assert from 'node:assert/strict';
import router from './menus.js';
import matter from '../services/matterApiService.js';
import Customer from '../models/Customer.js';
import Record from '../models/MenuSelectionRecord.js';
import Menu from '../models/WeeklyMenu.js';

const handler = router.stack.find((layer) => layer.route?.path === '/customers/:email/select-meals').route.stack.at(-1).handle;
const response = () => { const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; return res; };

test('submission stores a Matter customer selection without using Internal identity matching', async () => {
  const original = { lookup: matter.getKitchenNutrition, find: Customer.findOne, allergyFind: Customer.find, menuRead: Menu.findById, byId: Customer.findById, prior: Record.findOne, save: Record.findOneAndUpdate, count: Record.countDocuments, menu: Menu.findByIdAndUpdate, log: console.log };
  let saved;
  const customer = { _id: '507f1f77bcf86cd799439011', customerId: 'internal', email: 'internal@example.invalid', firstName: 'Internal', selectedMeals: [], save: async function () { return this; } };
  matter.getKitchenNutrition = async (params) => {
    assert.deepEqual(params, { email: 'website@example.invalid' });
    return { subscription_id: 'verified-subscription', customer_id: 'permanent', customer_email: 'website@example.invalid', customer_name: 'Website', exclusions: [] };
  };
  Customer.findOne = () => assert.fail('Internal identity profiles must not be read');
  Customer.find = () => ({ select: () => ({ lean: async () => [] }) });
  Menu.findById = () => ({ populate: () => ({ lean: async () => ({ meals: [{ date: '2026-10-22', mealType: 'main', items: [{ _id: '507f1f77bcf86cd799439013', mealName: 'Fixture', itemDate: '2026-10-22', mealType: 'main' }] }] }) }) });
  Customer.findById = async () => customer;
  Record.findOne = () => ({ select: () => ({ lean: async () => null }) });
  Record.findOneAndUpdate = async (filter, update) => { saved = { filter, values: update.$set }; return {}; };
  Record.countDocuments = async () => 1;
  Menu.findByIdAndUpdate = async () => ({});
  console.log = () => {};
  try {
    const res = response();
    await handler({ params: { email: 'website@example.invalid' }, body: { weeklyMenuId: '507f1f77bcf86cd799439012', subscriptionId: 'untrusted-client-id', selections: [{ date: '2026-10-22', mealType: 'main', mealName: 'Fixture' }] } }, res);
    assert.equal(res.body.success, true);
    assert.equal(saved.values.email, 'website@example.invalid');
    assert.equal(saved.values.customerId, 'permanent');
    assert.equal(saved.values.customer, undefined);
    assert.equal(saved.values.matterEmail, 'website@example.invalid');
    assert.equal(saved.values.matterCustomerId, 'permanent');
    assert.equal(saved.values.matterSubscriptionId, 'verified-subscription');
    const doc = new Record(saved.values);
    assert.equal(doc.validateSync(), undefined);
    assert.equal(doc.toObject().matterEmail, 'website@example.invalid');
  } finally { matter.getKitchenNutrition = original.lookup; Customer.findOne = original.find; Customer.find = original.allergyFind; Menu.findById = original.menuRead; Customer.findById = original.byId; Record.findOne = original.prior; Record.findOneAndUpdate = original.save; Record.countDocuments = original.count; Menu.findByIdAndUpdate = original.menu; console.log = original.log; }
});

test('failed website verification cannot save an unverified selection', async () => {
  const original = { lookup: matter.getKitchenNutrition, find: Customer.findOne, log: console.log, error: console.error };
  matter.getKitchenNutrition = async () => { throw new Error('Upstream unavailable'); };
  Customer.findOne = () => assert.fail('must stop before Internal lookup or writes');
  console.log = console.error = () => {};
  try {
    const res = response();
    await handler({ params: { email: 'website@example.invalid' }, body: { weeklyMenuId: '507f1f77bcf86cd799439012', selections: [] } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
  } finally { matter.getKitchenNutrition = original.lookup; Customer.findOne = original.find; console.log = original.log; console.error = original.error; }
});


const adminHandler = router.stack.find(layer => layer.route?.path === '/:menuId/selections/:email' && layer.route.methods.put).route.stack.at(-1).handle;
const menuId = '507f1f77bcf86cd799439012', dishId = '507f1f77bcf86cd799439013';
async function withSelectionFixtures(run) {
  const original = { lookup: matter.getKitchenNutrition, allergies: Customer.find, menu: Menu.findById, prior: Record.findOne, save: Record.findOneAndUpdate, count: Record.countDocuments, menuCount: Menu.findByIdAndUpdate, log: console.log, error: console.error };
  const state = { writes: [], nutrition: { subscription_id: 'sub', customer_id: 'permanent', customer_email: 'website@example.invalid', exclusions: ['Nuts'] }, allergies: [], item: { _id: dishId, mealName: 'Fixture', mealType: 'main', itemDate: '2026-10-22', cycleMeal: { components: [{ id: 'p', type: 'Protein', name: 'Chicken', exclusions: [] }], carbCombined: 'No' } } };
  matter.getKitchenNutrition = async ({ email }) => { state.profileEmail = email; return state.nutrition; };
  Customer.find = () => ({ select: () => ({ lean: async () => state.allergies }) });
  Menu.findById = () => { const menu = { _id: menuId, meals: [{ date: '2026-10-22', mealType: 'main', items: [state.item] }] }; return { populate() { return this; }, lean: async () => menu, then: (yes, no) => Promise.resolve(menu).then(yes, no) }; };
  Record.findOne = () => ({ select() { return this; }, lean: async () => ({ matterEmail: 'website@example.invalid', email: 'storage@example.invalid', matterCustomerId: 'permanent', skippedDays: [], selectedMeals: state.savedMeals || [] }) });
  Record.findOneAndUpdate = async (filter, update) => { state.writes.push({ filter, update }); return {}; };
  Record.countDocuments = async () => 1; Menu.findByIdAndUpdate = async () => ({});
  console.log = console.error = () => {};
  try { await run(state); } finally { matter.getKitchenNutrition = original.lookup; Customer.find = original.allergies; Menu.findById = original.menu; Record.findOne = original.prior; Record.findOneAndUpdate = original.save; Record.countDocuments = original.count; Menu.findByIdAndUpdate = original.menuCount; console.log = original.log; console.error = original.error; }
}
const submitted = extra => ({ date: '2026-10-22', mealType: 'main', menuItemId: dishId, mealName: 'Fixture', ...extra });
const post = async selections => { const res = response(); await handler({ params: { email: 'website@example.invalid' }, body: { weeklyMenuId: menuId, selections } }, res); return res; };

test('customer save allows a portion preference warning but recomputes its conflict record', () => withSelectionFixtures(async state => {
  state.item.cycleMeal.components[0].exclusions = ['Nuts'];
  const res = await post([submitted({ carbVegAction: 'replace', exclusionConflict: [] })]);
  assert.equal(res.statusCode, 200); assert.equal(state.writes.length, 1);
  const saved=state.writes[0].update.$set.selectedMeals[0];assert.deepEqual(saved.preferenceConflict,['Nuts']);assert.deepEqual(saved.exclusionConflict || [],[]);assert.equal(saved.carbVegAction,undefined);
}));
test('customer save recomputes private salad replacement flags', () => withSelectionFixtures(async state => {
  state.item.cycleMeal.components.push({ id: 's', type: 'Sauce 2', name: 'Dressing', exclusions: ['Nuts'] }, { id: 'v', type: 'Salad', name: 'Slaw', exclusions: [] });
  const res = await post([submitted({ carbVegAction: 'kept', vegConflict: [], needsSauceChange: true })]);
  assert.equal(res.statusCode, 200); const saved = state.writes[0].update.$set.selectedMeals[0];
  assert.equal(saved.carbVegAction, 'replace'); assert.deepEqual(saved.vegConflict, ['Nuts']); assert.equal(saved.needsSauceChange, false);
}));
test('customer save rejects a known allergy including hidden sauce ingredients', () => withSelectionFixtures(async state => {
  state.allergies = [{ matterCustomerId: 'permanent', allergies: ['Dairy'] }]; state.item.sauceIngredients = [{ name: 'Milk', visible: false }];
  const res = await post([submitted()]); assert.equal(res.statusCode, 409); assert.equal(state.writes.length, 0);
}));
test('customer save rejects forged dish identity/date/name and malformed selections', () => withSelectionFixtures(async state => {
  for (const data of [[submitted({ menuItemId: '507f1f77bcf86cd799439099' })], [submitted({ date: '2026-10-23' })], [submitted({ mealName: 'Forged' })], [null], 'invalid']) {
    const res = await post(data); assert.ok([400, 409].includes(res.statusCode));
  }
  assert.equal(state.writes.length, 0);
}));
test('admin save uses saved identity profile and recomputes flags', () => withSelectionFixtures(async state => {
  state.item.cycleMeal.components.push({ id: 'c', type: 'Carb', name: 'Rice', exclusions: ['Nuts'] });
  const res = response(); await adminHandler({ params: { menuId, email: 'storage@example.invalid' }, body: { selections: [submitted({ carbVegAction: 'kept', carbConflict: [] })] } }, res);
  assert.equal(res.statusCode, 200); assert.equal(state.profileEmail, 'website@example.invalid'); assert.equal(state.writes[0].update.$set.selectedMeals[0].carbVegAction, 'kept');
}));
test('admin cannot save against a mismatched verified Matter identity', () => withSelectionFixtures(async state => {
  state.nutrition.customer_id = 'different'; const res = response(); await adminHandler({ params: { menuId, email: 'storage@example.invalid' }, body: { selections: [submitted()] } }, res);
  assert.equal(res.statusCode, 409); assert.equal(state.writes.length, 0);
}));


test('customer and admin save reject unchecked component overrides before writing', () => withSelectionFixtures(async state => {
  state.nutrition.exclusions = ['Chicken'];
  state.allergies = [{ matterCustomerId: 'permanent', allergies: ['Nuts'] }];
  state.item = { ...state.item, portionType: 'beef', proteinSource: 'Beef roast', carbs: 'Rice', veg: 'Broccoli', sauce: 'Lemon sauce', cycleMeal: { components: [{ id: 'p', type: 'Protein', name: 'Beef', exclusions: [] }] } };
  for (const override of [
    { proteinChoice: 'Chicken' }, { carbChoice: 'Chicken rice' }, { vegChoice: 'Nut topping' }, { sauceChoice: 'Nut butter' }, { sauceChoice: {} },
  ]) {
    const customer = await post([submitted(override)]); assert.equal(customer.statusCode, 409);
    const admin = response(); await adminHandler({ params: { menuId, email: 'storage@example.invalid' }, body: { selections: [submitted(override)] } }, admin); assert.equal(admin.statusCode, 409);
  }
  assert.equal(state.writes.length, 0);
}));

test('staff saves correct protein classification while preserving saved pool snacks, breakfast and fallback rows', () => withSelectionFixtures(async state => {
  state.nutrition.exclusions=[];
  state.savedMeals=[
    {date:new Date('2026-10-22'),mealType:'snack',mealName:'Pool snack',isAutoAssigned:true,quantity:1,snackMacros:{C:11,P:4,F:3}},
    {date:new Date('2026-10-22'),mealType:'breakfast',mealName:'Pool breakfast',isAutoAssigned:true,quantity:1},
    {date:new Date('2026-10-22'),mealType:'main',mealName:'Fallback',isAutoAssigned:true,quantity:1,exclusionConflict:['Dairy'],remark:'veg'},
  ];
  const request=[submitted({manualProteinType:'fish'}),...state.savedMeals.map(row=>({...row,date:'2026-10-22',snackMacros:{C:999},exclusionConflict:[]}))];
  const denied=await post(request);assert.equal(denied.statusCode,409);assert.equal(state.writes.length,0);
  const res=response();await adminHandler({params:{menuId,email:'storage@example.invalid'},body:{selections:request}},res);
  assert.equal(res.statusCode,200);const saved=state.writes[0].update.$set.selectedMeals;
  assert.equal(saved[0].manualProteinType,'fish');
  for(let i=0;i<state.savedMeals.length;i++)assert.deepEqual(saved[i+1],{...state.savedMeals[i],manualProteinType:''});
  const record=new Record({weeklyMenuId:menuId,email:'website@example.invalid',selectedMeals:saved});
  assert.equal(record.validateSync(),undefined);assert.equal(record.toObject().selectedMeals[1].snackMacros.C,11);
}));

test('staff correction accepts valid protein enums while public submissions cannot claim staff privileges', () => withSelectionFixtures(async state => {
  state.nutrition.exclusions=[];
  for(const portionType of ['', 'beef']){
    state.item.portionType=portionType;
    const customer=await post([submitted({manualProteinType:'fish',staffOverride:true,staffRecord:{selectedMeals:[]}})]);assert.equal(customer.statusCode,409);
    const staff=response();await adminHandler({params:{menuId,email:'storage@example.invalid'},body:{selections:[submitted({manualProteinType:'fish'})]}},staff);assert.equal(staff.statusCode,200);
    assert.equal(state.writes.at(-1).update.$set.selectedMeals[0].manualProteinType,'fish');
  }
}));
test('customer and admin preserve verified unchanged component choices and metadata', () => withSelectionFixtures(async state => {
  state.item = { ...state.item, portionType: 'beef', proteinSource: 'Beef roast', carbs: 'Rice', veg: 'Broccoli', sauce: 'Lemon sauce', cycleMeal: { components: [{ id: 'p', type: 'Protein', name: 'Beef', exclusions: [] }] } };
  const choices = { proteinChoice: 'Beef', carbChoice: 'Rice', vegChoice: 'Broccoli', sauceChoice: 'Lemon sauce', manualProteinType: 'beef', quantity: 2 };
  assert.equal((await post([submitted(choices)])).statusCode, 200);
  const admin = response(); await adminHandler({ params: { menuId, email: 'storage@example.invalid' }, body: { selections: [submitted({ ...choices, remark: 'Keep note' })] } }, admin); assert.equal(admin.statusCode, 200);
  for (const write of state.writes) for (const [field, value] of Object.entries(choices)) assert.equal(write.update.$set.selectedMeals[0][field], value);
  assert.equal(state.writes[1].update.$set.selectedMeals[0].remark, 'Keep note');
}));


test('customer and admin save mixed preferences as warnings without trusting replacement or conflict claims', () => withSelectionFixtures(async state => {
  state.nutrition.exclusions=['Gluten','Coriander'];
  state.item.cycleMeal={carbCombined:'Yes',components:[{id:'p',type:'Protein',name:'Roast',exclusions:[]},{id:'c',type:'Carb',name:'Rice',exclusions:['Gluten']},{id:'v',type:'Salad',name:'Slaw',exclusions:['Coriander']}]};
  const choices=submitted({carbVegAction:'replace',exclusionConflict:['Fake']});
  assert.equal((await post([choices])).statusCode,200);
  const admin=response();await adminHandler({params:{menuId,email:'storage@example.invalid'},body:{selections:[choices]}},admin);assert.equal(admin.statusCode,200);
  for(const write of state.writes){const saved=write.update.$set.selectedMeals[0];assert.equal(saved.carbVegAction,undefined);assert.equal(saved.carbVegPreference,undefined);assert.deepEqual(saved.preferenceConflict,['Gluten','Coriander']);assert.deepEqual(saved.exclusionConflict || [],[]);assert.deepEqual(saved.carbConflict || [],[]);assert.deepEqual(saved.vegConflict || [],[]);assert.deepEqual(saved.carbVegConflict || [],[]);}
}));


test('customer and admin persist Keep choice separately from private salad replacement through schema roundtrip', () => withSelectionFixtures(async state => {
  state.nutrition.exclusions=['Dairy'];
  state.item.cycleMeal.components.push({id:'c',type:'Carb',name:'Rice',exclusions:['Dairy']},{id:'v',type:'Salad',name:'Slaw',exclusions:[]},{id:'s',type:'Sauce 2',name:'Dressing',exclusions:['Dairy']});
  const choices=submitted({carbVegPreference:'kept',carbVegAction:'kept',carbConflict:[],vegConflict:[]});
  assert.equal((await post([choices])).statusCode,200);
  const admin=response();await adminHandler({params:{menuId,email:'storage@example.invalid'},body:{selections:[choices]}},admin);assert.equal(admin.statusCode,200);
  for(const write of state.writes){
    const saved=write.update.$set.selectedMeals[0];assert.equal(saved.carbVegPreference,'kept');assert.equal(saved.carbVegAction,'replace');assert.deepEqual(saved.carbConflict || [],[]);assert.deepEqual(saved.vegConflict,['Dairy']);
    assert.deepEqual(saved.keptCarbConflict,['Dairy']);
    const record=new Record({weeklyMenuId:menuId,email:'website@example.invalid',selectedMeals:[saved]});assert.equal(record.validateSync(),undefined);assert.equal(record.toObject().selectedMeals[0].carbVegPreference,'kept');assert.deepEqual(record.toObject().selectedMeals[0].preferenceConflict,['Dairy']);assert.deepEqual(record.toObject().selectedMeals[0].exclusionConflict,[]);
    assert.deepEqual(record.toObject().selectedMeals[0].keptCarbConflict,['Dairy']);
  }
}));

test('customer and admin allow Keep for separate public carb but reject malformed preferences and allergies', () => withSelectionFixtures(async state => {
  state.nutrition.exclusions=['Dairy'];state.item.cycleMeal.components.push({id:'c',type:'Carb',name:'Rice',exclusions:['Dairy']});
  const choices=submitted({carbVegPreference:'kept',preferenceConflict:['Fake'],exclusionConflict:['Fake']});assert.equal((await post([choices])).statusCode,200);
  const admin=response();await adminHandler({params:{menuId,email:'storage@example.invalid'},body:{selections:[choices]}},admin);assert.equal(admin.statusCode,200);
  for(const write of state.writes){const saved=write.update.$set.selectedMeals[0];assert.equal(saved.carbVegAction,'kept');assert.equal(saved.carbVegPreference,'kept');assert.deepEqual(saved.carbConflict || [],[]);assert.deepEqual(saved.vegConflict || [],[]);assert.deepEqual(saved.carbVegConflict || [],[]);assert.deepEqual(saved.preferenceConflict,['Dairy']);assert.deepEqual(saved.exclusionConflict || [],[]);}
  const before=state.writes.length;
  assert.equal((await post([submitted({carbVegPreference:{}})])).statusCode,409);
  state.allergies=[{matterCustomerId:'permanent',allergies:['Dairy']}];assert.equal((await post([choices])).statusCode,409);assert.equal(state.writes.length,before);
}));
