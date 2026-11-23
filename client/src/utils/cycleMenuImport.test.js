import { importCycleMenu, importSavedCycleMenu, CYCLE_BOARD_KEY, CYCLE_CATALOGUE_KEY } from './cycleMenuImport';
const meal = (id, kind, components = []) => ({ id, name: id, mealKind: kind, mealType: kind === 'Main meal' ? 'Chicken' : '', temperature: 'WARM', carbCombined: 'No', components: components.length ? components : [{ id: `${id}-component`, type: kind === 'Snack' ? 'Snack' : 'Protein', name: `${id} component`, exclusions: ['Nuts'], notes: 'Kitchen only' }] });
const board = () => Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => []));
const input = () => {
  const meals = [meal('Main', 'Main meal'), meal('Sub', 'Main meal'), meal('Breakfast', 'Breakfast'), meal('Snack', 'Snack')];
  const value = board(); value[0] = [[{ mealId: 'Breakfast' }], [{ mealId: 'Main', isMatterCore: true }], [{ mealId: 'Sub' }], [{ mealId: 'Snack', isMatterCore: true }]];
  return { catalogue: { meals, source: 'Own workbook.xlsx' }, boards: { 'Main menu:Week 1': value }, week: 'Week 1', startDate: '2026-11-09', endDate: '2026-11-15' };
};

test('QTY and grams-per-piece follow the library meal into its dated menu snapshot', () => {
  const options = input();
  Object.assign(options.catalogue.meals[0], { qtyUnit: 'PCS', gramsPerPiece: 100 });
  const item = importCycleMenu(options)[0].items[1];
  expect(item.cycleMeal).toMatchObject({ qtyUnit: 'PCS', gramsPerPiece: 100 });
});

test('copies placements to actual dates with Main/Sub, Core and internal-only component snapshots', () => {
  const options = input(), before = JSON.stringify(options), days = importCycleMenu(options);
  expect(days).toHaveLength(7); expect(days[6].date).toBe('2026-11-15');
  expect(days[0].items.map(i => [i.mealType, i.rotationCategory, i.usedForCorePlan])).toEqual([['breakfast','',false], ['main','main',true], ['main','sub',false], ['snack','',false]]);
  expect(days[0].items[1]).toMatchObject({ portionType: 'chicken', intolerances: '', allergens: '', portionIngredients: [], cycleMeal: { id: 'Main', components: options.catalogue.meals[0].components } });
  days[0].items[1].cycleMeal.components[0].exclusions.push('Milk');
  expect(JSON.stringify(options)).toBe(before);
});

test('salad maps to veg; optional absent sauces and garnish stay empty; all notes and extras survive', () => {
  const options = input(); options.catalogue.meals[0].components = [
    { id:'p', type:'Protein',name:'Chicken', exclusions:[],notes:'' },
    { id:'v', type:'Salad',name:'Salad name', exclusions:['Coriander'],notes:'Keep note' },
    { id:'s2', type:'Sauce 2',name:'Dressing name', exclusions:['Soy'],notes:'Separate' },
  ];
  const item = importCycleMenu(options)[0].items[1];
  expect(item.veg).toBe('Salad name'); expect(item.sauce).toBe(''); expect(item.garnish).toBe('');
  expect(item.cycleMeal.components).toEqual(options.catalogue.meals[0].components);
});

test.each([['2026-11-10','2026-11-16'],['2026-11-09','2026-11-14'],['2026-02-30','2026-03-08'],['','']])('rejects invalid/non-Monday or non-week dates %s %s', (startDate,endDate) => {
  expect(() => importCycleMenu({ ...input(), startDate, endDate })).toThrow(/date|Monday/);
});

test('uses a stored board exactly, even an intentionally empty Week 1; only absent Week 1 falls back to imported days', () => {
  const options = input(); options.catalogue.meals[0].day='DAY 1'; options.boards['Main menu:Week 1']=board();
  expect(() => importCycleMenu(options)).toThrow('empty');
  delete options.boards['Main menu:Week 1']; expect(importCycleMenu(options)[0].items).toHaveLength(1);
  options.week='Week 2'; expect(() => importCycleMenu(options)).toThrow('Save the selected');
});

