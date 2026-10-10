'use strict'

// Background Cognition Step 1: persistent, per-user/per-agent runtime state.
// Backend-only functions. Caller supplies a trusted Supabase client and userId.

const STATE_COLUMNS = [
    'user_id', 'agent_id', 'version', 'last_user_message_at',
    'last_cognition_at', 'last_wake_at', 'absence_started_at',
    'absence_checkpoint', 'current_emotional_tone', 'pending_topic',
    'next_review_at', 'last_proactive_at', 'metadata', 'updated_at',
].join(', ')

const TIMESTAMP_FIELDS = new Set([
    'last_user_message_at', 'last_cognition_at', 'last_wake_at',
    'absence_started_at', 'next_review_at', 'last_proactive_at',
])

const TEXT_FIELDS = new Set([
    'current_emotional_tone', 'pending_topic',
])

class RuntimeStateConflictError extends Error {
    constructor() {
        super('agent_runtime_state 已被其他任务更新，请重新读取后重试')
        this.name = 'RuntimeStateConflictError'
        this.code = 'RUNTIME_STATE_CONFLICT'
    }
}

function ensureClient(supabase) {
    if (!supabase || typeof supabase.from !== 'function') {
        throw new Error('cognition 缺少有效的 supabase client')
    }
}

function normalizeIdentity({ userId, agentId = 'star' } = {}) {
    const normalizedUserId =
        typeof userId === 'string' ? userId.trim() : ''
    const normalizedAgentId =
        typeof agentId === 'string' ? agentId.trim() : ''

    if (!normalizedUserId) {
        throw new Error('cognition 缺少 userId')
    }
    if (!normalizedAgentId) {
        throw new Error('cognition 缺少 agentId')
    }

    return { userId: normalizedUserId, agentId: normalizedAgentId }
}

function toIsoTimestamp(value, name) {
    if (value === null) {
        return null
    }
    if (value === undefined || value === '') {
        throw new Error(`${name} 缺少有效时间`)
    }

    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(date.getTime())) {
        throw new Error(`${name} 不是有效时间`)
    }
    return date.toISOString()
}

function isPlainObject(value) {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
}

function normalizeStatePatch(patch) {
    if (!isPlainObject(patch)) {
        throw new Error('runtime state patch 必须是普通对象')
    }

    const normalized = {}

    for (const [name, value] of Object.entries(patch)) {
        if (TIMESTAMP_FIELDS.has(name)) {
            normalized[name] = toIsoTimestamp(value, name)
        } else if (TEXT_FIELDS.has(name)) {
            if (value !== null && typeof value !== 'string') {
                throw new Error(`${name} 必须是字符串或 null`)
            }
            const maxLength = name === 'pending_topic' ? 1000 : 160
            normalized[name] = value === null
                ? null
                : value.trim().slice(0, maxLength) || null
        } else if (name === 'absence_checkpoint') {
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new Error('absence_checkpoint 必须是非负整数')
            }
            normalized[name] = value
        } else if (name === 'metadata') {
            if (!isPlainObject(value)) {
                throw new Error('runtime state metadata 必须是普通对象')
            }
            normalized[name] = value
        } else {
            // Forbid rewriting identity, version, updated_at, or unknown fields.
            throw new Error(`不允许更新 runtime state 字段: ${name}`)
        }
    }
    return normalized
}

async function getRuntimeState({ supabase, userId, agentId = 'star' }) {
    ensureClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })

    const { data, error } = await supabase
        .from('agent_runtime_state')
        .select(STATE_COLUMNS)
        .eq('user_id', identity.userId)
        .eq('agent_id', identity.agentId)
        .maybeSingle()

    if (error) {
        throw error
    }
    return data || null
}

async function ensureRuntimeState({ supabase, userId, agentId = 'star' }) {
    ensureClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })

    // DO NOTHING on conflict: never overwrite existing thoughts/state.
    const { error } = await supabase
        .from('agent_runtime_state')
        .upsert(
            { user_id: identity.userId, agent_id: identity.agentId },
            { onConflict: 'user_id,agent_id', ignoreDuplicates: true }
        )

    if (error) {
        throw error
    }

    const state = await getRuntimeState({
        supabase,
        userId: identity.userId,
        agentId: identity.agentId,
    })
    if (!state) {
        throw new Error('创建 agent_runtime_state 后无法读取状态')
    }
    return state
}

async function saveRuntimeStatePatch({
    supabase,
    userId,
    agentId = 'star',
    expectedVersion,
    patch,
    now = new Date(),
}) {
    ensureClient(supabase)
    const identity = normalizeIdentity({ userId, agentId })
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new Error('更新 runtime state 必须提供 expectedVersion')
    }

    const normalized = normalizeStatePatch(patch)
    if (Object.keys(normalized).length === 0) {
        return getRuntimeState({ supabase, ...identity })
    }

    const payload = {
        ...normalized,
        version: expectedVersion + 1,
        updated_at: toIsoTimestamp(now, 'now'),
    }

    // Optimistic concurrency: a stale wake check cannot overwrite a newer
    // chat message or cause a second claim of the same absence checkpoint.
    const { data, error } = await supabase
        .from('agent_runtime_state')
        .update(payload)
        .eq('user_id', identity.userId)
        .eq('agent_id', identity.agentId)
        .eq('version', expectedVersion)
        .select(STATE_COLUMNS)
        .maybeSingle()

    if (error) {
        throw error
    }
    if (!data) {
        throw new RuntimeStateConflictError()
    }
    return data
}

async function recordUserMessage({
    supabase,
    userId,
    agentId = 'star',
    messageAt = new Date(),
    maxAttempts = 3,
}) {
    const identity = normalizeIdentity({ userId, agentId })
    const timestamp = toIsoTimestamp(messageAt, 'messageAt')
    const messageMs = new Date(timestamp).getTime()
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
        throw new Error('maxAttempts 必须在 1～10 之间')
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const state = await ensureRuntimeState({ supabase, ...identity })
        const previousMs = state.last_user_message_at
            ? new Date(state.last_user_message_at).getTime()
            : -Infinity

        // Duplicate / out-of-order messages must never reset a newer episode.
        if (messageMs <= previousMs) {
            return state
        }

        try {
            return await saveRuntimeStatePatch({
                supabase,
                ...identity,
                expectedVersion: state.version,
                now: new Date(),
                patch: {
                    last_user_message_at: timestamp,
                    absence_started_at: null,
                    absence_checkpoint: 0,
                },
            })
        } catch (error) {
            if (error.code !== 'RUNTIME_STATE_CONFLICT' ||
                attempt === maxAttempts - 1) {
                throw error
            }
        }
    }
    throw new RuntimeStateConflictError()
}

module.exports = {
    RuntimeStateConflictError,
    ensureRuntimeState,
    getRuntimeState,
    normalizeIdentity,
    recordUserMessage,
    saveRuntimeStatePatch,
}
