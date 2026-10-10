'use strict'

// Pure Wake Gate + optional persistence. No model calls, messages or Diary writes.
// Time checks use UTC instants, not local clock arithmetic (DST-safe).

const {
    ensureRuntimeState,
    normalizeIdentity,
    saveRuntimeStatePatch,
} = require('./runtimeStateService')

const HOUR_MS = 60 * 60 * 1000
const ABSENCE_HOUR_THRESHOLDS = Object.freeze([
    6, 12, 18, 24, 36, 48, 72,
])
const EVENT_TRIGGERS = new Set([
    'chat_finished', 'milestone_transition', 'external_event',
])
const TRIGGER_TYPES = new Set([
    'heartbeat', 'pending_review', 'continued_absence',
    'manual', ...EVENT_TRIGGERS,
])

function parsedMs(value, field) {
    if (value == null) {
        return null
    }
    const ms = new Date(value).getTime()
    if (!Number.isFinite(ms)) {
        throw new Error(`${field} 时间无效`)
    }
    return ms
}

function getAbsenceCheckpoint(elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
        return 0
    }

    const hours = elapsedMs / HOUR_MS
    const checkpoints = ABSENCE_HOUR_THRESHOLDS.filter(
        (threshold) => hours >= threshold
    ).length

    if (hours < 72) {
        return checkpoints
    }
    // Once past 72h, check once per 24h instead of every 6h.
    return checkpoints + Math.floor((hours - 72) / 24)
}

function evaluateWakeGate({
    state = {},
    now = new Date(),
    triggerType = 'heartbeat',
    triggerKey = null,
    cooldownMinutes = 60,
} = {}) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new Error('wake gate state 必须是对象')
    }
    if (!TRIGGER_TYPES.has(triggerType)) {
        throw new Error(`不支持的 wake trigger: ${triggerType}`)
    }
    if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) {
        throw new Error('cooldownMinutes 必须是非负数')
    }
    if (EVENT_TRIGGERS.has(triggerType) &&
        (typeof triggerKey !== 'string' || !triggerKey.trim() ||
            triggerKey.trim().length > 256)) {
        throw new Error(`${triggerType} 需要长度 1～256 的稳定 triggerKey`)
    }

    const nowMs = parsedMs(now, 'now')
    if (nowMs === null) {
        throw new Error('now 时间无效')
    }
    const lastUserMs = parsedMs(
        state.last_user_message_at, 'last_user_message_at'
    )
    const startedMs = parsedMs(
        state.absence_started_at, 'absence_started_at'
    )
    const previousCheckpoint = state.absence_checkpoint ?? 0
    if (!Number.isSafeInteger(previousCheckpoint) || previousCheckpoint < 0) {
        throw new Error('state.absence_checkpoint 无效')
    }

    const reasons = []
    const patch = {}
    const metadata = state.metadata && typeof state.metadata === 'object' &&
        !Array.isArray(state.metadata) ? state.metadata : {}

    // A newer user message closes the previous absence episode immediately.
    // recordUserMessage() also closes this episode at write time.
    const userReturned = lastUserMs !== null && startedMs !== null &&
        lastUserMs > startedMs
    if (userReturned) {
        patch.absence_started_at = null
        patch.absence_checkpoint = 0
    }

    let checkpoint = 0
    if (lastUserMs !== null && !userReturned && nowMs >= lastUserMs) {
        checkpoint = getAbsenceCheckpoint(nowMs - lastUserMs)
        if (checkpoint > previousCheckpoint) {
            reasons.push('continued_absence')
        }
    }

    const reviewAtMs = parsedMs(state.next_review_at, 'next_review_at')
    if (reviewAtMs !== null && reviewAtMs <= nowMs) {
        reasons.push('pending_review')
    }

    const key = typeof triggerKey === 'string' ? triggerKey.trim() : null
    const processedKeys = Array.isArray(metadata.processed_wake_trigger_keys)
        ? metadata.processed_wake_trigger_keys.filter(
            (item) => typeof item === 'string'
        )
        : []
    if (EVENT_TRIGGERS.has(triggerType) &&
        !processedKeys.includes(key)) {
        reasons.push(triggerType)
    }
    if (triggerType === 'manual') {
        reasons.push('manual')
    }

    const lastWakeMs = parsedMs(state.last_wake_at, 'last_wake_at')
    const lastCognitionMs = parsedMs(
        state.last_cognition_at, 'last_cognition_at'
    )
    const lastActivityMs = Math.max(
        lastWakeMs === null ? -Infinity : lastWakeMs,
        lastCognitionMs === null ? -Infinity : lastCognitionMs
    )
    const inCooldown = lastActivityMs !== -Infinity &&
        nowMs - lastActivityMs < cooldownMinutes * 60 * 1000
    const shouldWake = reasons.length > 0 && !inCooldown

    if (shouldWake) {
        if (checkpoint > previousCheckpoint) {
            patch.absence_started_at = new Date(lastUserMs).toISOString()
            patch.absence_checkpoint = checkpoint
        }
        if (reasons.includes('pending_review')) {
            patch.next_review_at = null
        }
        if (reasons.some((reason) => EVENT_TRIGGERS.has(reason))) {
            patch.metadata = {
                ...metadata,
                // Keep a bounded history so an older event cannot wake again
                // after a newer event has been processed.
                processed_wake_trigger_keys: [
                    ...processedKeys.filter((item) => item !== key),
                    key,
                ].slice(-32),
            }
        }
        patch.last_wake_at = new Date(nowMs).toISOString()
    }

    return {
        shouldWake,
        reasons: shouldWake ? reasons : [],
        pendingReasons: !shouldWake ? reasons : [],
        inCooldown: reasons.length > 0 && inCooldown,
        absenceCheckpoint: checkpoint,
        previousCheckpoint,
        userReturned,
        patch,
    }
}

async function processWakeGate({
    supabase,
    userId,
    agentId = 'star',
    now = new Date(),
    triggerType = 'heartbeat',
    triggerKey = null,
    cooldownMinutes = 60,
    maxAttempts = 3,
}) {
    const identity = normalizeIdentity({ userId, agentId })
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
        throw new Error('maxAttempts 必须在 1～10 之间')
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const state = await ensureRuntimeState({ supabase, ...identity })
        const decision = evaluateWakeGate({
            state, now, triggerType, triggerKey, cooldownMinutes,
        })
        if (Object.keys(decision.patch).length === 0) {
            return { ...decision, state }
        }
        try {
            const updatedState = await saveRuntimeStatePatch({
                supabase,
                ...identity,
                expectedVersion: state.version,
                now,
                patch: decision.patch,
            })
            return { ...decision, state: updatedState }
        } catch (error) {
            if (error.code !== 'RUNTIME_STATE_CONFLICT' ||
                attempt === maxAttempts - 1) {
                throw error
            }
        }
    }
    throw new Error('wake gate 争用过多')
}

module.exports = {
    ABSENCE_HOUR_THRESHOLDS,
    evaluateWakeGate,
    getAbsenceCheckpoint,
    processWakeGate,
}
