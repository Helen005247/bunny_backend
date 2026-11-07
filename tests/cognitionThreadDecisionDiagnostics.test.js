'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseCognitionOutput } = require('../services/cognition/cognitionService')
const { sendHeartbeat, formatHeartbeatLog } = require('../scripts/cognition-heartbeat')

const NOW = new Date('2026-10-20T12:00:00.000Z')
const common = { should_store: false, thought: '', significance: 0.5 }
const opts = {
    endpoint: 'https://test.example.org/internal/cognition/tick',
    userId: '123e4567-e89b-42d3-a456-426614174000',
    secret: 'this-is-a-test-secret-with-24-plus-chars',
}
const response = value => ({ ok: true, status: 200, json: async () => value })

test('decision reason fields accept only fixed labels and remain optional for old outputs', () => {
    const legacy = parseCognitionOutput(JSON.stringify(common), NOW)
    assert.equal(legacy.thoughtReason, 'unreported')
    assert.equal(legacy.threadReason, 'unreported')

    const labelled = parseCognitionOutput(JSON.stringify({ ...common,
        thought_reason: 'no_new_information',
        thread_reason: 'no_continuation_value',
    }), NOW)
    assert.equal(labelled.thoughtReason, 'no_new_information')
    assert.equal(labelled.threadReason, 'no_continuation_value')

    const untrusted = parseCognitionOutput(JSON.stringify({ ...common,
        thought_reason: 'PRIVATE_MESSAGE_MUST_NOT_BE_LOGGED',
        thread_reason: 'arbitrary model explanation',
    }), NOW)
    assert.equal(untrusted.thoughtReason, 'unreported')
    assert.equal(untrusted.threadReason, 'unreported')
})

test('parsing distinguishes missing and explicit none without changing stored behavior', () => {
    const missing = parseCognitionOutput(JSON.stringify(common), NOW)
    assert.equal(missing.threadAction.type, 'none')
    assert.equal(missing.threadActionProvided, false)
    assert.equal(missing.threadActionInvalid, false)
    const nullable = parseCognitionOutput(JSON.stringify({ ...common, thread_action: null }), NOW)
    assert.equal(nullable.threadAction.type, 'none')
    assert.equal(nullable.threadActionProvided, false)
    const explicit = parseCognitionOutput(JSON.stringify({ ...common,
        thread_action: { type: 'none' } }), NOW)
    assert.equal(explicit.threadActionProvided, true)
    assert.equal(explicit.threadActionInvalid, false)
    const invalid = parseCognitionOutput(JSON.stringify({ ...common,
        thread_action: { type: 'unknown' } }), NOW)
    assert.equal(invalid.threadActionProvided, true)
    assert.equal(invalid.threadActionInvalid, true)
    assert.equal(invalid.threadAction.type, 'none')
})

test('heartbeat reports fixed labels and never echoes private model content', async () => {
    const PRIVATE = 'PRIVATE_DRAFT_MUST_NOT_APPEAR\nPRIVATE'
    const safe = await sendHeartbeat({ ...opts, fetchImpl: async () => response({
        ok: true, executed: true, stored: false, threadStatus: 'none',
        threadDecision: 'explicit_none', threadContextStatus: 'empty',
        thought: PRIVATE, thoughtId: PRIVATE,
    }) })
    assert.equal(safe.threadDecision, 'explicit_none')
    assert.equal(safe.threadContextStatus, 'empty')
    assert.match(formatHeartbeatLog(safe), /decision=explicit_none; thread_context=empty/)
    assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_DRAFT/)
    const unsafe = await sendHeartbeat({ ...opts, fetchImpl: async () => response({
        ok: true, executed: true, stored: false, threadStatus: 'none',
        threadDecision: PRIVATE, threadContextStatus: PRIVATE,
    }) })
    assert.match(formatHeartbeatLog(unsafe), /decision=unknown; thread_context=unknown/)
    assert.doesNotMatch(formatHeartbeatLog(unsafe), /PRIVATE_DRAFT/)
})

test('old deployments and skipped gates retain compatibility', async () => {
    const old = await sendHeartbeat({ ...opts, fetchImpl: async () => response({
        ok: true, executed: true, stored: false, threadStatus: 'none',
    }) })
    assert.match(formatHeartbeatLog(old), /decision=unknown; thread_context=unknown/)
    const skipped = await sendHeartbeat({ ...opts, fetchImpl: async () => response({
        ok: true, executed: false, stored: false, reason: 'wake_gate_skipped',
    }) })
    assert.equal(skipped.reason, 'wake_gate_skipped')
})
