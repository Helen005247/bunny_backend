'use strict'

const crypto = require('crypto')

const PAGE_SIZE = 200
const MAX_RAW_ROWS = 5000
const MAX_SOURCE_CHARACTERS = 1200000
const STAR_VOICE_KEY = 'xingxing'

class DiaryReadError extends Error {
    constructor(code) {
        super(code)
        this.code = code
    }
}

function requireRows(result) {
    if (result?.error) throw new DiaryReadError('source_database_unavailable')
    if (!Array.isArray(result?.data)) throw new DiaryReadError('invalid_source_response')
    return result.data
}

async function loadStarVoiceSessionIds({ supabase, userId, rows }) {
    const allIds = [...new Set(rows.filter((r) => r.channel === 'voice')
        .map((r) => r.call_session_id).filter((v) => v != null).map(String))]
    const approved = new Set()
    // Only voice sessions whose authenticated owner AND exact agent match Star.
    // Missing, deleted, or untagged call sessions must not leak another persona.
    for (let i = 0; i < allIds.length; i += 80) {
        const chunk = allIds.slice(i, i + 80)
        const found = requireRows(await supabase.from('call_sessions')
            .select('id, agent_key').eq('user_id', userId).in('id', chunk))
        for (const row of found) {
            if (row.agent_key === STAR_VOICE_KEY) approved.add(String(row.id))
        }
    }
    return approved
}

async function readDiaryMessages({ supabase, userId, agentId = 'star',
    periodStart, periodEnd, maxRows = MAX_RAW_ROWS } = {}) {
    if (!supabase || typeof supabase.from !== 'function' || !userId ||
        agentId !== 'star' || !Number.isInteger(maxRows) ||
        maxRows < 1 || maxRows > MAX_RAW_ROWS ||
        !Number.isFinite(Date.parse(periodStart)) ||
        !Number.isFinite(Date.parse(periodEnd)) ||
        Date.parse(periodStart) >= Date.parse(periodEnd)) {
        throw new DiaryReadError('invalid_diary_reader_input')
    }
    const raw = []
    let offset = 0
    while (true) {
        // Re-read every page in a deterministic stable order. No visible=true
        // filter: memory compression and regenerated turns can hide old rows.
        const rows = requireRows(await supabase.from('messages')
            .select('id, session_id, role, content, created_at, visible, channel, call_session_id, reasoning_content')
            .eq('user_id', userId)
            .gte('created_at', periodStart)
            .lt('created_at', periodEnd)
            .in('role', ['user', 'assistant'])
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(offset, offset + PAGE_SIZE - 1))
        // If exactly MAX_RAW_ROWS exists we still need one more page/row to
        // prove no truncation. Failing closed is preferable to false diaries.
        if (raw.length + rows.length > maxRows) {
            throw new DiaryReadError('source_row_limit_exceeded')
        }
        raw.push(...rows)
        offset += rows.length
        if (rows.length < PAGE_SIZE) break
    }
    const allowedVoice = await loadStarVoiceSessionIds({ supabase, userId, rows: raw })
    const included = []
    let totalChars = 0
    for (const row of raw) {
        const channel = row.channel || 'text' // legacy untagged messages
        if (channel !== 'text' && channel !== 'voice') continue
        if (channel === 'voice' && !allowedVoice.has(String(row.call_session_id))) continue
        if (!['user', 'assistant'].includes(row.role) ||
            typeof row.content !== 'string' || !row.content.trim()) continue
        // Call summaries, model scratchpad, and non-conversation internals are
        // excluded. The reasoning_content column itself is NEVER selected into
        // the model input, source metadata, or logs.
        if (typeof row.reasoning_content === 'string' &&
            row.reasoning_content !== '' && row.reasoning_content !== 'proactive') {
            continue
        }
        totalChars += row.content.length
        if (totalChars > MAX_SOURCE_CHARACTERS) {
            throw new DiaryReadError('source_character_limit_exceeded')
        }
        included.push({ id: String(row.id), sessionId: String(row.session_id),
            role: row.role, channel, content: row.content,
            createdAt: row.created_at, wasHidden: row.visible === false })
    }
    const digest = crypto.createHash('sha256')
    for (const row of included) {
        // Length-delimited serialization prevents ambiguous concatenations.
        const encoded = JSON.stringify([row.id, row.sessionId, row.role, row.channel,
            row.createdAt, row.content])
        digest.update(`${Buffer.byteLength(encoded)}:`)
        digest.update(encoded)
    }
    return { rows: included, fetchedCount: raw.length,
        includedCount: included.length, filteredCount: raw.length - included.length,
        sourceHash: digest.digest('hex'),
        sourceRefs: included.map(({ id, sessionId, createdAt, channel }) =>
            ({ id, session_id: sessionId, at: createdAt, channel })),
    }
}

module.exports = { PAGE_SIZE, MAX_RAW_ROWS, DiaryReadError,
    readDiaryMessages, loadStarVoiceSessionIds }
