'use strict'

// Self-contained tests: node --test backend/tests/personalDiary.v3-4.test.js
// Express and Supabase are mocked so the tests are non-destructive.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')
const path = require('node:path')

function makeRouter() {
    const routes = []
    return {
        routes,
        use(...args) { routes.push({ method: 'USE', args }); return this },
        get(p, h) { routes.push({ method: 'GET', path: p, handler: h }); return this },
        post(p, h) { routes.push({ method: 'POST', path: p, handler: h }); return this },
    }
}

const originalLoad = Module._load
Module._load = function (id, parent, isMain) {
    if (id === 'express') return { Router: makeRouter }
    return originalLoad.call(this, id, parent, isMain)
}
const personal = require('../routes/personalDiary')
Module._load = originalLoad

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const TODAY = '2026-10-18'

function makeDb(initial = []) {
    const rows = initial.map(row => ({
        id: '33333333-3333-4333-8333-333333333333',
        user_id: A, diary_date: TODAY, title: '', body: '初稿',
        visibility: 'shared', edit_version: 1,
        created_at: '2026-10-18T00:00:00.000Z',
        updated_at: '2026-10-18T00:00:00.000Z', ...row,
    }))
    const calls = []
    let nextId = 1
    const db = {
        rows, calls, failRead: false, failWrite: false,
        from(table) {
            assert.equal(table, 'user_diary')
            const query = {
                operation: 'read', cols: '*', filters: [], orderBy: null, payload: null,
                insert(payload) { this.operation = 'insert'; this.payload = payload; return this },
                update(payload) { this.operation = 'update'; this.payload = payload; return this },
                eq(key, val) { this.filters.push(row => row[key] === val); return this },
                gte(key, val) { this.filters.push(row => row[key] >= val); return this },
                lt(key, val) { this.filters.push(row => row[key] < val); return this },
                order(key, option) { this.orderBy = { key, option }; return this },
                select(cols) { this.cols = cols; return this },
                single() { return Promise.resolve(this.result(true)) },
                maybeSingle() { return Promise.resolve(this.result(true)) },
                then(resolve, reject) { return Promise.resolve(this.result(false)).then(resolve,reject) },
                result(one) {
                    calls.push({ operation: this.operation, cols: this.cols, filters: this.filters.length,
                        payload: this.payload && { ...this.payload } })
                    if (db.failRead && this.operation === 'read') return { data: null, error: { code: 'DOWN' } }
                    if (db.failWrite && this.operation !== 'read') return { data: null, error: { code: 'DOWN' } }
                    if (this.operation === 'insert') {
                        if (rows.some(r => r.user_id === this.payload.user_id && r.diary_date === this.payload.diary_date)) {
                            return { data: null, error: { code: '23505' } }
                        }
                        const now = '2026-10-18T02:00:00.000Z'
                        const row = { id: `44444444-4444-4444-8444-${String(nextId++).padStart(12,'0')}`,
                            title: '', visibility: 'shared', edit_version: 1, created_at:now,updated_at:now,
                            ...this.payload }
                        rows.push(row)
                        return { data: pick(row, this.cols), error: null }
                    }
                    let found = rows.filter(row => this.filters.every(fn => fn(row)))
                    if (this.operation === 'update') {
                        found.forEach(row => {Object.assign(row,this.payload); row.edit_version++;
                            row.updated_at = '2026-10-18T03:00:00.000Z'})
                    }
                    if (this.orderBy) {
                        const {key, option}=this.orderBy
                        found.sort((a,b) => String(a[key]).localeCompare(String(b[key])) * (option?.ascending ? 1:-1))
                    }
                    if (one) return { data: found[0] ? pick(found[0],this.cols):null, error: null }
                    return { data: found.map(row => pick(row,this.cols)), error: null }
                },
            }
            return query
        },
    }
    return db
}
function pick(row,cols) {
    if (cols==='*') return { ...row }
    return Object.fromEntries(cols.split(',').map(k => k.trim()).filter(k=>k in row).map(k=>[k,row[k]]))
}

