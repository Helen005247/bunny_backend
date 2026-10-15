'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
    createThoughtThread, getThoughtThread, listThoughtThreads,
    updateThoughtThread, completeThoughtThread, abandonThoughtThread,
} = require('../services/cognition/thoughtThreadService')

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-10-15T12:00:00.000Z')
const FUTURE = '2026-10-20T12:00:00.000Z'
const LATER = '2026-10-30T12:00:00.000Z'
const base = (db, other = {}) => ({
    supabase: db, userId: USER_A, agentId: 'star', now: NOW, ...other,
})
const create = (db, other = {}) => createThoughtThread(base(db, {
    title: '生日朋友圈要写的话', currentDraft: '先考虑温柔一点的表达',
    nextStep: '再想想具体措辞', nextReviewAt: FUTURE,
    metadata: { source: 'conversation', message_id: 42 }, ...other,
}))

function fakeSupabase() {
    const rows = []
    let nextId = 1
    const fails = []
    const clone = (value) => structuredClone(value)
    class Builder {
        constructor() {
            this.mode = 'read'
            this.filters = []
            this.sort = []
            this.max = Number.POSITIVE_INFINITY
        }
        select() { return this }
        eq(key, val) {
            this.filters.push((row) => row[key] === val)
            return this
        }
        lte(key, val) {
            this.filters.push((row) => row[key] != null && row[key] <= val)
            return this
        }
        order(key, { ascending = true } = {}) {
            this.sort.push({ key, ascending })
            return this
        }
        limit(value) { this.max = value; return this }
        insert(payload) { this.mode = 'insert'; this.payload = clone(payload); return this }
        update(payload) { this.mode = 'update'; this.payload = clone(payload); return this }
        matching() {
            return rows.filter((row) => this.filters.every((check) => check(row)))
                .sort((a, b) => {
                    for (const { key, ascending } of this.sort) {
                        if (a[key] === b[key]) continue
                        if (a[key] === null) return ascending ? 1 : -1
                        if (b[key] === null) return ascending ? -1 : 1
                        return (a[key] < b[key] ? -1 : 1) * (ascending ? 1 : -1)
                    }
                    return 0
                }).slice(0, this.max)
        }
        async answer(single) {
            const failed = fails.findIndex((item) => item.operation === this.mode)
            if (failed >= 0) {
                return { data: null, error: fails.splice(failed, 1)[0].error }
            }
            if (this.mode === 'insert') {
                const p = this.payload
                if (p.dedupe_key && rows.some((row) => row.user_id === p.user_id &&
                    row.agent_id === p.agent_id && row.dedupe_key === p.dedupe_key)) {
                    return { data: null, error: { code: '23505', message: 'duplicate key' } }
                }
                const row = {
                    id: `00000000-0000-4000-8000-${(nextId++).toString(16).padStart(12, '0')}`,
                    status: 'open', result: null, closed_at: null, version: 0,
                    ...p,
                }
                rows.push(row)
                return { data: clone(single ? row : [row]), error: null }
            }
            if (this.mode === 'update') {
                const matched = this.matching()
                for (const row of matched) Object.assign(row, this.payload)
                return { data: clone(single ? matched[0] || null : matched), error: null }
            }
            const matched = this.matching()
            return { data: clone(single ? matched[0] || null : matched), error: null }
        }
        single() { return this.answer(true) }
        maybeSingle() { return this.answer(true) }
        then(yes, no) { return this.answer(false).then(yes, no) }
    }
    return {
        rows,
        failNext(operation, error = new Error('database unavailable')) {
            fails.push({ operation, error })
        },
        from(table) {
            assert.equal(table, 'agent_thought_threads')
            return new Builder()
        },
    }
}

async function rejectsCode(fn, code) {
    await assert.rejects(fn, (error) => {
        assert.equal(error.code, code)
        return true
    })
}

test('create and read a durable draft without touching short-lived thoughts', async () => {
    const db = fakeSupabase()
    const thread = await create(db)
    assert.equal(thread.status, 'open')
    assert.equal(thread.version, 0)
    assert.equal(thread.current_draft, '先考虑温柔一点的表达')
    assert.equal(thread.next_review_at, FUTURE)
    assert.equal(thread.result, null)
    assert.equal(db.rows.length, 1)
    assert.deepEqual(await getThoughtThread(base(db, { threadId: thread.id })), thread)
})

