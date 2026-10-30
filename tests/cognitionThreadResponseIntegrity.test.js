'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
    listThoughtThreads, createThoughtThread,
} = require('../services/cognition/thoughtThreadService')
const { loadThreadContext } = require('../services/cognition/thoughtThreadCognition')
const { hasDueThoughtThread } = require('../services/cognition/wakeGate')

const userId = '11111111-1111-4111-8111-111111111111'
const agentId = 'star'
const now = new Date('2026-10-30T12:00:00.000Z')

function unusualSupabase(result) {
    const calls = []
    const builder = {
        select() { return this },
        eq(field, value) { calls.push(['eq', field, value]); return this },
        lte(field, value) { calls.push(['lte', field, value]); return this },
        order() { return this },
        limit() { return Promise.resolve(result) },
        insert() { calls.push(['insert']); return this },
        single() { return Promise.resolve(result) },
    }
    return { calls, from(table) {
        assert.equal(table, 'agent_thought_threads')
        return builder
    } }
}

test('unexpected null list response must not be mistaken for an empty Thread table', async () => {
    const db = unusualSupabase({ data: null, error: null })
    await assert.rejects(
        listThoughtThreads({ supabase: db, userId, agentId }),
        (error) => error.code === 'THOUGHT_THREAD_READ_INVALID',
    )
    assert.ok(db.calls.some(([op, field, value]) =>
        op === 'eq' && field === 'user_id' && value === userId))
    assert.ok(db.calls.some(([op, field, value]) =>
        op === 'eq' && field === 'agent_id' && value === agentId))
})

test('invalid Thread list response disables context, not available:true with zero rows', async () => {
    const db = unusualSupabase({ data: null, error: null })
    await assert.rejects(
        loadThreadContext({ supabase: db, userId, agentId, now }),
        (error) => error.code === 'THOUGHT_THREAD_READ_INVALID',
    )
})

test('due-thread probe surfaces malformed read response for optional-gate fallback', async () => {
    const db = unusualSupabase({ data: null, error: null })
    await assert.rejects(
        hasDueThoughtThread({ supabase: db, userId, agentId, now }),
        (error) => error.code === 'THOUGHT_THREAD_READ_INVALID',
    )
})

test('unacknowledged insert must never count as a newly created durable Thread', async () => {
    const db = unusualSupabase({ data: null, error: null })
    await assert.rejects(
        createThoughtThread({ supabase: db, userId, agentId,
            title: 'An idea worth revisiting', currentDraft: 'Initial draft',
            now }),
        (error) => error.code === 'THOUGHT_THREAD_WRITE_UNCONFIRMED',
    )
    assert.ok(db.calls.some(([op]) => op === 'insert'))
})

test('real empty array remains a legitimate no-Thread outcome', async () => {
    const db = unusualSupabase({ data: [], error: null })
    assert.deepEqual(await listThoughtThreads({ supabase: db, userId, agentId }), [])
    assert.equal(await hasDueThoughtThread({ supabase: db, userId, agentId, now }), false)
    const context = await loadThreadContext({ supabase: db, userId, agentId, now })
    assert.equal(context.available, true)
    assert.deepEqual(context.eligible, [])
})
