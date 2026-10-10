'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const {
    runCognitionTick, parseCognitionOutput, buildCognitionInput,
} = require('../services/cognition/cognitionService')
const { getAbsenceCheckpoint } = require('../services/cognition/wakeGate')

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-10-10T12:00:00.000Z')

function deepClone(o) { return JSON.parse(JSON.stringify(o)) }
function createFakeSupabase(messages = []) {
    const data = {
        messages: deepClone(messages),
        agent_runtime_state: [],
        agent_thoughts: [],
    }
    let nextId = 1
    class Builder {
        constructor(table) {
            this.table = table
            this.mode = 'select'
            this.conditions = []
            this.orders = []
            this.max = Infinity
            this.payload = null
            this.options = null
        }
        select() { return this }
        eq(k, v) { this.conditions.push(x => x[k] === v); return this }
        gt(k, v) { this.conditions.push(x => x[k] > v); return this }
        in(k, vals) { this.conditions.push(x => vals.includes(x[k])); return this }
        order(k, {ascending = true} = {}) { this.orders.push({k, ascending}); return this }
        limit(n) { this.max = n; return this }
        insert(v) { this.mode='insert';this.payload=v;return this }
        upsert(v,o) { this.mode='upsert';this.payload=v;this.options=o;return this }
        update(v) { this.mode='update';this.payload=v;return this }
        matching() {
            let rows = data[this.table].filter(x => this.conditions.every(f => f(x)))
            if (this.orders.length) rows = rows.slice().sort((a,b) => {
                for (const {k,ascending} of this.orders) {
                    if (a[k] === b[k]) continue
                    return (a[k]<b[k]?-1:1)*(ascending?1:-1)
                }
                return 0
            })
            return rows.slice(0,this.max)
        }
        result(single = false) {
            if (this.mode==='select') {
                const rows = this.matching()
                return {data:single?deepClone(rows[0]||null):deepClone(rows),error:null}
            }
            if (this.mode==='upsert') {
                const p = this.payload
                const found = data[this.table].find(x=>x.user_id===p.user_id&&x.agent_id===p.agent_id)
                if (!found) data[this.table].push({
                    ...p,version:0,metadata:{},last_user_message_at:null,
                    last_cognition_at:null,last_wake_at:null,absence_checkpoint:0,
                    absence_started_at:null,current_emotional_tone:null,pending_topic:null,
                    next_review_at:null,last_proactive_at:null,
                })
                return {data:null,error:null}
            }
            if (this.mode==='update') {
                const rows = this.matching()
                for (const row of rows) Object.assign(row,this.payload)
                return {data:single?deepClone(rows[0]||null):deepClone(rows),error:null}
            }
            if (this.mode==='insert') {
                const values=Array.isArray(this.payload)?this.payload:[this.payload]
                const created=values.map(v=>({...v,id:nextId++}))
                data[this.table].push(...created)
                return {data:single?deepClone(created[0]):deepClone(created),error:null}
            }
            throw Error('unsupported fake operation')
        }
        maybeSingle() { return Promise.resolve(this.result(true)) }
        single() { return Promise.resolve(this.result(true)) }
        then(resolve,reject) { return Promise.resolve(this.result()).then(resolve,reject) }
    }
    return { data, from(table) {
        if (!data[table]) throw new Error(`unknown mock table: ${table}`)
        return new Builder(table)
    } }
}
function baseMessages(userId=USER_A) {
    return [
        {id:1,user_id:userId,session_id:8,role:'user',visible:true,
            content:'我明天还有一个重要的演讲。',created_at:'2026-10-10T06:00:00.000Z'},
        {id:2,user_id:userId,session_id:8,role:'assistant',visible:true,
            content:'你准备得很认真。',created_at:'2026-10-10T06:01:00.000Z'},
    ]
}
function response(shouldStore=true) {
    return {output_text:JSON.stringify({
        should_store:shouldStore,
        thought:shouldStore?'她明天有重要的演讲，希望一切顺利。':'',
        emotion:'平静',significance:0.65,pending_topic:'明天的演讲',review_after:null,
    })}
}
function opts(db, callModel) { return {
    supabase:db,userId:USER_A,now:NOW,callModel,
    getSettings:async()=>({system_prompt:'温柔且克制',character_context:'星星'}),
    getLatestMemory:async()=>({summary:'用户很重视自己的演讲。'}),
    getMilestoneContext:async()=>({text:'演讲日 2 天后'}),
} }