test('read/list/due queries isolate both user and agent', async () => {
    const db = fakeSupabase()
    const a = await create(db)
    const b = await create(db, { userId: USER_B, title: '别人的事情' })
    const c = await create(db, { agentId: 'moon', title: '另一个角色' })
    const future = await create(db, { title: '未来再看', nextReviewAt: LATER })
    const unscheduled = await create(db, { title: '先放着', nextReviewAt: null })
    assert.equal((await getThoughtThread(base(db, { threadId: b.id }))), null)
    assert.equal((await getThoughtThread(base(db, { threadId: c.id }))), null)
    assert.equal((await listThoughtThreads(base(db))).length, 3)
    assert.deepEqual((await listThoughtThreads(base(db, { dueBefore: FUTURE }))).map(t => t.id), [a.id])
    assert.deepEqual((await listThoughtThreads(base(db, { dueBefore: LATER }))).map(t => t.id), [a.id, future.id])
    assert.equal((await listThoughtThreads(base(db, { dueBefore: LATER }))).some(t => t.id === unscheduled.id), false)
    assert.equal((await listThoughtThreads(base(db, { userId: USER_B }))).length, 1)
    assert.equal((await listThoughtThreads(base(db, { agentId: 'moon' }))).length, 1)
    assert.equal((await listThoughtThreads(base(db, { limit: 1 }))).length, 1)
})

test('update preserves the same id and increments version for each revision', async () => {
    const db = fakeSupabase()
    const t0 = await create(db)
    const t1 = await updateThoughtThread(base(db, {
        threadId: t0.id, expectedVersion: 0,
        patch: { currentDraft: '第一版文字', nextStep: '看看是不是太正式', nextReviewAt: LATER },
    }))
    assert.equal(t1.version, 1)
    assert.equal(t1.id, t0.id)
    assert.equal(t1.current_draft, '第一版文字')
    assert.equal(t1.next_review_at, LATER)
    const t2 = await updateThoughtThread(base(db, {
        threadId: t0.id, expectedVersion: 1,
        patch: { title: '生日文案第二稿', nextStep: null, nextReviewAt: null,
            metadata: { revised: true } },
    }))
    assert.equal(t2.version, 2)
    assert.equal(t2.title, '生日文案第二稿')
    assert.equal(t2.next_step, null)
    assert.equal(t2.next_review_at, null)
    assert.deepEqual(t2.metadata, { revised: true })
    assert.equal(db.rows.length, 1)
})

test('stale concurrent writes conflict without overwriting newer data', async () => {
    const db = fakeSupabase()
    const thread = await create(db)
    const outcome = await Promise.allSettled([
        updateThoughtThread(base(db, { threadId: thread.id, expectedVersion: 0,
            patch: { currentDraft: 'first' } })),
        updateThoughtThread(base(db, { threadId: thread.id, expectedVersion: 0,
            patch: { currentDraft: 'second' } })),
    ])
    assert.equal(outcome.filter((o) => o.status === 'fulfilled').length, 1)
    const rejection = outcome.find((o) => o.status === 'rejected')
    assert.equal(rejection.reason.code, 'THOUGHT_THREAD_CONFLICT')
    assert.equal(db.rows[0].version, 1)
    assert.equal(db.rows[0].current_draft, outcome.find((o) => o.status === 'fulfilled').value.current_draft)
    await rejectsCode(() => updateThoughtThread(base(db, { threadId: thread.id,
        userId: USER_B, expectedVersion: 1, patch: { title: 'not my thread' } })), 'THOUGHT_THREAD_CONFLICT')
    await rejectsCode(() => abandonThoughtThread(base(db, { threadId: thread.id,
        expectedVersion: 0 })), 'THOUGHT_THREAD_CONFLICT')
})

