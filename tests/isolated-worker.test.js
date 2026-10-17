const {test}=require('node:test');
const assert=require('node:assert/strict');
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
