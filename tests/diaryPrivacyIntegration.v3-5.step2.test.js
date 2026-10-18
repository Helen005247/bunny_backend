'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function loadTickService({ tickResult, privacyResult } = {}) {
  const code=fs.readFileSync(path.resolve(__dirname,'../services/diary/diaryService.js'),'utf8')
  const calls={tick:0,privacy:0,annotation:0}
  const day = {
    runAutonomousDailyTick: async ()=>{calls.tick++; return tickResult},
    CATCHUP_DAYS:14,MAX_DAILY_JOBS_PER_TICK:1,
  }
  const modules={
    'crypto': crypto,
    './diaryWindows':{ getWindow:()=>({}),validTimeZone:(zone)=>zone||null },
    './diaryReader':{ readDiaryMessages:async()=>[] },
    './diaryWriter':{ reviewAndWriteDiary:async()=>({}) },
    './diaryAutonomyService':day,
    './diaryPrivacy':{ reviewStarDiaryPrivacy:async()=>{calls.privacy++; if(privacyResult instanceof Error)throw privacyResult; return privacyResult} },
    './diaryAnnotationsAutonomy':{reviewStarDiaryAnnotations:async()=>{calls.annotation++}},
  }
  const entry={exports:{}}
  new Function('module','exports','require',code)(entry,entry.exports,(name)=>{
    if(!(name in modules))throw Error('Unexpected require '+name)
    return modules[name]
  })
  return { runDiaryTick:entry.exports.runDiaryTick, calls }
}
const COMMON={
  supabase:{ from(){throw Error('not needed')} },
  userId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',agentId:'star',
  triggerType:'daily',getSettings:async()=>({timezone:'Asia/Shanghai'}),
  callModel:async()=>({output_text:'{"action":"keep","diary_id":null}'})
}

test('daily success triggers exactly one separate Star privacy review',async()=>{
  const svc=loadTickService({tickResult:{status:'completed',processed:1,written:2},privacyResult:{status:'reviewed'}})
  const result=await svc.runDiaryTick(COMMON)
  assert.deepEqual(result,{status:'completed',processed:1,written:2})
  assert.deepEqual(svc.calls,{tick:1,privacy:1,annotation:1})
})
test('partial, busy and failed diary jobs never run privacy review',async()=>{
  for(const status of ['partial','failed']){
    const svc=loadTickService({tickResult:{status,processed:0}})
    const result=await svc.runDiaryTick(COMMON)
    assert.equal(result.status,status)
    assert.deepEqual(svc.calls,{tick:1,privacy:0,annotation:0})
  }
})
test('private review errors never falsely change the outcome of existing diary commits',async()=>{
  const warn=console.warn
  console.warn=()=>{}
  try {
    const svc=loadTickService({tickResult:{status:'completed',processed:1,written:1},privacyResult:new Error('private data!')})
    const result=await svc.runDiaryTick(COMMON)
    assert.deepEqual(result,{status:'completed',processed:1,written:1})
    assert.deepEqual(svc.calls,{tick:1,privacy:1,annotation:1})
  } finally { console.warn=warn }
})
