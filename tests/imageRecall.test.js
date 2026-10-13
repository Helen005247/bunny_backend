'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { parseRecallFilters, searchPastImages } = require('../services/images/imageRecallService')

const USER_A = 'user-a'
const USER_B = 'user-b'
const rows = [
    { id: '00000000-0000-4000-8000-000000000001', user_id: USER_A, agent_id: 'star', kind: 'uploaded', session_id: 101, message_id: 501, summary: '一只可爱的棕色小狗正在草地上玩耍', mime_type: 'image/jpeg', created_at: '2026-10-01T12:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000002', user_id: USER_A, agent_id: 'star', kind: 'uploaded', session_id: 102, message_id: 502, summary: '一只小狗睡在沙发上', mime_type: 'image/png', created_at: '2026-10-11T13:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000003', user_id: USER_A, agent_id: 'star', kind: 'uploaded', session_id: 102, message_id: 503, summary: '桌上一杯咖啡和一本书', mime_type: 'image/webp', created_at: '2026-10-11T20:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000004', user_id: USER_B, agent_id: 'star', kind: 'uploaded', session_id: 201, message_id: 504, summary: '用户 B 的小狗照片', mime_type: 'image/jpeg', created_at: '2026-10-12T12:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000005', user_id: USER_A, agent_id: 'other', kind: 'uploaded', session_id: 101, message_id: 505, summary: '另一个角色的小狗照片', mime_type: 'image/jpeg', created_at: '2026-10-13T12:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000006', user_id: USER_A, agent_id: 'star', kind: 'uploaded', session_id: 102, message_id: null, summary: '未真正发送的小狗照片', mime_type: 'image/jpeg', created_at: '2026-10-13T12:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000007', user_id: USER_A, agent_id: 'star', kind: 'generated', session_id: 102, message_id: 507, summary: '星星画的小狗', mime_type: 'image/png', created_at: '2026-10-13T12:00:00.000Z' },
]

function fakeSupabase(data = rows, error = null) {
    const calls = []
    return {
        calls,
        from(table) {
            calls.push({ action: 'from', table })
            let current = table === 'sessions'
                ? [{ id: 101, user_id: USER_A }, { id: 102, user_id: USER_A }, { id: 201, user_id: USER_B }]
                : data.slice()
            const chain = {
                select(fields) { calls.push({ action: 'select', fields }); return this },
                eq(field, value) { calls.push({ action: 'eq', field, value }); current = current.filter(r => r[field] === value); return this },
                not(field, operator, value) {
                    calls.push({ action: 'not', field, operator, value })
                    assert.equal(operator, 'is'); assert.equal(value, null)
                    current = current.filter(r => r[field] !== null && r[field] !== undefined)
                    return this
                },
                ilike(field, pattern) {
                    calls.push({ action: 'ilike', field, pattern })
                    assert.ok(pattern.startsWith('%') && pattern.endsWith('%'))
                    const needle = pattern.slice(1, -1).toLocaleLowerCase()
                    current = current.filter(r => String(r[field] || '').toLocaleLowerCase().includes(needle))
                    return this
                },
                gte(field, value) { calls.push({ action: 'gte', field, value }); current = current.filter(r => r[field] >= value); return this },
                lt(field, value) { calls.push({ action: 'lt', field, value }); current = current.filter(r => r[field] < value); return this },
                lte(field, value) { calls.push({ action: 'lte', field, value }); current = current.filter(r => r[field] <= value); return this },
                order(field, { ascending }) {
                    calls.push({ action: 'order', field, ascending })
                    current.sort((a,b) => (ascending ? 1 : -1) * String(a[field]).localeCompare(String(b[field])))
                    return this
                },
                range(start, end) { calls.push({ action: 'range', start, end }); return Promise.resolve({ data: current.slice(start, end + 1), error }) },
                maybeSingle() { calls.push({ action: 'maybeSingle' }); return Promise.resolve({ data: current[0] || null, error }) },
            }
            return chain
        },
    }
}

function ids(result) { return result.images.map(x => x.id.slice(-1)) }

test('recent recall is ordered, user/agent isolated, and excludes unsent/generated images', async () => {
    const db = fakeSupabase()
    const result = await searchPastImages({ supabase: db, userId: USER_A })
    assert.deepEqual(ids(result), ['3', '2', '1'])
    assert.equal(result.pagination.has_more, false)
    assert.equal(Object.hasOwn(result.images[0], 'storage_path'), false)
    assert.equal(Object.hasOwn(result.images[0], 'user_id'), false)
    assert.ok(db.calls.some(c => c.action === 'eq' && c.field === 'user_id' && c.value === USER_A))
    assert.ok(db.calls.some(c => c.action === 'eq' && c.field === 'agent_id' && c.value === 'star'))
    assert.ok(db.calls.some(c => c.action === 'not' && c.field === 'message_id'))
})

