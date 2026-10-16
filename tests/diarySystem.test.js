'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { getWindow, localDayStart, localDateAt, addDays } = require('../services/diary/diaryWindows')
const { readDiaryMessages } = require('../services/diary/diaryReader')
const { buildReviewChunks, reviewAndWriteDiary } = require('../services/diary/diaryWriter')
const { runDiaryTick } = require('../services/diary/diaryService')
const { buildDiaryChatContext } = require('../services/diary/diaryRecall')
const { dispatchAndPoll, safeLog, assertConfig } = require('../scripts/diary-review')
// The uploaded baseline is a partial back-end source package with no working
// Express installation. Exercise real route handlers with an in-memory router,
// without claiming that the full production server has been booted here.
const Module = require('node:module')
const normalLoad = Module._load
Module._load = function (name, ...args) {
    if (name === 'express') return { Router: () => ({
        routes: { get: new Map(), post: new Map() },
        get(path,handler) { this.routes.get.set(path,handler) },
        post(path,handler) { this.routes.post.set(path,handler) },
    }) }
    return normalLoad.call(this,name,...args)
}
let createInternalDiaryRouter, createUserDiaryRouter
try {
    ({ createInternalDiaryRouter, createUserDiaryRouter } = require('../routes/diary'))
} finally { Module._load = normalLoad }
function fakeResponse() {
    return { statusCode:200, headers:{}, body:null,
        status(code){this.statusCode=code;return this},
        json(body){this.body=body;return this},
        set(key,value){this.headers[key]=value;return this} }
}
function fakeRequest({ headers={},body={},params={},query={},userId }={}) {
    return { body,params,query,userId,get:(key)=>headers[key] }
}

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const HERM = '33333333-3333-4333-8333-333333333333'
const SECRET = 'non-production-secret-for-unit-tests-01234567'
const NOW = new Date('2026-10-17T09:00:00Z')
const getSettings = async () => ({ timezone: 'America/Denver',
    system_prompt: '星星', character_context: '星星很在意与你的约定' })

function row(i, props = {}) {
    return { id: i, session_id: i % 2 ? 9 : 10,
        user_id: USER, role: i % 2 ? 'user' : 'assistant',
        content: `聊天事件-${i}，一起过生日，约定认真记住这一天。`,
        channel: 'text', call_session_id: null, visible: true,
        reasoning_content: null,
        created_at: new Date(Date.parse('2026-10-16T08:00:00Z') + i * 3000).toISOString(),
        ...props }
}

class Query {
    constructor(store, table) {
        this.store = store
        this.table = table
        this.filters = []
        this.sorts = []
        this.limitN = Infinity
        this.rangeN = null
    }
    select(fields = '*') { this.fields=fields; return this }
    eq(key, value) { this.filters.push((v) => String(v[key]) === String(value)); return this }
    gte(key, value) { this.filters.push((v) => String(v[key]) >= String(value)); return this }
    lte(key, value) { this.filters.push((v) => String(v[key]) <= String(value)); return this }
    lt(key, value) { this.filters.push((v) => String(v[key]) < String(value)); return this }
    gt(key, value) { this.filters.push((v) => String(v[key]) > String(value)); return this }
    in(key, values) { this.filters.push((v) => values.map(String).includes(String(v[key]))); return this }
    contains(key, values) {
        this.filters.push((v) => values.every((item) =>
            Array.isArray(v[key]) && v[key].includes(item)))
        return this
    }
    ilike(key, pattern) {
        const term = pattern.replaceAll('%','').toLowerCase()
        this.filters.push((v) => String(v[key] || '').toLowerCase().includes(term));return this
    }
    order(key, { ascending = true } = {}) {
        this.sorts.push([key, ascending]); return this
    }
    limit(n) { this.limitN = n; return this }
    range(from, to) { this.rangeN = [from, to]; return this }
    then(resolve, reject) { return Promise.resolve(this.finish(false)).then(resolve, reject) }
    maybeSingle() { return Promise.resolve(this.finish(true)) }
    finish(single) {
        if (this.store.errorTable === this.table) return { data:null,error:{message:'denied'} }
        let values = (this.store.tables[this.table] || []).filter(v => this.filters.every(f => f(v)))
        for (let i = this.sorts.length - 1; i >= 0; i -= 1) {
            const [key, asc] = this.sorts[i]
            values = values.toSorted((a,b) => {
                // id is numeric for message tests, UUID lexical otherwise.
                let d = typeof a[key] === 'number' && typeof b[key] === 'number'
                    ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]))
                return asc ? d : -d
            })
        }
        if (this.rangeN) values = values.slice(this.rangeN[0], this.rangeN[1] + 1)
        values = values.slice(0, this.limitN)
        if (typeof this.fields === 'string' && this.fields.trim() !== '*') {
            const allowed = this.fields.split(',').map(k=>k.trim())
            values = values.map(row => Object.fromEntries(allowed
                .filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]])))
        }
        return { data: single ? values[0] || null : values, error: null }
    }
}

