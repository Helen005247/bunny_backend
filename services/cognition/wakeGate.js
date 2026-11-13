'use strict'

// Pure Wake Gate + optional persistence. No model calls, messages or Diary writes.
// Time checks use UTC instants, not local clock arithmetic (DST-safe).

const {
    ensureRuntimeState,
    normalizeIdentity,
    saveRuntimeStatePatch,
} = require('./runtimeStateService')

// A minimal indexed due check; drafts themselves remain private and are loaded
// only AFTER the ordinary versioned Wake Gate has granted a tick.
async function hasDueThoughtThread({ supabase, userId, agentId, now }) {
    const { data, error } = await supabase.from('agent_thought_threads')
        .select('id')
        .eq('user_id', userId)
        .eq('agent_id', agentId)
        .eq('status', 'open')
        .lte('next_review_at', new Date(now).toISOString())
        .limit(1)
    if (error) throw error
    // Empty [] means no due drafts; null data without an error means a
    // malformed read, which the optional-probe caller will log and skip.
    if (!Array.isArray(data)) {
        const unexpected = new Error('Due Thread probe response is not an array')
        unexpected.code = 'THOUGHT_THREAD_READ_INVALID'
        throw unexpected
    }
    return data.length > 0
}

const HOUR_MS = 60 * 60 * 1000
// A low-frequency thinking opportunity independent of user absence or drafts.
// The GitHub heartbeat cadence is unchanged; this is only a Wake Gate rule.
const AUTONOMOUS_INTERVAL_HOURS = 6
const AUTONOMOUS_INTERVAL_MS = AUTONOMOUS_INTERVAL_HOURS * HOUR_MS
const AUTONOMOUS_ANCHOR_KEY = 'cognition_autonomous_anchor_at'
// Keep the two trigger clocks separate without a schema migration. The
// heartbeat key is seeded from legacy timestamps on the first manual claim.
const HEARTBEAT_ACTIVITY_KEY = 'cognition_heartbeat_activity_at'
const MANUAL_ACTIVITY_KEY = 'cognition_manual_activity_at'
// A separate, versioned lease for finishing a previously checkpointed review.
// It is never created by an external request and does not move the regular
// heartbeat activity clock. One request owns one chunk at a time.
const CONTEXT_RESUME_KEY = 'cognition_context_resume'
const CONTEXT_RESUME_LEASE_MS = 190000

function pendingContextResume(metadata, nowMs) {
    const resume = metadata?.[CONTEXT_RESUME_KEY]
    if (!resume || typeof resume !== 'object' || Array.isArray(resume) ||
        resume.status !== 'pending' || typeof resume.sessionId !== 'string' ||
        !resume.sessionId || resume.sessionId.length > 128) return null
    const dueMs = Date.parse(resume.dueAt)
    const leaseMs = resume.leaseUntil == null ? -Infinity : Date.parse(resume.leaseUntil)
    if (!Number.isFinite(dueMs) || Number.isNaN(leaseMs)) return null
    return { resume, due: nowMs >= dueMs, leased: nowMs < leaseMs }
}
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

// Existing accounts fall back to legacy last-wake / last-cognition timestamps
// until the separate heartbeat anchor is seeded. Manual activity never moves
// the heartbeat's 60-minute throttle or six-hour autonomous opportunity.
// Brand-new accounts still get a durable anchor that chat does not reset.
function autonomousOpportunity({ nowMs, lastUserMs, lastActivityMs, metadata }) {
    if (lastUserMs === null || lastUserMs > nowMs) {
        return { due: false, minutesUntilDue: null, needsAnchor: false }
    }
    const lastActivity = lastActivityMs
    if (lastActivity !== -Infinity) {
        const remaining = AUTONOMOUS_INTERVAL_MS - (nowMs - lastActivity)
        return { due: remaining <= 0,
            minutesUntilDue: Math.max(0, Math.ceil(remaining / 60000)),
            needsAnchor: false }
    }
    const raw = metadata[AUTONOMOUS_ANCHOR_KEY]
    const anchor = typeof raw === 'string' ? Date.parse(raw) : NaN
    if (!Number.isFinite(anchor) || anchor > nowMs) {
        return { due: false, minutesUntilDue: AUTONOMOUS_INTERVAL_HOURS * 60,
            needsAnchor: true }
    }
    const remaining = AUTONOMOUS_INTERVAL_MS - (nowMs - anchor)
    return { due: remaining <= 0,
        minutesUntilDue: Math.max(0, Math.ceil(remaining / 60000)),
        needsAnchor: false }
}

