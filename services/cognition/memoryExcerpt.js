'use strict'

// Keep both the opening context and the latest end of a long global-memory
// summary. This is a bounded excerpt, not a rewrite or an inference about the
// user's life. Never log the source summary or the excerpt.
const MAX_MEMORY_EXCERPT_CHARS = 1400
const OMITTED_MIDDLE_MARKER = '\n[记忆中段省略]\n'

function excerptMemorySummary(value) {
    if (typeof value !== 'string') return ''
    const text = value.trim()
    if (text.length <= MAX_MEMORY_EXCERPT_CHARS) return text

    const available = MAX_MEMORY_EXCERPT_CHARS - OMITTED_MIDDLE_MARKER.length
    const headChars = Math.ceil(available * 0.55)
    const tailChars = available - headChars
    // Avoid cutting a UTF-16 surrogate pair (e.g. emoji) in half.
    let head = text.slice(0, headChars)
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
    let tail = text.slice(-tailChars)
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1)
    return head + OMITTED_MIDDLE_MARKER + tail
}

module.exports = {
    excerptMemorySummary,
    MAX_MEMORY_EXCERPT_CHARS,
    OMITTED_MIDDLE_MARKER,
}
