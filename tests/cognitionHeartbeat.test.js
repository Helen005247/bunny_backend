'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { assertConfig, sendHeartbeat } = require('../scripts/cognition-heartbeat')

const URL = 'https://bunny-backend-19g1.onrender.com/internal/cognition/tick'
const UUID = '123e4567-e89b-42d3-a456-426614174000'
const SECRET = 'example-test-secret-at-least-24-characters'

const args = { endpoint: URL, userId: UUID, secret: SECRET }
const jsonResponse = (value) => ({ ok: true, status: 200, json: async () => value })

test('workflow schedules heartbeat separately from proactive and never uses manual trigger', () => {
    const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/cognition-heartbeat.yml'), 'utf8')
    assert.match(workflow, /cron:\s*['"]23 \*\/3 \* \* \*['"]/) // interval
    assert.match(workflow, /workflow_dispatch:/)
    assert.match(workflow, /COGNITION_USER_ID:.*secrets\.COGNITION_USER_ID/)
    assert.match(workflow, /COGNITION_TICK_SECRET:.*secrets\.COGNITION_TICK_SECRET/)
    assert.match(workflow, /node scripts\/cognition-heartbeat\.js/)
    assert.doesNotMatch(workflow, /PROACTIVE_CRON_SECRET|api\/proactive-check/)
})

test('valid heartbeat sends exactly private POST with heartbeat gate enabled', async () => {
    let called = 0
    const result = await sendHeartbeat({ ...args, fetchImpl: async (url, options) => {
        called++
        assert.equal(url, URL)
        assert.equal(options.method, 'POST')
        assert.equal(options.headers['x-cognition-secret'], SECRET)
        assert.deepEqual(JSON.parse(options.body), {
            userId: UUID, agentId: 'star', triggerType: 'heartbeat',
        })
        return jsonResponse({ ok: true, executed: true, stored: true,
            thought: 'Private thought must never be logged or returned', thoughtId: 'secret-id',
            wakeReasons: ['continued_absence'] })
    } })
    assert.equal(called, 1)
    assert.deepEqual(result, { executed: true, stored: true, reason: null })
    assert.equal(JSON.stringify(result).includes('Private thought'), false)
})

test('wake gate skip is successful, does not force thinking', async () => {
    const result = await sendHeartbeat({ ...args, fetchImpl: async () => jsonResponse({
        ok: true, executed: false, reason: 'wake_gate_skipped', pendingReasons: [],
    }) })
    assert.deepEqual(result, {
        executed: false, stored: false, reason: 'wake_gate_skipped',
    })
})

test('invalid identities, missing secret, unsafe URL fail BEFORE HTTP request', async () => {
    let called = 0
    const mock = async () => { called++; return jsonResponse({ ok: true, executed: false }) }
    for (const changes of [
        { userId: '' }, { userId: 'bad-id' }, { secret: 'too-short' },
        { endpoint: 'http://bunny-backend-19g1.onrender.com/internal/cognition/tick' },
        { endpoint: 'https://bad.example/other/endpoint' },
        { endpoint: 'https://username:password@example.org/internal/cognition/tick' },
    ]) {
        await assert.rejects(() => sendHeartbeat({ ...args, ...changes, fetchImpl: mock }))
    }
    assert.equal(called, 0)
})

test('401 fails without retry; nothing sensitive appears in errors', async () => {
    let calls = 0
    await assert.rejects(() => sendHeartbeat({ ...args, fetchImpl: async () => {
        calls++
        return { ok: false, status: 401 }
    } }), /HTTP 401/)
    assert.equal(calls, 1)
})

test('502 retries once and then succeeds; no duplicate forced thought', async () => {
    let calls = 0
    const result = await sendHeartbeat({ ...args, sleep: async () => {},
        fetchImpl: async () => (++calls === 1)
            ? { ok: false, status: 502 }
            : jsonResponse({ ok: true, executed: false, reason: 'cooldown' }),
    })
    assert.equal(calls, 2)
    assert.equal(result.reason, 'cooldown')
})

test('network failure retries once; malformed or invalid JSON fails', async () => {
    let calls = 0
    await assert.rejects(() => sendHeartbeat({ ...args, sleep: async () => {},
        fetchImpl: async () => { calls++; throw new Error('network failed') },
    }), /网络或超时/)
    assert.equal(calls, 2)
    await assert.rejects(() => sendHeartbeat({ ...args,
        fetchImpl: async () => ({ ok: true, status: 200,
            json: async () => { throw new Error('malformed') } }),
    }), /不是 JSON/)
    await assert.rejects(() => sendHeartbeat({ ...args,
        fetchImpl: async () => jsonResponse({ ok: true, executed: 'no' }),
    }), /返回格式错误/)
})
