'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildCognitionInput, fitConversationReviewSummary } = require('../services/cognition/cognitionService')

const NOW = new Date('2026-11-07T12:00:00.000Z')

test('production Cognition prompt carries the role model, selected lore, all reviewed summaries and recent messages within budget', () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        at: NOW.toISOString(),
        text: `RECENT_MESSAGE_${String(index + 1).padStart(2, '0')}` + 'X'.repeat(900),
        wasHidden: index === 0,
    }))
    const summaries = Array.from({ length: 17 }, (_, index) =>
        `HISTORY_SUMMARY_${String(index + 1).padStart(2, '0')}_` + 'S'.repeat(220))
    const input = buildCognitionInput({
        now: NOW,
        state: { last_user_message_at: NOW.toISOString() },
        wakeReasons: ['manual'],
        messages,
        conversationReviewSummary: summaries,
        settings: {
            system_prompt: 'ROLE_BEHAVIOR_RULES_' + 'SYSTEM'.repeat(2000),
            character_context: 'STABLE_RELATIONSHIP_CONTEXT_' + 'CHARACTER'.repeat(1000),
        },
        characterLore: {
            status: 'present',
            selected: [{ id: 'voice-1', type: 'voice_sample' }, { id: 'behavior-1', type: 'behavior' }],
            context: 'DYNAMIC_CHARACTER_BEHAVIOR_AND_VOICE_REFERENCE',
        },
        storyLore: {
            status: 'present',
            selected: [{ id: 'lore-1' }],
            context: 'RELEVANT_ORIGINAL_STORY_FACTS',
        },
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

    assert.match(input, /ROLE_BEHAVIOR_RULES_/)
    assert.match(input, /STABLE_RELATIONSHIP_CONTEXT_/)
    assert.match(input, /DYNAMIC_CHARACTER_BEHAVIOR_AND_VOICE_REFERENCE/)
    assert.match(input, /RELEVANT_ORIGINAL_STORY_FACTS/)
    assert.match(input, /HISTORY_SUMMARY_01_/)
    assert.match(input, /HISTORY_SUMMARY_17_/)
    assert.match(input, /RECENT_MESSAGE_01/)
    assert.match(input, /RECENT_MESSAGE_60/)
    assert.match(input, /wasHidden/)
    assert.ok(input.length < 17500, `input length was ${input.length}`)
})

test('history review summaries are bounded but retain the latest available observations', () => {
    const summaries = Array.from({ length: 20 }, (_, index) => `SUMMARY_${index + 1}_` + 'x'.repeat(200))
    const fitted = fitConversationReviewSummary(summaries)
    assert.equal(fitted.length, 18)
    assert.match(fitted[0], /SUMMARY_3_/)
    assert.match(fitted[17], /SUMMARY_20_/)
    assert.ok(fitted.every((item) => item.length <= 160))
})
