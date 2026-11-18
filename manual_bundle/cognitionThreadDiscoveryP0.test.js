'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  modeFromEnv, allowlistedShadowUser, manualOnceDedupeKey, canEvaluate,
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

test('non-acknowledged real mode is off',()=>{
 const mode=modeFromEnv({
    THREAD_DISCOVERY_MODE:'manual_live_once',
    THREAD_DISCOVERY_LIVE_USER_ID:USER
 })
 assert.equal(mode,'off')
})

const manualEnvKeys=[
  'THREAD_DISCOVERY_MODE','THREAD_DISCOVERY_LIVE_WRITE_ACK',
  'THREAD_DISCOVERY_LIVE_USER_ID'
]
async function withManualEnv(fn) {
 const saved=Object.fromEntries(manualEnvKeys.map(k=>[k,process.env[k]]))
 process.env.THREAD_DISCOVERY_MODE='manual_live_once'
 process.env.THREAD_DISCOVERY_LIVE_WRITE_ACK='create-one-real-thread'
 process.env.THREAD_DISCOVERY_LIVE_USER_ID=USER
 try {await fn()}
 finally {
   for(const k of manualEnvKeys){
     if(saved[k]===undefined) delete process.env[k]
     else process.env[k]=saved[k]
   }
 }
}
const manualBase=(opts={})=>base({
  triggerType:'manual',wakeReasons:['manual'],mode:'manual_live_once',
  ...opts
})

test('manual mode requires exact three settings',()=>{
 assert.equal(modeFromEnv({THREAD_DISCOVERY_MODE:'manual_live_once'}),'off')
 assert.equal(modeFromEnv({
   THREAD_DISCOVERY_MODE:'manual_live_once',
   THREAD_DISCOVERY_LIVE_WRITE_ACK:'create-one-real-thread'
 }), 'manual_live_once')
})
test('manual mode cannot run on heartbeat, wrong user, or wrong agent',async()=>{
 await withManualEnv(async()=>{
   let called=0
   const cb=async()=>{called++}
   const opts={callModel:cb}
   const other=await evaluateOpportunity(manualBase({...opts,userId:OTHER}))
   const heartbeat=await evaluateOpportunity(manualBase({...opts,triggerType:'heartbeat',
     wakeReasons:['periodic_autonomous']}))
   const wrongAgent=await evaluateOpportunity(manualBase({...opts,agentId:'other'}))
   assert.equal(other.status,'not_allowlisted')
   assert.equal(heartbeat.status,'not_manual')
   assert.equal(wrongAgent.status,'not_allowlisted')
   assert.equal(called,0)
 })
})
test('manual live once candidate requires genuine model decision',async()=>{
 await withManualEnv(async()=>{
    let calls=0
    const result=await evaluateOpportunity(manualBase({callModel:async()=>{
      calls++;return {output_text:createRaw()}
    }}))
    assert.equal(calls,1)
    assert.equal(result.status,'candidate')
    assert.equal(result.mode,'manual_live_once')
    const negative=await evaluateOpportunity(manualBase({callModel:async()=>({output_text:noneRaw()})}))
    assert.equal(negative.status,'none')
 })
})
test('one real Thread can be created only once in live-mode fake DB',async()=>{
 await withManualEnv(async()=>{
   const evaluated=await evaluateOpportunity(manualBase())
   let writes=0, requested, previous=null
   const mockCreate=async x=>{
     writes++;requested=x
     previous={id:'44444444-4444-4444-8444-444444444444',
       user_id:x.userId,agent_id:x.agentId,status:'open',title:x.title}
     return previous
   }
   const args={
      evaluated,mode:'manual_live_once',userId:USER,agentId:'star',
      fetchThoughts:async()=>rows,
      fetchThreads:async()=>previous?[previous]:[],
      createThread:mockCreate
   }
   const first=await persistOpportunity(args)
   const second=await persistOpportunity(args)
   assert.equal(first.status,'created')
   assert.equal(first.persisted,true)
   assert.equal(second.status,'thread_already_exists')
   assert.equal(second.persisted,false)
   assert.equal(writes,1)
   assert.equal(requested.metadata.source_thought_ids.length,2)
   assert(Date.parse(requested.nextReviewAt)>Date.now())
   assert(requested.dedupeKey.startsWith('thread-discovery-manual-once-v1:'))
 })
})
test('unique idempotency key does not depend on title or source selection',()=>{
 const one=manualOnceDedupeKey(USER,'star')
 const two=manualOnceDedupeKey(USER,'star')
 const other=manualOnceDedupeKey(OTHER,'star')
 assert.equal(one,two)
 assert.notEqual(one,other)
})
test('expired or missing Thought rejects live write before mutation',async()=>{
 await withManualEnv(async()=>{
   const evaluated=await evaluateOpportunity(manualBase())
   let writes=0
   const result=await persistOpportunity({
      evaluated,mode:'manual_live_once',userId:USER,agentId:'star',
      fetchThoughts:async()=>rows.slice(1),
      fetchThreads:async()=>[],
      createThread:async()=>{writes++}
   })
   assert.equal(result.status,'source_no_longer_active')
   assert.equal(writes,0)
 })
})
test('no existing Thread (including closed) is allowed for this initial test',async()=>{
 await withManualEnv(async()=>{
   const evaluated=await evaluateOpportunity(manualBase())
   let writes=0
   const result=await persistOpportunity({
     evaluated,mode:'manual_live_once',userId:USER,agentId:'star',
     fetchThoughts:async()=>rows,
     fetchThreads:async()=>[{status:'completed',title:'already there'}],
     createThread:async()=>{writes++}
   })
   assert.equal(result.status,'thread_already_exists')
   assert.equal(writes,0)
 })
})
test('live mode turns off immediately when env acknowledgement removed',async()=>{
 await withManualEnv(async()=>{
   const evaluated=await evaluateOpportunity(manualBase())
   delete process.env.THREAD_DISCOVERY_LIVE_WRITE_ACK
   let writes=0
   const result=await persistOpportunity({
     evaluated,mode:'manual_live_once',userId:USER,agentId:'star',
     fetchThoughts:async()=>rows,
     fetchThreads:async()=>[],
     createThread:async()=>{writes++}
   })
   assert.equal(result.persisted,false)
   assert.equal(writes,0)
 })
})
test('unconfirmed DB insert is never considered saved',async()=>{
 await withManualEnv(async()=>{
   const evaluated=await evaluateOpportunity(manualBase())
   const r=await persistOpportunity({
     evaluated,mode:'manual_live_once',userId:USER,agentId:'star',
     fetchThoughts:async()=>rows,
     fetchThreads:async()=>[],
     createThread:async()=>({id:'test-row-without-owner'})
   })
   assert.equal(r.status,'write_unconfirmed')
   assert.equal(r.persisted,false)
 })
})
