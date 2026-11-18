'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  modeFromEnv, allowlistedShadowUser, canEvaluate,
  buildDiscoveryPrompt, parseDiscoveryOutput,
  evaluateOpportunity, persistOpportunity, discoveryMetadata,
  normalizedTitle, sameSourceCluster,
} = require('../services/cognition/thoughtThreadDiscoveryP0')

const USER='00edc61c-092e-44e4-be88-048b366d3bcf'
const OTHER='fba1d2b0-1111-4111-8111-111111111111'
const NOW = new Date('2026-11-18T09:00:00.000Z')
const rows = [
  {id:'101',content:'今天想重新理解怎样尊重彼此的界限',created_at:'2026-11-10T00:00:00.000Z',expires_at:'2026-11-25T00:00:00.000Z'},
  {id:'102',content:'表达心意时，也要给对方选择的自由',created_at:'2026-11-11T00:00:00.000Z',expires_at:'2026-11-25T00:00:00.000Z'},
  {id:'103',content:'不要把回应当成爱的条件',created_at:'2026-11-12T00:00:00.000Z',expires_at:'2026-11-25T00:00:00.000Z'}
]
const context = {available:true,eligible:[],known:[]}
const base = (other={}) => ({
  supabase: {}, userId:USER, agentId:'star',
  now:NOW, triggerType:'heartbeat', wakeReasons:['periodic_autonomous'],
  context, metadata:{}, fetchThoughts:async()=>rows,
  callModel:async()=>({output_text:createRaw()}), ...other
})
function createRaw(ids=['101','102']) {
  return JSON.stringify({
    decision:'create',thread_reason:'worth_continuing',source_thought_ids:ids,
    title:'尊重边界的表达方式',current_draft:'想继续学习如何表达感情而不强迫对方回应',
    next_step:'如果有新理解，再思考如何做得更自然'
  })
}
function noneRaw() {
  return JSON.stringify({
    decision:'none',thread_reason:'no_continuation_value',source_thought_ids:[],
    title:'',current_draft:'',next_step:''
  })
}
async function withShadowEnv(fn) {
  const keys=['THREAD_DISCOVERY_MODE','THREAD_DISCOVERY_SHADOW_USER_ID',
    'THREAD_DISCOVERY_STAGING_WRITE_ACK','THREAD_DISCOVERY_TEST_USER_ID']
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]))
  process.env.THREAD_DISCOVERY_MODE='shadow'
  process.env.THREAD_DISCOVERY_SHADOW_USER_ID=USER
  try { await fn() }
  finally {
    for (const k of keys) {
      if(saved[k]===undefined) delete process.env[k]
      else process.env[k]=saved[k]
    }
  }
}

