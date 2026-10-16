'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseJsonResponse, modelText, reviewAndWriteDiary } =
    require('../services/diary/diaryWriter')

const sampleWindow = { periodStart: '2026-10-14T00:00:00Z',
    periodEnd: '2026-10-16T00:00:00Z', timeZone: 'UTC',
    startDate: '2026-10-14', endDate: '2026-10-15' }

function fakeSource() {
    return { rows: [
        { id: 'x', sessionId: 's', createdAt: '2026-10-14T01:00:00Z',
          role: 'user', channel: 'text', content: 'the birthday happened' },
        { id: 'y', sessionId: 's', createdAt: '2026-10-14T01:05:00Z',
          role: 'assistant', channel: 'text', content: 'we talked about a promise' },
    ], includedCount: 2 }
}

test('strict JSON object, BOM, and Markdown fenced JSON are read safely', () => {
    assert.deepEqual(parseJsonResponse('\uFEFF {"observations":[]}', 'review'),
        { observations: [] })
    assert.deepEqual(parseJsonResponse('```json\n{"observations":["A"]}\n```', 'review'),
        { observations: ['A'] })
    assert.deepEqual(parseJsonResponse('```\n{"write":false}\n```', 'draft'),
        { write: false })
})

test('single brief prose wrapper is accepted with escaped quote/braces', () => {
    const data = { observations: ['Someone wrote a { symbol and said "yes"'] }
    const input = 'Here is JSON:\n' + JSON.stringify(data) + '\nEnd.'
    assert.deepEqual(parseJsonResponse(input, 'review'), data)
})

test('ambiguity, truncation, excessive wrapper, wrong schema are rejected', () => {
    const bad = [
        'One {"observations":["a"]} two {"observations":["b"]}',
        '{"observations":["incomplete"',
        'prefix '.repeat(100) + '{"observations":["a"]}',
        '[{"observations":["a"]}]',
        '{"observations":"not array"}',
        'true',
        'this is plain text',
    ]
    for (const raw of bad) {
        assert.throws(() => parseJsonResponse(raw, 'review'),
            { code: 'invalid_model_json' })
    }
    assert.throws(() => parseJsonResponse({
        status: 'incomplete', output_text: '{"observations":[]}',
    }, 'review'), { code: 'model_incomplete_output' })
    assert.throws(() => parseJsonResponse('x'.repeat(65000)),
        { code: 'invalid_model_json' })
})

test('reprompt invalid JSON at most once and request JSON mode', async () => {
    const inputs = []
    const result = await modelText(async (opts) => {
        inputs.push(opts)
        return inputs.length === 1 ? { output_text: 'Prose, not valid JSON.' } :
            { output_text: '{"observations":["Evidence"]}' }
    }, 'ORIGINAL EVIDENCE', { shape: 'review' })
    assert.deepEqual(result, { observations: ['Evidence'] })
    assert.equal(inputs.length, 2)
    assert.equal(inputs[0].text, undefined)
    assert.deepEqual(inputs[1].text, { format: { type: 'json_object' } })
    assert.match(inputs[1].input, /ORIGINAL EVIDENCE/)
})

test('unsupported JSON mode is retried once without it, not indefinitely', async () => {
    const calls = []
    const result = await modelText(async (opts) => {
        calls.push(opts)
        if (calls.length === 1) return { output_text: 'invalid raw' }
        if (calls.length === 2) throw Object.assign(new Error('private response'), {status:400})
        return { output_text: '{"write":false,"reason":"nothing_meaningful"}' }
    }, 'source', { shape: 'draft' })
    assert.equal(calls.length, 3)
    assert.ok(calls[1].text)
    assert.equal(calls[2].text, undefined)
    assert.equal(result.write, false)
})

test('malformed correction fails closed; sensitive content is not copied to errors', async () => {
    let calls = 0
    await assert.rejects(modelText(async () => {
        calls++
        return { output_text: 'PRIVATE BIRTHDAY DETAIL invalid json' }
    }, 'SOURCE PRIVATE DATA', { shape: 'draft' }), (error) => {
        assert.equal(error.code, 'invalid_model_json')
        assert.doesNotMatch(error.message, /PRIVATE|BIRTHDAY|SOURCE/)
        return true
    })
    assert.equal(calls, 2)
})

test('non-JSON request failures are not retried as formatting errors', async () => {
    let calls = 0
    await assert.rejects(modelText(async () => {
        calls++
        throw Object.assign(new Error('secret'), { status: 403 })
    }, 'private', { shape: 'review' }), { code: 'model_access_forbidden' })
    assert.equal(calls, 1)
})

test('review and draft both recover malformed format but still validate evidence', async () => {
    const calls = []
    const draft = await reviewAndWriteDiary({
        callModel: async (opts) => {
            calls.push(opts)
            // Review first output wrong, retry structured. Draft first output
            // wrong, retry structured. No copy of user text in console logs.
            if (calls.length === 1) return { output_text: 'observations: birthday' }
            if (calls.length === 2) return { output_text: '{"observations":["A birthday was discussed"]}' }
            if (calls.length === 3) return { output_text: 'write a diary please' }
            return { output_text: JSON.stringify({ write:true,
                title:'Birthday', body:'The birthday conversation and promise mattered to me today.',
                topics:['birthday'] }) }
        },
        source: fakeSource(), window: sampleWindow, requested: true,
    })
    assert.equal(draft.action, 'written')
    assert.equal(draft.chunks, 1)
    assert.equal(calls.length, 4)
    assert.equal(calls[1].text.format.type, 'json_object')
    assert.equal(calls[3].text.format.type, 'json_object')
    assert.equal(draft.title, 'Birthday')
})
