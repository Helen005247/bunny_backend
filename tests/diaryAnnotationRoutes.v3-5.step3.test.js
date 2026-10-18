'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SHARED='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LOCKED='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PERSONAL='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const HUMAN_NOTE='ffffffff-ffff-4fff-8fff-ffffffffffff'

function setup() {
  const routes={}
  const middleware=[]
  const Router=()=>({
    use(fn){middleware.push(fn)},
    get(path,fn){routes['GET '+path]=fn},
    post(path,fn){routes['POST '+path]=fn},
  })
  const source=fs.readFileSync(path.resolve(__dirname,'../routes/diaryAnnotations.js'),'utf8')
  const loaded={exports:{}}
  new Function('module','exports','require',source)(loaded,loaded.exports,(name)=>{
    if (name==='express')return {Router};throw Error('unexpected dependency')
  })
  const notes=[{id:HUMAN_NOTE,user_id:USER,star_diary_id:SHARED,user_diary_id:null,author:'human',body:'今天的批注',created_at:'2026-10-18T08:00:00Z'},
    {id:'11111111-1111-4111-8111-111111111111',user_id:USER,star_diary_id:null,user_diary_id:PERSONAL,author:'star',body:'我读到了你的心情',created_at:'2026-10-18T09:00:00Z'}]
  const tables={
    agent_diary:[{id:SHARED,user_id:USER,agent_id:'star',visibility:'shared'},{id:LOCKED,user_id:USER,agent_id:'star',visibility:'locked'}],
    user_diary:[{id:PERSONAL,user_id:USER,diary_date:'2026-10-18',visibility:'locked'}],
    diary_annotations_v35:notes,
  }
  let rpcCalls=0
  const supabase={
    from(table){
      const filters=[]
      const query={
        select(){return query},eq(k,v){filters.push([k,v]);return query},
        order(){return query},
        maybeSingle(){const data=(tables[table]||[]).find(r=>filters.every(([k,v])=>r[k]===v));return Promise.resolve({data:data||null})},
        range(start,end){return Promise.resolve({data:(tables[table]||[]).filter(r=>filters.every(([k,v])=>r[k]===v)).slice(start,end+1)})},
      }
      return query
    },
    async rpc(name,input){rpcCalls++;
      if(name!=='diary_add_human_annotation_v35') throw Error('wrong rpc')
      const valid=tables.agent_diary.find(row=>row.id===input.p_star_diary_id && row.user_id===input.p_user_id && row.visibility==='shared')
      if(!valid)return {data:{ok:false,code:'not_found'}}
      const note={id:'22222222-2222-4222-8222-222222222222',author:'human',body:input.p_body,created_at:'2026-10-18T10:00:00Z'}
      return {data:{ok:true,note}}
    },
  }
  loaded.exports.createDiaryAnnotationsRouter({supabase})
  async function call(method,route, {userId=USER,params={},query={},body}={}) {
    const req={userId,params,query,body}
    const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this},set(k,v){this.headers[k]=v;return this},json(data){this.data=data;return this}}
    for(const fn of middleware) {
      let proceeded=false
      await fn(req,res,()=>{proceeded=true})
      if(!proceeded)return res
    }
    const handler=routes[method+' '+route]
    if(!handler)throw Error('Missing route '+method+' '+route)
    await handler(req,res)
    return res
  }
  return {call, notes, tables, getRpcCalls:()=>rpcCalls, routes}
}

test('owner may list human notes on shared Star diary, but not on locked',async()=>{
  const db=setup()
  const good=await db.call('GET','/star/:id',{params:{id:SHARED}})
  assert.equal(good.statusCode,200)
  assert.deepEqual(good.data.annotations.map(x=>x.body),['今天的批注'])
  const locked=await db.call('GET','/star/:id',{params:{id:LOCKED}})
  assert.equal(locked.statusCode,404)
  assert.equal(locked.data.annotations,undefined)
})
test('user cannot read another account Star or fox annotations',async()=>{
  const db=setup()
  const a=await db.call('GET','/star/:id',{userId:OTHER,params:{id:SHARED}})
  const b=await db.call('GET','/mine/:date',{userId:OTHER,params:{date:'2026-10-18'}})
  assert.equal(a.statusCode,404);assert.equal(b.statusCode,404)
})
test('author sees Star notes on fox entry even after locking',async()=>{
  const db=setup()
  const r=await db.call('GET','/mine/:date',{params:{date:'2026-10-18'}})
  assert.equal(r.statusCode,200)
  assert.equal(r.data.annotations[0].author,'star')
  assert.equal(r.data.annotations[0].body,'我读到了你的心情')
})
test('only human can post to Shared Star entry through trusted RPC',async()=>{
  const db=setup()
  const r=await db.call('POST','/star/:id',{params:{id:SHARED},body:{body:'这一篇我很喜欢。'}})
  assert.equal(r.statusCode,201)
  assert.equal(db.getRpcCalls(),1)
  const denied=await db.call('POST','/star/:id',{params:{id:LOCKED},body:{body:'不能评论'}})
  assert.equal(denied.statusCode,404)
  assert.equal(db.getRpcCalls(),2)
  assert.equal(db.routes['POST /mine/:date'],undefined)
})
test('no arbitrary author or user_id accepted, strict validation and auth',async()=>{
  const db=setup()
  for(const body of [{body:'hi',author:'star'},{body:'x',user_id:USER},{body:' '},{body:'x'.repeat(601)}]){
    const r=await db.call('POST','/star/:id',{params:{id:SHARED},body})
    assert.equal(r.statusCode,400)
  }
  assert.equal(db.getRpcCalls(),0)
  const unauthorized=await db.call('GET','/star/:id',{userId:'fake',params:{id:SHARED}})
  assert.equal(unauthorized.statusCode,401)
  assert.equal(unauthorized.data.ok,false)
})
test('offset and date validation',async()=>{
  const db=setup()
  assert.equal((await db.call('GET','/star/:id',{params:{id:SHARED},query:{offset:'-2'}})).statusCode,400)
  assert.equal((await db.call('GET','/mine/:date',{params:{date:'2026-02-29'}})).statusCode,400)
  assert.equal((await db.call('GET','/mine/:date',{params:{date:'2024-02-29'}})).statusCode,404)
})
test('read rechecks parent after fetching notes; lock race fails closed',async()=>{
  const db=setup()
  // Simulate a lock between pre-read and post-read parent lookups.
  const row=db.tables.agent_diary[0]
  const original=db.tables.diary_annotations_v35
  Object.defineProperty(original,'0',{ get(){row.visibility='locked'; return {id:HUMAN_NOTE,author:'human',body:'秘密',created_at:'2026-10-18T08:00:00Z'}},configurable:true })
  const result=await db.call('GET','/star/:id',{params:{id:SHARED}})
  assert.equal(result.statusCode,404)
})
