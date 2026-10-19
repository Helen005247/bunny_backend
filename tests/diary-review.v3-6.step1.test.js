'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const {continueDailyDiary,dailyModeOnly,progressOfPartial,
    dispatchAndPoll,assertConfig,DAILY_AUTO_LIMITS}=require('../scripts/diary-review')

const noSleep=async()=>{}
const quiet=()=>{}
function partial(reviewDone,reviewTotal=30,rollupDone=0,rollupTotal=0,modelCalls=6){
    return {status:'partial',ok:true,reviewDone,reviewTotal,rollupDone,rollupTotal,modelCalls,code:'review_partial'}
}
function options(dispatch, overrides={}) {
    return {dispatch,dispatchOptions:{endpoint:'https://example.com/internal/diary/tick',
        userId:'123e4567-e89b-42d3-a456-426614174000',secret:'long-enough-test-secret-xxxxxxxx',
        acceptanceMode:'off'},sleep:noSleep,log:quiet,...overrides}
}

test('one scheduled wake-up resumes review, rollup and selection; stops after completion',async()=>{
    const seq=[partial(6),partial(12),partial(18),partial(24),partial(30,30,0,4),
        partial(30,30,4,4,4),{status:'completed',ok:true,processed:1,written:2,revised:0,skipped:0}]
    let count=0
    const last=await continueDailyDiary(options(async ({maxPollMs})=>{
        assert(maxPollMs>0&&maxPollMs<=7*60*1000)
        return seq[count++]
    }))
    assert.equal(last.written,2)
    assert.equal(count,7)
})

test('a finished job with zero writes is not dispatched again',async()=>{
    let calls=0
    const last=await continueDailyDiary(options(async()=>{calls++;return {status:'completed',ok:true,processed:1,written:0,skipped:1}}))
    assert.equal(last.skipped,1)
    assert.equal(calls,1)
})

test('busy/cooldown 0/0 partial fails without rapid redispatch',async()=>{
    let calls=0
    await assert.rejects(continueDailyDiary(options(async()=>{calls++;return partial(0,0,0,0,0)})),/busy or retry cooldown/)
    assert.equal(calls,1)
})

test('identical progress with calls is allowed once, then fails without infinite retry',async()=>{
    let count=0
    await assert.rejects(continueDailyDiary(options(async()=>{count++;return partial(30,30,4,4)})),/no progress/)
    assert.equal(count,3)
})

test('missing or invalid progress causes fail-closed',async()=>{
    let count=0
    await assert.rejects(continueDailyDiary(options(async()=>{count++;return {status:'partial',ok:true}})),/invalid partial progress/)
    assert.equal(count,1)
    assert.equal(progressOfPartial(partial(31,30)),null)
})

test('unexpected per-round model calls are not silently allowed',async()=>{
    await assert.rejects(continueDailyDiary(options(async()=>partial(6,30,0,0,7))),/unexpected model-call budget/)
})

test('global model-call budget applies before starting the next pass',async()=>{
    let count=0
    await assert.rejects(continueDailyDiary(options(async()=>partial(++count*6,30,0,0),{limits:{...DAILY_AUTO_LIMITS,maxTotalModelCalls:12}})),/model-call budget/, 'must not start next expensive pass')
    assert.equal(count,2)
})

test('round budget marks persistent partial as incomplete even if advancing',async()=>{
    let count=0
    await assert.rejects(continueDailyDiary(options(async()=>partial(++count,30,0,0),{limits:{...DAILY_AUTO_LIMITS,maxRounds:3}})),/round budget/)
    assert.equal(count,3)
})

test('elapsed-time budget stops before another server request',async()=>{
    let count=0,clock=0
    const cfg=options(async()=>{count++;clock+=70000;return partial(count,30)}, {
        nowMs:()=>clock,
        limits:{...DAILY_AUTO_LIMITS,maxElapsedMs:130000,minimumRemainingMs:80000},
    })
    await assert.rejects(continueDailyDiary(cfg),/time budget/)
    assert.equal(count,1)
})

