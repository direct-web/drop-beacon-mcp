import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, publicProduct, TOOLS, API_ORIGIN } from '../dist/catalog.js';
const fakeProduct = { id: 12, title: 'Example', price: '21.00', currency:'USD', isAvailable:true, slug:'example', brand:{name:'Maker', email:'private'}, rawData:{credential:'do-not-export'}, userEmail:'private', images:[{src:'https://example.com/product.jpg'}], firstSeenAt:new Date().toISOString() };
const json = body => new Response(JSON.stringify(body), { headers:{'content-type':'application/json'} });
test('only fixed public GET destinations and no secrets or cookies', async () => {
  process.env.DATABASE_URL='unused-canary'; process.env.API_KEY='unused-key';
  let requested;
  const c = new Catalog(async (url, options) => { requested={url,options}; return json({drops:[fakeProduct]}); });
  const r = await c.call('search_products',{query:'test&admin=true',limit:2});
  assert.equal(requested.url.origin,API_ORIGIN); assert.equal(requested.url.pathname,'/api/drops');
  assert.equal(requested.url.searchParams.get('q'),'test&admin=true'); assert.equal(requested.options.method,'GET'); assert.equal(requested.options.redirect,'error'); assert.equal(requested.options.credentials,'omit');
  assert(!JSON.stringify(requested.options).includes('unused')); assert.equal(r.products.length,1); assert(!JSON.stringify(r).includes('private')); assert(!JSON.stringify(r).includes('do-not-export'));
});
test('rejects unbounded, unknown, SQL, URL, and credential arguments before fetching', async () => {
  const c = new Catalog(async()=>{throw new Error('must not fetch');});
  for (const args of [{limit:26},{limit:1.5},{query:'x'.repeat(121)},{url:'http://localhost'},{api_key:'private'},{sql:'SELECT * FROM users'}]) await assert.rejects(c.call('search_products',args),/Invalid arguments/);
  await assert.rejects(c.call('get_market_trends',{}),/retired/); assert.equal(TOOLS.length,4);
});
test('does not report results from an unresolved brand as belonging to that brand', async () => {
  let calls=0;
  const c=new Catalog(async()=>{calls++;return json({brands:[{name:'Unrelated',slug:'unrelated'}]});});
  const r=await c.call('search_products',{brand:'missing'});assert.equal(calls,1);assert.deepEqual(r.products,[]);
});
test('upstream errors and oversized bodies never echo upstream content',async()=>{
  const c = new Catalog(async()=>new Response('secret upstream diagnostic',{status:500}));
  await assert.rejects(c.call('search_products',{}),e=>!e.message.includes('secret'));
  const big = new Catalog(async()=>new Response('a'.repeat(2_000_001),{headers:{'content-type':'application/json'}}));
  await assert.rejects(big.call('search_products',{}),/size limit/);
});
test('price missing is unknown, URLs reject credentials, old dates excluded',async()=>{
  assert.equal(publicProduct({price:null}).price,null); assert.equal(publicProduct({images:[{src:'javascript:alert(1)'}]}).imageUrl,null);
  const c=new Catalog(async()=>json({drops:[fakeProduct,{...fakeProduct,firstSeenAt:'2000-01-01'}]}));
  const r=await c.call('get_latest_drops',{}); assert.equal(r.products.length,1);
});
