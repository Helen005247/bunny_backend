'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildCognitionInput } = require('../services/cognition/cognitionService')

const NOW = new Date('2026-11-07T12:00:00.000Z')

test('production Cognition prompt carries 60 recent messages and the reviewed-history summary within budget', () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        at: NOW.toISOString(),
        text: `RECENT_MESSAGE_${String(index + 1).padStart(2, '0')}` + 'X'.repeat(900),
        wasHidden: index === 0,
    }))
    const input = buildCognitionInput({
        now: NOW,
        state: { last_user_message_at: NOW.toISOString() },
        wakeReasons: ['manual'],
        messages,
        conversationReviewSummary: [
            'HISTORY_SUMMARY_UNFINISHED_TOPIC',
            'HISTORY_SUMMARY_EXPLICIT_USER_PREFERENCE',
        ],
        settings: { system_prompt: 'SYSTEM'.repeat(2000), character_context: 'CHARACTER'.repeat(1000) },
        memory: { summary: 'MEMORY'.repeat(2000) },
        milestones: { text: 'MILESTONE'.repeat(1000) },
        recentThoughts: Array.from({ length: 3 }, () => ({ at: NOW.toISOString(), content: 'THOUGHT'.repeat(1000) })),
        threadContext: {
            available: true,
            eligible: Array.from({ length: 6 }, (_, index) => ({
                id: `thread-${index}`, version: 4, title: 'THREAD_TITLE'.repeat(30),
                current_draft: 'THREAD_DRAFT'.repeat(300), next_step: 'NEXT_STEP'.repeat(100),
                next_review_at: NOW.toISOString(),
            })),
            known: Array.from({ length: 30 }, (_, index) => ({
                id: `known-${index}`, title: 'KNOWN_TOPIC'.repeat(30), status: 'open',
                next_review_at: NOW.toISOString(),
            })),
        },
    })
    assert.match(input, /RECENT_MESSAGE_01/)
    assert.match(input, /RECENT_MESSAGE_60/)
    assert.match(input, /HISTORY_SUMMARY_UNFINISHED_TOPIC/)
    assert.match(input, /HISTORY_SUMMARY_EXPLICIT_USER_PREFERENCE/)
    assert.match(input, /wasHidden/)
    assert.ok(input.length < 12000, `input length was ${input.length}`)
})
