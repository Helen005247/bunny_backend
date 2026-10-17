'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildDiaryChatContext } = require('../services/diary/diaryRecall')

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const DIARY_ID = '33333333-3333-4333-8333-333333333333'

class Query {
    constructor(db) { this.db=db; this.predicates=[]; this.selection='*';this.n=Infinity }
    select(x) {this.selection=x;return this}
    eq(k,v) {this.predicates.push((r)=>String(r[k])===String(v));return this}
    ilike(k,q) {const sub=q.replaceAll('%','').toLowerCase();
        this.predicates.push((r)=>String(r[k]||'').toLowerCase().includes(sub));return this}
    contains(k,values) {assert.equal(k,'topics');assert.equal(typeof values,'string');
        const tags=JSON.parse(values);this.predicates.push((r)=>Array.isArray(r[k])&&
        tags.every((x)=>r[k].includes(x)));return this}
    lt(k,v) {this.predicates.push((r)=>r[k]<v);return this}
    gt(k,v) {this.predicates.push((r)=>r[k]>v);return this}
    gte(k,v) {this.predicates.push((r)=>r[k]>=v);return this}
    order(k,{ascending=false}={}) {this.key=k;this.asc=ascending;return this}
    limit(n) {this.n=n;return this}
    then(resolve,reject) {return Promise.resolve(this.finish(false)).then(resolve,reject)}
    maybeSingle() {return Promise.resolve(this.finish(true))}
    finish(one) {
        this.db.queries.push(this.selection)
        if(this.db.fail) return {data:null,error:{message:'DB failure'}}
        let rows=this.db.rows.filter(r=>this.predicates.every(f=>f(r)))
        if(this.key) rows=rows.toSorted((a,b)=>String(a[this.key]).localeCompare(String(b[this.key]))*(this.asc?1:-1))
        rows=rows.slice(0,this.n)
        if(this.selection!=='*'){
            const cols=this.selection.split(',').map(x=>x.trim())
            rows=rows.map(r=>Object.fromEntries(cols.filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]])))
        }
        return {data:one?(rows[0]||null):rows,error:null}
    }
}
function dbWith(entries) {return {rows:entries,queries:[],fail:false,
    from(name){assert.equal(name,'agent_diary');return new Query(this)} } }
function entry(body='那天，我们一起过生日。这是我写下的完整日记。') {return {
    id:DIARY_ID,user_id:USER,agent_id:'star',title:'烛光下的心愿',
    body,topics:['生日','约定'],
    period_start:'2026-10-14T06:00:00Z',period_end:'2026-10-16T06:00:00Z',
    timezone:'America/Denver',created_at:'2026-10-16T09:30:00Z',
}}

test('without a diary keyword, Star still knows a diary was saved, but body stays unloaded',async()=>{
    const row=entry('私人的完整正文，只应在全文读取时出现。')
    const db=dbWith([row])
    const result=await buildDiaryChatContext({supabase:db,userId:USER,message:'星星，早上好！'})
    assert.equal(result.mode,'awareness')
    assert.equal(result.matched,0)
    assert.match(result.context,/确实曾经写过日记/)
    assert.match(result.context,/烛光下的心愿/)
    assert.doesNotMatch(result.context,/私人的完整正文/)
    assert.ok(db.queries.every(q=>!q.split(',').map(x=>x.trim()).includes('body')))
})

test('explicitly opening the latest diary gives the model its COMPLETE 10000-char body',async()=>{
    const body='生日后的心情。'+ '星'.repeat(9980)+'END-OF-DIARY'
    assert.ok(Array.from(body).length<=10000)
    const db=dbWith([entry(body)])
    const result=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'星星，你刚写过的那篇日记，能完整读给我听吗？'})
    assert.equal(result.mode,'full')
    assert.equal(result.matched,1)
    assert.equal(result.fullChars,Array.from(body).length)
    assert.ok(result.context.includes(body),'diary must not be truncated or summarized')
    assert.match(result.context,/END-OF-DIARY/)
    assert.equal(db.queries.filter(q=>q.split(',').map(x=>x.trim()).includes('body')).length,1)
})

test('contextual birthday recall reads full diary even when title is generic',async()=>{
    const birth=entry('从今天到未来，我们一起记住生日这件事。')
    birth.title='夜里的一点光'
    const db=dbWith([birth])
    const result=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'你还记得生日那天发生的事情吗？'})
    assert.equal(result.mode,'full')
    assert.match(result.context,/从今天到未来/)
})

