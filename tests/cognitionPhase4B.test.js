'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const { idleMinutes,scanIdle,guardClaim }=require('../services/cognition/phase4bIdleService')
const { dispatchOneCognitionEvent }=require('../services/cognition/cognitionEventQueue')
const USER='11111111-1111-4111-8111-111111111111'
const ID='22222222-2222-4222-8222-222222222222'
const TOKEN='33333333-3333-4333-8333-333333333333'
const CLAIM={status:'claimed',id:ID,event_type:'chat_finished',
    attempts:1,lease_token:TOKEN,event_key:'phase4b-chat:abc'}

test('idle default is 60, allows 5 and 60 only within 5..180',()=>{
  assert.equal(idleMinutes({}),60)
  assert.equal(idleMinutes({COGNITION_PHASE4B_IDLE_MINUTES:'5'}),5)
  assert.equal(idleMinutes({COGNITION_PHASE4B_IDLE_MINUTES:'60'}),60)
  assert.equal(idleMinutes({COGNITION_PHASE4B_IDLE_MINUTES:'180'}),180)
  for(const val of ['1','4','181','abc','0','5.0','5m','-5','999'])
    assert.throws(()=>idleMinutes({COGNITION_PHASE4B_IDLE_MINUTES:val}),/INVALID_PHASE4B_IDLE/)
})
test('scan uses one server-only RPC; no transcript, prompt or message content',async()=>{
 const calls=[]
 const db={rpc:async(name,input)=>{
   calls.push([name,input]);return {data:{status:'queued',event_id:ID}}
 }}
 const r=await scanIdle({supabase:db,userId:USER,env:{COGNITION_PHASE4B_IDLE_MINUTES:'5'}})
 assert.equal(r.status,'queued')
 assert.deepEqual(calls,[['cognition_phase4b_scan_idle',{
   p_user_id:USER,p_agent_id:'star',p_idle_minutes:5
 }]])
})
test('fail closed on malformed identity, DB error and invalid RPC result',async()=>{
 const db={rpc:async()=>({data:{status:'OK'}})}
 await assert.rejects(scanIdle({supabase:db,userId:'invalid'}),/IDENTITY/)
 await assert.rejects(scanIdle({supabase:db,userId:USER}),/PHASE4B_RPC_ERROR/)
 await assert.rejects(scanIdle({supabase:{rpc:async()=>({error:{message:'private'}})},userId:USER}),/PHASE4B_RPC_ERROR/)
})
test('guard accepts only allow/skip/stale response',async()=>{
 let req
 const db={rpc:async(name,args)=>{req=[name,args];return {data:{status:'allowed'}}}}
 assert.equal((await guardClaim({supabase:db,eventId:ID,leaseToken:TOKEN})).status,'allowed')
 assert.equal(req[0],'cognition_phase4b_guard_claim')
 assert.equal(req[1].p_idle_minutes,60)
})
test('Phase4B claimed event with resumed chat never calls Cognition model',async()=>{
 let ticks=0,settled=0
 const q={claimCognitionEvent:async()=>CLAIM,
   settleCognitionEvent:async()=>{settled++;return {status:'done'}}}
 const db={rpc:async(name)=>{
    assert.equal(name,'cognition_phase4b_guard_claim');return {data:{status:'skipped'}}
 }}
 const r=await dispatchOneCognitionEvent({supabase:db,userId:USER,eventQueue:q,
    runTick:async()=>{ticks++;return {executed:true,outcome:'complete',stateUpdated:true}}})
 assert.equal(r.status,'superseded')
 assert.equal(r.executed,false)
 assert.equal(ticks,0)
 assert.equal(settled,0) // guard RPC settles in one transaction
})
test('Phase4B allowed event uses existing Cognition path exactly once',async()=>{
 let ticks=0,settled=[]
 const q={claimCognitionEvent:async()=>CLAIM,
   settleCognitionEvent:async x=>{settled.push(x.result);return {status:'done'}}}
 const db={rpc:async()=>({data:{status:'allowed'}})}
 const r=await dispatchOneCognitionEvent({supabase:db,userId:USER,eventQueue:q,
   runTick:async input=>{
      ticks++;assert.equal(input.triggerType,'chat_finished')
      assert.equal(input.triggerKey,`${ID}:1`)
      return {executed:true,outcome:'complete',stateUpdated:true}
   }})
 assert.equal(r.status,'done')
 assert.equal(ticks,1)
 assert.deepEqual(settled,['done'])
})
test('guard RPC failure never runs Cognition or retries silently',async()=>{
 let ticks=0,settled=[]
 const q={claimCognitionEvent:async()=>CLAIM,
  settleCognitionEvent:async x=>{settled.push(x.result);return {status:'uncertain'}}}
 const r=await dispatchOneCognitionEvent({
    supabase:{rpc:async()=>({error:{message:'fail'}})},userId:USER,eventQueue:q,
    runTick:async()=>{ticks++}})
 assert.equal(r.status,'uncertain')
 assert.equal(r.executed,false)
 assert.equal(ticks,0)
 assert.deepEqual(settled,['uncertain'])
})
test('Phase4A other chat_finished events retain unchanged behavior',async()=>{
 let ticks=0
 const claim={...CLAIM,event_key:'non-phase4b-key'}
 const q={claimCognitionEvent:async()=>claim,
   settleCognitionEvent:async()=>({status:'done'})}
 const result=await dispatchOneCognitionEvent({supabase:{},userId:USER,eventQueue:q,
    runTick:async()=>{ticks++;return {executed:true,outcome:'complete',stateUpdated:true}}})
 assert.equal(result.status,'done')
 assert.equal(ticks,1)
})
test('migration references actual chat/call data, locks, idempotency and RLS',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../sql/cognition_phase4b_idle.sql'),'utf8')
 for (const needle of [
  "public.messages",'public.call_sessions',"agent_key='xingxing'",
  'ended_at IS NULL','visible IS DISTINCT FROM false',
  'FOR UPDATE','ON CONFLICT(user_id,agent_id,event_key) DO NOTHING',
  "'superseded_by_activity'",'p_idle_minutes','ENABLE ROW LEVEL SECURITY',
  'TO service_role', 'event_key', 'CREATE OR REPLACE FUNCTION public.cognition_phase4_claim_event'
 ]) assert(sql.includes(needle),needle)
})
