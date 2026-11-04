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
