'use strict'

const { httpError } = require('./imageService')

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30
const MAX_OFFSET = 500
const MAX_QUERY_LENGTH = 120
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/i

function optionalString(value, name) {
    if (value === undefined || value === null || value === '') return ''
    if (typeof value !== 'string') {
        throw httpError(400, 'INVALID_RECALL_FILTER', `${name} 参数必须是字符串`)
    }
    return value.trim()
}

function parseInteger(value, name, defaultValue, min, max) {
    if (value === undefined || value === null || value === '') return defaultValue
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw httpError(400, 'INVALID_RECALL_FILTER', `${name} 参数格式不正确`)
    }
    const raw = String(value)
    if (!/^\d+$/.test(raw)) {
        throw httpError(400, 'INVALID_RECALL_FILTER', `${name} 必须为整数`)
    }
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw httpError(400, 'INVALID_RECALL_FILTER', `${name} 必须在 ${min} 到 ${max} 之间`)
    }
    return parsed
}

function civilDay(year, month, day) {
    // setUTCFullYear handles years 0000–0099 without Date.UTC's 1900 adjustment.
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(0, 0, 0, 0)
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month &&
        date.getUTCDate() === day ? date : null
}

function parseDateFilter(raw, name, upper) {
    if (!raw) return null
    const dateOnly = DATE_ONLY_RE.exec(raw)
    if (dateOnly) {
        const [, yearStr, monthStr, dayStr] = dateOnly
        const date = civilDay(Number(yearStr), Number(monthStr), Number(dayStr))
        if (!date) throw httpError(400, 'INVALID_RECALL_DATE', `${name} 不是有效日期`)
        // Date-only filters represent UTC calendar days. "to" includes that entire day.
        return { iso: new Date(date.getTime() + (upper ? DAY_MS : 0)).toISOString(), exclusive: Boolean(upper) }
    }
    const match = TIMESTAMP_RE.exec(raw)
    if (!match) {
        throw httpError(400, 'INVALID_RECALL_DATE', `${name} 必须是 YYYY-MM-DD 或带时区的 ISO 时间`)
    }
    const [, year, month, day, hour, minute, second, , tz, tzHour, tzMinute] = match
    if (!civilDay(Number(year), Number(month), Number(day)) ||
        Number(hour) > 23 || Number(minute) > 59 || Number(second || 0) > 59 ||
        (tz !== 'Z' && tz !== 'z' && (Number(tzHour) > 14 || Number(tzMinute) > 59 ||
            (Number(tzHour) === 14 && Number(tzMinute) !== 0)))) {
        throw httpError(400, 'INVALID_RECALL_DATE', `${name} 不是有效时间`)
    }
    const date = new Date(raw)
    if (!Number.isFinite(date.getTime())) {
        throw httpError(400, 'INVALID_RECALL_DATE', `${name} 不是有效时间`)
    }
    return { iso: date.toISOString(), exclusive: false }
}

function parseRecallFilters(input = {}) {
    const query = optionalString(input.q, 'q')
    if (query.length > MAX_QUERY_LENGTH || /[%_*\\\u0000-\u001f]/u.test(query)) {
        throw httpError(400, 'INVALID_RECALL_QUERY', '搜索词过长或包含不支持的通配符')
    }
    const limit = parseInteger(input.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT)
    const offset = parseInteger(input.offset, 'offset', 0, 0, MAX_OFFSET)
    const sessionId = input.session_id === undefined || input.session_id === null || input.session_id === ''
        ? null : parseInteger(input.session_id, 'session_id', null, 1, Number.MAX_SAFE_INTEGER)
    const from = parseDateFilter(optionalString(input.from, 'from'), 'from', false)
    const to = parseDateFilter(optionalString(input.to, 'to'), 'to', true)
    if (from && to && (from.iso > to.iso || (from.iso === to.iso && to.exclusive))) {
        throw httpError(400, 'INVALID_RECALL_DATE', 'from 不能晚于 to')
    }
    return { query, limit, offset, sessionId, from, to }
}

/**
 * Phase 2 Step 1: search by keyword/date or browse recent images, across sessions.
 * This is a literal substring search over existing visual summaries, NOT semantic search.
 * Reinspection from private Storage and automatic chat recall belong to later steps.
 */
async function searchPastImages({ supabase, userId, filters }) {
    if (!supabase) throw httpError(503, 'DATABASE_UNAVAILABLE', '数据库未连接')
    if (typeof userId !== 'string' || !userId.trim()) {
        throw httpError(401, 'UNAUTHORIZED', '缺少用户身份')
    }
    const { query, limit, offset, sessionId, from, to } = parseRecallFilters(filters)

    let request = supabase.from('image_records')
        .select('id, session_id, message_id, summary, mime_type, created_at')
        .eq('user_id', userId)
        .eq('agent_id', 'star')
        .eq('kind', 'uploaded')
        // Ignore images uploaded but never actually attached to a sent message.
        .not('message_id', 'is', null)

    if (sessionId !== null) request = request.eq('session_id', sessionId)
    if (query) request = request.ilike('summary', `%${query}%`)
    if (from) request = request.gte('created_at', from.iso)
    if (to) request = to.exclusive
        ? request.lt('created_at', to.iso)
        : request.lte('created_at', to.iso)

    const { data, error } = await request
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + limit) // one extra item to report has_more, no COUNT scan
    if (error) throw error

    const items = data || []
    return {
        images: items.slice(0, limit).map((item) => ({
            id: item.id,
            session_id: item.session_id,
            message_id: item.message_id,
            summary: item.summary,
            mime_type: item.mime_type,
            created_at: item.created_at,
        })),
        pagination: { limit, offset, has_more: items.length > limit },
    }
}

module.exports = {
    searchPastImages,
    parseRecallFilters,
}