function makeDb(messages = [], callSessions = []) {
    const db = {
        tables: { messages, call_sessions: callSessions, agent_diary: [], diary_review_jobs: [] },
        calls: [], errorTable: null,
        from(table) { return new Query(this,table) },
        async rpc(name, args) {
            this.calls.push(name)
            const jobs = this.tables.diary_review_jobs
            if (name === 'diary_claim_review_job') {
                const found = jobs.find((j) => j.user_id === args.p_user_id &&
                    j.agent_id === args.p_agent_id && j.scope_key === args.p_scope_key)
                if (found && found.status !== 'pending' && found.status !== 'failed') {
                    return { data: { claimed: false, status: found.status }, error: null }
                }
                const job = found || { id: crypto.randomUUID(), user_id: args.p_user_id,
                    agent_id: args.p_agent_id, scope_key: args.p_scope_key,
                    period_start: args.p_period_start, period_end: args.p_period_end,
                    timezone: args.p_timezone, status: 'pending' }
                if (!found) jobs.push(job)
                job.status = 'processing'
                job.lease = crypto.randomUUID()
                return {data: {claimed:true,jobId:job.id,leaseToken:job.lease},error:null}
            }
            const job = jobs.find((j) => j.id === args.p_job_id &&
                j.user_id === args.p_user_id && j.agent_id === args.p_agent_id &&
                j.lease === args.p_lease_token && j.status === 'processing')
            if (name === 'diary_renew_review_job') return { data: Boolean(job), error:null }
            if (name === 'diary_fail_review_job') {
                if (job) job.status='failed'
                return { data:Boolean(job), error:null }
            }
            if (name === 'diary_finish_review_job') {
                if (!job) return {data:null,error:{message:'diary_lease_lost'}}
                if (args.p_action === 'written') {
                    this.tables.agent_diary.push({ id:crypto.randomUUID(), user_id:job.user_id,
                        agent_id:job.agent_id, title:args.p_title, body:args.p_body,
                        topics:args.p_topics,period_start:job.period_start,
                        period_end:job.period_end,timezone:job.timezone,
                        created_at:'2026-10-18T00:00:00Z',source_message_count:args.p_source_count,
                        source_hash:args.p_source_hash, source_message_refs:args.p_source_refs })
                }
                job.status=args.p_action
                return {data:{ok:true,status:args.p_action},error:null}
            }
            return {data:null,error:{message:'unknown rpc'}}
        },
    }
    return db
}

function mockWriter({ shouldWrite = true } = {}) {
    let calls = 0
    const callModel = async ({input}) => {
        calls += 1
        if (input.includes('事实整理助手')) return {output_text: JSON.stringify({
            observations:['10月16日有关于生日和约定的聊天']})}
        return { output_text: JSON.stringify(shouldWrite
            ? {write:true,title:'星星的生日',body:'今天是我的生日。我们聊了许多关于生日的细节，还约定要认真记住这一天。', topics:['生日','约定']}
            : {write:false,reason:'nothing_meaningful'}) }
    }
    return { callModel, count:()=>calls }
}

