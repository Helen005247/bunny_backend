'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
    DEFAULT_MANUAL_COOLDOWN_MINUTES,
    HEARTBEAT_COOLDOWN_MINUTES,
    getCognitionCooldownMinutes,
    getManualCooldownMinutes,
} = require('../services/cognition/cooldownPolicy')
const {
    evaluateWakeGate,
    HEARTBEAT_ACTIVITY_KEY,
    MANUAL_ACTIVITY_KEY,
} = require('../services/cognition/wakeGate')

const NOW = '2026-11-07T12:00:00.000Z'
const at = (minutes) => new Date(Date.parse(NOW) + minutes * 60000)

function state(overrides = {}) {
    return {
        last_user_message_at: '2026-11-07T11:55:00.000Z',
        last_wake_at: null,
        last_cognition_at: null,
        absence_started_at: null,
        absence_checkpoint: 0,
        next_review_at: null,
        metadata: {},
        ...overrides,
    }
}

test('manual cooldown defaults to 60 and can be temporarily set to 5; heartbeat stays fixed', () => {
    assert.equal(DEFAULT_MANUAL_COOLDOWN_MINUTES, 60)
    assert.equal(HEARTBEAT_COOLDOWN_MINUTES, 60)
    assert.equal(getManualCooldownMinutes({}), 60)
    assert.equal(getCognitionCooldownMinutes('manual', { COGNITION_MANUAL_COOLDOWN_MINUTES: '5' }), 5)
    assert.equal(getCognitionCooldownMinutes('heartbeat', { COGNITION_MANUAL_COOLDOWN_MINUTES: '5' }), 60)
})

test('manual cooldown configuration rejects zero, fractions and values above 60', () => {
    for (const value of ['0', '1.5', '61', '-1', 'abc']) {
        assert.throws(() => getManualCooldownMinutes({
            COGNITION_MANUAL_COOLDOWN_MINUTES: value,
        }), /1～60/)
    }
})

test('manual gate uses its own clock and seeds the legacy heartbeat anchor once', () => {
    const before = state({
        last_wake_at: '2026-11-07T11:30:00.000Z',
        last_cognition_at: '2026-11-07T11:30:00.000Z',
    })
    const first = evaluateWakeGate({
        state: before, now: new Date(NOW), triggerType: 'manual', cooldownMinutes: 5,
    })
    assert.equal(first.shouldWake, true)
    assert.deepEqual(first.reasons, ['manual'])
    assert.equal(first.patch.last_wake_at, undefined)
    assert.equal(first.patch.metadata[MANUAL_ACTIVITY_KEY], NOW)
    assert.equal(first.patch.metadata[HEARTBEAT_ACTIVITY_KEY], before.last_cognition_at)

    const afterManual = {
        ...before,
        ...first.patch,
        last_cognition_at: NOW,
    }
    const tooSoon = evaluateWakeGate({
        state: afterManual, now: at(4), triggerType: 'manual', cooldownMinutes: 5,
    })
    assert.equal(tooSoon.shouldWake, false)
    assert.equal(tooSoon.inCooldown, true)

    // A manual cognition at 12:00 does not move the heartbeat anchor from 11:30.
    const heartbeatBefore60 = evaluateWakeGate({
        state: { ...afterManual, next_review_at: '2026-11-07T11:00:00.000Z' },
        now: at(29), triggerType: 'heartbeat', cooldownMinutes: 60,
    })
    assert.equal(heartbeatBefore60.shouldWake, false)
    assert.equal(heartbeatBefore60.inCooldown, true)
    const heartbeatAt60 = evaluateWakeGate({
        state: { ...afterManual, next_review_at: '2026-11-07T11:00:00.000Z' },
        now: at(30), triggerType: 'heartbeat', cooldownMinutes: 60,
    })
    assert.equal(heartbeatAt60.shouldWake, true)
    assert.equal(heartbeatAt60.inCooldown, false)
    assert.equal(heartbeatAt60.patch.metadata[HEARTBEAT_ACTIVITY_KEY], at(30).toISOString())
})

test('manual run with no legacy heartbeat history cannot start the heartbeat clock', () => {
    const first = evaluateWakeGate({
        state: state(), now: new Date(NOW), triggerType: 'manual', cooldownMinutes: 5,
    })
    assert.equal(first.shouldWake, true)
    assert.equal(first.patch.metadata[HEARTBEAT_ACTIVITY_KEY], null)

    const afterManual = {
        ...state(), ...first.patch, last_cognition_at: NOW,
        next_review_at: '2026-11-07T11:00:00.000Z',
    }
    const heartbeat = evaluateWakeGate({
        state: afterManual, now: at(1), triggerType: 'heartbeat', cooldownMinutes: 60,
    })
    assert.equal(heartbeat.shouldWake, true)
    assert.equal(heartbeat.inCooldown, false)
})

test('legacy rows without the new metadata key keep their existing heartbeat cooldown', () => {
    const legacy = state({
        last_wake_at: '2026-11-07T11:30:00.000Z',
        last_cognition_at: '2026-11-07T11:30:00.000Z',
        next_review_at: '2026-11-07T11:00:00.000Z',
    })
    const result = evaluateWakeGate({
        state: legacy, now: at(29), triggerType: 'heartbeat', cooldownMinutes: 60,
    })
    assert.equal(result.shouldWake, false)
    assert.equal(result.inCooldown, true)
})
