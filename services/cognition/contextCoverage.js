'use strict'

// Describes only whether each source actually contributed usable prompt data.
// Never emit messages, memories, user identifiers or LLM contents in diagnostics.
function textPresence(value) {
    return typeof value === 'string' && value.trim() ? 'present' : 'empty'
}

function sourcePresence({ configured, unavailable = false, value, field }) {
    if (!configured) return 'unwired'
    if (unavailable) return 'unavailable'
    if (value == null) return 'empty'
    if (typeof value !== 'object' || Array.isArray(value) ||
        typeof value[field] !== 'string') return 'shape_mismatch'
    return textPresence(value[field])
}

function summarizeCognitionContext({
    messages, memory, milestones, previousThoughts, state,
    memoryConfigured, milestonesConfigured,
    memoryUnavailable = false,
    milestonesUnavailable = false,
    previousThoughtsUnavailable = false,
} = {}) {
    return {
        messages: Array.isArray(messages) && messages.some(
            (m) => typeof m?.text === 'string' && m.text.trim())
            ? 'present' : 'empty',
        memory: sourcePresence({ configured: memoryConfigured === true,
            unavailable: memoryUnavailable === true,
            value: memory, field: 'summary' }),
        milestones: sourcePresence({ configured: milestonesConfigured === true,
            unavailable: milestonesUnavailable === true,
            value: milestones, field: 'text' }),
        previousThoughts: previousThoughtsUnavailable ? 'unavailable' :
            (Array.isArray(previousThoughts) && previousThoughts.some(
                (t) => typeof t?.content === 'string' && t.content.trim())
                ? 'present' : 'empty'),
        pendingTopic: textPresence(state?.pending_topic),
    }
}

module.exports = { summarizeCognitionContext }