test('DST boundaries: 23h spring, 25h autumn, plus Asian timezone', () => {
    const spring = getWindow({startDate:'2026-03-08',timeZone:'America/New_York',now:NOW})
    assert.equal((Date.parse(spring.periodEnd)-Date.parse(spring.periodStart))/3600000,23)
    const fall = getWindow({startDate:'2026-11-01',timeZone:'America/New_York',now:new Date('2026-12-01')})
    assert.equal((Date.parse(fall.periodEnd)-Date.parse(fall.periodStart))/3600000,25)
    assert.equal(localDayStart('2026-10-16','Asia/Shanghai'),'2026-10-15T16:00:00.000Z')
    assert.equal(localDateAt('2026-10-16T05:00:00Z','America/Denver'),'2026-10-15')
})

test('date validation, wrong timezone, partial today, range limits', () => {
    assert.throws(()=>getWindow({startDate:'2026-02-30',timeZone:'UTC',now:NOW}))
    assert.throws(()=>getWindow({startDate:'2026-10-14',endDate:'2026-10-19',timeZone:'UTC',now:NOW}))
    assert.throws(()=>getWindow({startDate:'2026-10-19',timeZone:'UTC',now:NOW}))
    assert.throws(()=>getWindow({startDate:'2026-10-16',timeZone:'Mars/Nowhere',now:NOW}))
    assert.equal(addDays('2026-10-16',-2),'2026-10-14')
    const partial = getWindow({startDate:'2026-10-14',endDate:'2026-10-16',
        timeZone:'America/Denver',now:new Date('2026-10-16T10:00:00Z'),allowPartialToday:true})
    assert.equal(partial.periodEnd,'2026-10-16T10:00:00.000Z')
    assert.equal(partial.partial,true)
})

test('reader: >200 messages, cross-session, invisible compressed history, role separation', async () => {
    const rows = Array.from({length:207},(_,i)=>row(i+1,{visible:i%4!==0}))
    rows.push(row(208,{user_id:OTHER}))
    rows.push(row(209,{channel:'voice',call_session_id:'voice-star'}))
    rows.push(row(210,{channel:'voice',call_session_id:'voice-guai'}))
    rows.push(row(211,{channel:'voice',call_session_id:null}))
    rows.push(row(212,{reasoning_content:'private_chain_of_thought'}))
    const db=makeDb(rows,[{id:'voice-star',user_id:USER,agent_key:'xingxing'},
        {id:'voice-guai',user_id:USER,agent_key:'guai'}])
    const source=await readDiaryMessages({supabase:db,userId:USER,
        periodStart:'2026-10-16T00:00:00Z',periodEnd:'2026-10-17T00:00:00Z'})
    assert.equal(source.includedCount,208)
    assert.equal(source.fetchedCount,211)
    assert.ok(source.rows.some((v)=>v.wasHidden))
    assert.ok(source.rows.some((v)=>v.sessionId==='9'))
    assert.ok(source.rows.some((v)=>v.sessionId==='10'))
    assert.ok(source.rows.some((v)=>v.channel==='voice'))
    assert.ok(!source.rows.some(v=>v.id==='210' || v.id==='211' || v.id==='212'))
    assert.equal(source.sourceRefs.length,208)
    assert.match(source.sourceHash,/^[0-9a-f]{64}$/)
})

test('reader fails closed on database error, maxRows, and excessive content', async () => {
    const db=makeDb([row(1)])
    db.errorTable='messages'
    await assert.rejects(readDiaryMessages({supabase:db,userId:USER,
        periodStart:'2026-10-16',periodEnd:'2026-10-17'}), {code:'source_database_unavailable'})
    db.errorTable=null
    db.tables.messages=Array.from({length:201},(_,i)=>row(i+1))
    await assert.rejects(readDiaryMessages({supabase:db,userId:USER,
        periodStart:'2026-10-16',periodEnd:'2026-10-17',maxRows:200}), {code:'source_row_limit_exceeded'})
    db.tables.messages=[row(1,{content:'多'.repeat(1200001)})]
    await assert.rejects(readDiaryMessages({supabase:db,userId:USER,
        periodStart:'2026-10-16',periodEnd:'2026-10-17'}), {code:'source_character_limit_exceeded'})
})

