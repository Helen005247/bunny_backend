'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {assembleEvidence}=require('../services/diary/diarySearch')
const {buildReviewChunks}=require('../services/diary/diaryWriter')
const {planAutonomousDiary,newReviewBudget,reviewHash,rollupHash}=require('../services/diary/diaryAutonomyWriter')
const settings={timezone:'UTC',system_prompt:'Star',character_context:'journal keeper'}
const window={periodStart:'2026-10-14T00:00:00Z',periodEnd:'2026-10-16T00:00:00Z',timeZone:'UTC',topicHint:''}
function sourceText(n=1,big=false){
 const rows=Array.from({length:n},(_,i)=>({id:'m'+(i+1),sessionId:'session-1',role:'user',channel:'text',
  createdAt:'2026-10-14T15:00:00Z',content:big?'an old memory '.repeat(260):'a real memory from the conversation'}))
 return assembleEvidence(rows,[])
}
function model(fn){
 const calls=[]
 const callModel=async({input})=>{calls.push(input)
  let answer
  if(input.includes('日记回顾助手'))answer={observations:['one source backed observation']}
  else if(input.includes('归纳助手'))answer={observations:['one summary']}
  else if(input.includes('日记选题助手'))answer=fn.search(calls.filter(c=>c.includes('日记选题助手')).length,input)
  else if(input.includes('你是星星，准备写自己的私人日记'))answer=fn.write(calls.filter(c=>c.includes('你是星星，准备写自己的私人日记')).length,input)
  else throw new Error('unexpected prompt')
  return {output_text:JSON.stringify(answer)}
 }
 return {calls,callModel}
}
function inputs({source=sourceText(),callModel,budget=null,cachedChunks=[],cachedRollups=[]}){
 return {source,window,settings,supabase:{},userId:'user-one',agentId:'star',
  callModel,budget,cachedChunks,cachedRollups}
}
const legitimate={kind:'create',topic_id:null,anchor_id:'m36',topic_label:'A moment',
 title:'A small moment',body:'I remember a small thing that was said in the conversation and it seems worth keeping.',
 topics:['memory'],evidence_ids:['m36']}
function cachedOldPages(){
 // This simulates a multi-run preview where review and rollup both finished.
 const source=sourceText(36,true)
 const chunks=buildReviewChunks(source.rows,{maxChunkChars:5000,maxChunks:320})
 const cachedChunks=chunks.map((c,i)=>({chunk_index:i+1,chunk_hash:reviewHash(c),observations:['a grounded detail']}))
 const groups=[]
 const summaries=cachedChunks.map(c=>({chunk:c.chunk_index,hash:c.chunk_hash,observations:c.observations}))
 for(let i=0;i<summaries.length;i+=8)groups.push(summaries.slice(i,i+8))
 const cachedRollups=groups.map((g,i)=>({group_index:i+1,group_hash:rollupHash(g),observations:['a compressed map']}))
 return {source,cachedChunks,cachedRollups,chunks:chunks.length,groups:groups.length}
}

test('search plan invalid JSON schema gets one bounded correction (not a fake skip)',async()=>{
 const ai=model({search:n=>n===1?{queries:['a','b','c','d']}:{queries:[]},write:()=>({actions:[]})})
 const plan=await planAutonomousDiary(inputs({callModel:ai.callModel}))
 assert.equal(plan.partial,undefined)
 assert.deepEqual(plan.actions,[])
 assert.equal(plan.modelCalls,0)
 assert.equal(ai.calls.filter(s=>s.includes('日记选题助手')).length,2)
 assert.equal(ai.calls.filter(s=>s.includes('你是星星，准备写自己的私人日记')).length,1)
})

test('36 cached pages / 5 rollup groups remain reusable while invalid final plan is regenerated',async()=>{
 const state=cachedOldPages()
 assert.equal(state.chunks,36)
 assert.equal(state.groups,5)
 const ai=model({search:()=>({queries:[]}),write:n=>({actions:[n===1?
  {...legitimate,anchor_id:'made-up-id'}:legitimate]})})
 const plan=await planAutonomousDiary(inputs({...state,callModel:ai.callModel,
  budget:newReviewBudget({maxModelCalls:6})}))
 assert.equal(plan.cacheHits,36)
 assert.equal(plan.rollupDone,5)
 assert.equal(plan.reviewDone,36)
 assert.equal(plan.modelCalls,3)
 assert.equal(plan.actions.length,1)
 assert.equal(plan.actions[0].anchor_id,'m36')
 assert.equal(ai.calls.filter(s=>s.includes('日记回顾助手')).length,0)
 assert.equal(ai.calls.filter(s=>s.includes('归纳助手')).length,0)
 assert.ok(ai.calls.at(-1).includes('VALIDATION RETRY'))
})

test('if a correction would exceed budget, return honest partial with no actions',async()=>{
 const state=cachedOldPages()
 const ai=model({search:()=>({queries:[]}),write:()=>({actions:[{...legitimate,anchor_id:'imagined'}]})})
 const plan=await planAutonomousDiary(inputs({...state,callModel:ai.callModel,
  budget:newReviewBudget({maxModelCalls:2})}))
 assert.equal(plan.partial,true)
 assert.equal(plan.phase,'selection')
 assert.equal(plan.modelCalls,2)
 assert.equal(ai.calls.length,2)
 assert.equal(plan.actions,undefined)
})

test('two invalid plans still fail explicitly; no silent acceptance of invented evidence',async()=>{
 const ai=model({search:()=>({queries:[]}),write:()=>({actions:[{...legitimate,evidence_ids:['not-in-chat']}]})})
 await assert.rejects(planAutonomousDiary(inputs({callModel:ai.callModel})),
  {code:'diary_evidence_out_of_scope'})
 assert.equal(ai.calls.filter(s=>s.includes('你是星星，准备写自己的私人日记')).length,2)
})

test('repeated invalid search plans still fail explicitly',async()=>{
 const ai=model({search:()=>({queries:['a','b','c','d']}),write:()=>({actions:[]})})
 await assert.rejects(planAutonomousDiary(inputs({callModel:ai.callModel})),{code:'invalid_diary_plan'})
 assert.equal(ai.calls.filter(s=>s.includes('日记选题助手')).length,2)
 assert.equal(ai.calls.filter(s=>s.includes('你是星星，准备写自己的私人日记')).length,0)
})