test('rejects missing references, incompatible slots and duplicate daily dishes', () => {
  const missing=input();missing.boards['Main menu:Week 1'][1][1]=[{mealId:'missing'}];expect(()=>importCycleMenu(missing)).toThrow('missing from');
  const wrong=input();wrong.boards['Main menu:Week 1'][1][1]=[{mealId:'Snack'}];expect(()=>importCycleMenu(wrong)).toThrow('incompatible');
  const duplicate=input();duplicate.boards['Main menu:Week 1'][0][2]=[{mealId:'Main'}];expect(()=>importCycleMenu(duplicate)).toThrow('more than once');
  const sameName=input();sameName.catalogue.meals[1].name='Main';expect(()=>importCycleMenu(sameName)).toThrow('more than once');
});

test('storage reader performs no writes and reports malformed saved JSON', () => {
  const options=input(), values={ [CYCLE_CATALOGUE_KEY]:JSON.stringify(options.catalogue), [CYCLE_BOARD_KEY]:JSON.stringify(options.boards) };
  const storage={getItem: jest.fn(key=>values[key]),setItem:jest.fn()};
  expect(importSavedCycleMenu({ ...options, storage })).toHaveLength(7); expect(storage.setItem).not.toHaveBeenCalled();
  storage.getItem.mockReturnValue('{bad');expect(()=>importSavedCycleMenu({ ...options,storage })).toThrow('could not be read');
});

test('a deduplicated recipe seeds every original workbook occurrence once',()=>{
  const options=input();options.catalogue.meals=[{...options.catalogue.meals[0],day:'DAY 1',cycleDays:['DAY 1','DAY 6 & 7']}];options.boards={};
  const days=importCycleMenu(options);expect(days.map(day=>day.items.length)).toEqual([1,0,0,0,0,1,1]);expect(days[6].items[0].cycleMeal.id).toBe('Main');
});

test('NOV3, NOV4 and DEC1 import independently without consuming shared recipes or cycles',()=>{
  const options=input(), first=board(), second=board(), third=board();
  first[0][1]=[{mealId:'Main',isMatterCore:true}];second[3][2]=[{mealId:'Main',isMatterCore:false}];third[4][1]=[{mealId:'Main',isMatterCore:true}];
  options.cycles=[
    {id:'NOV3',name:'NOV3',source:'November_Cycle_3.xlsx',meals:[{mealId:'Main',sourceMealId:'NOV3-004',day:'DAY 1'}],boards:{'Main menu:Week 1':first}},
    {id:'NOV4',name:'NOV4',source:'November_Cycle_4.xlsx',meals:[{mealId:'Main',sourceMealId:'NOV4-020',day:'DAY 4'}],boards:{'Main menu:Week 1':second}},
    {id:'DEC1',name:'DEC1',source:'December_Cycle_1.xlsx',meals:[{mealId:'Main',sourceMealId:'DEC1-001',day:'DAY 5'}],boards:{'Main menu:Week 1':third}},
  ];
  const before=JSON.stringify(options);
  for(const [index,cycleId]of ['NOV3','NOV4','DEC1'].entries()){
    const days=importCycleMenu({...options,cycleId});const expected=[0,3,4][index];
    expect(days.map(day=>day.items.length)).toEqual(Array.from({length:7},(_,day)=>day===expected?1:0));
    const item=days[expected].items[0];expect(item.cycleMeal.cycleSource).toMatchObject({cycleId,sourceMealId:options.cycles[index].meals[0].sourceMealId,workbook:options.cycles[index].source});
    item.cycleMeal.components[0].exclusions.push('Dairy');
  }
  expect(JSON.stringify(options)).toBe(before);
  expect(()=>importCycleMenu(options)).toThrow('Choose a saved cycle');
  expect(()=>importCycleMenu({...options,cycleId:'MISSING'})).toThrow('could not be found');
  options.cycles[1].boards['Main menu:Week 1']=board();
  expect(()=>importCycleMenu({...options,cycleId:'NOV4'})).toThrow('empty');
});
