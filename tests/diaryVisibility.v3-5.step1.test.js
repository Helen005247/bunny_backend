'use strict'
// Non-destructive mock tests: node --test backend/tests/diaryVisibility.v3-5.step1.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const SHARED_ID = '33333333-3333-4333-8333-333333333333'
const LOCKED_ID = '44444444-4444-4444-8444-444444444444'
const DATE = '2026-10-18'

function Router() {
    const routes = []
    return {
        routes,
        use(...args) { routes.push({ method:'USE', args }); return this },
        get(p,h) { routes.push({ method:'GET', path:p,handler:h }); return this },
        post(p,h) { routes.push({ method:'POST', path:p,handler:h }); return this },
    }
}
const restoreLoad = Module._load
Module._load = function(request, parent, isMain) {
    if (request === 'express') return { Router }
    if (request === './cognition') return { secureEqual:()=>false }
    if (request === '../services/diary/diaryService') return { runDiaryTick:async()=>{}, safeErrorCode:()=>'' }
    if (request === '../services/diary/diaryAcceptance') return {
        runAcceptancePreview:async()=>{}, runAcceptanceProbe:async()=>{},runManualV2Live:async()=>{} }
    if (request === '../services/diary/diaryPlanStore') return { commitDiaryPreviewPlan:async()=>{} }
    if (request === '../services/diary/diaryVerification') return { runDiaryV2Verification:async()=>{} }
    if (request === '../services/diary/diaryCalendar') return {
        parseMonthQuery: q => q && q.year==='2026' && q.month==='10' ?
            {year:2026,month:10,limit:50,offset:0} : null,
        monthUtcSearchBounds:()=>({start:'2026-09-30T00:00:00Z',end:'2026-11-02T00:00:00Z'}),
        monthCalendarEntries: rows => rows.map(r=>({...r, diary_date:DATE})),
    }
    if (request === './personalDiaryRecall') return {
        sharedDiaryIntent:()=>({wantsMine:false,mineOnly:false}),
        buildSharedUserDiaryChatContext:async()=>({context:'',matched:0,mode:'none',fullChars:0}),
    }
    return restoreLoad.call(this,request,parent,isMain)
}
const { createPersonalDiaryRouter } = require('../routes/personalDiary')
const { createUserDiaryRouter } = require('../routes/diary')
const { buildDiaryChatContext } = require('../services/diary/diaryRecall')
Module._load = restoreLoad

