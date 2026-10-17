'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const crypto=require('node:crypto')
const fs=require('node:fs')
const path=require('node:path')
const {runAcceptancePreview,runAcceptanceProbe,acceptanceHash,countKinds}=
    require('../services/diary/diaryAcceptance')
const {assertConfig,safeLog,dispatchAndPoll}=require('../scripts/diary-review')
const {assembleEvidence}=require('../services/diary/diarySearch')
const {planAutonomousDiary}=require('../services/diary/diaryAutonomyWriter')

const USER='11111111-1111-4111-8111-111111111111'
const OTHER='22222222-2222-4222-8222-222222222222'
const SETTINGS={timezone:'Asia/Shanghai',system_prompt:'星星',character_context:''}
const NOW=new Date('2026-10-17T18:00:00Z')
const URL='https://example.org/internal/diary/tick'
const SECRET='x'.repeat(32)

function makeDb() {
  const calls=[]
  const tables={agent_diary:[],diary_topics:[],messages:[],call_sessions:[],
    diary_acceptance_chunk_cache:[],diary_acceptance_rollup_cache:[],
    diary_review_material_cache:[],diary_review_jobs:[],
    diary_revisions:[],diary_review_actions:[],diary_acceptance_plans:[]}
  class Query {
    constructor(name){this.name=name;this.filters=[];this.limitNum=Infinity;this.orders=[];this.fields='*'}
    select(fields){this.fields=fields||'*';return this}
    eq(k,v){this.filters.push(row=>String(row[k])===String(v));return this}
    in(k,vs){this.filters.push(row=>vs.includes(row[k]));return this}
    ilike(k,p){const term=p.replace(/^%|%$/g,'').toLowerCase();this.filters.push(row=>String(row[k]||'').toLowerCase().includes(term));return this}
    contains(k,value){const terms=JSON.parse(value);this.filters.push(row=>terms.every(t=>row[k]?.includes(t)));return this}
    order(k,{ascending=true}={}){this.orders.push({k,ascending});return this}
    limit(n){this.limitNum=Math.min(this.limitNum,n);return this}
    range(a,b){this.offset=a;this.limitNum=Math.min(this.limitNum,b-a+1);return this}
    gte(k,v){this.filters.push(row=>row[k]>=v);return this}
    lt(k,v){this.filters.push(row=>row[k]<v);return this}
    lte(k,v){this.filters.push(row=>row[k]<=v);return this}
    insert(record){this.toInsert=record;return this}
    async single(){
      if(!this.toInsert)throw new Error('single_no_insert')
      if(this.name!=='diary_acceptance_plans')throw new Error('production_write_violation')
      const row={...this.toInsert,id:crypto.randomUUID()}
      tables[this.name].push(row)
      calls.push({kind:'insert',table:this.name,record:row})
      return {data:{id:row.id},error:null}
    }
    async upsert(record,opts){
      calls.push({kind:'upsert',table:this.name,record})
      if(!['diary_acceptance_chunk_cache','diary_acceptance_rollup_cache'].includes(this.name))
        throw new Error('production_write_violation')
      const cols=opts.onConflict.split(',')
      const current=tables[this.name].find(row=>cols.every(k=>row[k]===record[k]))
      if(current)Object.assign(current,record)
      else tables[this.name].push({...record})
      return {data:null,error:null}
    }
    then(done,fail){
      let output=tables[this.name].filter(row=>this.filters.every(fn=>fn(row)))
      for(const {k,ascending} of this.orders)output=output.sort((a,b)=>{
        const d=String(a[k]||'').localeCompare(String(b[k]||''));return ascending?d:-d
      })
      output=output.slice(this.offset||0,(this.offset||0)+this.limitNum)
      if(this.fields!=='*'){const fields=this.fields.split(',').map(x=>x.trim());
        output=output.map(row=>Object.fromEntries(fields.filter(k=>k in row).map(k=>[k,row[k]])))}
      calls.push({kind:'read',table:this.name})
      return Promise.resolve({data:output,error:null}).then(done,fail)
    }
  }
  return {tables,calls,from:table=>new Query(table),async rpc(name,params){
    calls.push({kind:'rpc',name,params})
    return {data:{ok:true,rolled_back:true,
      probeCreate:true,probeAppend:true,probeRewrite:true,probeDefer:true,
      probeDuplicate:true,probeConflict:true,probeAtomic:true},error:null}
  }}
}
function source(){const rows=[
  {id:'m1',sessionId:'sess',role:'user',content:'2026年10月16日提到生日礼物',createdAt:'2026-10-16T02:00:00.000Z',channel:'text'},
  {id:'m2',sessionId:'sess',role:'assistant',content:'那天说起礼物上有星星',createdAt:'2026-10-16T02:01:00.000Z',channel:'text'}]
  return {...assembleEvidence(rows,[]),fetchedCount:2,filteredCount:0}
}
const BASE={userId:USER,agentId:'star',startDate:'2026-10-15',endDate:'2026-10-15',
  topicHint:'生日',now:NOW,getSettings:async()=>SETTINGS,callModel:async()=>({output_text:'{}'})}

