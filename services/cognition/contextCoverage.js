'use strict'

// Describes only whether each source actually contributed usable prompt data.
// Never emit messages, memories, user identifiers or LLM contents in diagnostics.
function textPresence(value) {
    return typeof value === 'string' && value.trim() ? 'present' : 'empty'
}

function sourcePresence({ configured = true, unavailable = false, readStatus,
    value, field, explicitStatus = true }) {
    if (readStatus === 'unwired' || configured === false) return 'unwired'
    if (unavailable || readStatus === 'unavailable' || value?.status === 'unavailable') {
        return 'unavailable'
    }
    if (value == null) return 'empty'
    if (explicitStatus && ['present', 'empty'].includes(value?.status)) return value.status
    if (typeof value !== 'object' || Array.isArray(value) ||
        typeof value[field] !== 'string') return 'shape_mismatch'
    return textPresence(value[field])
}

function safeCount(value, max) {
    return Number.isSafeInteger(value) && value >= 0
        ? Math.min(value, max) : 0
}

function summarizeCognitionContext({
    messages, memory, milestones, previousThoughts, state,
    settings, characterLore, storyLore, conversationReviewSummary,
    recentMessageCount, recentMessageChars,
    memoryConfigured, milestonesConfigured,
    memoryUnavailable = false,
    milestonesUnavailable = false,
    previousThoughtsUnavailable = false,
    settingsReadStatus,
    characterLoreReadStatus,
    storyLoreReadStatus,
} = {}) {
    const summaryItems = Array.isArray(conversationReviewSummary)
        ? conversationReviewSummary.filter((item) => typeof item === 'string' && item.trim())
        : []
    const selectedLore = Array.isArray(characterLore?.selected) ? characterLore.selected : []
    const selectedStory = Array.isArray(storyLore?.selected) ? storyLore.selected : []
    const recentCount = Number.isSafeInteger(recentMessageCount)
        ? recentMessageCount
        : (Array.isArray(messages) ? messages.length : 0)

    return {
        messages: Array.isArray(messages) && messages.some(
            (m) => typeof m?.text === 'string' && m.text.trim())
            ? 'present' : 'empty',
        memory: sourcePresence({ configured: memoryConfigured === true,
            unavailable: memoryUnavailable, value: memory, field: 'summary', explicitStatus: false }),
        milestones: sourcePresence({ configured: milestonesConfigured === true,
            unavailable: milestonesUnavailable, value: milestones, field: 'text', explicitStatus: false }),
        previousThoughts: previousThoughtsUnavailable ? 'unavailable' :
            (Array.isArray(previousThoughts) && previousThoughts.some(
                (t) => typeof t?.content === 'string' && t.content.trim() !== '')
                ? 'present' : 'empty'),
        pendingTopic: textPresence(state?.pending_topic),
        systemPrompt: sourcePresence({ readStatus: settingsReadStatus,
            value: settings, field: 'system_prompt', explicitStatus: false }),
        characterContext: sourcePresence({ readStatus: settingsReadStatus,
            value: settings, field: 'character_context', explicitStatus: false }),
        characterLore: sourcePresence({ readStatus: characterLoreReadStatus,
            value: characterLore, field: 'context' }),
        storyLore: sourcePresence({ readStatus: storyLoreReadStatus,
            value: storyLore, field: 'context' }),
        historySummary: summaryItems.length ? 'present' : 'empty',
        historySummaryItems: safeCount(summaryItems.length, 18),
        historySummaryChars: safeCount(summaryItems.reduce((sum, item) => sum + item.length, 0), 2880),
        recentMessageCount: safeCount(recentCount, 60),
        recentMessageChars: safeCount(recentMessageChars, 3000),
        characterLoreItems: safeCount(selectedLore.length, 10),
        storyLoreItems: safeCount(selectedStory.length, 3),
    }
}

module.exports = { summarizeCognitionContext }