test('fail closed by default and reject any legacy staging write flag',()=>{
  assert.equal(modeFromEnv({}),'off')
  assert.equal(modeFromEnv({THREAD_DISCOVERY_MODE:'shadow'}),'shadow')
  assert.equal(modeFromEnv({
    THREAD_DISCOVERY_MODE:'staging_write',
    THREAD_DISCOVERY_STAGING_WRITE_ACK:'isolated-test-db'}),'off')
  assert.equal(modeFromEnv({THREAD_DISCOVERY_MODE:'write'}),'off')
})
test('shadow allowlist requires a valid matching UUID',()=>{
  assert.equal(allowlistedShadowUser(USER,{THREAD_DISCOVERY_SHADOW_USER_ID:USER}),true)
  assert.equal(allowlistedShadowUser(OTHER,{THREAD_DISCOVERY_SHADOW_USER_ID:USER}),false)
  assert.equal(allowlistedShadowUser(USER,{}),false)
  assert.equal(allowlistedShadowUser(USER,{THREAD_DISCOVERY_SHADOW_USER_ID:'not-a-uuid'}),false)
})
test('not_periodic, open_thread_exists, cooldown, time_budget prevent new model calls',()=>{
  const c={mode:'shadow',triggerType:'heartbeat',
    wakeReasons:['periodic_autonomous'],context,metadata:{},now:NOW}
  assert.equal(canEvaluate(c),null)
  assert.equal(canEvaluate({...c,triggerType:'manual'}),'not_periodic')
  assert.equal(canEvaluate({...c,wakeReasons:['continued_absence']}),'not_periodic')
  assert.equal(canEvaluate({...c,context:{available:true,eligible:[],known:[{status:'open'}]}}),'open_thread_exists')
  assert.equal(canEvaluate({...c,metadata:{thread_discovery_p0:{
    lastAttemptAt:new Date(NOW.getTime()-1000).toISOString()
  }}}),'review_cooldown')
  assert.equal(canEvaluate({...c,elapsedMs:30001}),'time_budget_exceeded')
})
test('off in actual runtime cannot be bypassed by mode argument',async()=>{
  await withShadowEnv(async()=>{
    delete process.env.THREAD_DISCOVERY_MODE
    let count=0
    const res=await evaluateOpportunity(base({mode:'shadow',callModel:async()=>{count++}}))
    assert.equal(res.status,'disabled')
    assert.equal(count,0)
  })
})
test('user not allowlisted cannot call model, even when shadow enabled',async()=>{
  await withShadowEnv(async()=>{
    let count=0
    const result=await evaluateOpportunity(base({
      userId:OTHER,mode:'shadow',callModel:async()=>{count++}
    }))
    assert.equal(result.status,'not_allowlisted')
    assert.equal(count,0)
  })
})
test('shadow invokes real opportunity evaluator contract and returns candidate',async()=>{
  await withShadowEnv(async()=>{
    let count=0
    const result=await evaluateOpportunity(base({mode:'shadow',callModel:async({model,input})=>{
      assert.equal(model,'gpt-5.6-sol')
      assert(input.includes('"101"'))
      count++
      return {output_text:createRaw()}
    }}))
    assert.equal(count,1)
    assert.equal(result.status,'candidate')
    assert.equal(result.candidate.sourceIds.length,2)
    assert.equal(result.at,NOW.toISOString())
    assert.equal(result.mode,'shadow')
  })
})
test('candidate never writes, even with write flags, DB and writer injected',async()=>{
  await withShadowEnv(async()=>{
    process.env.THREAD_DISCOVERY_STAGING_WRITE_ACK='isolated-test-db'
    process.env.THREAD_DISCOVERY_TEST_USER_ID=USER
    const evaluated=await evaluateOpportunity(base({mode:'shadow'}))
    let wrote=0
    const write=async()=>{wrote++; throw Error('MUST_NOT_BE_CALLED')}
    const result=await persistOpportunity({
      evaluated,mode:'shadow',supabase:{insert:write,update:write,rpc:write},
      userId:USER,agentId:'star',createThread:write,
      fetchThreads:write,fetchThoughts:write,
    })
    assert.equal(result.status,'shadow_candidate')
    assert.equal(result.persisted,false)
    assert.equal(wrote,0)
    const forced=await persistOpportunity({evaluated:{...evaluated,mode:'staging_write'},
      mode:'staging_write',createThread:write})
    assert.equal(forced.persisted,false)
    assert.equal(wrote,0)
  })
})
test('valid none stays none, has no source and no persist',async()=>{
  await withShadowEnv(async()=>{
    const evaluated=await evaluateOpportunity(base({
      mode:'shadow',callModel:async()=>({output_text:noneRaw()})
    }))
    assert.equal(evaluated.status,'none')
    assert.equal(evaluated.candidate,null)
    const result=await persistOpportunity({evaluated,mode:'shadow'})
    assert.equal(result.persisted,false)
  })
})
test('bad or expired sources cannot yield candidate',()=>{
  assert.throws(()=>parseDiscoveryOutput(createRaw(['999']),rows,[],NOW),
    /expired_or_unknown_discovery_source/)
  assert.throws(()=>parseDiscoveryOutput(createRaw(['101','101']),rows,[],NOW),
    /duplicate_discovery_sources/)
  const expired=[{...rows[0],expires_at:'2026-11-17T00:00:00.000Z'},rows[1]]
  assert.throws(()=>parseDiscoveryOutput(createRaw(['101']),expired,[],NOW),
    /expired_or_unknown_discovery_source/)
})
test('existing topics are not duplicated by title or source overlap',()=>{
  const raw=createRaw(['101','102'])
  assert.throws(()=>parseDiscoveryOutput(raw,rows,[{
    id:'x',title:'尊重边界的表达方式',status:'completed'
  }],NOW),/duplicate_discovery_topic/)
  assert.throws(()=>parseDiscoveryOutput(raw,rows,[{
    id:'x',title:'另一个标题',status:'abandoned',
    metadata:{source_thought_ids:['101','102']}
  }],NOW),/duplicate_discovery_topic/)
})
test('model errors are contained and no exception bubbles to Thought path',async()=>{
  await withShadowEnv(async()=>{
    const result=await evaluateOpportunity(base({mode:'shadow',
      callModel:async()=>{throw Error('simulated API failure')}
    }))
    assert.equal(result.status,'discovery_error')
    assert.equal(result.attempted,true)
  })
})
test('insufficient Thoughts and exceeded budget make no model calls',async()=>{
  await withShadowEnv(async()=>{
    let calls=0
    const model=async()=>{calls++}
    const one=await evaluateOpportunity(base({
      mode:'shadow',fetchThoughts:async()=>rows.slice(0,1),callModel:model
    }))
    assert.equal(one.status,'insufficient_active_thoughts')
    const slow=await evaluateOpportunity(base({
      mode:'shadow',elapsedMs:30002,callModel:model
    }))
    assert.equal(slow.status,'time_budget_exceeded')
    assert.equal(calls,0)
  })
})
test('attempted decisions stamp cooldown; skips do not',()=>{
  assert.deepEqual(discoveryMetadata({x:1},{attempted:false}),{x:1})
  const updated=discoveryMetadata({x:1},{attempted:true,at:NOW.toISOString()})
  assert.equal(updated.x,1)
  assert.equal(updated.thread_discovery_p0.lastAttemptAt,NOW.toISOString())
})
test('prompt uses real Thought data and allows legitimate none',()=>{
  const p=buildDiscoveryPrompt({now:NOW,thoughts:rows,known:[]})
  assert(p.includes(rows[0].content))
  assert(p.includes('没有就输出 none'))
  assert(p.includes('source_thought_ids'))
})
test('shadow-only module has no database mutation function',()=>{
  const file=fs.readFileSync(path.resolve(__dirname,
    '../services/cognition/thoughtThreadDiscoveryP0.js'),'utf8')
  assert(!file.includes("require('./thoughtThreadService')"))
  assert(!/\.(insert|upsert|delete|rpc)\s*\(/.test(file))
  assert(!/\bsupabase\s*\.\s*(?:from|rpc)\s*\(/.test(file))
  assert(!/\bcreateThoughtThread\s*\(/.test(file))
  assert(!/\bstaging_write\s*===/.test(file))
})
