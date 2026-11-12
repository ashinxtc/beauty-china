const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('the custom domain preserves the existing Worker and its sole isolated KV namespace',()=>{
  const config=JSON.parse(fs.readFileSync(path.join(__dirname,'..','wrangler.json'),'utf8'));
  assert.equal(config.name,'beauty-china-sync');
  assert.equal(config.main,'worker/sync.mjs');
  assert.equal(config.workers_dev,true,'Existing clients must retain their original route');
  assert.deepEqual(config.kv_namespaces,[{
    binding:'BEAUTY_SYNC',id:'8e884dbdcbee4f9988369dcb3db843e6',
  }]);
  assert.deepEqual(config.routes,[{pattern:'beauty-sync.daka-tool.top',custom_domain:true}]);
  assert.equal(config.services,undefined,'The isolated Worker must not gain a daka service binding');
});
async function fixture(){
  const worker=(await import('../worker/sync.mjs')).default;
  const values=new Map(), writes=[];
  const env={BEAUTY_SYNC:{get:async k=>values.get(k)||null,put:async(k,v)=>{writes.push(k);values.set(k,v)}}};
  return {values,writes,call:(path='/?code=bc_test',data)=>worker.fetch(new Request('https://isolated.test'+path,data===undefined?{}:{method:'POST',body:JSON.stringify(data)}),env)};
}
const payload={_app:'beautifulChina',_syncTs:123,profiles:[{id:'one',name:'孩子'}],childrenData:{one:{answers:{q:'A'}}}};
test('isolated storage supports upload, download, timestamps and backup',async()=>{
  const f=await fixture();assert.equal((await f.call()).status,404);
  assert.equal((await f.call(undefined,payload)).status,200);
  assert.deepEqual(await (await f.call()).json(),payload);
  assert.deepEqual(await(await f.call('/ts?code=bc_test')).json(),{ts:123});
  await f.call(undefined,{...payload,_syncTs:124});
  assert.deepEqual(await(await f.call('/bak?code=bc_test')).json(),payload);
});
test('daka codes, daka payloads and unexpected routes never write',async()=>{
  const f=await fixture();
  assert.equal((await f.call('/?code=daka_test',payload)).status,400);
  assert.equal((await f.call(undefined,{app_profiles_v1:'[]'})).status,400);
  assert.equal((await f.call('/other?code=bc_test',payload)).status,404);
  assert.equal(f.writes.length,0);
});
test('wrong-app stored data cannot be exposed or overwritten',async()=>{
  const f=await fixture();f.values.set('sync:bc_test',JSON.stringify({app_profiles_v1:'[]'}));
  assert.equal((await f.call()).status,409);
  assert.equal((await f.call(undefined,payload)).status,409);
  assert.equal(f.writes.length,0);
});