test('keyword search works across sessions, with safe pagination', async () => {
    const db = fakeSupabase()
    const result = await searchPastImages({ supabase: db, userId: USER_A, filters: { q: '小狗', limit: '1' } })
    assert.deepEqual(ids(result), ['2'])
    assert.equal(result.pagination.has_more, true)
    const pageTwo = await searchPastImages({ supabase: db, userId: USER_A, filters: { q: '小狗', limit: '1', offset: '1' } })
    assert.deepEqual(ids(pageTwo), ['1'])
    assert.equal(pageTwo.pagination.has_more, false)
})

test('session filter and UTC inclusive calendar date bounds work', async () => {
    const result = await searchPastImages({
        supabase: fakeSupabase(), userId: USER_A,
        filters: { session_id: '102', from: '2026-10-11', to: '2026-10-11' },
    })
    assert.deepEqual(ids(result), ['3', '2'])
    const timestampResult = await searchPastImages({
        supabase: fakeSupabase(), userId: USER_A,
        filters: { from: '2026-10-11T14:00:00+08:00', to: '2026-10-11T21:00:00Z' },
    })
    assert.deepEqual(ids(timestampResult), ['3', '2'])
})

test('user B cannot see user A images', async () => {
    const result = await searchPastImages({ supabase: fakeSupabase(), userId: USER_B, filters: { q: '小狗' } })
    assert.deepEqual(ids(result), ['4'])
})

test('rejects invalid query inputs before touching storage', async () => {
    for (const filters of [
        { limit: '0' }, { limit: '10000' }, { offset: '-1' }, { offset: '999999' },
        { session_id: '0' }, { session_id: 'garbage' }, { q: '%' }, { q: 'a'.repeat(121) },
        { from: '2026-02-30' }, { from: '2026-02-30T10:30:00Z' }, { from: '2026-10-13T24:00Z' }, { from: '2026-10-13T11:60Z' }, { to: '2026-13-01' }, { from: 'yesterday' },
        { from: '2026-10-13', to: '2026-10-12' }, { from: ['2026-10-11'] },
    ]) {
        assert.throws(() => parseRecallFilters(filters), err => err.status === 400, JSON.stringify(filters))
    }
    assert.rejects(() => searchPastImages({ supabase: fakeSupabase(), userId: '' }), err => err.status === 401)
})

test('propagates Supabase read failures to the route', async () => {
    await assert.rejects(() => searchPastImages({ supabase: fakeSupabase(rows, new Error('simulated database failure')), userId: USER_A }), /simulated/)
})

// Load the route without installing dependencies: verify handler behavior, not HTTP transport.
function loadRouter() {
    const realLoad = Module._load
    let routes
    try {
        Module._load = function patched(request, parent, isMain) {
            if (request === 'express') {
                return {
                    Router() {
                        routes = { get: {}, post: {} }
                        return {
                            get(path, handler) { routes.get[path] = handler },
                            post(path, middleware, handler) { routes.post[path] = handler },
                        }
                    },
                    raw: () => (_req,_res,next) => next(),
                }
            }
            if (request === 'openai') return class FakeOpenAI {}
            return realLoad.call(this, request, parent, isMain)
        }
        delete require.cache[require.resolve('../routes/images')]
        const createImagesRouter = require('../routes/images')
        return { createImagesRouter, getRoutes: () => routes }
    } finally {
        Module._load = realLoad
    }
}

async function getResponse(handler, { query = {}, userId = USER_A } = {}) {
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this },
        json(data) { this.body = data; return this },
    }
    await handler({ query, userId }, res)
    return res
}

test('router exposes authenticated GET recall, and session lookup rejects other user sessions', async () => {
    const { createImagesRouter, getRoutes } = loadRouter()
    createImagesRouter({ supabase: fakeSupabase() })
    const handle = getRoutes().get['/recall']
    assert.equal(typeof handle, 'function')
    const allowed = await getResponse(handle, { query: { session_id: '101', q: '小狗' } })
    assert.equal(allowed.statusCode, 200)
    assert.deepEqual(ids(allowed.body), ['1'])
    const refused = await getResponse(handle, { query: { session_id: '201' } })
    assert.equal(refused.statusCode, 404)
    assert.equal(refused.body.code, 'SESSION_NOT_FOUND')
    const bad = await getResponse(handle, { query: { limit: 'oops' } })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.body.code, 'INVALID_RECALL_FILTER')
})

test('database failures return sanitized HTTP errors', async () => {
    const { createImagesRouter, getRoutes } = loadRouter()
    createImagesRouter({ supabase: fakeSupabase(rows, new Error('secret table query detail')) })
    const result = await getResponse(getRoutes().get['/recall'])
    assert.equal(result.statusCode, 500)
    assert.equal(result.body.code, 'IMAGE_RECALL_FAILED')
    assert.doesNotMatch(JSON.stringify(result.body), /secret table query detail/)
})