async function issue(router,method,url,{userId=A,body,query={}}={}) {
    let status=200, payload=null, headers={}
    const res={
        set(k,v) { headers[k] = v; return this },
        status(code) {status=code;return this},
        json(value) {payload=value; return this},
    }
    const req={userId,body,query,params:{date:url.split('/').at(-1)}}
    const middlewares = router.routes.filter(r=>r.method==='USE' && typeof r.args[0]==='function')
    let blocked=false
    for(const mw of middlewares) {
        let next=false
        await Promise.resolve(mw.args[0](req,res,()=>{next=true}))
        if (!next) {blocked=true; break}
    }
    if (!blocked) {
        const matched = router.routes.find(r=>r.method===method && r.path===url.replace(/^\/\d{4}-\d{2}-\d{2}$/,'/:date'))
        assert.ok(matched,`unrecognized route ${method} ${url}`)
        await matched.handler(req,res)
    }
    return {status,payload,headers}
}

test('calendar dates: leap day, day zero, century and bounds',() => {
    for (const value of ['2024-02-29','2026-10-18','2100-12-31','2000-01-01']) {
        assert.equal(personal.localDiaryDate(value),value)
    }
    for(const value of ['2025-02-29','2100-02-29','2026-00-01','2026-04-31',
        '2026-01-00','2026-13-01','2026-1-1','1999-12-31','2101-01-01',null,{}]) {
        assert.equal(personal.localDiaryDate(value),null)
    }
    assert.deepEqual(personal.monthBounds({year:'2026',month:'12'}),
        {first:'2026-12-01',following:'2027-01-01'})
    assert.deepEqual(personal.monthBounds({year:'2024',month:'2'}),
        {first:'2024-02-01',following:'2024-03-01'})
    assert.equal(personal.monthBounds({year:'2025',month:'13'}),null)
})

test('new entry is per-user and shared by database default', async () => {
    const db=makeDb(),router=personal.createPersonalDiaryRouter({supabase:db})
    const x=await issue(router,'POST',`/${TODAY}`, {body:{body:'第一次写日记。',expected_version:0}})
    assert.equal(x.status,201)
    assert.equal(x.payload.entry.visibility,'shared')
    assert.equal(x.payload.entry.edit_version,1)
    assert.equal(db.rows[0].user_id,A)
    assert.equal(db.calls[0].payload.user_id,A)
    assert.equal(db.calls[0].payload.visibility,undefined)
    assert.equal(x.headers['Cache-Control'],'private, no-store')
})

test('unauthenticated and forged userId or visibility are rejected without touching db',async () => {
    const db=makeDb(), router=personal.createPersonalDiaryRouter({supabase:db})
    const y=await issue(router,'POST',`/${TODAY}`, {userId:null,body:{body:'日记',expected_version:0}})
    const z=await issue(router,'POST',`/${TODAY}`, {body:{body:'日记',user_id:B,expected_version:0}})
    const l=await issue(router,'POST',`/${TODAY}`, {body:{body:'日记',visibility:'locked',expected_version:0}})
    assert.equal(y.status,401)
    assert.equal(z.status,400)
    assert.equal(l.status,400)
    assert.equal(db.rows.length,0)
})

test('isolated reads, missing day, month summary hides body', async () => {
    const db=makeDb([{user_id:A,diary_date:'2026-10-12',body:'私密正文A'},
        {user_id:B,diary_date:'2026-10-12',body:'私密正文B'},
        {user_id:A,diary_date:'2026-09-12',body:'过往月份'}])
    const router=personal.createPersonalDiaryRouter({supabase:db})
    const user=await issue(router,'GET','/2026-10-12')
    assert.equal(user.status,200)
    assert.equal(user.payload.entry.body,'私密正文A')
    const b=await issue(router,'GET','/2026-10-12',{userId:B})
    assert.equal(b.payload.entry.body,'私密正文B')
    const gone=await issue(router,'GET','/2026-10-13')
    assert.equal(gone.status,404)
    const m=await issue(router,'GET','/month',{query:{year:'2026',month:'10'}})
    assert.equal(m.status,200)
    assert.equal(m.payload.entries.length,1)
    assert.equal(m.payload.entries[0].body,undefined)
    assert.equal(m.payload.entries[0].diary_date,'2026-10-12')
})

