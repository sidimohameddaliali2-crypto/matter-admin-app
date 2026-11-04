import test from 'node:test';
import assert from 'node:assert/strict';
import { menuSelectionNames } from './menuSelectionNames.js';
test('names come only from uniquely matched Matter summaries, following the permanent ID across renewals',()=>{
  const rows=[{_id:'a',matterCustomerId:'1',matterSubscriptionId:'old',firstName:'Wrong internal name'},
    {_id:'b',matterCustomerId:'2',email:'shared@example.invalid',firstName:'Legacy'},
    {_id:'c',email:'email@example.invalid'}];
  const names=menuSelectionNames(rows,[{customer_id:1,subscription_id:'old',subscription_status:'ended',name:'Old Name'},
    {customer_id:1,subscription_id:'new',subscription_status:'active',name:'Current Matter Name'},
    {customer_id:3,subscription_id:'other',email:'shared@example.invalid',name:'Other Person'},
    {customer_id:4,subscription_id:'email',email:'email@example.invalid',name:'Email Match'}]);
  assert.deepEqual(names.get('a'),{firstName:'Current',lastName:'Matter Name'});
  assert.deepEqual(names.get('b'),{firstName:'',lastName:''});
  assert.deepEqual(names.get('c'),{firstName:'Email',lastName:'Match'});
});

test('legacy missing/stale email falls back to exact subscription ID, with no cross-customer ID override',()=>{
  const subscriptions=[{customer_id:'current',subscription_id:'valid-sub',email:'new@example.invalid',subscription_status:'active',name:'Verified Matter Name'}];
  const rows=[{_id:'stale',email:'old@example.invalid',matterSubscriptionId:'valid-sub'},
    {_id:'missing',matterSubscriptionId:'valid-sub'},
    {_id:'wrong-id',matterCustomerId:'another-person',matterSubscriptionId:'valid-sub',email:'new@example.invalid'},
    {_id:'unmatched',email:'old@example.invalid',matterSubscriptionId:'unknown'}];
  const before=JSON.stringify(rows),names=menuSelectionNames(rows,subscriptions);
  assert.deepEqual(names.get('stale'),{firstName:'Verified',lastName:'Matter Name'});
  assert.deepEqual(names.get('missing'),names.get('stale'));
  assert.deepEqual(names.get('wrong-id'),{firstName:'',lastName:''});
  assert.deepEqual(names.get('unmatched'),{firstName:'',lastName:''});
  assert.equal(JSON.stringify(rows),before);
});

test('a fallback subscription must be unique and does not replace an existing email match',()=>{
  const subs=[{customer_id:'one',subscription_id:'same',name:'First Person'},
    {customer_id:'two',subscription_id:'same',name:'Second Person'},
    {customer_id:'three',subscription_id:'email-sub',email:'match@example.invalid',name:'Email Person'}];
  const names=menuSelectionNames([{_id:'duplicate',matterSubscriptionId:'same'},
    {_id:'email',email:'match@example.invalid',matterSubscriptionId:'same'}],subs);
  assert.deepEqual(names.get('duplicate'),{firstName:'',lastName:''});
  assert.deepEqual(names.get('email'),{firstName:'Email',lastName:'Person'});
});