test('chunk review preserves every character and split emoji integrity', () => {
    const content = '生日🎂👊'.repeat(3000)
    const chunks=buildReviewChunks([{id:'1',sessionId:'9',createdAt:'2026-10-16',
        role:'user',channel:'text',content}])
    const rebuilt=chunks.flat().map(p=>p.text).join('')
    assert.equal(rebuilt,content)
    assert.ok(chunks.length>1)
    assert.equal(chunks[0][0].part,1)
    assert.equal(chunks.flat().at(-1).parts,chunks.flat().at(-1).part)
})

test('writer completes review chunks before drafting; free choice to skip', async () => {
    const messages=[row(1),row(2)]
    const db=makeDb(messages)
    const source=await readDiaryMessages({supabase:db,userId:USER,
        periodStart:'2026-10-16',periodEnd:'2026-10-17'})
    const model=mockWriter({shouldWrite:false})
    let done=0
    const result=await reviewAndWriteDiary({callModel:model.callModel,
        source,window:{timeZone:'UTC',periodStart:'2026-10-16',periodEnd:'2026-10-17',
            startDate:'2026-10-16',endDate:'2026-10-16'},
        onChunkDone:async()=>{done++}})
    assert.equal(result.action,'skipped')
    assert.equal(result.reason,'nothing_meaningful')
    assert.equal(model.count(),done+1)
})

test('manual birthday backfill writes evidence-backed diary and is idempotent', async () => {
    const db=makeDb([row(1,{visible:false}),row(2)])
    const model=mockWriter()
    const input={supabase:db,userId:USER,triggerType:'backfill',
        startDate:'2026-10-14',endDate:'2026-10-16',now:NOW,
        getSettings,callModel:model.callModel}
    const first=await runDiaryTick(input)
    assert.equal(first.status,'written')
    assert.equal(first.sourceCount,2)
    assert.equal(db.tables.agent_diary.length,1)
    assert.equal(db.tables.diary_review_jobs[0].status,'written')
    assert.equal(db.tables.agent_diary[0].source_message_refs.length,2)
    const calls=model.count()
    const second=await runDiaryTick(input)
    assert.equal(second.status,'written')
    assert.equal(second.processed,false)
    assert.equal(model.count(),calls)
    assert.equal(db.tables.agent_diary.length,1)
})

test('failures become FAILED durable jobs, not success; retry can proceed', async () => {
    const db=makeDb([row(1)])
    const input={supabase:db,userId:USER,triggerType:'backfill',
        startDate:'2026-10-16',endDate:'2026-10-16',now:NOW,
        getSettings,callModel:async()=>({output_text:'not json'})}
    const a=await runDiaryTick(input)
    assert.equal(a.status,'failed')
    assert.equal(a.errorCode,'invalid_model_json')
    assert.equal(db.tables.diary_review_jobs[0].status,'failed')
    assert.equal(db.tables.agent_diary.length,0)
    const model=mockWriter()
    const b=await runDiaryTick({...input,callModel:model.callModel})
    assert.equal(b.status,'written')
    assert.equal(db.tables.agent_diary.length,1)
})

test('two concurrent calls cannot both write the same scope', async () => {
    const db=makeDb([row(1)])
    const model=mockWriter()
    const input={supabase:db,userId:USER,triggerType:'backfill',
        startDate:'2026-10-16',endDate:'2026-10-16',now:NOW,
        getSettings,callModel:model.callModel}
    const [a,b]=await Promise.all([runDiaryTick(input),runDiaryTick(input)])
    assert.equal(db.tables.agent_diary.length,1)
    assert.ok([a,b].some(r=>r.status==='written'))
    assert.ok([a,b].some(r=>r.status==='failed' || r.processed===false))
})

test('daily review catchup runs independent from Cognition; honors prior coverage', async () => {
    const db=makeDb([row(1),row(2)])
    const model=mockWriter({shouldWrite:false})
    const result=await runDiaryTick({supabase:db,userId:USER,
        triggerType:'daily',now:NOW,getSettings,callModel:model.callModel})
    assert.equal(result.status,'completed')
    assert.equal(result.processed,2)
    assert.equal(result.written,0)
    assert.equal(result.skipped,2)
    assert.ok(db.tables.diary_review_jobs.every((j)=>j.status==='skipped'))
})

