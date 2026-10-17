// This Worker has exactly one binding: BEAUTY_SYNC, a dedicated namespace.
// No legacy fallback, service binding, or request to the daka service is allowed.
const headers = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type','Content-Type':'application/json','Cache-Control':'no-store'};
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers});
const isBeauty = value => value && value._app === 'beautifulChina' && value.childrenData &&
  typeof value.childrenData === 'object' && !Array.isArray(value.childrenData);
export default {
  async fetch(request,env) {
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    const url=new URL(request.url),code=url.searchParams.get('code');
    if(!code || !/^bc_[\w一-鿿-]+$/.test(code) || code.length>32)return json({error:'无效的答题同步码'},400);
    if(!['/','/ts','/bak'].includes(url.pathname))return json({error:'Not found'},404);
    const key=`sync:${code}`;
    try {
      if(request.method==='GET') {
        const raw=await env.BEAUTY_SYNC.get(key+(url.pathname==='/bak'?':bak':''));
        if(!raw)return url.pathname==='/ts'?json({ts:0}):json({error:'未找到数据'},404);
        const data=JSON.parse(raw);
        if(!isBeauty(data))return json({error:'应用数据不匹配，已拒绝读取'},409);
        return url.pathname==='/ts'?json({ts:data._syncTs||0}):new Response(raw,{headers});
      }
      if(request.method!=='POST'||url.pathname!=='/')return json({error:'Method not allowed'},405);
      if(Number(request.headers.get('content-length'))>8*1024*1024)return json({error:'数据过大'},413);
      const raw=await request.text();
      if(new TextEncoder().encode(raw).length>8*1024*1024)return json({error:'数据过大'},413);
      let data;try{data=JSON.parse(raw)}catch{return json({error:'无效 JSON'},400)}
      if(!isBeauty(data)||!Array.isArray(data.profiles)||!data.profiles.length||
        !Number.isFinite(data._syncTs)||data._syncTs<0)return json({error:'无效的答题快照'},400);
      const previous=await env.BEAUTY_SYNC.get(key);
      if(previous){
        if(!isBeauty(JSON.parse(previous)))return json({error:'应用数据不匹配，已拒绝覆盖'},409);
        await env.BEAUTY_SYNC.put(key+':bak',previous,{expirationTtl:90*86400});
      }
      await env.BEAUTY_SYNC.put(key,raw,{expirationTtl:90*86400,metadata:{ts:data._syncTs}});
      return json({ok:true,ts:data._syncTs});
    } catch {return json({error:'同步服务暂时不可用，请重试'},503)}
  }
};
