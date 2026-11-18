'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const {
    EVENT_TYPES,validateEventInput,enqueueCognitionEvent,
    claimCognitionEvent,settleCognitionEvent,
    classifyCognitionEventResult,dispatchOneCognitionEvent,
}=require('../services/cognition/cognitionEventQueue')
const { evaluateWakeGate, HEARTBEAT_ACTIVITY_KEY }=require('../services/cognition/wakeGate')
const { getCognitionCooldownMinutes }=require('../services/cognition/cooldownPolicy')
const USER='11111111-1111-4111-8111-111111111111'
const UUID='22222222-2222-4222-8222-222222222222'
const TOKEN='33333333-3333-4333-8333-333333333333'
const NOW=new Date('2026-11-18T11:00:00.000Z')

function fakeRpc(handler){
 const calls=[]
 return {
  calls,
  rpc:async(name,args)=>{
   calls.push([name,args])
   return {data:await handler(name,args),error:null}
  }
 }
}
function activeState(){
 return {
   version:3,metadata:{
      cognition_heartbeat_activity_at:'2026-11-18T09:00:00.000Z'
   },
   last_user_message_at:'2026-11-18T10:00:00.000Z',
   absence_started_at:null,absence_checkpoint:0,
   last_wake_at:'2026-11-18T09:00:00.000Z',
   last_cognition_at:'2026-11-18T09:00:00.000Z',
   next_review_at:'2026-11-18T10:00:00.000Z',
 }
}
function claimed(n=1){
 return {status:'claimed',id:UUID,event_type:'chat_finished',
  attempts:n,lease_token:TOKEN}
}

