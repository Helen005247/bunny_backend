'use strict'
// This test uses only synthetic values and never connects to the live backend.
const test=require('node:test')
const assert=require('node:assert/strict')
const {assertConfig, dispatchAndPoll}=require('../scripts/diary-review')
const base={
  endpoint:'https://example.invalid/internal/diary/tick',
  userId:'11111111-1111-4111-8111-111111111111',
  secret:'s'.repeat(32),
  acceptanceMode:'commit',startDate:'',endDate:'',topicHint:'',
  planId:'22222222-2222-4222-8222-222222222222',
  planDigest:'a'.repeat(64),confirmWrite:'WRITE',
}
function config(overrides={}){return {...base,...overrides}}
function rejection(name, overrides, expected) {
  test(name,()=>assert.throws(()=>assertConfig(config(overrides)),err=>{
    assert.match(err.message,expected)
    assert.doesNotMatch(err.message,/a{16}|s{16}|22222222-2222/)
    return true
  }))
}
test('correct GitHub commit input passes offline checks',()=>{
  assert.equal(assertConfig(config()),base.endpoint)
})
test('whitespace fields are normalized for commit checks',()=>{
  assert.equal(assertConfig(config({startDate:' \t ',endDate:'\n',topicHint:'\r\n',confirmWrite:' WRITE ',planId:`  ${base.planId} \n`,planDigest:` ${base.planDigest.toUpperCase()} `})),base.endpoint)
})
rejection('non-empty start date named precisely',{startDate:'2026-10-14'},/start_date_not_empty/)
rejection('non-empty end date named precisely',{endDate:'2026-10-15'},/end_date_not_empty/)
rejection('non-empty topic named precisely',{topicHint:'birthday'},/topic_hint_not_empty/)
rejection('empty UUID named precisely',{planId:''},/plan_id_invalid/)
rejection('malformed UUID named precisely',{planId:'not-a-uuid'},/plan_id_invalid/)
rejection('short fingerprint exposes length only',{planDigest:'a'.repeat(63)},/plan_digest_invalid\(length=63\)/)
rejection('too long fingerprint exposes length only',{planDigest:'a'.repeat(65)},/plan_digest_invalid\(length=65\)/)
rejection('fingerprint invalid alphabet named precisely',{planDigest:'z'.repeat(64)},/plan_digest_invalid\(length=64\)/)
rejection('invalid confirmation named precisely',{confirmWrite:'write'},/confirm_write_not_WRITE/)
rejection('multiple invalid fields give separate names',{planId:'',planDigest:'a',topicHint:'bad'},/topic_hint_not_empty.*plan_id_invalid.*plan_digest_invalid/)
test('off/scheduled mode retains original behavior',()=>{
  assert.equal(assertConfig({...base,acceptanceMode:'off',planId:'',planDigest:'',confirmWrite:''}),base.endpoint)
})
rejection('reject confirmation arguments outside commit',{acceptanceMode:'preview',startDate:'2026-10-14',endDate:'2026-10-15'},/Invalid plan confirmation fields/)
test('commit body uses same normalized values as validation',async()=>{
  let requests=[]
  const result=await dispatchAndPoll({...config({
    startDate:' ',endDate:'\t',topicHint:' ',
    planId:` ${base.planId} `,planDigest:` ${base.planDigest.toUpperCase()} `,
    confirmWrite:' WRITE '
  }),
  fetchImpl:async(url, init)=>{
    requests.push({url,init})
    if(init.method==='POST')return {status:202,json:async()=>({ok:true,runId:'33333333-3333-4333-8333-333333333333'})}
    return {ok:true,json:async()=>({ok:true,status:'committed',mode:'acceptance_commit'})}
  },sleep:async()=>{},maxPollMs:4000})
  assert.equal(result.status,'committed')
  assert.equal(requests.length,2)
  const body=JSON.parse(requests[0].init.body)
  assert.equal(body.triggerType,'acceptance_commit')
  assert.equal(body.planId,base.planId)
  assert.equal(body.planDigest,base.planDigest)
  assert.equal(body.confirmWrite,true)
  assert.equal('startDate' in body,false)
  assert.equal('endDate' in body,false)
  assert.equal('topicHint' in body,false)
})
