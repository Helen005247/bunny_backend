'use strict'

// Background Cognition Step 1: short-lived internal thoughts (not Diary or Memory).
// This module stores data; it never asks an LLM to generate a thought.

const { normalizeIdentity } = require('./runtimeStateService')

const THOUGHT_COLUMNS = [
    'id', 'user_id', 'agent_id', 'content', 'trigger_type',
    'emotion', 'significance', 'created_at', 'expires_at', 'metadata',
].join(', ')

const DAY_MS = 24 * 60 * 60 * 1000

function parseTime(value, name) {
    if (value === null || value === undefined || value === '') {
        throw new Error(`${name} 必须是有效时间`)
    }
    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(date.getTime())) {
        throw new Error(`${name} 必须是有效时间`)
    }
    return date.toISOString()
}

function requireClient(supabase) {
    if (!supabase || typeof supabase.from !== 'function') {
        throw new Error('thought service 缺少 supabase')
    }
}

async function createThought({
    supabase,
    userId,
    agentId = 'star',
    content,
    triggerType = 'manual',
    emotion = null,
    significance = 0.5,
    metadata = {},
    now = new Date(),
    expiresAt,
}) {
    requireClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })
    const normalizedContent =
        typeof content === 'string' ? content.trim() : ''
    const normalizedTrigger =
        typeof triggerType === 'string' ? triggerType.trim() : ''

    if (!normalizedContent || normalizedContent.length > 2000) {
        throw new Error('thought 内容长度应为 1～2000 字符')
    }
    if (!normalizedTrigger || normalizedTrigger.length > 120) {
        throw new Error('thought triggerType 不能为空且不能超过120字符')
    }
    if (!Number.isFinite(significance) ||
        significance < 0 || significance > 1) {
        throw new Error('significance 必须在 0～1 之间')
    }
    if (emotion !== null &&
        (typeof emotion !== 'string' || emotion.length > 160)) {
        throw new Error('emotion 必须是字符串或 null')
    }
    if (!metadata || typeof metadata !== 'object' ||
        Array.isArray(metadata) ||
        Object.getPrototypeOf(metadata) !== Object.prototype) {
        throw new Error('thought metadata 必须是普通对象')
    }

    const nowIso = parseTime(now, 'now')
    const expiryIso = expiresAt === undefined
        ? new Date(new Date(nowIso).getTime() + 7 * DAY_MS).toISOString()
        : parseTime(expiresAt, 'expiresAt')

    if (new Date(expiryIso).getTime() <= new Date(nowIso).getTime()) {
        throw new Error('expiresAt 必须晚于 now')
    }

    const { data, error } = await supabase
        .from('agent_thoughts')
        .insert({
            user_id: identity.userId,
            agent_id: identity.agentId,
            content: normalizedContent,
            trigger_type: normalizedTrigger,
            emotion: emotion === null ? null : emotion.trim() || null,
            significance,
            metadata,
            created_at: nowIso,
            expires_at: expiryIso,
        })
        .select(THOUGHT_COLUMNS)
        .single()

    if (error) {
        throw error
    }
    return data
}

async function getRecentThoughts({
    supabase,
    userId,
    agentId = 'star',
    limit = 10,
    now = new Date(),
}) {
    requireClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('limit 必须在 1～50 之间')
    }

    const { data, error } = await supabase
        .from('agent_thoughts')
        .select(THOUGHT_COLUMNS)
        .eq('user_id', identity.userId)
        .eq('agent_id', identity.agentId)
        .gt('expires_at', parseTime(now, 'now'))
        .order('created_at', { ascending: false })
        .limit(limit)

    if (error) {
        throw error
    }
    return data || []
}

module.exports = {
    createThought,
    getRecentThoughts,
}
