'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { cognitionModelTimeoutMs, createCognitionModelCaller } =
    require('../services/cognition/modelCallPolicy')

test('Cognition defaults to 90s per attempt; two attempts are only for quick errors', async () => {
    const calls = []
    const run = createCognitionModelCaller({
        timeoutMs: undefined,
        callModelWithRetry: (...args) => {
            calls.push(args)
            return Promise.resolve({ output_text: '{"should_store":false}' })
        },
    })
    const request = { model: 'test', input: 'test input' }
    const result = await run(request)
    assert.equal(result.output_text, '{"should_store":false}')
    assert.equal(calls.length, 1)
    assert.strictEqual(calls[0][0], request)
    assert.equal(calls[0][1], 2)
    assert.deepEqual(calls[0][2], { timeout: 90000 })
})

test('Cognition timeout is independently configurable and bounded', () => {
    assert.equal(cognitionModelTimeoutMs('60000'), 60000)
    assert.equal(cognitionModelTimeoutMs('2000'), 45000)
    assert.equal(cognitionModelTimeoutMs('999999'), 105000)
    for (const invalid of ['', 'NaN', '-10', 'Infinity', undefined]) {
        assert.equal(cognitionModelTimeoutMs(invalid), 90000)
    }
})

test('Cognition caller forwards bounded timeout to the existing retry implementation', async () => {
    let args
    const run = createCognitionModelCaller({
        timeoutMs: '200000',
        callModelWithRetry: (...received) => {
            args = received
            return Promise.resolve({ output_text: '{}' })
        },
    })
    await run({ input: 'test' })
    assert.equal(args[1], 2)
    assert.deepEqual(args[2], { timeout: 105000 })
})

test('Cognition model failure propagates; helper does not fake a skip or success', async () => {
    const failure = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
    const run = createCognitionModelCaller({
        callModelWithRetry: async () => { throw failure },
    })
    await assert.rejects(run({ input: 'test' }), (error) => error === failure)
})

test('Cognition caller requires a real model-call dependency', () => {
    assert.throws(() => createCognitionModelCaller({}), TypeError)
})
