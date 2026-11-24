import test from 'node:test';
import assert from 'node:assert/strict';
import router from './mealCreation.js';
import State from '../models/MealCreationState.js';
import Menu from '../models/WeeklyMenu.js';

const route = (method,path) => router.stack.find(layer=>layer.route?.path===path && layer.route.methods[method]).route.stack.at(-1).handle;
const res = () => ({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
const meal = id => ({id,name:id,components:[{id:id+'-p',type:'Protein',name:'Chicken',exclusions:['Nuts'],notes:'Keep note'}]});
const board = () => Array.from({length:7},()=>Array.from({length:4},()=>[]));

async function fixtures(run) {
  const original={find:State.findById,create:State.create,update:State.findOneAndUpdate,menus:Menu.find};
  const saved={state:null,writes:0,menus:[{meals:[{mealType:'main',items:[{cycleMeal:{...meal('recovered'),cycleSource:{week:'Week 1',day:1}}}]}]}]};
  State.findById=()=>({lean:async()=>saved.state&&structuredClone(saved.state)});
  State.create=async values=>{const doc=new State(values);assert.equal(doc.validateSync(),undefined);saved.state=doc.toObject();saved.writes++;return doc;};
  State.findOneAndUpdate=(filter,update)=>({lean:async()=>{
    if(saved.concurrent || saved.state.revision!==filter.revision)return null;
    saved.state={...saved.state,...structuredClone(update.$set),revision:saved.state.revision+1};saved.writes++;return structuredClone(saved.state);
  }});
  Menu.find=()=>({sort(){return this;},select(){return this;},populate(){return this;},lean:async()=>saved.menus});
  try{await run(saved);}finally{State.findById=original.find;State.create=original.create;State.findOneAndUpdate=original.update;Menu.find=original.menus;}
}

test('bootstrap recovers saved snapshots without modifying menus; repeat loads cannot empty state',()=>fixtures(async saved=>{
  const events = [];
  const app = { get: () => ({ emit: event => events.push([event, saved.writes]) }) };
  const before=JSON.stringify(saved.menus), first=res();await route('post','/bootstrap')({app,body:{}},first);
  assert.equal(first.statusCode,200);assert.equal(first.body.data.catalogue.meals[0].id,'recovered');assert.equal(saved.writes,1);
  const again=res();await route('post','/bootstrap')({app,body:{}},again);assert.equal(saved.writes,1);assert.deepEqual(again.body.data,first.body.data);assert.equal(JSON.stringify(saved.menus),before);
  assert.deepEqual(events, [['kitchen:mealLibraryChanged', 1]]);
}));

test('first-run migration survives dangling browser boards while retaining browser meals and recovered placements',()=>fixtures(async saved=>{
  const bad=board();bad[0][0]=[{mealId:'gone',isMatterCore:false}];
  const response=res();await route('post','/bootstrap')({body:{legacy:{catalogue:{meals:[meal('browser')]},boards:{'Main menu:Week 1':bad}}}},response);
  assert.equal(response.statusCode,200);assert.equal(response.body.data.catalogue.meals.length,2);assert.equal(response.body.data.boards['Main menu:Week 1'][0][1][0].mealId,'recovered');
}));

test('updates require current revision and CAS; failed/stale updates never change data',()=>fixtures(async saved=>{
  await route('post','/bootstrap')({body:{}},res());
  const events = [];
  const app = { get: () => ({ emit: event => events.push([event, saved.state.revision]) }) };
  const ok=res();await route('put','/')({app,body:{revision:0,catalogue:{meals:[meal('new')]}}},ok);assert.equal(ok.statusCode,200);assert.equal(ok.body.data.revision,1);
  const state=structuredClone(saved.state);
  const stale=res();await route('put','/')({app,body:{revision:0,catalogue:{meals:[]}}},stale);assert.equal(stale.statusCode,409);assert.deepEqual(saved.state,state);
  saved.concurrent=true;const race=res();await route('put','/')({app,body:{revision:1,catalogue:{meals:[meal('lost')]}}},race);assert.equal(race.statusCode,409);assert.deepEqual(saved.state,state);
  assert.deepEqual(events, [['kitchen:mealLibraryChanged', 1]]);
}));

test('routes are staff-authenticated and require effective menus permission',()=>{
  assert.ok(router.stack[0].handle.name==='protect');
  const guard=router.stack[1].handle;
  let passed=false;guard({user:{role:'super_admin'}},res(),()=>{passed=true;});assert.equal(passed,true);
  const denied=res();guard({user:{role:'viewer',permissions:{menus:false}}},denied,()=>assert.fail('must deny'));assert.equal(denied.statusCode,403);
});

test('bootstrap removes existing duplicate records once, remaps Core placements and retains aliases',()=>fixtures(async saved=>{
  saved.menus=[];
  const canonical=meal('first'),duplicate={...meal('second'),name:'FIRST'};
  const week=board();week[4][2]=[{mealId:'second',isMatterCore:true}];
  saved.state={_id:'shared',catalogue:{meals:[canonical,duplicate],source:'Own.xlsx'},boards:{'Main menu:Week 2':week},revision:3,aliases:[]};
  const response=res();await route('post','/bootstrap')({body:{}},response);
  assert.equal(response.statusCode,200);assert.equal(response.body.data.catalogue.meals.length,1);assert.deepEqual(response.body.data.boards['Main menu:Week 2'][4][2],[{mealId:'first',isMatterCore:true}]);assert.deepEqual(response.body.data.aliases,[{from:'second',to:'first'}]);assert.equal(response.body.data.revision,4);
  const again=res();await route('post','/bootstrap')({body:{}},again);assert.equal(saved.writes,1);assert.deepEqual(again.body.data,response.body.data);
}));

test('bootstrap repairs an existing empty shared document from saved cycles without changing dated menus',()=>fixtures(async saved=>{
  saved.state={_id:'shared',catalogue:{meals:[],source:''},boards:{},cycles:[],aliases:[],revision:7};
  saved.menus=['NOV4','NOV3'].map((id,index)=>({meals:[{mealType:'main',items:[{cycleMeal:{...meal(id+'-004'),day:'DAY '+(index+1),cycleSource:{workbook:id+'.xlsx',week:'Week 1',day:index+1}},rotationCategory:'sub',usedForCorePlan:true}]}]}));
  const before=JSON.stringify(saved.menus), response=res();await route('post','/bootstrap')({body:{}},response);
  assert.equal(response.statusCode,200);assert.equal(response.body.data.catalogue.meals.length,2);assert.equal(response.body.data.cycles.length,2);
  assert.equal(response.body.data.cycles.find(cycle=>cycle.id==='NOV3').boards['Main menu:Week 1'][1][2][0].isMatterCore,true);
  const writes=saved.writes,again=res();await route('post','/bootstrap')({body:{}},again);assert.equal(saved.writes,writes);assert.deepEqual(again.body.data,response.body.data);assert.equal(JSON.stringify(saved.menus),before);
}));

test('one-time legacy migration repairs missing saved cycles while preserving edited recipes and empty saved weeks',()=>fixtures(async saved=>{
  const existing={...meal('NOV3-004'),name:'Edited recipe',day:'DAY 1'};
  saved.state={_id:'shared',catalogue:{meals:[existing],source:'NOV3.xlsx'},boards:{'Main menu:Week 1':board()},revision:2,aliases:[]};
  saved.menus=['NOV4','NOV3'].map(id=>({meals:[{mealType:'main',items:[{cycleMeal:{...meal(id+'-004'),day:'DAY 1',cycleSource:{workbook:id+'.xlsx',week:'Week 1',day:1}},rotationCategory:'sub',usedForCorePlan:true}]}]}));
  const before=JSON.stringify(saved.menus), response=res();await route('post','/bootstrap')({body:{}},response);
  assert.equal(response.statusCode,200);assert.equal(response.body.data.catalogue.meals.find(value=>value.id==='NOV3-004').name,'Edited recipe');
  assert.deepEqual(response.body.data.cycles.find(value=>value.id==='NOV3').boards['Main menu:Week 1'],board());
  assert.equal(response.body.data.cycles.find(value=>value.id==='NOV4').boards['Main menu:Week 1'][0][2][0].isMatterCore,true);
  assert.equal(JSON.stringify(saved.menus),before);
  const writes=saved.writes;await route('post','/bootstrap')({body:{}},res());assert.equal(saved.writes,writes);
}));

test('selected cycle board updates persist independently with the revision guard',()=>fixtures(async saved=>{
  saved.menus=[];await route('post','/bootstrap')({body:{}},res());
  let response=res();await route('put','/')({body:{revision:0,catalogue:{meals:[{...meal('NOV3-004'),day:'DAY 1'},{...meal('NOV4-004'),day:'DAY 2'}],source:'November.xlsx'},skipDuplicates:true}},response);
  assert.equal(response.statusCode,200);const other=structuredClone(response.body.data.cycles.find(value=>value.id==='NOV4'));
  const changed=board();changed[5][2]=[{mealId:'NOV3-004',isMatterCore:true}];response=res();await route('put','/')({body:{revision:1,cycleId:'NOV3',boards:{'Main menu:Week 1':changed}}},response);
  assert.equal(response.statusCode,200);assert.deepEqual(response.body.data.cycles.find(value=>value.id==='NOV4'),other);assert.deepEqual(response.body.data.boards,{});
  const reload=res();await route('get','/')({},reload);assert.deepEqual(reload.body.data.cycles,response.body.data.cycles);
}));

test('repeat upload skips a duplicate recipe and later board saves accept its old import ID',()=>fixtures(async saved=>{
  await route('post','/bootstrap')({body:{}},res());
  const duplicate={...meal('upload'),name:'RECOVERED'};
  const response=res();await route('put','/')({body:{revision:0,catalogue:{meals:[duplicate]},skipDuplicates:true}},response);
  assert.equal(response.statusCode,200);assert.equal(response.body.data.catalogue.meals.length,1);assert.equal(response.body.data.aliases[0].from,'upload');
  const week=board();week[3][1]=[{mealId:'upload',isMatterCore:true}];
  const next=res();await route('put','/')({body:{revision:1,boards:{'Main menu:Week 2':week}}},next);assert.equal(next.statusCode,200);assert.equal(next.body.data.boards['Main menu:Week 2'][3][1][0].mealId,'recovered');
}));