test('optimistic edit increments version and preserves locked visibility',async () => {
    const db=makeDb([{visibility:'locked',edit_version:7,body:'原文'}])
    const router=personal.createPersonalDiaryRouter({supabase:db})
    const result=await issue(router,'POST',`/${TODAY}`,
        {body:{body:'改过的版本',expected_version:7}})
    assert.equal(result.status,200)
    assert.equal(result.payload.entry.edit_version,8)
    assert.equal(result.payload.entry.visibility,'locked')
    assert.equal(db.calls[0].payload.visibility,undefined)
    const stale=await issue(router,'POST',`/${TODAY}`,
        {body:{body:'过期覆盖',expected_version:7}})
    assert.equal(stale.status,409)
    assert.equal(db.rows[0].body,'改过的版本')
})

test('creating the same diary again returns 409',async () => {
    const db=makeDb([{}]),router=personal.createPersonalDiaryRouter({supabase:db})
    const result=await issue(router,'POST',`/${TODAY}`,
        {body:{body:'不能覆盖',expected_version:0}})
    assert.equal(result.status,409)
    assert.equal(db.rows[0].body,'初稿')
})

test('editing missing day returns 404; editing another user cannot overwrite',async () => {
    const db=makeDb([{user_id:B}]), router=personal.createPersonalDiaryRouter({supabase:db})
    const result=await issue(router,'POST',`/${TODAY}`,
        {body:{body:'尝试改B',expected_version:1}})
    assert.equal(result.status,404)
    assert.equal(db.rows[0].body,'初稿')
})

test('invalid writes/date/month return 400 before database query',async () => {
    const db=makeDb(),router=personal.createPersonalDiaryRouter({supabase:db})
    for(const body of [null,{}, {body:' ',expected_version:0},
        {body:'ok',expected_version:-1}, {body:'ok',expected_version:1.5},
        {body:'ok',expected_version:0,title:'a\nb'},
        {body:'X'.repeat(10001),expected_version:0},
        {body:'ok',expected_version:0,visibility:'shared'},
        {body:'ok',expected_version:0,created_at:'2026'}]) {
        const r=await issue(router,'POST',`/${TODAY}`,{body})
        assert.equal(r.status,400,JSON.stringify(body)?.slice(0,40))
    }
    assert.equal((await issue(router,'POST','/2026-02-30',
        {body:{body:'ok',expected_version:0}})).status,400)
    assert.equal((await issue(router,'GET','/month',
        {query:{year:'2026',month:'13'}})).status,400)
    assert.equal((await issue(router,'GET','/month',
        {query:{year:['2026'],month:'10'}})).status,400)
    assert.equal(db.calls.length,0)
})

test('database failures are not mistakenly displayed as empty diary',async () => {
    const db=makeDb([{}]);db.failRead=true
    const router=personal.createPersonalDiaryRouter({supabase:db})
    assert.equal((await issue(router,'GET',`/${TODAY}`)).status,503)
    assert.equal((await issue(router,'GET','/month',
        {query:{year:'2026',month:'10'}})).status,503)
    db.failWrite=true
    assert.equal((await issue(router,'POST',`/${TODAY}`,{
        body:{body:'test',expected_version:0}})).status,503)
})

test('route integration mounts /mine ahead of /:id in existing diary router',() => {
    const diaryPath=path.join(__dirname,'../routes/diary.js')
    const code=fs.readFileSync(diaryPath,'utf8')
    const mount=code.indexOf("router.use('/mine', createPersonalDiaryRouter({ supabase }))")
    assert.ok(mount>=0)
    assert.ok(mount<code.indexOf("router.get('/:id', async (req, res) => {"))
    assert.match(code,/function createUserDiaryRouter\(\{ supabase \} = \{\}\)/)
})

test('SQL migrates only new table with RLS and version trigger',() => {
    const sql=fs.readFileSync(path.join(__dirname,'../sql/diary_v3-4_step1_user_diary.sql'),'utf8')
    assert.match(sql,/create table if not exists public\.user_diary/i)
    assert.match(sql,/enable row level security/i)
    assert.match(sql,/auth\.uid\(\)/i)
    assert.match(sql,/visibility text not null default 'shared'/i)
    assert.match(sql,/unique \(user_id, diary_date\)/i)
    assert.match(sql,/new\.edit_version := old\.edit_version \+ 1/i)
    assert.ok(!/alter table\s+(?:public\.)?(?:agent_diary|diary_revisions)/i.test(sql))
})