test('mode input validation protects ordinary scheduled daily and manually selected dates',()=>{
  const common={endpoint:URL,userId:USER,secret:SECRET,startDate:'',endDate:'',topicHint:''}
  assert.equal(assertConfig({...common,acceptanceMode:'off'}),URL)
  assert.equal(assertConfig({...common,startDate:'2026-10-15',endDate:'2026-10-15'}),URL)
  assert.throws(()=>assertConfig({...common,acceptanceMode:'preview'}),/V2 manual mode requires/)
  assert.equal(assertConfig({...common,acceptanceMode:'preview',startDate:'2026-10-15',endDate:'2026-10-15'}),URL)
  assert.equal(assertConfig({...common,acceptanceMode:'probe'}),URL)
  assert.throws(()=>assertConfig({...common,acceptanceMode:'probe',startDate:'2026-10-15'}),/probe requires/)
  assert.throws(()=>assertConfig({...common,acceptanceMode:'unknown'}),/acceptance mode/)
  assert.throws(()=>assertConfig({...common,acceptanceMode:'preview',startDate:'2026-10-15'}),/both/)
})
test('real-history preview only writes acceptance checkpoints, never diary/topics/revisions/jobs',async()=>{
  const db=makeDb()
  const writer=async opts=>{
    assert.equal(opts.window.topicHint,'生日')
    await opts.storeReviewedChunk({index:1,hash:'a'.repeat(64),observations:['真实聊天观察']})
    await opts.storeReviewedRollup({index:1,hash:'b'.repeat(64),observations:['一件事']})
    return {actions:[
      {kind:'create',anchor_id:'m1',topic_label:'礼物',evidence_ids:['m1'],
        title:'记录',body:'这是一段测试日记正文，有足够的长度，仅用于预演和确认测试。',topics:['生日']},
      {kind:'defer',anchor_id:'m2',topic_label:'后续',evidence_ids:['m2'],note:''}
    ],evidence:assembleEvidence(source().rows,[]),
      reviewDone:1,reviewTotal:1,rollupDone:1,rollupTotal:1,
      cacheHits:0,modelCalls:2,searchCount:2}
  }
  const result=await runAcceptancePreview({...BASE,supabase:db,
    reader:async()=>source(),writer})
  assert.equal(result.status,'previewed')
  assert.equal(result.previewCreate,1)
  assert.equal(result.previewDefer,1)
  assert.equal(result.sourceCount,2)
  assert.equal(db.tables.diary_acceptance_chunk_cache.length,1)
  assert.equal(db.tables.diary_acceptance_rollup_cache.length,1)
  assert.equal(db.tables.diary_acceptance_plans.length,1)
  assert.ok(result.planId && result.planDigest)
  assert.equal(db.calls.filter(c=>c.kind==='upsert').length,2)
  assert.deepEqual(db.calls.filter(c=>c.kind==='upsert').map(c=>c.table),
    ['diary_acceptance_chunk_cache','diary_acceptance_rollup_cache'])
  for(const table of ['agent_diary','diary_topics','diary_review_jobs','diary_revisions','diary_review_actions'])
    assert.deepEqual(db.tables[table],[])
})
test('preview partial checkpoints resume for same owner and time range; other users isolated',async()=>{
  const db=makeDb()
  const partial=async opts=>{
    await opts.storeReviewedChunk({index:1,hash:'a'.repeat(64),observations:['memo']})
    return {partial:true,reviewDone:1,reviewTotal:2,cacheHits:0,
      modelCalls:1,rollupDone:0,rollupTotal:0}
  }
  const one=await runAcceptancePreview({...BASE,supabase:db,reader:async()=>source(),writer:partial})
  assert.equal(one.status,'partial')
  assert.equal(one.errorCode,'acceptance_preview_partial')
  const two=await runAcceptancePreview({...BASE,supabase:db,reader:async()=>source(),
    writer:async opts=>{
      assert.equal(opts.cachedChunks.length,1)
      assert.equal(opts.cachedChunks[0].observations[0],'memo')
      return {actions:[],evidence:assembleEvidence([],[]),reviewDone:2,reviewTotal:2,rollupDone:0,
        rollupTotal:0,cacheHits:1,modelCalls:1}
    }})
  assert.equal(two.status,'previewed')
  assert.equal(two.previewSkipped,1)
  assert.equal(two.cacheHits,1)
  const three=await runAcceptancePreview({...BASE,userId:OTHER,supabase:db,
    reader:async()=>source(),writer:async opts=>{
      assert.equal(opts.cachedChunks.length,0)
      return {actions:[],evidence:assembleEvidence([],[]),reviewDone:0,reviewTotal:0}
    }})
  assert.equal(three.status,'previewed')
})
test('source date boundary and timezone rules reject invalid or future ranges before model/writes',async()=>{
  const db=makeDb()
  for(const [a,b] of [ ['2026-10-18','2026-10-18'],['2026-10-01','2026-10-10'],
    ['2026-10-16','2026-10-15'],['not-a-date','2026-10-15'] ]){
    await assert.rejects(runAcceptancePreview({...BASE,startDate:a,endDate:b,supabase:db,
      reader:async()=>{throw new Error('reader_should_not_run')}}))
  }
  assert.equal(db.calls.length,0)
  await assert.rejects(runAcceptancePreview({...BASE,supabase:db,
    getSettings:async()=>({timezone:null})}),/settings_timezone_missing/)
})
test('probe only calls rollback-only RPC and refuses an incomplete result',async()=>{
  const db=makeDb()
  const actual=await runAcceptanceProbe({supabase:db,userId:USER})
  assert.equal(actual.status,'verified')
  assert.equal(actual.rolledBack,1)
  assert.equal(actual.probeConflict,1)
  assert.equal(db.calls.filter(c=>c.kind==='rpc').length,1)
  assert.equal(db.calls.find(c=>c.kind==='rpc').name,'diary_v2_acceptance_probe')
  db.rpc=async()=>({data:{ok:true,rolled_back:false,probeCreate:true},error:null})
  const failure=await runAcceptanceProbe({supabase:db,userId:USER})
  assert.equal(failure.status,'failed')
  assert.equal(failure.errorCode,'acceptance_probe_failed')
})
test('real V2 writer can be used in preview without writing any production table',async()=>{
  const db=makeDb()
  db.tables.messages=[
    {user_id:USER,id:'m1',session_id:'sess',role:'user',content:'生日礼物',created_at:'2026-10-16T02:00:00Z',channel:'text',visible:false,call_session_id:null,reasoning_content:null},
    {user_id:USER,id:'m2',session_id:'sess',role:'assistant',content:'生日礼物上的一颗星星',created_at:'2026-10-16T02:01:00Z',channel:'text',visible:false,call_session_id:null,reasoning_content:null}
  ]
  const inputs=[]
  const callModel=async({input})=>{
    inputs.push(input)
    if(input.includes('日记回顾助手'))return {output_text:'{"observations":["生日礼物的真实细节"]}'}
    if(input.includes('日记选题助手'))return {output_text:'{"queries":["生日礼物"]}'}
    if(input.includes('你是星星，准备写自己的私人日记'))return {output_text:'{"actions":[]}'}
    throw new Error('unexpected_model_input')
  }
  const result=await runAcceptancePreview({...BASE,supabase:db,
    callModel,reader:async()=>source(),writer:planAutonomousDiary})
  assert.equal(result.status,'previewed')
  assert.equal(result.previewSkipped,1)
  assert.ok(inputs.some(x=>x.includes('生日礼物')))
  assert.ok(inputs.some(x=>x.includes('用户提供的搜索线索')))
  assert.ok(result.searchCount>0)
  for(const table of ['agent_diary','diary_topics','diary_review_jobs','diary_revisions','diary_review_actions'])
    assert.equal(db.tables[table].length,0)
})
test('dispatcher previews and probes with correct trigger but never changes normal mode',async()=>{
  for(const {mode,date,trigger,status} of [
    {mode:'off',date:'',trigger:'daily',status:'completed'},
    {mode:'off',date:'2026-10-15',trigger:'backfill',status:'written'},
    {mode:'preview',date:'2026-10-15',trigger:'acceptance_preview',status:'previewed'},
    {mode:'probe',date:'',trigger:'acceptance_probe',status:'verified'},
  ]){
    const called=[]
    const fakeFetch=async(url,opts)=>{
      if(opts.method==='POST'){
        called.push(JSON.parse(opts.body))
        return {status:202,async json(){return {ok:true,runId:crypto.randomUUID()}}}
      }
      return {ok:true,async json(){return {ok:true,status,
        mode:trigger.startsWith('acceptance_')?trigger:undefined}}}
    }
    const result=await dispatchAndPoll({endpoint:URL,userId:USER,secret:SECRET,
      acceptanceMode:mode,startDate:date,endDate:date,fetchImpl:fakeFetch,
      sleep:async()=>{},maxPollMs:1000,nowMs:(()=>{let i=0;return()=>i++})()})
    assert.equal(called.length,1)
    assert.equal(called[0].triggerType,trigger)
    assert.equal(result.status,status)
  }
})
test('log counts are safe: no titles, diary body, evidence, credentials or ids',()=>{
  const s=safeLog({mode:'acceptance_preview',status:'previewed',previewCreate:1,
    searchCount:4,reviewDone:8,reviewTotal:8,rollupDone:0,rollupTotal:0,
    title:'不要输出的日记标题',body:'私密日记正文',userId:USER,token:SECRET})
  assert.match(s,/preview status=previewed/)
  assert.match(s,/create=1/)
  assert.doesNotMatch(s,/不要输出|私密|111111|xxxxxxxx/)
  const p=safeLog({mode:'acceptance_probe',status:'verified',rolledBack:1,
    probeCreate:1,probeAppend:1,probeRewrite:1,probeDefer:1,probeAtomic:1})
  assert.match(p,/rolled_back=1/)
})
test('SQL probe is service-only, intentionally throws rollback marker, preview tables isolated',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../sql/hermit_diary_v2_acceptance.sql'),'utf8')
  for(const term of ['diary_acceptance_chunk_cache','diary_acceptance_rollup_cache',
    'diary_v2_acceptance_probe','diary_finish_autonomy_job','diary_claim_review_job',
    'acceptance_probe_rollback',"ERRCODE='PT001'",'rolled_back',
    'diary_revision_conflict','duplicate_diary_topic_action','ENABLE ROW LEVEL SECURITY',
    'FROM PUBLIC,anon,authenticated','TO service_role'])assert.ok(sql.includes(term),term)
  assert.doesNotMatch(sql,/DELETE FROM public\.agent_diary|TRUNCATE public\.agent_diary/)
  assert.doesNotMatch(sql,/DROP TABLE.*agent_diary/i)
  const inner=sql.indexOf('RAISE EXCEPTION USING ERRCODE=\'PT001\'')
  const end=sql.indexOf('END;\n$$;',inner)
  assert.ok(inner>0 && end>inner)
})

