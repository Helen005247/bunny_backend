'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyModelError, modelText } = require('../services/diary/diaryWriter')
const { safeErrorCode } = require('../services/diary/diaryService')
const { safeLog } = require('../scripts/diary-review')

function failure(properties) {
    return Object.assign(new Error('SENSITIVE PRIVATE TEXT - DO NOT LOG'), properties)
}

const cases = [
    [{ status: 400 }, 'model_invalid_request'],
    [{ status: 401 }, 'model_auth_failed'],
    [{ status: 403 }, 'model_access_forbidden'],
    [{ status: 404 }, 'model_route_not_found'],
    [{ status: 408 }, 'model_timeout'],
    [{ status: 413 }, 'model_request_too_large'],
    [{ status: 422 }, 'model_invalid_request'],
    [{ status: 429 }, 'model_rate_limited'],
    [{ status: 500 }, 'model_upstream_failure'],
    [{ status: 502 }, 'model_upstream_failure'],
    [{ status: 503 }, 'model_upstream_failure'],
    [{ status: 504 }, 'model_timeout'],
    [{ response: { status: 403 } }, 'model_access_forbidden'],
    [{ cause: { status: 429 } }, 'model_rate_limited'],
    [{ code: 'ETIMEDOUT' }, 'model_timeout'],
    [{ code: 'ECONNRESET' }, 'model_connection_failure'],
    [{ name: 'APIConnectionError' }, 'model_connection_failure'],
    [{ name: 'AbortError' }, 'model_timeout'],
    [{}, 'model_unavailable'],
]

test('safe error classifications for HTTP, transport and unknown failures', () => {
    for (const [input, expected] of cases) {
        const result = classifyModelError(failure(input))
        assert.equal(result, expected)
        assert.equal(safeErrorCode({code: result}), result)
        const logged = safeLog({ status: 'failed', code: result, processed: 1 })
        assert.match(logged, new RegExp(`code=${result}`))
        assert.doesNotMatch(logged, /SENSITIVE|PRIVATE|TEXT/)
    }
})

test('do not repeat permanent 400, 401, 403, 404, 413', async () => {
    for (const status of [400, 401, 403, 404, 413]) {
        let calls = 0
        await assert.rejects(
            modelText(async () => { calls++; throw failure({status}) }, 'test', {
                sleep: async () => { throw new Error('sleep must not run') },
            }),
            { code: classifyModelError({status}) },
        )
        assert.equal(calls, 1)
    }
})

test('quick transient 429 retries once then succeeds', async () => {
    const sleeps=[]
    let calls=0
    const result = await modelText(async () => {
        calls++
        if (calls === 1) throw failure({ status: 429 })
        return { output_text: '{"observations":[]}' }
    }, 'test', { sleep: async (ms) => sleeps.push(ms) })
    assert.deepEqual(result, { observations: [] })
    assert.equal(calls, 2)
    assert.deepEqual(sleeps, [3000])
})

test('quick server 503 retries once, never spins indefinitely', async () => {
    let calls=0
    await assert.rejects(modelText(async () => {
        calls++
        throw failure({ status: 503 })
    }, 'test', { sleep: async () => {} }), { code:'model_upstream_failure' })
    assert.equal(calls, 2)
})

test('slow upstream failures do not double the wait', async () => {
    let calls=0
    let clock=0
    await assert.rejects(modelText(async () => {
        calls++
        clock=45000
        throw failure({status:503})
    }, 'test', {
        nowMs: () => clock,
        sleep: async () => { throw new Error('unexpected sleep') },
    }), {code:'model_upstream_failure'})
    assert.equal(calls, 1)
})

test('empty successful response is not mislabelled as provider outage', async () => {
    await assert.rejects(modelText(async () => ({ output_text: '' }), 'test'),
        { code:'model_empty_output' })
})

test('invalid JSON is not mislabelled as provider outage', async () => {
    await assert.rejects(modelText(async () => ({ output_text: 'not json' }), 'test'),
        { code:'invalid_model_json' })
})

test('model input is passed unchanged across a retry', async () => {
    const inputs=[]
    await modelText(async ({ model, input }) => {
        inputs.push({ model, input })
        if (inputs.length === 1) throw failure({ code: 'ECONNRESET' })
        return { output_text: '{"write":false}' }
    }, 'MARKED_TEST_INPUT', { sleep: async () => {} })
    assert.equal(inputs.length, 2)
    assert.deepEqual(inputs[0], inputs[1])
})