function rows() {
    const day = new Date().toISOString()
    const common = {
        user_id: OWNER,agent_id:'star', created_at:'2026-10-18T03:00:00Z',
        updated_at:'2026-10-18T03:00:00Z',period_start:'2026-10-17T15:00:00Z',
        period_end:'2026-10-18T15:00:00Z',timezone:'Asia/Shanghai',
        current_version:1,topics:[],source_message_count:10,
    }
    return {
        user_diary: [
            { id:SHARED_ID,user_id:OWNER,diary_date:DATE,title:'我的日记',body:'我的日记秘密正文',
                visibility:'shared',edit_version:2,created_at:day,updated_at:day },
            { id:LOCKED_ID,user_id:OTHER,diary_date:DATE,title:'别人的日记',body:'别人的秘密',
                visibility:'locked',edit_version:3,created_at:day,updated_at:day },
        ],
        agent_diary: [
            {id:SHARED_ID,...common, visibility:'shared',title:'星星可公开的日记',body:'星星的公开正文'},
            {id:LOCKED_ID,...common, visibility:'locked',title:'被星星锁住的秘密',body:'上锁的绝密正文',current_version:2},
        ],
        diary_revisions: [
            {diary_id:SHARED_ID,user_id:OWNER,agent_id:'star',version:1,kind:'initial',
                created_at:day,title:'星星可公开的日记',body:'初稿公开',topics:[]},
            {diary_id:LOCKED_ID,user_id:OWNER,agent_id:'star',version:1,kind:'initial',
                created_at:day,title:'被星星锁住的秘密',body:'旧版秘密',topics:[]},
        ],
    }
}
function fakeDb(initial=rows()) {
    const calls = []
    const db={ data: initial, calls, errorMode:false, onRead:null,
        from(table) {
            if (!(table in db.data)) throw new Error('unknown table: '+table)
            const q={ type:'select',fieldList:'*',filters:[], sorting:[], start:0,end:Infinity,
                updateData:null,table,
                select(fields){this.fieldList=fields;return this},
                eq(k,v){this.filters.push({op:'eq',k,v});return this},
                gte(k,v){this.filters.push({op:'gte',k,v});return this},
                gt(k,v){this.filters.push({op:'gt',k,v});return this},
                lt(k,v){this.filters.push({op:'lt',k,v});return this},
                order(k,opts){this.sorting.push([k,opts?.ascending===true]);return this},
                limit(n){this.start=0;this.end=n;return this},
                range(a,b){this.start=a;this.end=b+1;return this},
                update(changes){this.type='update';this.updateData=changes;return this},
                maybeSingle(){return Promise.resolve(this.result(true))},
                single(){return Promise.resolve(this.result(true))},
                then(resolve,reject){return Promise.resolve(this.result(false)).then(resolve,reject)},
                result(single){
                    calls.push({table,type:this.type,fields:this.fieldList,
                        filters: this.filters.map(f=>({...f})), updateData:this.updateData})
                    if(db.errorMode) return {data:null,error:{message:'unavailable'}}
                    let matches=db.data[table].filter(r=>this.filters.every(f=>
                        f.op==='eq' ? r[f.k]===f.v :
                        f.op==='gte'?r[f.k]>=f.v:f.op==='gt'?r[f.k]>f.v:r[f.k]<f.v))
                    for(const [key,asc] of this.sorting.reverse()) matches.sort((a,b)=>
                        String(a[key]).localeCompare(String(b[key]))*(asc?1:-1))
                    matches=matches.slice(this.start,this.end)
                    if(this.type==='update') for(const r of matches) {
                        Object.assign(r,this.updateData)
                        r.edit_version+=1
                    }
                    const fields=this.fieldList.split(',').map(v=>v.trim())
                    const selected=matches.map(r=> Object.fromEntries(fields.filter(k=>k in r)
                        .map(k=>[k,r[k]])))
                    if(typeof db.onRead==='function') db.onRead({table,query:this,results:selected})
                    return {data:single?(selected[0]||null):selected,error:null}
                },
            }
            return q
        },
    }
    return db
}
function makeResponse() {
    return { statusCode:200, headers:{}, output:null,
        status(s){this.statusCode=s;return this},
        set(k,v){this.headers[k]=v;return this},
        json(x){this.output=x;return this},
    }
}
async function invoke(router,method,pattern,{userId=OWNER,params={},query={},body}={}) {
    const req={userId,params,query,body}
    const res=makeResponse()
    const middleware=router.routes.filter(x=>x.method==='USE' && typeof x.args[0]==='function')
    for (const m of middleware) {
        let continued=false
        await m.args[0](req,res,()=>{continued=true})
        if (!continued) return res
    }
    const route=router.routes.find(x=>x.method===method && x.path===pattern)
    assert.ok(route,`missing route ${method} ${pattern}`)
    await route.handler(req,res)
    return res
}

function hasVisibilityFilter(call) {
    return call.filters.some(x=> x.k==='visibility' && x.v==='shared' && x.op==='eq')
}

test('owner can lock/unlock own date; concurrency token advances; body unchanged',async()=>{
    const db=fakeDb(),router=createPersonalDiaryRouter({supabase:db})
    const first=await invoke(router,'POST','/:date/visibility',{
        params:{date:DATE},body:{visibility:'locked',expected_version:2},
    })
    assert.equal(first.statusCode,200)
    assert.equal(first.output.entry.visibility,'locked')
    assert.equal(first.output.entry.edit_version,3)
    assert.equal(first.output.entry.body,'我的日记秘密正文')
    const old=await invoke(router,'POST','/:date/visibility',{
        params:{date:DATE},body:{visibility:'shared',expected_version:2},
    })
    assert.equal(old.statusCode,409)
    const unlock=await invoke(router,'POST','/:date/visibility',{
        params:{date:DATE},body:{visibility:'shared',expected_version:3},
    })
    assert.equal(unlock.statusCode,200)
    assert.equal(unlock.output.entry.edit_version,4)
    assert.equal(unlock.output.entry.visibility,'shared')
})

test('locked owner diary is readable to its author, but not writable by others', async()=>{
    const db=fakeDb(),router=createPersonalDiaryRouter({supabase:db})
    db.data.user_diary[0].visibility='locked'
    const r=await invoke(router,'GET','/:date',{params:{date:DATE}})
    assert.equal(r.output.entry.visibility,'locked')
    const other=await invoke(router,'POST','/:date/visibility',{
        userId:OTHER,params:{date:DATE},body:{visibility:'shared',expected_version:2},
    })
    assert.equal(other.statusCode,409) // OTHER owns its own date, but has a different edit version
    assert.equal(db.data.user_diary[0].visibility,'locked')
    const missing=await invoke(router,'POST','/:date/visibility',{
        userId:'55555555-5555-4555-8555-555555555555',
        params:{date:DATE},body:{visibility:'locked',expected_version:2},
    })
    assert.equal(missing.statusCode,404)
})

