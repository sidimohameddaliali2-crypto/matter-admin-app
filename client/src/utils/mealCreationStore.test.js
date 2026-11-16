import { createMealCreationStore, readLegacyMealDraft } from './mealCreationStore';
jest.mock('./api',()=>({post:jest.fn(),put:jest.fn()}));
const initial = () => ({ catalogue: { meals: [], source: '' }, boards: {}, revision: 0 });
const response = data => ({ data: { success: true, data } });

test('v1 custom meals and both weeks migrate, excluding obsolete April seed meals and their placements only',async()=>{
  const sample={id:'APR1-001',name:'Bundled sample',components:[]};
  const custom={id:'PREVIEW-own',name:'Custom meal',components:[{id:'own-p',type:'Protein',name:'Roast',exclusions:['DAIRY'],notes:'Keep this note'}]};
  const week=()=>Array.from({length:7},()=>Array.from({length:4},()=>[]));
  const main=week(),core=week(),second=week();main[0][1]=[{mealId:sample.id},{mealId:custom.id}];core[0][1]=[{mealId:sample.id},{mealId:custom.id}];second[4][2]=[{mealId:custom.id,isMatterCore:true}];
  const catalogue=JSON.stringify({meals:[sample,custom],source:'April_Cycle_1_Meals_and_Exclusions.xlsx'}),boards=JSON.stringify({'Main menu:Week 1':main,'Matter Core menu:Week 1':core,'Main menu:Week 2':second});
  sessionStorage.clear();sessionStorage.setItem('matter-admin-v2:workbook-cycle-v1',catalogue);sessionStorage.setItem('matter-admin-v2:weekly-board-v1',boards);
  try{
    const client={post:jest.fn(async()=>response(initial()))};await createMealCreationStore(client,readLegacyMealDraft).load();
    const legacy=client.post.mock.calls[0][1].legacy;
    expect(legacy.catalogue).toEqual({meals:[custom],source:''});
    expect(legacy.boards['Main menu:Week 1'][0][1]).toEqual([{mealId:custom.id,isMatterCore:true}]);expect(legacy.boards['Main menu:Week 2'][4][2]).toEqual([{mealId:custom.id,isMatterCore:true}]);
    expect(sessionStorage.getItem('matter-admin-v2:workbook-cycle-v1')).toBe(catalogue);expect(sessionStorage.getItem('matter-admin-v2:weekly-board-v1')).toBe(boards);
  }finally{sessionStorage.clear();}
});

test.each([null,'{bad'])('missing or unreadable v2 data falls back to real v1 imports without sample filtering (%s)',v2=>{
  const catalogue={meals:[{id:'APR1-own',name:'A real imported meal',components:[]}],source:'Own.xlsx'};
  sessionStorage.clear();sessionStorage.setItem('matter-admin-v2:workbook-cycle-v1',JSON.stringify(catalogue));if(v2!==null)sessionStorage.setItem('matter-admin-v2:workbook-cycle-v2',v2);
  try{expect(readLegacyMealDraft().catalogue).toEqual(catalogue);}finally{sessionStorage.clear();}
});

test.each([[[]],[[{id:'APR1-user-import',name:'Actual v2 April import',components:[]}]]])('valid v2 stays authoritative over v1, including an intentionally empty v2 (%s)',meals=>{
  const v2={meals,source:'April_Cycle_1_Meals_and_Exclusions.xlsx'};
  sessionStorage.clear();sessionStorage.setItem('matter-admin-v2:workbook-cycle-v1',JSON.stringify({meals:[{id:'old-v1'}],source:'Old.xlsx'}));sessionStorage.setItem('matter-admin-v2:workbook-cycle-v2',JSON.stringify(v2));
  try{if(meals.length)expect(readLegacyMealDraft().catalogue).toEqual(v2);else expect(readLegacyMealDraft()).toBeUndefined();}finally{sessionStorage.clear();}
});

test('serializes pending saves across navigation and uses accepted revisions', async () => {
  let release;
  const state=initial();
  const client={post:jest.fn(async()=>response(state)),put:jest.fn().mockImplementationOnce((url,body)=>new Promise(resolve=>{release=()=>resolve(response({...state,boards:body.boards,revision:1}));})).mockImplementationOnce(async(url,body)=>response({...state,boards:body.boards,revision:2}))};
  const store=createMealCreationStore(client);await store.load();
  const first=store.save({boards:{one:1}}),second=store.save({boards:{two:2}});
  await Promise.resolve();expect(client.put).toHaveBeenCalledTimes(1);release();await Promise.all([first,second]);
  expect(client.put.mock.calls.map(call=>call[1].revision)).toEqual([0,1]);expect(store.getSnapshot().data.revision).toBe(2);
});

test('failed loads never create an empty writable catalogue; failed saves retain accepted data and block queued overwrites',async()=>{
  const client={post:jest.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(response(initial())),put:jest.fn().mockRejectedValue({response:{status:409,data:{message:'Changed elsewhere'}}})};
  const store=createMealCreationStore(client);
  await expect(store.load()).rejects.toThrow('Offline');expect(store.getSnapshot()).toMatchObject({status:'error',data:null});expect(client.put).not.toHaveBeenCalled();
  await store.load();await expect(store.save({boards:{one:1}})).rejects.toBeDefined();
  expect(store.getSnapshot().data).toEqual(initial());await expect(store.save({boards:{two:2}})).rejects.toThrow('Changed elsewhere');expect(client.put).toHaveBeenCalledTimes(1);
});

test('bootstrap migrates surviving tab data without modifying or clearing the original',async()=>{
  const meal={id:'one',name:'Own meal',components:[]};const board=Array.from({length:7},()=>Array.from({length:4},()=>[]));board[0][1]=[{mealId:'one',isNew:true}];
  const original=JSON.stringify({meals:[meal],source:'Own.xlsx'});sessionStorage.setItem('matter-admin-v2:workbook-cycle-v2',original);sessionStorage.setItem('matter-admin-v2:weekly-board-v1',JSON.stringify({'Main menu:Week 1':board}));
  try {
    const client={post:jest.fn(async()=>response(initial()))};await createMealCreationStore(client,readLegacyMealDraft).load();
    expect(client.post.mock.calls[0][1].legacy.catalogue.meals).toEqual([meal]);expect(client.post.mock.calls[0][1].legacy.boards['Main menu:Week 1'][0][1]).toEqual([{mealId:'one',isMatterCore:false}]);
    expect(sessionStorage.getItem('matter-admin-v2:workbook-cycle-v2')).toBe(original);
  }finally{sessionStorage.clear();}
});
