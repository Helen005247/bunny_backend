'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STAR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FOX = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const NOTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function create({ locked = false, rpcFail = false, truncated = false } = {}) {
  const routes = {}, middleware = [], calls = []
  const Router = () => ({
    use(fn){ middleware.push(fn) },
    get(route, fn){routes['GET '+route] = fn},
    post(route, fn){routes['POST '+route] = fn},
  })
  const source = fs.readFileSync(path.resolve(__dirname, '../routes/diaryUnread.js'), 'utf8')
  const module = { exports: {} }
  new Function('module','exports','require',source)(module,module.exports,(name) => {
    if(name === 'express') return {Router}
    if(name === '../services/diary/diaryCalendar') {
      return {dateKeyInTimezone:(instant,timezone) => {
        const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone || 'UTC',year:'numeric',month:'2-digit',day:'2-digit'})
          .formatToParts(new Date(instant))
        const get=(type)=>parts.find(p=>p.type===type).value
        return `${get('year')}-${get('month')}-${get('day')}`
      }}
    }
    throw Error('Unexpected dependency: '+name)
  })
  const records = [
    {id:1,kind:'star_diary',target_id:STAR,action:'created',owner:OWNER,
      diary_created_at:'2026-10-17T18:00:00Z',diary_updated_at:'2026-10-17T18:00:00Z',diary_timezone:'Asia/Shanghai',diary_version:1},
    {id:2,kind:'star_diary',target_id:STAR,action:'updated',owner:OWNER,
      diary_created_at:'2026-10-17T18:00:00Z',diary_updated_at:'2026-10-19T12:00:00Z',diary_timezone:'Asia/Shanghai',diary_version:2},
    {id:3,kind:'star_note',target_id:FOX,action:'annotated',owner:OWNER,
      diary_date:'2026-10-18',annotation_id:NOTE},
  ]
  const read = new Map()
  const supabase = { async rpc(name, payload){
    calls.push({name,payload})
    if(rpcFail) return {data:null,error:{message:'fail'}}
    if (name==='diary_unread_snapshot_v36') {
      const results = [...new Map(records.filter(r=>r.owner===payload.p_user_id &&
        !(locked && r.kind==='star_diary') && r.id>(read.get(r.kind+':'+r.target_id)||0))
        .map(r=>[r.kind+':'+r.target_id,r])).values()]
      return {data:{items:results.map(r=>({kind:r.kind,target_id:r.target_id,
        event_id:r.id,action:r.action,diary_created_at:r.diary_created_at || null,
        diary_updated_at:r.diary_updated_at || null,diary_version:r.diary_version || null,diary_timezone:r.diary_timezone || null,
        diary_date:r.diary_date || null,annotation_id:r.annotation_id || null})),truncated}}
    }
    if(name==='diary_mark_seen_v36') {
      const row = records.find(r=>r.id===payload.p_event_id &&
        r.owner===payload.p_user_id && r.kind===payload.p_kind &&
        r.target_id===payload.p_target_id && !(locked && r.kind==='star_diary'))
      if(!row) return {data:false}
      const key=row.kind+':'+row.target_id
      read.set(key,Math.max(read.get(key)||0,row.id))
      return {data:true}
    }
    throw Error('bad RPC: '+name)
  }}
  module.exports.createDiaryUnreadRouter({supabase})
  async function call(method, route, {userId=OWNER,body}={}) {
    const req={userId,body}, res={statusCode:200,headers:{},
      set(k,v){this.headers[k]=v;return this},
      status(n){this.statusCode=n;return this},
      json(data){this.data=data;return this}}
    for(const fn of middleware){let next=false;await fn(req,res,()=>{next=true});if(!next)return res}
    assert.ok(routes[method+' '+route],`Missing ${method} ${route}`)
    await routes[method+' '+route](req,res)
    return res
  }
  return {call,calls,read,records}
}