test('diary with a poetic title and no topic tags can still be found from its full text',async()=>{
    const birth=entry('生日那天我记住了一句很重要的话。')
    birth.title='窗边的微光'
    birth.topics=['心情']
    const db=dbWith([birth])
    const result=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'你还记得生日那天吗？'})
    assert.equal(result.mode,'full')
    assert.match(result.context,/生日那天我记住了/)
})

test('Star can open his diary in a new session; followups can resolve the previous diary topic',async()=>{
    const db=dbWith([entry()])
    const first=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'星星，你写的日记是什么？',recentMessages:[]})
    const followup=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'那篇的完整内容呢？',recentMessages:[
            {role:'user',content:'星星，你写的日记是什么？'},
            {role:'assistant',content:'我写过一篇。'}]})
    assert.equal(first.mode,'full')
    assert.equal(followup.mode,'full')
    assert.match(followup.context,/一起过生日/)
})

test('multiple diaries: explicit complete-date request selects the right record, not the latest',async()=>{
    const birthday=entry('生日那天的完整内容。')
    const recent={...birthday,id:'new',title:'日常记录',body:'隔天另一篇',topics:['日常'],
        period_start:'2026-10-17T06:00:00Z',period_end:'2026-10-18T06:00:00Z',
        created_at:'2026-10-18T10:00:00Z'}
    const db=dbWith([birthday,recent])
    const result=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'星星，你能打开2026年10月14日的日记全文吗？'})
    assert.equal(result.mode,'full')
    assert.match(result.context,/生日那天的完整内容/)
    assert.doesNotMatch(result.context,/隔天另一篇/)
})

test('date of writing and date covered are both searchable',async()=>{
    const db=dbWith([entry()])
    const result=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'星星，给我看你在2026年10月16日写的日记。'})
    assert.equal(result.mode,'full')
    assert.match(result.context,/一起过生日/)
})

test('listing diaries returns only headings, never their bodies',async()=>{
    const db=dbWith([entry('列表时不应该展示这段私密正文')])
    const result=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'你写过哪些日记？给我看目录。'})
    assert.equal(result.mode,'directory')
    assert.doesNotMatch(result.context,/列表时不应该展示/)
    assert.ok(db.queries.every(q=>!q.split(',').map(x=>x.trim()).includes('body')))
})

test('user/agent/channel are isolated, never leak other users diaries',async()=>{
    const own=entry()
    const stranger={...own,id:'stranger',user_id:OTHER,body:'另外一位用户的机密日记'}
    const db=dbWith([own,stranger])
    const result=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'你写的日记全文',channel:'text'})
    assert.equal(result.mode,'full')
    assert.doesNotMatch(result.context,/另外一位用户/)
    assert.equal((await buildDiaryChatContext({supabase:db,userId:USER,
        agentId:'guai',message:'日记'})).context,'')
    assert.equal((await buildDiaryChatContext({supabase:db,userId:USER,
        channel:'call',message:'日记'})).context,'')
})

test('fail closed: no match, missing body or DB outage are never presented as read',async()=>{
    const db=dbWith([entry()])
    const noMatch=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'2026年11月18日的日记在哪里？'})
    assert.equal(noMatch.mode,'not_found')
    assert.equal(noMatch.matched,0)
    assert.match(noMatch.context,/没有找到/)
    db.rows[0].body=null
    const broken=await buildDiaryChatContext({supabase:db,userId:USER,message:'给我看日记全文'})
    assert.equal(broken.mode,'unavailable')
    assert.match(broken.context,/暂时无法打开正文/)
    db.fail=true
    const outage=await buildDiaryChatContext({supabase:db,userId:USER,message:'今天过得如何'})
    assert.equal(outage.mode,'unavailable')
    assert.equal(outage.context,'')
})

test('invalid max-size body never silently slices content',async()=>{
    const db=dbWith([entry('长'.repeat(10001))])
    const result=await buildDiaryChatContext({supabase:db,userId:USER,
        message:'你写的日记原文是什么'})
    assert.equal(result.mode,'unavailable')
    assert.equal(result.fullChars,0)
})

test('server hook includes Star diary index and full-body diagnostic without exposing text',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8')
    assert.match(source,/buildDiaryChatContext\(\{/)
    assert.match(source,/recentMessages: history/)
    assert.match(source,/\[diary-recall\] mode=full; entries=/)
    assert.match(source,/if \(messageChannel === 'text' \|\| callAgentKey === 'xingxing'\)/)
    assert.match(source,/modelInputSections\.push\(diaryReplyContext\)/)
    assert.doesNotMatch(source,/console\.log\(diaryReplyContext\)/)
})