test('untrusted or malformed lock payload fails closed', async()=>{
    const db=fakeDb(), router=createPersonalDiaryRouter({supabase:db})
    for(const body of [null,{}, {visibility:'private',expected_version:2},
        {visibility:'shared',expected_version:2,user_id:OWNER},
        {visibility:'locked',expected_version:'2'},
        {visibility:'locked',expected_version:0}]) {
        const r=await invoke(router,'POST','/:date/visibility',{params:{date:DATE},body})
        assert.equal(r.statusCode,400)
    }
    const unauth=await invoke(router,'POST','/:date/visibility',{params:{date:DATE},
        userId:null,body:{visibility:'locked',expected_version:2}})
    assert.equal(unauth.statusCode,401)
    assert.equal(db.calls.length,0)
})

test('star diary list, month and detail exclude locked titles and bodies',async()=>{
    const db=fakeDb(),router=createUserDiaryRouter({supabase:db})
    const listing=await invoke(router,'GET','/',{query:{limit:'10'}})
    assert.equal(listing.statusCode,200)
    assert.deepEqual(listing.output.entries.map(r=>r.id),[SHARED_ID])
    const month=await invoke(router,'GET','/month',{query:{year:'2026',month:'10'}})
    assert.equal(month.statusCode,200)
    assert.deepEqual(month.output.entries.map(r=>r.id),[SHARED_ID])
    const hidden=await invoke(router,'GET','/:id',{params:{id:LOCKED_ID}})
    assert.equal(hidden.statusCode,404)
    const shown=await invoke(router,'GET','/:id',{params:{id:SHARED_ID}})
    assert.equal(shown.statusCode,200)
    assert.equal(shown.output.entry.body,'星星的公开正文')
    for (const call of db.calls.filter(x=>x.table==='agent_diary')) {
        assert.ok(hasVisibilityFilter(call),'one agent diary SELECT omitted shared filter')
    }
})

test('old revision titles and bodies of locked star entries are hidden',async()=>{
    const db=fakeDb(),router=createUserDiaryRouter({supabase:db})
    for(const p of ['/:id/revisions','/:id/revisions/:version']) {
        const hidden=await invoke(router,'GET',p,{params:{id:LOCKED_ID,version:'1'}})
        assert.equal(hidden.statusCode,404)
        assert.equal(hidden.output.code,'not_found')
        const shown=await invoke(router,'GET',p,{params:{id:SHARED_ID,version:'1'}})
        assert.equal(shown.statusCode,200)
        assert.ok(shown.output.revisions || shown.output.revision)
    }
})

test('when parent is locked mid-request revision details are rejected',async()=>{
    const db=fakeDb(),router=createUserDiaryRouter({supabase:db})
    let seen=0
    db.onRead = ({table}) => {
        if(table==='diary_revisions' && ++seen===1) {
            db.data.agent_diary.find(r=>r.id===SHARED_ID).visibility='locked'
        }
    }
    const result=await invoke(router,'GET','/:id/revisions/:version',
        {params:{id:SHARED_ID,version:'1'}})
    assert.equal(result.statusCode,404)
})

test('user-visible Star chat excludes locked diary metadata and full text',async()=>{
    const db=fakeDb()
    const full=await buildDiaryChatContext({supabase:db,userId:OWNER,agentId:'star',
        message:'请读一下你自己的日记',channel:'text'})
    assert.equal(full.mode,'full')
    assert.ok(full.context.includes('星星的公开正文'))
    assert.ok(!full.context.includes('被星星锁住的秘密'))
    assert.ok(!full.context.includes('上锁的绝密正文'))
    assert.ok(db.calls.filter(c=>c.table==='agent_diary').every(hasVisibilityFilter))
    db.data.agent_diary.find(r=>r.id===SHARED_ID).visibility='locked'
    const hidden=await buildDiaryChatContext({supabase:db,userId:OWNER,agentId:'star',
        message:'请读一下你自己的日记',channel:'text'})
    assert.ok(!hidden.context.includes('被星星锁住的秘密'))
    assert.ok(!hidden.context.includes('上锁的绝密正文'))
    assert.equal(hidden.matched,0)
})

test('SQL migration has restrictive RLS checks for both diary and revisions',()=>{
    const filename=path.join(__dirname,'../../sql/diary_v3-5_step1_visibility.sql')
    const sql=fs.readFileSync(filename,'utf8')
    assert.match(sql,/CREATE POLICY agent_diary_v35_shared_read[\s\S]*?AS RESTRICTIVE FOR SELECT TO authenticated/)
    assert.match(sql,/CREATE POLICY diary_revisions_v35_shared_read[\s\S]*?AS RESTRICTIVE FOR SELECT TO authenticated/)
    assert.match(sql,/EXISTS[\s\S]*?FROM public\.agent_diary AS d[\s\S]*?d\.visibility = 'shared'/)
    assert.match(sql,/ADD COLUMN IF NOT EXISTS visibility/)
})