test('wake gate checkpoints 6/12/18/24/36/48/72h and after',()=>{
    const h=3600000
    for(const [hours,expected] of [[0,0],[5,0],[6,1],[7,1],[12,2],
        [18,3],[24,4],[36,5],[48,6],[72,7],[95,7],[96,8]]) {
        assert.equal(getAbsenceCheckpoint(hours*h),expected)
    }
})

test('manual offline tick saves Thought and runtime state, then skips cooldown',async()=>{
    const db=createFakeSupabase(baseMessages())
    let calls=0
    const a=opts(db,async request=>{
        calls++
        assert.equal(request.model,'gpt-5.6-sol')
        assert.match(request.input,/明天.*重要的演讲/)
        return response()
    })
    const first=await runCognitionTick(a)
    assert.equal(first.executed,true)
    assert.equal(first.stored,true)
    assert.equal(db.data.agent_thoughts.length,1)
    assert.equal(db.data.agent_thoughts[0].user_id,USER_A)
    assert.equal(db.data.agent_runtime_state[0].last_cognition_at,NOW.toISOString())
    assert.equal(db.data.agent_runtime_state[0].absence_checkpoint,1)
    assert.equal(db.data.agent_runtime_state[0].pending_topic,'明天的演讲')
    const again=await runCognitionTick(a)
    assert.deepEqual([again.executed,again.reason],[false,'cooldown'])
    assert.equal(calls,1)
    assert.equal(db.data.agent_thoughts.length,1)
})

test('no messages does not wake or call the model',async()=>{
    const db=createFakeSupabase()
    const result=await runCognitionTick(opts(db,()=>{throw Error('unexpected model call')}))
    assert.equal(result.reason,'no_user_messages')
    assert.equal(db.data.agent_thoughts.length,0)
})

test('other users messages are never read',async()=>{
    const db=createFakeSupabase(baseMessages(USER_B))
    const result=await runCognitionTick(opts(db,()=>{throw Error('unexpected model call')}))
    assert.equal(result.reason,'no_user_messages')
})

test('store:false updates cognition time without creating thoughts',async()=>{
    const db=createFakeSupabase(baseMessages())
    const result=await runCognitionTick(opts(db,async()=>response(false)))
    assert.equal(result.executed,true)
    assert.equal(result.stored,false)
    assert.equal(db.data.agent_thoughts.length,0)
    assert.equal(db.data.agent_runtime_state[0].last_cognition_at,NOW.toISOString())
})

test('invalid model JSON fails and wake claim is released so it can retry',async()=>{
    const db=createFakeSupabase(baseMessages())
    await assert.rejects(runCognitionTick(opts(db,async()=>({output_text:'not json'}))),
        /有效 JSON/)
    assert.equal(db.data.agent_thoughts.length,0)
    assert.equal(db.data.agent_runtime_state[0].last_wake_at,null)
    assert.equal(db.data.agent_runtime_state[0].absence_checkpoint,0)
    const result=await runCognitionTick(opts(db,async()=>response(true)))
    assert.equal(result.stored,true)
})

test('new user message during model call cancels stale thought',async()=>{
    const db=createFakeSupabase(baseMessages())
    const result=await runCognitionTick(opts(db,async()=>{
        db.data.messages.push({id:3,user_id:USER_A,session_id:8,role:'user',visible:true,
            content:'我回来啦',created_at:'2026-10-10T12:00:01.000Z'})
        return response()
    }))
    assert.equal(result.executed,false)
    assert.equal(result.reason,'new_user_message_during_tick')
    assert.equal(db.data.agent_thoughts.length,0)
    assert.equal(db.data.agent_runtime_state[0].absence_checkpoint,0)
})