test('internal route authenticates acceptance, validates mode, polls safe result only',async()=>{
  const Module=require('node:module')
  const orig=Module._load
  Module._load=function(name,...args){
    if(name==='express')return {Router:()=>({handlers:new Map(),
      post(route,handler){this.handlers.set('POST '+route,handler)},
      get(route,handler){this.handlers.set('GET '+route,handler)}})}
    if(name==='./cognition'&&args[0]?.filename?.endsWith('/routes/diary.js'))
      return {secureEqual:(a,b)=>a===b}
    return orig.call(this,name,...args)
  }
  let makeRouter
  try {makeRouter=require('../routes/diary').createInternalDiaryRouter}
  finally{Module._load=orig}
  const db=makeDb()
  const seen=[]
  const router=makeRouter({supabase:db,callModel:async()=>{},getSettings:async()=>SETTINGS,
    expectedSecret:SECRET,
    runTick:async()=>{throw new Error('normal_mode_should_not_run')},
    runPreview:async opts=>{seen.push('preview');return {
      mode:'acceptance_preview',status:'previewed',processed:1,
      previewCreate:1,sourceCount:200,secretText:'private'}} ,
    runProbe:async opts=>{seen.push('probe');return {
      mode:'acceptance_probe',status:'verified',processed:1,
      rolledBack:1,probeCreate:1}}
  })
  const post=router.handlers.get('POST /tick')
  const get=router.handlers.get('GET /status/:id')
  function res(){return {statusCode:200,body:null,
    status(code){this.statusCode=code;return this},
    set(){return this},json(v){this.body=v;return this}}}
  const req=(body,secret=SECRET)=>({body,get:k=>k==='x-cognition-secret'?secret:undefined})
  const denied=res();await post(req({userId:USER,triggerType:'acceptance_preview'},'wrong'),denied)
  assert.equal(denied.statusCode,401)
  const missing=res();await post(req({userId:USER,triggerType:'acceptance_preview'}),missing)
  assert.equal(missing.statusCode,400)
  const forbid=res();await post(req({userId:USER,triggerType:'acceptance_probe',topicHint:'x'}),forbid)
  assert.equal(forbid.statusCode,400)
  const initial=res();await post(req({userId:USER,triggerType:'acceptance_preview',
    startDate:'2026-10-15',endDate:'2026-10-15',topicHint:'生日'}),initial)
  assert.equal(initial.statusCode,202)
  const id=initial.body.runId
  await new Promise(resolve=>setImmediate(resolve))
  const polled=res();get({get:()=>SECRET,params:{id}},polled)
  assert.equal(polled.body.status,'previewed')
  assert.equal(polled.body.previewCreate,1)
  assert.equal(polled.body.sourceCount,200)
  assert.equal(polled.body.secretText,undefined)
  assert.deepEqual(seen,['preview'])
  const probe=res();await post(req({userId:USER,triggerType:'acceptance_probe'}),probe)
  await new Promise(resolve=>setImmediate(resolve))
  const poll2=res();get({get:()=>SECRET,params:{id:probe.body.runId}},poll2)
  assert.equal(poll2.body.status,'verified')
  assert.equal(poll2.body.rolledBack,1)
  assert.deepEqual(seen,['preview','probe'])
})