test('new/updated diary collapses to latest event and retains the original month',async()=>{
  const db=create(),result=await db.call('GET','/')
  assert.equal(result.statusCode,200)
  assert.equal(result.data.items.length,2)
  const diary=result.data.items.find(i=>i.kind==='star_diary')
  assert.equal(diary.event_id,2)
  assert.equal(diary.diary_date,'2026-10-18') // created at UTC 17th, China 18th
  assert.equal(diary.action,'updated')
  assert.equal(diary.diary_version,2)
  assert.ok(!Object.hasOwn(diary,'body'))
  assert.ok(!Object.hasOwn(diary,'title'))
  assert.deepEqual(db.calls[0].payload,{p_user_id:OWNER})
})

test('different users cannot obtain the unread data of this account',async()=>{
  const db=create(),res=await db.call('GET','/',{userId:OTHER})
  assert.equal(res.data.items.length,0)
  assert.equal((await db.call('POST','/seen',{userId:OTHER,body:{kind:'star_diary',target_id:STAR,event_id:2}})).statusCode,404)
})

test('locked diary metadata is not returned or acknowledgeable',async()=>{
  const db=create({locked:true})
  assert.deepEqual((await db.call('GET','/')).data.items.map(x=>x.kind),['star_note'])
  assert.equal((await db.call('POST','/seen',{body:{kind:'star_diary',target_id:STAR,event_id:2}})).statusCode,404)
})

test('opening an entry clears only its diary unread, not unrelated annotation',async()=>{
  const db=create()
  const seen=await db.call('POST','/seen',{body:{kind:'star_diary',target_id:STAR,event_id:2}})
  assert.equal(seen.statusCode,200)
  const later=await db.call('GET','/')
  assert.deepEqual(later.data.items.map(x=>x.kind),['star_note'])
})

test('an older read receipt never discards a newer revision',async()=>{
  const db=create()
  const old=await db.call('POST','/seen',{body:{kind:'star_diary',target_id:STAR,event_id:1}})
  assert.equal(old.statusCode,200)
  const current=await db.call('GET','/')
  assert.equal(current.data.items.find(x=>x.kind==='star_diary').event_id,2)
  await db.call('POST','/seen',{body:{kind:'star_diary',target_id:STAR,event_id:2}})
  await db.call('POST','/seen',{body:{kind:'star_diary',target_id:STAR,event_id:1}})
  assert.equal(db.read.get('star_diary:'+STAR),2)
})

test('malformed payloads rejected before any RPC and requireAuth user enforced',async()=>{
  const db=create()
  const bad=[{},null,{kind:'star_note',target_id:FOX,event_id:3,user_id:OWNER},
    {kind:'star_note',target_id:FOX,event_id:'3'},
    {kind:'unknown',target_id:FOX,event_id:3},
    {kind:'star_note',target_id:'not-a-uuid',event_id:3}]
  for(const body of bad){ const r=await db.call('POST','/seen',{body});assert.equal(r.statusCode,400) }
  assert.equal(db.calls.length,0)
  assert.equal((await db.call('GET','/',{userId:null})).statusCode,401)
  assert.equal(db.calls.length,0)
})

test('database outage does not quietly become an empty unread list',async()=>{
  const db=create({rpcFail:true})
  assert.equal((await db.call('GET','/')).statusCode,503)
  assert.equal((await db.call('POST','/seen',{body:{kind:'star_note',target_id:FOX,event_id:3}})).statusCode,503)
})

test('unread endpoint reports a truncated snapshot explicitly',async()=>{
  const db=create({truncated:true})
  assert.equal((await db.call('GET','/')).data.truncated,true)
})

test('migration has insert/update triggers and no historical backfill',()=>{
  const sql=fs.readFileSync(path.resolve(__dirname,'../../sql/diary_v3-6_step2_unread.sql'),'utf8')
  assert.match(sql,/AFTER INSERT OR UPDATE ON public\.agent_diary/)
  assert.match(sql,/AFTER INSERT ON public\.diary_annotations_v35/)
  assert.match(sql,/AND d\.visibility='shared'/)
  assert.match(sql,/diary_mark_seen_v36/)
  assert.match(sql,/GREATEST\(/)
  assert.match(sql,/REVOKE ALL ON public\.diary_activity_v36/)
  assert.doesNotMatch(sql,/INSERT INTO public\.diary_activity_v36\s+SELECT/i)
})
