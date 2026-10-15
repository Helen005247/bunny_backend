'use strict'

// Background Cognition v2 Step 2: durable drafts that can be resumed later.
// Storage only: no LLM invocation, automatic wake-up, chat injection or Diary writes.
// Call only from trusted server code with a server-side Supabase client.

const { normalizeIdentity } = require('./runtimeStateService')

const TABLE = 'agent_thought_threads'
const COLUMNS = [
    'id', 'user_id', 'agent_id', 'title', 'current_draft', 'next_step',
    'result', 'status', 'next_review_at', 'dedupe_key', 'metadata',
    'version', 'created_at', 'updated_at', 'closed_at',
].join(', ')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_METADATA_BYTES = 8192
const MAX_VERSION = 2147483646

class ThoughtThreadConflictError extends Error {
    constructor() {
        super('待续想法已更新、关闭或不存在，请重新读取后重试')
        this.name = 'ThoughtThreadConflictError'
        this.code = 'THOUGHT_THREAD_CONFLICT'
    }
}

class ThoughtThreadDedupeConflictError extends Error {
    constructor() {
        super('相同 dedupeKey 对应的待续想法内容不同')
        this.name = 'ThoughtThreadDedupeConflictError'
        this.code = 'THOUGHT_THREAD_DEDUPE_CONFLICT'
    }
}

function requireClient(supabase) {
    if (!supabase || typeof supabase.from !== 'function') {
        throw new Error('thought thread 缺少 Supabase client')
    }
}

function normalizeThreadId(threadId) {
    if (typeof threadId !== 'string' || !UUID_RE.test(threadId)) {
        throw new Error('threadId 必须是 UUID')
    }
    return threadId.toLowerCase()
}

function toIso(value, label) {
    if (value === null || value === undefined || value === '') {
        throw new Error(`${label} 必须是有效时间`)
    }
    if (typeof value === 'string') {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
            throw new Error(`${label} 必须包含明确时区的 ISO 8601 时间`)
        }
        // Date.parse sometimes rolls impossible calendar dates forward.
        const year = Number(value.slice(0, 4))
        const month = Number(value.slice(5, 7))
        const day = Number(value.slice(8, 10))
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
        if (year < 100 || month < 1 || month > 12 ||
            day < 1 || day > daysInMonth) {
            throw new Error(`${label} 日期无效`)
        }
    }
    if (!(value instanceof Date) && typeof value !== 'string') {
        throw new Error(`${label} 必须是 Date 或 ISO 8601 时间字符串`)
    }
    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(date.getTime())) {
        throw new Error(`${label} 必须是有效时间`)
    }
    return date.toISOString()
}

function normalizeReview(value, nowIso) {
    if (value === null) return null
    const reviewIso = toIso(value, 'nextReviewAt')
    if (Date.parse(reviewIso) <= Date.parse(nowIso)) {
        throw new Error('nextReviewAt 必须晚于当前时间')
    }
    return reviewIso
}

function requiredText(value, label, maxLength) {
    const normalized = typeof value === 'string' ? value.trim() : ''
    if (!normalized || normalized.length > maxLength) {
        throw new Error(`${label} 长度应为 1～${maxLength} 字符`)
    }
    return normalized
}

function optionalText(value, label, maxLength) {
    if (value === null) return null
    if (typeof value !== 'string' || value.trim().length > maxLength) {
        throw new Error(`${label} 必须是长度不超过 ${maxLength} 的字符串或 null`)
    }
    return value.trim() || null
}

function draftText(value) {
    if (typeof value !== 'string' || value.length > 6000) {
        throw new Error('currentDraft 必须是 0～6000 字符的字符串')
    }
    return value
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
        return Object.keys(value).sort().reduce((out, key) => {
            out[key] = canonical(value[key])
            return out
        }, Object.create(null))
    }
    return value
}

function normalizeMetadata(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error('metadata 必须是普通 JSON 对象')
    }
    let serialized
    try {
        serialized = JSON.stringify(value)
    } catch (_) {
        throw new Error('metadata 必须可以 JSON 序列化')
    }
    if (typeof serialized !== 'string' ||
        Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
        throw new Error('metadata JSON 不能超过 8192 字节')
    }
    // Clone at the API boundary so caller mutations cannot change the request.
    const parsed = JSON.parse(serialized)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('metadata 序列化后必须仍是 JSON 对象')
    }
    return parsed
}

function normalizeDedupeKey(value) {
    if (value === null) return null
    return requiredText(value, 'dedupeKey', 128)
}

function validateVersion(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VERSION) {
        throw new Error('expectedVersion 必须是有效的非负整数')
    }
    return value
}

function sameCreateRequest(record, proposed) {
    const sameReview = record.next_review_at == null
        ? proposed.next_review_at == null
        : proposed.next_review_at != null &&
            Date.parse(record.next_review_at) === Date.parse(proposed.next_review_at)
    return !!record && record.title === proposed.title &&
        record.current_draft === proposed.current_draft &&
        record.next_step === proposed.next_step && sameReview &&
        JSON.stringify(canonical(record.metadata || {})) ===
        JSON.stringify(canonical(proposed.metadata))
}