test('known event types, strict identity, stable short key',()=>{
 assert.deepEqual(EVENT_TYPES,['chat_finished','milestone_transition','external_event'])
 assert.doesNotThrow(()=>validateEventInput({
  userId:USER,agentId:'star',eventType:'chat_finished',eventKey:'session-1:finished:1'
 }))
 for(const eventType of ['manual','heartbeat','raw_prompt'])
   assert.throws(()=>validateEventInput({userId:USER,agentId:'star',eventType,eventKey:'k'}))
 assert.throws(()=>validateEventInput({userId:USER,agentId:'guai',
  eventType:'chat_finished',eventKey:'k'}))
 assert.throws(()=>validateEventInput({userId:USER,agentId:'star',
  eventType:'chat_finished',eventKey:' '.repeat(2)}))
})
test('enqueue uses only RPC and never sends body content',async()=>{
 const db=fakeRpc(()=>({status:'pending',id:UUID}))
 const value=await enqueueCognitionEvent({
   supabase:db,userId:USER,agentId:'star',eventType:'external_event',eventKey:'manual-smoke:1'
 })
 assert.equal(value.status,'pending')
 assert.deepEqual(db.calls[0],[ 'cognition_phase4_enqueue_event',
   {p_user_id:USER,p_agent_id:'star',p_event_type:'external_event',p_event_key:'manual-smoke:1'}])
})
test('claim/settle contracts reject malformed output',async()=>{
 const db=fakeRpc((name)=>name.includes('claim')?claimed():{status:'done'})
 assert.equal((await claimCognitionEvent({supabase:db,userId:USER})).status,'claimed')
 assert.equal((await settleCognitionEvent({
  supabase:db,eventId:UUID,leaseToken:TOKEN,result:'done'
 })).status,'done')
 await assert.rejects(settleCognitionEvent({
  supabase:db,eventId:UUID,leaseToken:TOKEN,result:'retry'
 }),/INVALID_SETTLE_INPUT/)
})
test('success is done only when full state update succeeded',()=>{
 assert.equal(classifyCognitionEventResult({
  executed:true,outcome:'complete',stateUpdated:true
 }), 'done')
 for(const r of [
  {executed:true,outcome:'partial',stateUpdated:false},
  {executed:true,outcome:'complete',stateUpdated:false},
  {executed:false,reason:'mystery'},
 ]) assert.equal(classifyCognitionEventResult(r),'uncertain')
})
test('review partial and ordinary Wake Gate skips are safely deferred',()=>{
 for(const reason of ['context_review_partial','cooldown','wake_gate_skipped','no_user_messages']){
  assert.equal(classifyCognitionEventResult({executed:false,reason}),'defer')
 }
})
test('dispatcher sends actual event reason and an attempt-specific key',async()=>{
 const seen=[]
 const q={
  claimCognitionEvent:async()=>claimed(2),
  settleCognitionEvent:async(x)=>{seen.push(x);return {status:'done'}}
 }
 let called=0
 const result=await dispatchOneCognitionEvent({
  supabase:{},userId:USER,agentId:'star',
  eventQueue:q,runTick:async args=>{
    called++
    assert.equal(args.triggerType,'chat_finished')
    assert.equal(args.triggerKey,`${UUID}:2`)
    assert.equal(args.userId,USER)
    return {executed:true,outcome:'complete',stateUpdated:true}
  }
 })
 assert.equal(result.status,'done')
 assert.equal(called,1)
 assert.equal(seen[0].result,'done')
})
test('partial context review never marks queue event as done',async()=>{
 let settleInput
 const q={claimCognitionEvent:async()=>claimed(),
  settleCognitionEvent:async x=>{settleInput=x;return {status:'pending'}}}
 const result=await dispatchOneCognitionEvent({
  supabase:{},userId:USER,runTick:async()=>({
    executed:false,reason:'context_review_partial'
  }),eventQueue:q
 })
 assert.equal(result.status,'deferred')
 assert.equal(settleInput.result,'defer')
})
test('model exception goes uncertain and never silently replays',async()=>{
 let count=0, resultCode=null
 const q={claimCognitionEvent:async()=>claimed(),
  settleCognitionEvent:async x=>{resultCode=x.result;return {status:'uncertain'}}}
 const result=await dispatchOneCognitionEvent({
   supabase:{},userId:USER,eventQueue:q,
   runTick:async()=>{count++;throw Error('private model error')}
 })
 assert.equal(result.status,'uncertain')
 assert.equal(count,1)
 assert.equal(resultCode,'uncertain')
})
test('clock cooldown and empty queue do not run cognition',async()=>{
 for(const status of ['cooldown','empty']){
  const q={claimCognitionEvent:async()=>({status}),
   settleCognitionEvent:async()=>{throw Error('should not settle')}}
  let called=0
  const result=await dispatchOneCognitionEvent({
   supabase:{},userId:USER,eventQueue:q,
   runTick:async()=>{called++}
  })
  assert.equal(result.status,status)
  assert.equal(called,0)
 }
})
test('event Wake Gate does not advance six-hour heartbeat clock',()=>{
 const s=activeState()
 const result=evaluateWakeGate({
  state:s,now:NOW,triggerType:'chat_finished',
  triggerKey:'queued-event:1',cooldownMinutes:0
 })
 assert.equal(result.shouldWake,true)
 assert(result.reasons.includes('chat_finished'))
 assert(!result.reasons.includes('pending_review'))
 assert.equal(result.patch.last_wake_at,undefined)
 assert.equal(result.patch.next_review_at,undefined)
 assert.equal(result.patch.metadata[HEARTBEAT_ACTIVITY_KEY],
    s.metadata[HEARTBEAT_ACTIVITY_KEY])
})
test('manual and heartbeat cooldowns remain unchanged',()=>{
 assert.equal(getCognitionCooldownMinutes('heartbeat'),60)
 assert.equal(getCognitionCooldownMinutes('manual',{}),60)
 assert.equal(getCognitionCooldownMinutes('external_event'),0)
})
test('migration protects service-role only and uncertain leases',()=>{
 const sql=fs.readFileSync(path.resolve(__dirname,
   '../sql/cognition_phase4a_event_queue.sql'),'utf8')
 assert.match(sql,/UNIQUE \(user_id,agent_id,event_key\)/)
 assert.match(sql,/FOR UPDATE SKIP LOCKED/)
 assert.match(sql,/lease_expired/)
 assert.match(sql,/REVOKE ALL ON FUNCTION/)
 assert.match(sql,/TO service_role/)
 assert.match(sql,/ENABLE ROW LEVEL SECURITY/)
 assert.match(sql,/interval '60 minutes'/)
 assert.match(sql,/status='uncertain'/)
})