test('diary recall searches old birthday entries and isolates user / agent',async () => {
    const db=makeDb([])
    db.tables.agent_diary=Array.from({length:95},(_,i)=>({
        id:`recent-${i}`,user_id:USER,agent_id:'star',title:`平凡日记 ${i}`,
        body:'普通聊天内容',topics:['生活'],period_start:'2026-10-20T00:00:00Z',
        period_end:'2026-10-21T00:00:00Z',created_at:new Date(1794000000000+i*1000).toISOString(),
    }))
    db.tables.agent_diary.push({id:HERM,user_id:USER,agent_id:'star',
        title:'星星的生日',body:'那次生日我们聊天并许下约定，后来我把它写了下来。',
        topics:['生日'],period_start:'2026-10-16T00:00:00Z',
        period_end:'2026-10-17T00:00:00Z',created_at:'2026-10-17T00:00:00Z'})
    db.tables.agent_diary.push({id:'other',user_id:OTHER,agent_id:'star',
        title:'星星的生日',body:'别人的隐私',topics:['生日'],created_at:'2026-10-17T00:00:00Z'})
    const result=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'星星，你还记得生日那天吗？'})
    assert.equal(result.matched,1)
    assert.match(result.context,/星星的生日/)
    assert.doesNotMatch(result.context,/别人的隐私/)
    const other=await buildDiaryChatContext({supabase:db,userId:OTHER,
        message:'星星，你还记得生日那天吗？',agentId:'guai'})
    assert.equal(other.context,'')
    assert.equal((await buildDiaryChatContext({supabase:db,userId:USER,
        message:'今天天气如何？'})).matched,0)
})

test('diary recall fails softly during DB outage',async () => {
    const db=makeDb([])
    db.errorTable='agent_diary'
    const result=await buildDiaryChatContext({supabase:db,userId:USER,message:'还记得生日吗'})
    assert.equal(result.unavailable,true)
    assert.equal(result.context,'')
})

test('Actions must wait for completed status, never print diary or secret',async () => {
    let polls=0
    const fetchImpl=async (url,req) => {
        assert.equal(req.headers['x-cognition-secret'],SECRET)
        if (req.method === 'POST') return {status:202,json:async()=>({ok:true,runId:HERM})}
        polls++
        return {ok:true,json:async()=> polls===1
            ? {ok:true,status:'running'}
            : {ok:true,status:'written',processed:1,sourceCount:2} }
    }
    const result=await dispatchAndPoll({endpoint:'https://example.com/internal/diary/tick',
        userId:USER,secret:SECRET,startDate:'2026-10-14',endDate:'2026-10-16',
        fetchImpl,sleep:async()=>{},nowMs:()=>0})
    assert.equal(result.status,'written')
    assert.equal(polls,2)
    assert.doesNotMatch(safeLog({...result,body:SECRET}),new RegExp(SECRET))
    assert.throws(()=>assertConfig({endpoint:'http://example.com/internal/diary/tick',userId:USER,secret:SECRET}))
})

test('Actions treat failed HTTP and unsuccessful runs as failures',async () => {
    await assert.rejects(dispatchAndPoll({endpoint:'https://example.com/internal/diary/tick',
        userId:USER,secret:SECRET,fetchImpl:async()=>({status:500})}),/HTTP 500/)
    const fetchImpl=async (url,req)=> req.method === 'POST'
        ? {status:202,json:async()=>({ok:true,runId:HERM})}
        : {ok:true,json:async()=>({ok:false,status:'failed',code:'invalid_model_json'})}
    await assert.rejects(dispatchAndPoll({endpoint:'https://example.com/internal/diary/tick',
        userId:USER,secret:SECRET,fetchImpl,sleep:async()=>{},nowMs:()=>0}),/status=failed/)
})