async function createThoughtThread({
    supabase, userId, agentId = 'star', title,
    currentDraft = '', nextStep = null, nextReviewAt = null,
    metadata = {}, dedupeKey = null, now = new Date(),
} = {}) {
    requireClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })
    const nowIso = toIso(now, 'now')
    const payload = {
        user_id: identity.userId,
        agent_id: identity.agentId,
        title: requiredText(title, 'title', 160),
        current_draft: draftText(currentDraft),
        next_step: optionalText(nextStep, 'nextStep', 1200),
        next_review_at: normalizeReview(nextReviewAt, nowIso),
        metadata: normalizeMetadata(metadata),
        dedupe_key: normalizeDedupeKey(dedupeKey),
        created_at: nowIso,
        updated_at: nowIso,
    }
    const { data, error } = await supabase.from(TABLE)
        .insert(payload).select(COLUMNS).single()
    if (!error) return data

    // An explicit stable idempotency key prevents duplicate threads when
    // an HTTP timeout or the next heartbeat repeats the SAME create request.
    if (error.code === '23505' && payload.dedupe_key !== null) {
        const { data: existing, error: readError } = await supabase.from(TABLE)
            .select(COLUMNS)
            .eq('user_id', identity.userId)
            .eq('agent_id', identity.agentId)
            .eq('dedupe_key', payload.dedupe_key)
            .maybeSingle()
        if (readError) throw readError
        if (existing) {
            // A successfully created thread may have been revised/closed since
            // the caller's request timed out. Never undo those newer changes.
            if (existing.version === 0 && !sameCreateRequest(existing, payload)) {
                throw new ThoughtThreadDedupeConflictError()
            }
            return existing
        }
    }
    throw error
}

async function getThoughtThread({
    supabase, userId, agentId = 'star', threadId,
} = {}) {
    requireClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })
    const { data, error } = await supabase.from(TABLE)
        .select(COLUMNS)
        .eq('id', normalizeThreadId(threadId))
        .eq('user_id', identity.userId)
        .eq('agent_id', identity.agentId)
        .maybeSingle()
    if (error) throw error
    return data || null
}

async function listThoughtThreads({
    supabase, userId, agentId = 'star', status = 'open',
    dueBefore = null, limit = 20,
} = {}) {
    requireClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })
    if (!['open', 'completed', 'abandoned', 'all'].includes(status)) {
        throw new Error('status 必须是 open、completed、abandoned 或 all')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('limit 必须在 1～50 之间')
    }
    if (dueBefore !== null && status !== 'open') {
        throw new Error('dueBefore 只能用于查询 open 的待续想法')
    }
    let query = supabase.from(TABLE).select(COLUMNS)
        .eq('user_id', identity.userId).eq('agent_id', identity.agentId)
    if (status !== 'all') query = query.eq('status', status)
    if (dueBefore !== null) {
        query = query.lte('next_review_at', toIso(dueBefore, 'dueBefore'))
            .order('next_review_at', { ascending: true })
    } else {
        query = query.order('updated_at', { ascending: false })
    }
    const { data, error } = await query.order('id', { ascending: true }).limit(limit)
    if (error) throw error
    return data || []
}

function normalizePatch(patch, nowIso) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.getPrototypeOf(patch) !== Object.prototype) {
        throw new Error('patch 必须是普通对象')
    }
    const payload = {}
    for (const [key, value] of Object.entries(patch)) {
        switch (key) {
            case 'title':
                payload.title = requiredText(value, 'title', 160)
                break
            case 'currentDraft':
                payload.current_draft = draftText(value)
                break
            case 'nextStep':
                payload.next_step = optionalText(value, 'nextStep', 1200)
                break
            case 'nextReviewAt':
                payload.next_review_at = normalizeReview(value, nowIso)
                break
            case 'metadata':
                payload.metadata = normalizeMetadata(value)
                break
            default:
                throw new Error(`不允许修改 thought thread 字段: ${key}`)
        }
    }
    if (Object.keys(payload).length === 0) {
        throw new Error('patch 至少需要一个可修改字段')
    }
    return payload
}

async function casUpdate({
    supabase, identity, threadId, expectedVersion, changes, nowIso,
}) {
    const { data, error } = await supabase.from(TABLE)
        .update({ ...changes, version: expectedVersion + 1, updated_at: nowIso })
        .eq('id', normalizeThreadId(threadId))
        .eq('user_id', identity.userId)
        .eq('agent_id', identity.agentId)
        .eq('status', 'open')
        .eq('version', expectedVersion)
        .select(COLUMNS).maybeSingle()
    if (error) throw error
    if (!data) throw new ThoughtThreadConflictError()
    return data
}

async function updateThoughtThread({
    supabase, userId, agentId = 'star', threadId,
    expectedVersion, patch, now = new Date(),
} = {}) {
    requireClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })
    validateVersion(expectedVersion)
    const nowIso = toIso(now, 'now')
    const changes = normalizePatch(patch, nowIso)
    return casUpdate({ supabase, identity, threadId, expectedVersion,
        changes, nowIso })
}

async function completeThoughtThread({
    supabase, userId, agentId = 'star', threadId,
    expectedVersion, result, now = new Date(),
} = {}) {
    requireClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })
    validateVersion(expectedVersion)
    const nowIso = toIso(now, 'now')
    return casUpdate({ supabase, identity, threadId, expectedVersion,
        nowIso, changes: {
            status: 'completed', result: requiredText(result, 'result', 6000),
            next_step: null, next_review_at: null, closed_at: nowIso,
        } })
}

async function abandonThoughtThread({
    supabase, userId, agentId = 'star', threadId,
    expectedVersion, now = new Date(),
} = {}) {
    requireClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })
    validateVersion(expectedVersion)
    const nowIso = toIso(now, 'now')
    return casUpdate({ supabase, identity, threadId, expectedVersion,
        nowIso, changes: {
            status: 'abandoned', result: null,
            next_step: null, next_review_at: null, closed_at: nowIso,
        } })
}

module.exports = {
    ThoughtThreadConflictError,
    ThoughtThreadDedupeConflictError,
    createThoughtThread,
    getThoughtThread,
    listThoughtThreads,
    updateThoughtThread,
    completeThoughtThread,
    abandonThoughtThread,
}
