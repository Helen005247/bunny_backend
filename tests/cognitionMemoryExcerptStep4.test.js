'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { excerptMemorySummary, MAX_MEMORY_EXCERPT_CHARS,
    OMITTED_MIDDLE_MARKER } = require('../services/cognition/memoryExcerpt')
const { buildCognitionInput } = require('../services/cognition/cognitionService')

test('missing or non-string memory stays empty', () => {
    for (const value of [undefined, null, {}, ['x'], 0]) {
        assert.equal(excerptMemorySummary(value), '')
    }
})

test('short memory stays intact after trimming', () => {
    assert.equal(excerptMemorySummary('  useful memory  '), 'useful memory')
    assert.equal(excerptMemorySummary('a'.repeat(MAX_MEMORY_EXCERPT_CHARS)),
        'a'.repeat(MAX_MEMORY_EXCERPT_CHARS))
})

test('long memory keeps both distinct ends, stays bounded, and does not mutate source', () => {
    const text = 'H'.repeat(800) + 'M'.repeat(650) + 'T'.repeat(802)
    const source = { summary: text }
    const result = excerptMemorySummary(source.summary)
    assert.equal(result.length, MAX_MEMORY_EXCERPT_CHARS)
    assert.ok(result.startsWith('H'.repeat(500)))
    assert.ok(result.endsWith('T'.repeat(500)))
    assert.ok(result.includes(OMITTED_MIDDLE_MARKER))
    assert.equal(result.includes('M'), false)
    assert.equal(source.summary, text)
})

test('production input uses the bounded head-and-tail excerpt', () => {
    const summary = 'BEGIN'.repeat(220) + 'MIDDLE'.repeat(200) + 'END'.repeat(300)
    const input = buildCognitionInput({
        now: new Date('2026-11-01T12:00:00.000Z'),
        state: { last_user_message_at: '2026-10-31T12:00:00.000Z',
            absence_checkpoint: 0 },
        wakeReasons: ['periodic_autonomous'],
        messages: [], settings: {}, memory: { summary },
        milestones: null, recentThoughts: [],
        threadContext: { available: true, eligible: [], known: [] },
    })
    const expected = excerptMemorySummary(summary)
    assert.ok(input.includes(JSON.stringify(expected)))
    assert.ok(expected.includes('BEGIN'))
    assert.ok(expected.includes('END'))
    assert.ok(!expected.includes('MIDDLE'))
})


test('surrogate pairs are not split at excerpt boundaries', () => {
    const text = '🐱'.repeat(600) + 'M'.repeat(600) + '🐶'.repeat(700)
    const excerpt = excerptMemorySummary(text)
    assert.ok(excerpt.length <= MAX_MEMORY_EXCERPT_CHARS)
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(excerpt), false)
    assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(excerpt), false)
})