test('a failed backend pass is not retried by the dispatcher',async()=>{
    let calls=0
    await assert.rejects(continueDailyDiary(options(async()=>{calls++;throw new Error('Diary backend failed')})),/Diary backend failed/)
    assert.equal(calls,1)
})

test('only ordinary daily runs auto-resume; manual acceptance and backfill remain single-shot',()=>{
    assert(dailyModeOnly({acceptanceMode:'off',startDate:'',endDate:''}))
    assert(!dailyModeOnly({acceptanceMode:'off',startDate:'2026-10-01',endDate:'2026-10-02'}))
    for(const mode of ['preview','commit','verify','probe','live'])
        assert(!dailyModeOnly({acceptanceMode:mode}))
    assert(!dailyModeOnly({acceptanceMode:'off',topicHint:'a topic'}))
    assert(!dailyModeOnly({acceptanceMode:'off',planId:'x'}))
})

test('original input validation and HTTPS endpoint guard remain active',()=>{
    const base={endpoint:'https://example.org/internal/diary/tick',
        userId:'123e4567-e89b-42d3-a456-426614174000',
        secret:'test-secret-very-long-value-xxxxxxx'}
    assert.equal(assertConfig(base),'https://example.org/internal/diary/tick')
    assert.throws(()=>assertConfig({...base,endpoint:'http://example.org/internal/diary/tick'}),/HTTPS/)
})

test('a resumed dispatch sends a new daily tick, but never logs diary content',async()=>{
    const requests=[]
    const runId='123e4567-e89b-42d3-a456-426614174001'
    const fetchImpl=async(url,opts)=>{
        requests.push({url,opts})
        if(opts.method==='POST')return {status:202,json:async()=>({ok:true,runId})}
        return {ok:true,json:async()=>({ok:true,status:'partial',...partial(6)})}
    }
    const result=await dispatchAndPoll({...options(()=>{}).dispatchOptions,fetchImpl,sleep:noSleep,maxPollMs:60000})
    assert.equal(result.status,'partial')
    assert.equal(requests.length,2)
    const body=JSON.parse(requests[0].opts.body)
    assert.equal(body.triggerType,'daily')
    assert.equal(body.agentId,'star')
    assert(!('startDate' in body))
    assert.equal(requests[1].opts.method,'GET')
    assert(!JSON.stringify(requests).includes('日记正文'))
})


test('an unknown success-looking terminal status must not be treated as finished',async()=>{
    await assert.rejects(continueDailyDiary(options(async()=>({status:'previewed',ok:true}))),/unexpected daily terminal/)
})

test('a final status without ok=true must not be treated as success',async()=>{
    await assert.rejects(continueDailyDiary(options(async()=>({status:'completed',ok:false}))),/unexpected daily terminal/)
})

test('partial multi-dispatch integration calls daily endpoint again with same scope',async()=>{
    let tick=0
    const runIds=[
        '123e4567-e89b-42d3-a456-426614174010',
        '123e4567-e89b-42d3-a456-426614174011',
        '123e4567-e89b-42d3-a456-426614174012',
    ]
    const outcomes=[partial(6),partial(12),{status:'completed',ok:true,processed:1,written:1}]
    let polls=0
    const fetchImpl=async(url,options)=>{
        if(options.method==='POST')return {status:202,json:async()=>({ok:true,runId:runIds[tick++]})}
        const i=runIds.findIndex(id=>url.endsWith(id))
        assert(i>=0)
        polls++
        return {ok:true,json:async()=>({ok:true,...outcomes[i]})}
    }
    const dispatched=async (opts)=>dispatchAndPoll({...opts,fetchImpl,sleep:noSleep})
    const result=await continueDailyDiary(options(dispatched))
    assert.equal(result.written,1)
    assert.equal(tick,3)
    assert.equal(polls,3)
})