test('completed draft keeps final result and becomes immutable', async () => {
    const db = fakeSupabase()
    const thread = await create(db)
    const completed = await completeThoughtThread(base(db, {
        threadId: thread.id, expectedVersion: 0,
        result: '生日快乐。希望每个平凡的日子都有光。',
    }))
    assert.equal(completed.status, 'completed')
    assert.equal(completed.result, '生日快乐。希望每个平凡的日子都有光。')
    assert.equal(completed.current_draft, thread.current_draft)
    assert.equal(completed.next_step, null)
    assert.equal(completed.next_review_at, null)
    assert.equal(completed.version, 1)
    assert.equal(completed.closed_at, NOW.toISOString())
    assert.equal((await listThoughtThreads(base(db))).length, 0)
    assert.equal((await listThoughtThreads(base(db, { status: 'completed' }))).length, 1)
    await rejectsCode(() => updateThoughtThread(base(db, {
        threadId: thread.id, expectedVersion: 1, patch: { currentDraft: 'mutate' },
    })), 'THOUGHT_THREAD_CONFLICT')
    await rejectsCode(() => completeThoughtThread(base(db, {
        threadId: thread.id, expectedVersion: 1, result: 'replace',
    })), 'THOUGHT_THREAD_CONFLICT')
})

test('abandon clears scheduling but does not delete draft history', async () => {
    const db = fakeSupabase()
    const thread = await create(db)
    const abandoned = await abandonThoughtThread(base(db, {
        threadId: thread.id, expectedVersion: 0,
    }))
    assert.equal(abandoned.status, 'abandoned')
    assert.equal(abandoned.result, null)
    assert.equal(abandoned.next_step, null)
    assert.equal(abandoned.next_review_at, null)
    assert.equal(abandoned.current_draft, thread.current_draft)
    assert.equal((await listThoughtThreads(base(db, { status: 'abandoned' }))).length, 1)
    await rejectsCode(() => completeThoughtThread(base(db, {
        threadId: thread.id, expectedVersion: 1, result: 'late result',
    })), 'THOUGHT_THREAD_CONFLICT')
})

test('repeat create with a stable dedupeKey reuses the original thread', async () => {
    const db = fakeSupabase()
    const original = await create(db, { dedupeKey: 'user-message-42:star' })
    const repeated = await create(db, { dedupeKey: 'user-message-42:star' })
    assert.equal(repeated.id, original.id)
    assert.equal(db.rows.length, 1)
    await rejectsCode(() => create(db, { dedupeKey: 'user-message-42:star',
        currentDraft: '意外用同一个 key 提交了不同草稿' }), 'THOUGHT_THREAD_DEDUPE_CONFLICT')
    const fromOtherUser = await create(db, { userId: USER_B, dedupeKey: 'user-message-42:star' })
    const fromOtherAgent = await create(db, { agentId: 'moon', dedupeKey: 'user-message-42:star' })
    assert.notEqual(fromOtherUser.id, original.id)
    assert.notEqual(fromOtherAgent.id, original.id)
    assert.equal(db.rows.length, 3)
})

test('dedupe handles Postgres timezone formatting and later revised drafts', async () => {
    const db = fakeSupabase()
    const original = await create(db, { dedupeKey: 'once-only' })
    db.rows[0].next_review_at = '2026-10-20T12:00:00+00:00'
    db.rows[0].metadata = { message_id: 42, source: 'conversation' }
    const same = await create(db, { dedupeKey: 'once-only' })
    assert.equal(same.id, original.id)
    const revised = await updateThoughtThread(base(db, { threadId: original.id,
        expectedVersion: 0, patch: { currentDraft: 'already updated by worker' },
    }))
    const repeated = await create(db, { dedupeKey: 'once-only' })
    assert.equal(repeated.id, original.id)
    assert.equal(repeated.current_draft, revised.current_draft)
    assert.equal(db.rows.length, 1)
})

test('database errors surface instead of silently losing a draft', async () => {
    const db = fakeSupabase()
    db.failNext('insert', Object.assign(new Error('db insert unavailable'), { code: 'PGRST503' }))
    await assert.rejects(() => create(db), /db insert unavailable/)
    assert.equal(db.rows.length, 0)
    const thread = await create(db)
    db.failNext('update', new Error('db update unavailable'))
    await assert.rejects(() => updateThoughtThread(base(db, { threadId: thread.id,
        expectedVersion: 0, patch: { currentDraft: 'not saved' } })), /db update unavailable/)
    assert.equal(db.rows[0].version, 0)
    db.failNext('read', new Error('db read unavailable'))
    await assert.rejects(() => getThoughtThread(base(db, { threadId: thread.id })), /db read unavailable/)
    db.failNext('read', new Error('db list unavailable'))
    await assert.rejects(() => listThoughtThreads(base(db)), /db list unavailable/)
})