function evaluateWakeGate({
    state = {},
    now = new Date(),
    triggerType = 'heartbeat',
    triggerKey = null,
    cooldownMinutes = 60,
    thoughtThreadDue = false,
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
    if (typeof thoughtThreadDue !== 'boolean') {
        throw new Error('thoughtThreadDue 必须是布尔值')
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
    const pendingResume = pendingContextResume(metadata, nowMs)
    // A live lease prevents both manual and scheduled calls from reviewing the
    // same chunk concurrently. CAS in processWakeGate grants the next lease.
    if (pendingResume?.leased) {
        return { shouldWake: false, reasons: [], pendingReasons: [],
            inCooldown: false, patch: {}, autonomousMinutesUntilDue: null }
    }
    if (triggerType === 'heartbeat' && pendingResume?.due) {
        return {
            shouldWake: true, reasons: ['context_review_pending'], pendingReasons: [],
            inCooldown: false, autonomousMinutesUntilDue: null,
            patch: { metadata: { ...metadata,
                [CONTEXT_RESUME_KEY]: { ...pendingResume.resume,
                    leaseUntil: new Date(nowMs + CONTEXT_RESUME_LEASE_MS).toISOString() },
            } },
        }
    }

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
    // Due drafts are an additional HEARTBEAT reason, not a way to bypass the
    // existing absence/review/manual gate. A normal wake already gives the
    // model access to due drafts; only add a new reason if otherwise idle.
    if (triggerType === 'heartbeat' && thoughtThreadDue && reasons.length === 0) {
        reasons.push('thought_thread_due')
    }

    const lastWakeMs = parsedMs(state.last_wake_at, 'last_wake_at')
    const lastCognitionMs = parsedMs(
        state.last_cognition_at, 'last_cognition_at'
    )
    const legacyActivityMs = Math.max(
        lastWakeMs === null ? -Infinity : lastWakeMs,
        lastCognitionMs === null ? -Infinity : lastCognitionMs
    )
    const hasHeartbeatActivityAnchor = Object.hasOwn(metadata, HEARTBEAT_ACTIVITY_KEY)
    const storedHeartbeatActivityMs = hasHeartbeatActivityAnchor
        ? parsedMs(metadata[HEARTBEAT_ACTIVITY_KEY], HEARTBEAT_ACTIVITY_KEY)
        : null
    // A present null anchor means there has not yet been a heartbeat in the
    // separated-clock era. Do not let a later manual last_cognition_at reset it.
    const heartbeatActivityMs = hasHeartbeatActivityAnchor
        ? (storedHeartbeatActivityMs === null ? -Infinity : storedHeartbeatActivityMs)
        : legacyActivityMs
    const manualActivityMs = parsedMs(metadata[MANUAL_ACTIVITY_KEY], MANUAL_ACTIVITY_KEY)
    const cooldownActivityMs = triggerType === 'manual'
        ? (manualActivityMs === null ? -Infinity : manualActivityMs)
        : heartbeatActivityMs
    const autonomous = triggerType === 'heartbeat'
        ? autonomousOpportunity({ nowMs, lastUserMs,
            lastActivityMs: heartbeatActivityMs, metadata })
        : { due: false, minutesUntilDue: null, needsAnchor: false }
    // This is an additional reason, never a substitute for an existing one.
    // Active chatting does not reset the six-hour window.
    if (triggerType === 'heartbeat' && reasons.length === 0) {
        if (autonomous.due) {
            reasons.push('periodic_autonomous')
        } else if (autonomous.needsAnchor) {
            // CAS-persist this once; never use last_user_message_at as an
            // anchor, because active conversations would starve cognition.
            patch.metadata = {
                ...metadata, [AUTONOMOUS_ANCHOR_KEY]: new Date(nowMs).toISOString(),
            }
        }
    }
    const inCooldown = cooldownActivityMs !== -Infinity &&
        nowMs - cooldownActivityMs < cooldownMinutes * 60 * 1000
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
        const activityAt = new Date(nowMs).toISOString()
        if (triggerType === 'manual') {
            const nextMetadata = { ...metadata, ...(patch.metadata || {}) }
            if (!hasHeartbeatActivityAnchor) {
                // Preserve the pre-change heartbeat throttle once, then keep
                // manual runs from moving that independent clock.
                nextMetadata[HEARTBEAT_ACTIVITY_KEY] = heartbeatActivityMs === -Infinity
                    ? null : new Date(heartbeatActivityMs).toISOString()
            }
            nextMetadata[MANUAL_ACTIVITY_KEY] = activityAt
            patch.metadata = nextMetadata
        } else {
            patch.last_wake_at = activityAt
            const nextMetadata = { ...metadata, ...(patch.metadata || {}) }
            nextMetadata[HEARTBEAT_ACTIVITY_KEY] = activityAt
            patch.metadata = nextMetadata
        }
    }

    return {
        shouldWake,
        reasons: shouldWake ? reasons : [],
        pendingReasons: !shouldWake ? reasons : [],
        inCooldown: reasons.length > 0 && inCooldown,
        absenceCheckpoint: checkpoint,
        previousCheckpoint,
        userReturned,
        autonomousMinutesUntilDue: autonomous.minutesUntilDue,
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
        let decision = evaluateWakeGate({
            state, now, triggerType, triggerKey, cooldownMinutes,
        })
        if (triggerType === 'heartbeat' && !decision.inCooldown &&
            decision.pendingReasons.length === 0 &&
            (!decision.shouldWake ||
                decision.reasons.every((reason) => reason === 'periodic_autonomous'))) {
            // A due Thread has priority over the independent opportunity.
            // Ordinary absence/review wakeups do not need this extra index read.
            // A database outage in this optional feature must not disable
            // ordinary chat, manual ticks or absence-based Cognition.
            let threadDue = false
            try {
                threadDue = await hasDueThoughtThread({
                    supabase, ...identity, now,
                })
            } catch (error) {
                // The DB exception may contain private query details; do not
                // forward its text into application logs.
                console.warn('[cognition] due-thread check unavailable; optional probe skipped')
            }
            if (threadDue) {
                decision = evaluateWakeGate({ state, now, triggerType,
                    triggerKey, cooldownMinutes, thoughtThreadDue: true })
            }
        }
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
    AUTONOMOUS_INTERVAL_HOURS,
    HEARTBEAT_ACTIVITY_KEY,
    MANUAL_ACTIVITY_KEY,
    CONTEXT_RESUME_KEY,
    evaluateWakeGate,
    getAbsenceCheckpoint,
    hasDueThoughtThread,
    processWakeGate,
}