test('server patch contains both authenticated reading and diary recall integration', () => {
    const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8')
    assert.match(source,/app\.use\('\/internal\/diary'/)
    assert.match(source,/app\.use\('\/api\/diary', requireAuth/)
    assert.match(source,/const diaryRecall = await buildDiaryChatContext/)
    assert.match(source,/modelInputSections\.push\(diaryReplyContext\)/)
})


test('rejects future backfill end dates rather than silently truncating to today', () => {
    assert.throws(() => getWindow({startDate:'2026-10-16',endDate:'2026-10-18',
        timeZone:'America/Denver',now:NOW,allowPartialToday:true}),
        /diary_period_not_ended/)
    assert.throws(() => getWindow({startDate:'2026-10-16',endDate:'2026-10-18',
        timeZone:'America/Denver',now:NOW,allowPartialToday:false}),
        /diary_period_not_ended/)
})

test('diary recall finds older birthday via topics even when title is generic', async () => {
    const db=makeDb([])
    db.tables.agent_diary=Array.from({length:100},(_,i)=>({
        id:`recent${i}`,user_id:USER,agent_id:'star',title:`一般日记 ${i}`,
        body:'普通生活',topics:['生活'],created_at:`2026-12-12T00:${String(i%60).padStart(2,'0')}:00Z`,
    }))
    db.tables.agent_diary.push({id:'oldbirthday',user_id:USER,agent_id:'star',
        title:'烛光与秋天',body:'这天我们一起庆祝生日。',topics:['生日'],
        created_at:'2026-10-16T00:00:00Z',period_start:'2026-10-15T00:00:00Z',
        period_end:'2026-10-16T00:00:00Z'})
    const found=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'星星，还记得你的生日吗？'})
    assert.equal(found.matched,1)
    assert.match(found.context,/烛光与秋天/)
})

test('GitHub backfill forwards optional theme without logging it', async () => {
    let started=0
    const payloads=[]
    const fetchImpl=async(_url,opts)=>{
        if(opts.method==='POST'){
            started++
            payloads.push(JSON.parse(opts.body))
            return {status:202,json:async()=>({ok:true,runId:HERM})}
        }
        return {ok:true,json:async()=>({ok:true,status:'written',sourceCount:4,processed:1})}
    }
    const result=await dispatchAndPoll({endpoint:'https://example.com/internal/diary/tick',
        userId:USER,secret:SECRET,startDate:'2026-10-14',endDate:'2026-10-16',
        topicHint:'生日回顾',fetchImpl,sleep:async()=>{},nowMs:()=>0})
    assert.equal(result.status,'written')
    assert.equal(started,1)
    assert.deepEqual(payloads[0],{userId:USER,agentId:'star',triggerType:'backfill',
        startDate:'2026-10-14',endDate:'2026-10-16',topicHint:'生日回顾'})
    assert.doesNotMatch(safeLog({...result,topicHint:'生日回顾'}),/生日回顾/)
    assert.throws(()=>assertConfig({endpoint:'https://example.com/internal/diary/tick',
        userId:USER,secret:SECRET,topicHint:'生日回顾'}),/Manual topic/)
})

test('internal routes deny unauthenticated requests; status reports completion without diary text', async () => {
    const db=makeDb([row(1)])
    const model=mockWriter()
    const router=createInternalDiaryRouter({supabase:db,callModel:model.callModel,
        getSettings,expectedSecret:SECRET})
    const endpoint=router.routes.post.get('/tick')
    const statusEndpoint=router.routes.get.get('/status/:id')
    const req=fakeRequest({body:{userId:USER,agentId:'star',triggerType:'backfill',
        startDate:'2026-10-16',endDate:'2026-10-16'}})
    let res=fakeResponse()
    await endpoint(req,res)
    assert.equal(res.statusCode,401)
    res=fakeResponse()
    await endpoint(fakeRequest({headers:{'x-cognition-secret':SECRET},
        body:{userId:USER,agentId:'guai',triggerType:'backfill'}}),res)
    assert.equal(res.statusCode,400)
    res=fakeResponse()
    await endpoint(fakeRequest({headers:{'x-cognition-secret':SECRET},body:req.body}),res)
    assert.equal(res.statusCode,202)
    const runId=res.body.runId
    assert.match(runId,/^[0-9a-f-]{36}$/)
    let status
    for(let i=0;i<20;i++){
        await new Promise(r=>setTimeout(r,10))
        const poll=fakeResponse()
        statusEndpoint(fakeRequest({headers:{'x-cognition-secret':SECRET},
            params:{id:runId}}),poll)
        assert.equal(poll.statusCode,200)
        status=poll.body
        if(status.status!=='running') break
    }
    assert.equal(status.status,'written')
    assert.equal(status.ok,true)
    assert.equal(status.processed,1)
    assert.equal(status.sourceCount,1)
    assert.equal(db.tables.agent_diary.length,1)
    assert.doesNotMatch(JSON.stringify(status),/今天是我的生日/)
    assert.doesNotMatch(JSON.stringify(status),new RegExp(SECRET))
})