test('creation validates lengths, timestamps, identity, metadata and retry key', async () => {
    const db = fakeSupabase()
    await create(db, { title: 'a'.repeat(160), currentDraft: 'd'.repeat(6000),
        nextStep: 'x'.repeat(1200) })
    for (const overrides of [
        { title: '' }, { title: 'a'.repeat(161) },
        { currentDraft: 'd'.repeat(6001) },
        { nextStep: 'x'.repeat(1201) },
        { dedupeKey: 'k'.repeat(129) },
        { metadata: [] }, { metadata: null },
        { metadata: { large: 'a'.repeat(9000) } },
        { nextReviewAt: NOW.toISOString() },
        { nextReviewAt: '2026-10-14T12:00:00Z' },
        { nextReviewAt: '2026-10-25' },
        { nextReviewAt: '2026-02-30T12:00:00Z' },
        { nextReviewAt: 'garbage' },
        { now: 'not a date' },
        { userId: '' }, { agentId: '' },
    ]) {
        await assert.rejects(() => create(db, overrides))
    }
    await assert.rejects(() => create(db, { metadata: { toJSON: () => 'not an object' } }))
    const circular = {}; circular.itself = circular
    await assert.rejects(() => create(db, { metadata: circular }))
    assert.equal(db.rows.length, 1)
})

test('updates cannot modify ownership, state, version or invalid results', async () => {
    const db = fakeSupabase()
    const thread = await create(db)
    for (const patch of [
        {}, { user_id: USER_B }, { agent_id: 'moon' }, { id: thread.id },
        { status: 'completed' }, { result: 'injected' }, { version: 99 },
        { title: '' }, { currentDraft: 'd'.repeat(6001) },
        { nextReviewAt: NOW.toISOString() }, { metadata: [] },
    ]) {
        await assert.rejects(() => updateThoughtThread(base(db, {
            threadId: thread.id, expectedVersion: 0, patch,
        })))
    }
    for (const expectedVersion of [-1, 0.5, 2147483647, undefined]) {
        await assert.rejects(() => updateThoughtThread(base(db, {
            threadId: thread.id, expectedVersion, patch: { title: 'not saved' },
        })))
    }
    await assert.rejects(() => getThoughtThread(base(db, { threadId: 'invalid-id' })))
    await assert.rejects(() => completeThoughtThread(base(db, {
        threadId: thread.id, expectedVersion: 0, result: '' })))
    await assert.rejects(() => completeThoughtThread(base(db, {
        threadId: thread.id, expectedVersion: 0, result: 'x'.repeat(6001) })))
    assert.equal(db.rows[0].version, 0)
})

test('listing validates statuses, due filters and pagination', async () => {
    const db = fakeSupabase()
    for (const args of [
        { status: 'unknown' }, { status: 'all', dueBefore: FUTURE },
        { status: 'completed', dueBefore: FUTURE }, { dueBefore: 'bad' },
        { limit: 0 }, { limit: 51 }, { limit: 2.5 },
    ]) {
        await assert.rejects(() => listThoughtThreads(base(db, args)))
    }
    assert.deepEqual(await listThoughtThreads(base(db, { limit: 50 })), [])
})

test('migration creates private durable storage without changing old tables', () => {
    const sql = fs.readFileSync(path.join(__dirname,
        '../sql/background_cognition_v2_step2_thought_threads.sql'), 'utf8')
    assert.match(sql, /create table if not exists public\.agent_thought_threads/i)
    assert.match(sql, /constraint thought_threads_dedupe_unique unique\s*\(user_id, agent_id, dedupe_key\)/i)
    assert.match(sql, /alter table public\.agent_thought_threads enable row level security/i)
    assert.match(sql, /revoke all on table public\.agent_thought_threads from public, anon, authenticated/i)
    assert.match(sql, /grant select, insert, update on table public\.agent_thought_threads to service_role/i)
    assert.doesNotMatch(sql, /\b(?:drop|truncate|alter)\s+table\s+(?:public\.)?agent_thoughts\b/i)
    assert.doesNotMatch(sql, /\b(?:drop|truncate|alter)\s+table\s+(?:public\.)?agent_runtime_state\b/i)
})
