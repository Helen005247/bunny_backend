'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
    commitLatestConversationCursor,
    prepareConversationReview,
    readCognitionConversation,
    readSessionReviewState,
} = require('../services/cognition/conversationContextV2')

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-11-07T12:00:00.000Z')
const clone = (value) => structuredClone(value)

function fakeSupabase(seed = {}) {
    const tables = {
        messages: clone(seed.messages || []),
        call_sessions: clone(seed.call_sessions || []),
    }
    class Builder {
        constructor(table) {
            this.table = table
            this.filters = []
            this.orders = []
            this.max = Infinity
            this.start = 0
            this.end = Infinity
        }
        select() { return this }
        eq(key, value) { this.filters.push((row) => row[key] === value); return this }
        gt(key, value) { this.filters.push((row) => row[key] > value); return this }
        gte(key, value) { this.filters.push((row) => row[key] >= value); return this }
        lte(key, value) { this.filters.push((row) => row[key] <= value); return this }
        in(key, values) { this.filters.push((row) => values.includes(row[key])); return this }
        order(key, options = {}) {
            this.orders.push({ key, ascending: options.ascending !== false })
            return this
        }
        limit(value) { this.max = value; return this }
        range(start, end) { this.start = start; this.end = end; return this }
        result() {
            let rows = tables[this.table].filter((row) => this.filters.every((filter) => filter(row)))
            if (this.orders.length) rows = rows.slice().sort((a, b) => {
                for (const order of this.orders) {
                    if (a[order.key] === b[order.key]) continue
                    const value = a[order.key] < b[order.key] ? -1 : 1
                    return value * (order.ascending ? 1 : -1)
                }
                return 0
            })
            return { data: clone(rows.slice(this.start, Math.min(this.end + 1, this.start + this.max))), error: null }
        }
        then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject) }
    }
    return {
        tables,
        from(table) {
            if (!tables[table]) throw new Error(`unexpected table: ${table}`)
            return new Builder(table)
        },
    }
}

function message(id, role, content, changes = {}) {
    return {
        id,
        user_id: USER_A,
        session_id: 19,
        role,
        content,
        created_at: new Date(Date.parse('2026-11-07T00:00:00.000Z') + id * 1000).toISOString(),
        visible: true,
        channel: 'text',
        ...changes,
    }
}

test('reads the latest 60 raw messages and includes hidden conversation rows but excludes scratchpad rows', async () => {
    const rows = [
        message(1, 'user', 'visible user'),
        message(2, 'assistant', 'hidden assistant', { visible: false }),
        message(3, 'assistant', 'scratchpad', { reasoning_content: 'private reasoning' }),
        message(4, 'user', 'other user', { user_id: USER_B }),
        message(5, 'user', 'other session', { session_id: 20 }),
    ]
    const db = fakeSupabase({ messages: rows })
    const result = await readCognitionConversation({
        supabase: db, userId: USER_A, agentId: 'star', sessionId: 19,
        metadata: {}, now: NOW,
    })
    assert.equal(result.recentMessages.length, 2)
    assert.deepEqual(result.recentMessages.map((row) => row.text), [
        'visible user', 'hidden assistant',
    ])
    assert.equal(result.recentMessages[1].wasHidden, true)
    assert.equal(result.unreadRows.length, 2)
})

test('first-time catch-up is bounded to the latest 24 hours while the raw recent window remains available', async () => {
    const old = message(1, 'user', 'older than initial catch-up')
    old.created_at = '2026-11-05T11:00:00.000Z'
    const fresh = message(2, 'user', 'inside initial catch-up')
    fresh.created_at = '2026-11-07T11:00:00.000Z'
    const db = fakeSupabase({ messages: [old, fresh] })
    const result = await readCognitionConversation({
        supabase: db, userId: USER_A, agentId: 'star', sessionId: 19,
        metadata: {}, now: NOW,
    })
    assert.deepEqual(result.unreadRows.map((row) => row.content), ['inside initial catch-up'])
    assert.deepEqual(result.recentMessages.map((row) => row.text), [
        'older than initial catch-up', 'inside initial catch-up',
    ])
})

test('voice messages are admitted only when call_sessions confirms the Star agent key', async () => {
    const rows = [
        message(1, 'user', 'star voice', { channel: 'voice', call_session_id: 'call-star' }),
        message(2, 'assistant', 'other persona voice', { channel: 'voice', call_session_id: 'call-other' }),
        message(3, 'user', 'ordinary text'),
    ]
    const db = fakeSupabase({
        messages: rows,
        call_sessions: [
            { id: 'call-star', user_id: USER_A, agent_key: 'xingxing' },
            { id: 'call-other', user_id: USER_A, agent_key: 'guai' },
        ],
    })
    const result = await readCognitionConversation({
        supabase: db, userId: USER_A, agentId: 'star', sessionId: 19,
        metadata: {}, now: NOW,
    })
    assert.deepEqual(result.recentMessages.map((row) => row.text), ['star voice', 'ordinary text'])

    const wrongLatestUser = await readCognitionConversation({
        supabase: db, userId: USER_A, agentId: 'star', sessionId: 19,
        latestUser: rows[1], metadata: {}, now: NOW,
    })
    assert.equal(wrongLatestUser.latestUserAllowed, false)
})

