import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortMenuToken, ensureShortMenuToken, menuShareFilter, invalidateMenuShareCache } from './menuShareLinks.js';
import Menu from '../models/WeeklyMenu.js';
import router from '../routes/menus.js';

const handler = path => router.stack.find(layer => layer.route?.path === path).route.stack.slice(-1)[0].handle;
const response = () => ({ statusCode:200, status(code){this.statusCode=code;return this;}, json(body){this.body=body;return this;} });

test('short links use 96 random bits in a URL-safe 16 character code', () => {
  const codes = Array.from({length:100}, createShortMenuToken);
  assert.equal(new Set(codes).size, 100);
  assert.ok(codes.every(code => /^[A-Za-z0-9_-]{16}$/.test(code)));
});
test('existing aliases are stable and old token links remain resolvable', async () => {
  const menu={_id:'menu',shareLink:{token:'original-token',shortToken:'existing-alias'}};
  assert.equal(await ensureShortMenuToken(menu, {Model:{}}), 'existing-alias');
  assert.deepEqual(menuShareFilter('old'), {$or:[{'shareLink.token':'old'},{'shareLink.shortToken':'old'}]});
});
test('allocation sets only the alias without touching the old token or menu edit timestamp', async () => {
  const calls=[];const Model={findOneAndUpdate:async (...args)=>{calls.push(args);return {shareLink:{shortToken:'new'}};}};
  assert.equal(await ensureShortMenuToken({_id:'menu',shareLink:{token:'old'}},{Model,makeToken:()=> 'new'}),'new');
  assert.deepEqual(calls[0][1],{$set:{'shareLink.shortToken':'new'}});
  assert.deepEqual(calls[0][2],{new:true,timestamps:false});
  assert.equal(calls[0][0]._id,'menu');
});
test('concurrent requests return the winning persisted alias', async () => {
  const Model={findOneAndUpdate:async ()=>null,findById:async ()=>({shareLink:{shortToken:'winner'}})};
  assert.equal(await ensureShortMenuToken({_id:'menu'}, {Model}), 'winner');
});
test('a unique-index collision retries with another random alias', async () => {
  let calls=0;const Model={findOneAndUpdate:async ()=>{if(++calls===1)throw Object.assign(Error('duplicate'),{code:11000});return {shareLink:{shortToken:'second'}};}};
  assert.equal(await ensureShortMenuToken({_id:'menu'},{Model}), 'second');assert.equal(calls,2);
});
test('storage failures do not silently return a broken short URL', async () => {
  const Model={findOneAndUpdate:async ()=>{throw Error('unavailable');}};
  await assert.rejects(ensureShortMenuToken({_id:'menu'},{Model}), /unavailable/);
});

test('cache invalidation removes short-only legacy entries as well as both aliases', async () => {
  for (const shareLink of [{shortToken:'short'}, {token:'long',shortToken:'short'}]) {
    const cached=new Map([['menu:share:short',{isActive:true}],['menu:share:long',{isActive:true}]]);
    await invalidateMenuShareCache({shareLink},async key=>cached.delete(key));
    assert.equal(cached.has('menu:share:short'),false);
    if(shareLink.token)assert.equal(cached.has('menu:share:long'),false);
  }
});

test('the public route loads the same menu through old and short links and rejects disabled short links', async t => {
  const menu={_id:'fixture',viewCount:0,shareLink:{token:'old-token',shortToken:'short-code',isActive:true},save:async()=>{},toObject(){return {_id:this._id,shareLink:this.shareLink};}};
  const filters=[];
  t.mock.method(Menu,'findOne',filter=>({populate:async()=>{filters.push(filter);return menu;}}));
  for(const token of ['old-token','short-code']){
    const res=response();await handler('/share/:token')({params:{token}},res);
    assert.equal(res.statusCode,200);assert.equal(res.body.data._id,'fixture');
    assert.deepEqual(filters.at(-1),menuShareFilter(token));
  }
  menu.shareLink.isActive=false;
  const res=response();await handler('/share/:token')({params:{token:'short-code'}},res);
  assert.equal(res.statusCode,410);assert.equal(menu.viewCount,2);
});

test('Copy link issues a short URL while preserving the original token', async t => {
  const menu={_id:'fixture',shareLink:{token:'old-token'}};
  t.mock.method(Menu,'findById',async()=>menu);
  t.mock.method(Menu,'findOneAndUpdate',async(filter,update)=>({shareLink:{...menu.shareLink,shortToken:update.$set['shareLink.shortToken']}}));
  const res=response();await handler('/:id/share-link')({params:{id:'fixture'},get:()=> 'https://example.invalid',protocol:'https'},res);
  assert.equal(res.statusCode,200);
  assert.match(res.body.data.shareUrl,/\/m\/[A-Za-z0-9_-]{16}$/);
  assert.equal(res.body.data.shareLink,'old-token');
});