test('format and significance validation reject bad AI outputs',()=>{
    assert.throws(()=>parseCognitionOutput('{}',NOW),/格式/)
    assert.throws(()=>parseCognitionOutput(JSON.stringify({should_store:true,thought:'x',
        significance:1.1}),NOW),/significance/)
    const valid=parseCognitionOutput('```json\n'+JSON.stringify({
        should_store:true,thought:'温柔的回想',emotion:'平静',significance:.3,
        pending_topic:null,review_after:null})+'\n```',NOW)
    assert.equal(valid.thought,'温柔的回想')
})

test('model input is bounded even with long messages',()=>{
    const input=buildCognitionInput({now:NOW,state:{},wakeReasons:['manual'],
        messages:[{role:'user',text:'A'.repeat(30000)}],settings:{system_prompt:'B'.repeat(9999)},
        memory:{summary:'C'.repeat(9999)},milestones:{text:'D'.repeat(9999)},
        recentThoughts:[]})
    // getConversationExcerpt is responsible for clipping messages in production.
    assert.ok(input.length<12000)
    assert.ok(!input.includes('B'.repeat(2000)))
    assert.ok(!input.includes('A'.repeat(500)))
})

test('secret comparison matches only exact non-empty strings',()=>{
    const origLoad = Module._load
    const fakeExpress={ Router:()=>({post(){return this}}) }
    try {
        Module._load=function(id,...args){
            if(id==='express') return fakeExpress
            return origLoad.call(this,id,...args)
        }
        const routePath=path.resolve(__dirname,'../routes/cognition.js')
        delete require.cache[routePath]
        const {secureEqual}=require(routePath)
        assert.equal(secureEqual('abcdef','abcdef'),true)
        assert.equal(secureEqual('abcdef','abcdeg'),false)
        assert.equal(secureEqual('abc','abcdef'),false)
        assert.equal(secureEqual(undefined,'abcdef'),false)
    } finally { Module._load=origLoad }
})

test('private router refuses missing secret and bad token, calls service only when authorized',async()=>{
    const origLoad = Module._load
    let handler
    const fakeExpress={Router:()=>({post(p,fn){assert.equal(p,'/tick');handler=fn;return this}})}
    const savedAI = process.env.AI_API_KEY
    const savedURL = process.env.AI_BASE_URL
    process.env.AI_API_KEY='mock-key'
    process.env.AI_BASE_URL='https://mock.invalid'
    try {
        Module._load=function(id,...args){
            if(id==='express') return fakeExpress
            return origLoad.call(this,id,...args)
        }
        const routePath=path.resolve(__dirname,'../routes/cognition.js')
        delete require.cache[routePath]
        const createRouter=require(routePath)
        let executions=0
        const secret='top-secret-1234567890-1234567890'
        createRouter({expectedSecret:secret, supabase:{from(){return {}}},
            callModel:async()=>response(),
            runTick:async({userId,agentId})=>{
                executions++
                assert.equal(userId,USER_A)
                assert.equal(agentId,'star')
                return {executed:true,stored:false}
            }})
        function responseObj(){return {
            statusCode:200, status(v){this.statusCode=v;return this},
            json(v){this.body=v;return this},
        }}
        let res=responseObj()
        await handler({get(){return undefined},body:{userId:USER_A}},res)
        assert.equal(res.statusCode,401)
        assert.equal(executions,0)
        res=responseObj()
        await handler({get(){return 'wrong'},body:{userId:USER_A}},res)
        assert.equal(res.statusCode,401)
        res=responseObj()
        await handler({get(){return secret},body:{userId:'not-uuid'}},res)
        assert.equal(res.statusCode,400)
        res=responseObj()
        await handler({get(){return secret},body:{userId:USER_A,agentId:'other'}},res)
        assert.equal(res.statusCode,400)
        res=responseObj()
        await handler({get(){return secret},body:{userId:USER_A,agentId:'star'}},res)
        assert.equal(res.statusCode,200)
        assert.equal(res.body.executed,true)
        assert.equal(executions,1)
    } finally {
        Module._load=origLoad
        if (savedAI===undefined) delete process.env.AI_API_KEY
        else process.env.AI_API_KEY=savedAI
        if (savedURL===undefined) delete process.env.AI_BASE_URL
        else process.env.AI_BASE_URL=savedURL
    }
})