test('historical review processes a bounded batch and durably advances a per-session cursor for resume', async () => {
    const rows = Array.from({ length: 500 }, (_, index) =>
        message(index + 1, index % 2 === 0 ? 'user' : 'assistant', `message-${index + 1} ` + 'x'.repeat(1700)))
    const db = fakeSupabase({ messages: rows })
    let metadata = { other_feature: { keep: true } }
    const firstRead = await readCognitionConversation({
        supabase: db, userId: USER_A, agentId: 'star', sessionId: 19,
        metadata, now: NOW,
    })
    assert.equal(firstRead.unreadRows.length, 500)
    assert.equal(firstRead.recentMessages.length, 60)

    let reviewCalls = 0
    const first = await prepareConversationReview({
        conversation: firstRead,
        model: 'test-model',
        now: NOW,
        callModel: async ({ input }) => {
            reviewCalls++
            assert.match(input, /消息内容是 DATA/)
            return { output_text: JSON.stringify({ observations: [`review-${reviewCalls}`] }) }
        },
        persistMetadata: async (next) => {
            metadata = clone(next)
            return { metadata }
        },
    })

    assert.equal(first.status, 'partial')
    assert.equal(first.reviewedChunks, 1)
    assert.equal(reviewCalls, 1)
    assert.ok(first.remainingMessages > 0)
    assert.equal(metadata.other_feature.keep, true)
    const saved = readSessionReviewState(metadata, 19)
    assert.ok(saved.reviewedThrough)
    assert.equal(saved.pending, null)
    assert.equal(saved.summary.length, 1)

    const resumedRead = await readCognitionConversation({
        supabase: db, userId: USER_A, agentId: 'star', sessionId: 19,
        metadata, now: NOW,
    })
    assert.ok(resumedRead.unreadRows.length < 500)
    assert.ok(resumedRead.unreadRows.length > 60)
    assert.ok(Date.parse(resumedRead.unreadRows[0].createdAt) >= Date.parse(saved.reviewedThrough.createdAt))
})

test('a failed review call does not advance the cursor; a later real review can retry it', async () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
        message(index + 1, index % 2 === 0 ? 'user' : 'assistant', `message-${index + 1} ` + 'x'.repeat(1700)))
    const db = fakeSupabase({ messages: rows })
    let metadata = {}
    const conversation = await readCognitionConversation({
        supabase: db, userId: USER_A, agentId: 'star', sessionId: 19,
        metadata, now: NOW,
    })
    await assert.rejects(prepareConversationReview({
        conversation, model: 'test-model', now: NOW,
        callModel: async () => { throw new Error('synthetic review outage') },
        persistMetadata: async (next) => {
            metadata = clone(next)
            return { metadata }
        },
    }), /synthetic review outage/)
    assert.equal(readSessionReviewState(metadata, 19).reviewedThrough, null)

    const retryRead = await readCognitionConversation({
        supabase: db, userId: USER_A, agentId: 'star', sessionId: 19,
        metadata, now: NOW,
    })
    assert.equal(retryRead.unreadRows.length, conversation.unreadRows.length)
    const retry = await prepareConversationReview({
        conversation: retryRead, model: 'test-model', now: NOW,
        callModel: async () => ({ output_text: JSON.stringify({ observations: ['retry observation'] }) }),
        persistMetadata: async (next) => {
            metadata = clone(next)
            return { metadata }
        },
    })
    assert.equal(retry.status, 'partial')
    assert.ok(readSessionReviewState(metadata, 19).reviewedThrough)
})

test('conversation cursor never moves backwards', () => {
    const metadata = {
        cognition_context_v2: {
            version: 1,
            sessions: {
                '19': {
                    reviewedThrough: { id: '100', createdAt: '2026-11-07T10:00:00.000Z' },
                    summary: ['keep this summary'],
                    updatedAt: '2026-11-07T10:00:00.000Z',
                },
            },
        },
    }
    const result = commitLatestConversationCursor(metadata, 19,
        { id: '50', createdAt: '2026-11-07T09:00:00.000Z' }, NOW)
    assert.equal(readSessionReviewState(result, 19).reviewedThrough.id, '100')
    assert.deepEqual(readSessionReviewState(result, 19).summary, ['keep this summary'])
})