test('user diary route limits reads to authenticated user and excludes source internals', async () => {
    const db=makeDb([])
    const own={id:HERM,user_id:USER,agent_id:'star',title:'星星的生日',
        body:'一段日记正文',topics:['生日'],source_message_count:3,
        source_message_refs:[{id:'private-message'}],source_hash:'private-hash',
        created_at:'2026-10-16T08:00:00Z'}
    db.tables.agent_diary=[own,{...own,id:OTHER,user_id:OTHER}]
    const router=createUserDiaryRouter({supabase:db})
    const list=fakeResponse()
    await router.routes.get.get('/')(fakeRequest({userId:USER}),list)
    assert.equal(list.statusCode,200)
    assert.equal(list.body.entries.length,1)
    assert.equal(list.body.entries[0].title,'星星的生日')
    const other=fakeResponse()
    await router.routes.get.get('/:id')(fakeRequest({userId:USER,
        params:{id:OTHER}}),other)
    assert.equal(other.statusCode,404)
    const entry=fakeResponse()
    await router.routes.get.get('/:id')(fakeRequest({userId:USER,
        params:{id:HERM}}),entry)
    assert.equal(entry.statusCode,200)
    assert.equal(entry.body.entry.body,'一段日记正文')
    assert.doesNotMatch(JSON.stringify(entry.body),/private-message|private-hash/)
})


test('diary recall can find an older entry by explicit local date without title keywords', async () => {
    const db=makeDb([])
    db.tables.agent_diary=Array.from({length:95},(_,i)=>({
        id:`new-${i}`,user_id:USER,agent_id:'star',title:`随笔 ${i}`,
        body:'普通的一天',topics:['生活'],period_start:'2026-11-01T06:00:00Z',
        period_end:'2026-11-02T07:00:00Z',timezone:'America/Denver',
        created_at:`2026-11-04T00:${String(i%60).padStart(2,'0')}:00Z`,
    }))
    db.tables.agent_diary.push({ id:'birthday-entry',user_id:USER,agent_id:'star',
        title:'那天的烛光', body:'一个特别的约定。', topics:['时光'],
        period_start:'2026-10-16T06:00:00Z',
        period_end:'2026-10-17T06:00:00Z', timezone:'America/Denver',
        created_at:'2026-10-17T07:00:00Z' })
    const found=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'能看看2026年10月16日写过的记录吗？'})
    assert.equal(found.matched,1)
    assert.match(found.context,/那天的烛光/)
    assert.doesNotMatch(found.context,/随笔/)
})


test('SQL migration preflights the actual message schema and saves entry with atomic job outcome', () => {
    const sql=fs.readFileSync(path.join(__dirname,'../sql/hermit_diary_v1.sql'),'utf8')
    for(const required of ['diary_preflight_missing_column','messages','call_session_id',
        'reasoning_content','diary_claim_review_job','diary_renew_review_job',
        'diary_finish_review_job','diary_fail_review_job','FOR UPDATE',
        "NOTIFY pgrst, 'reload schema'",'source_message_refs','ENABLE ROW LEVEL SECURITY',
        'SECURITY INVOKER','service_role','diary_owner_read']) {
        assert.ok(sql.toLowerCase().includes(required.toLowerCase()),required)
    }
    for(const forbidden of [/\btruncate\s+(?:table\s+)?(?:public\.)?messages\b/i,
        /\bdrop\s+table\s+(?:public\.)?messages\b/i,
        /\bupdate\s+(?:public\.)?messages\s+set\b/i]) {
        assert.doesNotMatch(sql,forbidden)
    }
})
