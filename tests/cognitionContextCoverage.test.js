'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { summarizeCognitionContext } = require('../services/cognition/contextCoverage')
const { sendHeartbeat, formatHeartbeatLog } = require('../scripts/cognition-heartbeat')
const { buildCognitionInput } = require('../services/cognition/cognitionService')

const AUTH = {
    endpoint: 'https://example.org/internal/cognition/tick',
    userId: '123e4567-e89b-42d3-a456-426614174000',
    secret: 'non-secret-test-key-of-sufficient-length',
}
const response = (value) => ({ ok: true, status: 200, json: async () => value })

// All fixtures are synthetic. No production records, network or database.
test('only reports fixed presence labels for real prompt fields', () => {
    const status = summarizeCognitionContext({
        messages: [{ text: '虚构的待续旅行计划' }],
        memory: { summary: '虚构的记忆' }, memoryConfigured: true,
        milestones: { text: '虚构的日程' }, milestonesConfigured: true,
        previousThoughts: [{ content: '虚构的旧想法' }],
        state: { pending_topic: '稍后再考虑' },
    })
    assert.deepEqual(status, { messages: 'present', memory: 'present',
        milestones: 'present', previousThoughts: 'present', pendingTopic: 'present' })
    assert.doesNotMatch(JSON.stringify(status), /旅行|日程|虚构/)
})

test('detects an unwired provider without inventing a missing database fact', () => {
    const status = summarizeCognitionContext({ messages: [],
        memoryConfigured: false, milestonesConfigured: false })
    assert.deepEqual(status, { messages: 'empty', memory: 'unwired',
        milestones: 'unwired', previousThoughts: 'empty', pendingTopic: 'empty' })
})

test('distinguishes empty summary from response shape mismatch', () => {
    const empty = summarizeCognitionContext({ memoryConfigured: true,
        milestonesConfigured: true, memory: { summary: '' }, milestones: null })
    assert.equal(empty.memory, 'empty')
    assert.equal(empty.milestones, 'empty')
    const wrong = summarizeCognitionContext({ memoryConfigured: true,
        milestonesConfigured: true, memory: 'raw string instead of summary object',
        milestones: { dates: [] } })
    assert.equal(wrong.memory, 'shape_mismatch')
    assert.equal(wrong.milestones, 'shape_mismatch')
})

test('heartbeat sanitizes every context label and drops extra private fields', async () => {
    const PRIVATE = 'PRIVATE_CONTEXT_DO_NOT_ECHO'
    const safe = await sendHeartbeat({ ...AUTH, fetchImpl: async () => response({
        ok: true, executed: true, stored: false,
        contextCoverage: { messages: 'present', memory: 'shape_mismatch',
            milestones: 'unwired', previousThoughts: 'empty', pendingTopic: 'present',
            raw_prompt: PRIVATE }, thought: PRIVATE,
    }) })
    const log = formatHeartbeatLog(safe)
    assert.match(log, /ctx_messages=present; ctx_memory=shape_mismatch/)
    assert.match(log, /ctx_milestones=unwired/)
    assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_CONTEXT_DO_NOT_ECHO/)
    const invalid = await sendHeartbeat({ ...AUTH, fetchImpl: async () => response({
        ok: true, executed: true, stored: false,
        contextCoverage: { messages: PRIVATE, memory: PRIVATE },
    }) })
    assert.match(formatHeartbeatLog(invalid), /ctx_messages=unknown; ctx_memory=unknown/)
    assert.doesNotMatch(formatHeartbeatLog(invalid), /PRIVATE_CONTEXT_DO_NOT_ECHO/)
})

test('old backend and skipped wake still produce safe unknown labels', async () => {
    const old = await sendHeartbeat({ ...AUTH, fetchImpl: async () => response({
        ok: true, executed: true, stored: false,
    }) })
    assert.match(formatHeartbeatLog(old), /ctx_memory=unknown/)
    const skipped = await sendHeartbeat({ ...AUTH, fetchImpl: async () => response({
        ok: true, executed: false, stored: false, reason: 'wake_gate_skipped',
    }) })
    assert.match(formatHeartbeatLog(skipped), /ctx_messages=unknown/)
})

test('actual prompt builder uses the same documented fields and per-source truncation', () => {
    const input = buildCognitionInput({
        now: new Date('2026-10-30T12:00:00.000Z'),
        state: { last_user_message_at: '2026-10-30T11:00:00.000Z',
            pending_topic: '虚构待续' }, wakeReasons: ['periodic_autonomous'],
        messages: [{ role: 'user', text: '虚构聊天' }],
        settings: {}, memory: { summary: '虚构记忆' },
        milestones: { text: '虚构里程碑' }, recentThoughts: [],
        threadContext: { available: true, eligible: [], known: [] },
    })
    assert.match(input, /虚构聊天/)
    assert.match(input, /虚构记忆/)
    assert.match(input, /虚构里程碑/)
    assert.match(input, /虚构待续/)
})
