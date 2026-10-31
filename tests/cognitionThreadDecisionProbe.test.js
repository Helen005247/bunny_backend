'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { syntheticFixture, diagnose, safeTimeout, CASES } = require('./cognitionThreadDecisionProbe')
const { buildCognitionInput } = require('../services/cognition/cognitionService')

const FIXED = new Date('2026-10-31T12:00:00.000Z')
const wrap = (action, shouldStore = false) => JSON.stringify({
    should_store: shouldStore, thought: shouldStore ? '值得记住的一点' : '',
    emotion: '平静', significance: 0.5, pending_topic: null, review_after: null,
    thread_action: action,
})

test('two synthetic fixtures provide distinct meaningful scenarios and empty Thread context', () => {
    assert.deepEqual(CASES, ['ordinary', 'continuation'])
    const ordinary = buildCognitionInput(syntheticFixture('ordinary', FIXED))
    const continuation = buildCognitionInput(syntheticFixture('continuation', FIXED))
    assert.match(ordinary, /午饭/)
    assert.match(continuation, /过两三天/)
    assert.match(ordinary, /periodic_autonomous/)
    assert.match(continuation, /thread_action/)
    assert.match(continuation, /eligibleThreads/)
    assert.notEqual(ordinary, continuation)
})

test('decision diagnostics distinguish explicit none, omission, invalid and create', () => {
    assert.equal(diagnose(wrap({ type: 'none' }), FIXED).decision, 'explicit_none')
    const omitted = JSON.parse(wrap({ type: 'none' }))
    delete omitted.thread_action
    assert.equal(diagnose(JSON.stringify(omitted), FIXED).decision, 'omitted')
    assert.equal(diagnose(wrap({ type: 'unknown' }), FIXED).decision, 'invalid')
    assert.equal(diagnose(wrap({ type: 'create', title: '生日祝福的构思',
        current_draft: '祝福开头从一件共同经历开始',
        next_step: '过两天再考虑结尾', next_review_at: null }), FIXED).decision, 'create')
})

test('default timeout is bounded and cannot accidentally stretch to minutes', () => {
    assert.equal(safeTimeout(undefined), 90000)
    assert.equal(safeTimeout('200000'), 90000)
    assert.equal(safeTimeout('55000'), 55000)
    assert.equal(safeTimeout('1'), 90000)
})

test('offline module import and fixture construction do not require secrets', () => {
    const fixture = syntheticFixture('ordinary', FIXED)
    assert.equal(fixture.memory, null)
    assert.equal(fixture.threadContext.available, true)
    assert.equal(fixture.threadContext.eligible.length, 0)
    assert.equal(fixture.threadContext.known.length, 0)
})
