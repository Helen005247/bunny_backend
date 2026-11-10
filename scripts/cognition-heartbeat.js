'use strict'

// Called by GitHub Actions. Uses the existing authenticated Cognition tick;
// heartbeat NEVER overrides Wake Gate or forces a manual thought.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_ATTEMPTS = 2
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
// These fixed labels are the ONLY diagnostic strings permitted in Action logs.
// Never log arbitrary server data, model text, user IDs, message IDs or secrets.
const SAFE_WAKE_REASONS = new Set([
    'continued_absence', 'pending_review', 'thought_thread_due',
    'periodic_autonomous', 'manual', 'chat_finished',
    'milestone_transition', 'external_event',
])
const SAFE_GATE_STATUSES = new Set([
    'executed', 'no_wake_signal', 'cooldown', 'stale_due_thread',
    'cancelled_new_user_message',
])
const SAFE_THREAD_STATUSES = new Set([
    'none', 'created', 'updated', 'completed', 'abandoned',
    'unchanged', 'already_tracked', 'invalid_action',
    'unavailable', 'conflict',
])
const SAFE_THREAD_DECISIONS = new Set([
    'explicit_none', 'omitted', 'invalid', 'create', 'update',
    'complete', 'abandon',
])
const SAFE_THREAD_CONTEXT_STATUSES = new Set(['empty', 'eligible', 'unavailable'])
const SAFE_OUTCOMES = new Set(['complete', 'partial', 'skipped'])
// Only structural presence flags are accepted; no prompt/data fragments.
const SAFE_CONTEXT_COVERAGE = {
    messages: new Set(['present', 'empty']),
    memory: new Set(['present', 'empty', 'unwired', 'unavailable', 'shape_mismatch']),
    milestones: new Set(['present', 'empty', 'unwired', 'unavailable', 'shape_mismatch']),
    previousThoughts: new Set(['present', 'empty', 'unavailable']),
    pendingTopic: new Set(['present', 'empty']),
    systemPrompt: new Set(['present', 'empty', 'unwired', 'unavailable', 'shape_mismatch']),
    characterContext: new Set(['present', 'empty', 'unwired', 'unavailable', 'shape_mismatch']),
    characterLore: new Set(['present', 'empty', 'unwired', 'unavailable', 'shape_mismatch']),
    storyLore: new Set(['present', 'empty', 'unwired', 'unavailable', 'shape_mismatch']),
    historySummary: new Set(['present', 'empty']),
}
const SAFE_CONTEXT_COUNTS = {
    historySummaryItems: 18,
    historySummaryChars: 2880,
    recentMessageCount: 60,
    recentMessageChars: 3000,
    characterLoreItems: 10,
    storyLoreItems: 3,
}

function safeContextCoverage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const safe = {}
    for (const [name, allowed] of Object.entries(SAFE_CONTEXT_COVERAGE)) {
        safe[name] = safeDiagnostic(value[name], allowed)
    }
    for (const [name, max] of Object.entries(SAFE_CONTEXT_COUNTS)) {
        safe[name] = Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= max
            ? value[name] : null
    }
    return safe
}

function safeDiagnostic(value, allowed) {
    return typeof value === 'string' && allowed.has(value) ? value : 'unknown'
}

function safeWakeReasons(value) {
    if (!Array.isArray(value)) return null
    return [...new Set(value.filter((item) =>
        typeof item === 'string' && SAFE_WAKE_REASONS.has(item)))].slice(0, 8)
}

function assertConfig({ endpoint, userId, secret }) {
    if (!UUID_RE.test(userId || '')) {
        throw new Error('缺少有效的 COGNITION_USER_ID（GitHub Actions Secret）')
    }
    if (typeof secret !== 'string' || secret.length < 24) {
        throw new Error('缺少有效的 COGNITION_TICK_SECRET（GitHub Actions Secret，至少24字符）')
    }
    let url
    try { url = new URL(endpoint) } catch (_) {
        throw new Error('COGNITION_ENDPOINT 格式不正确')
    }
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/internal/cognition/tick' || url.search || url.hash) {
        throw new Error('COGNITION_ENDPOINT 必须是 HTTPS /internal/cognition/tick')
    }
    return url.toString()
}

async function sendHeartbeat({ endpoint, userId, secret,
    fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
    const url = assertConfig({ endpoint, userId, secret })
    if (typeof fetchImpl !== 'function') throw new Error('Node fetch 不可用')
    const body = JSON.stringify({ userId, agentId: 'star', triggerType: 'heartbeat' })
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let response
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-cognition-secret': secret,
                },
                body,
                signal: AbortSignal.timeout(170000),
            })
        } catch (error) {
            if (attempt === MAX_ATTEMPTS) {
                throw new Error('Cognition Heartbeat 请求失败（网络或超时）')
            }
            await sleep(15000)
            continue
        }
        if (!response.ok) {
            // Never log request/response body: it may contain private data.
            if (attempt < MAX_ATTEMPTS && RETRYABLE_STATUS.has(response.status)) {
                await sleep(15000)
                continue
            }
            throw new Error(`Cognition Heartbeat HTTP ${response.status}`)
        }
        let result
        try { result = await response.json() } catch (_) {
            throw new Error('Cognition Heartbeat 返回值不是 JSON')
        }
        if (!result || result.ok !== true || typeof result.executed !== 'boolean') {
            throw new Error('Cognition Heartbeat 返回格式错误')
        }
        // Deliberately discard private thoughts, IDs and unknown fields.
        const safe = {
            executed: result.executed,
            stored: result.stored === true,
            reason: result.executed ? null : (
                ['cooldown', 'wake_gate_skipped', 'no_user_messages',
                    'new_user_message_during_tick'].includes(result.reason)
                    ? result.reason : 'skipped'),
        }
        if (SAFE_OUTCOMES.has(result.outcome)) {
            safe.outcome = result.outcome
        } else if (result.stateUpdated === false) {
            safe.outcome = 'partial'
        } else if (result.stateUpdated === true && result.executed === true) {
            safe.outcome = 'complete'
        } else if (result.executed === false) {
            safe.outcome = 'skipped'
        }
        // Optional fields are absent on older deployments. Validate *each*
        // string against fixed enums before allowing it into diagnostic logs.
        if (Object.hasOwn(result, 'gateStatus')) {
            safe.gateStatus = safeDiagnostic(result.gateStatus, SAFE_GATE_STATUSES)
        }
        if (Object.hasOwn(result, 'wakeReasons')) {
            safe.wakeReasons = safeWakeReasons(result.wakeReasons)
        }
        if (Object.hasOwn(result, 'threadStatus')) {
            safe.threadStatus = safeDiagnostic(result.threadStatus, SAFE_THREAD_STATUSES)
        }
        if (Object.hasOwn(result, 'threadDecision')) {
            safe.threadDecision = safeDiagnostic(result.threadDecision, SAFE_THREAD_DECISIONS)
        }
        if (Object.hasOwn(result, 'threadContextStatus')) {
            safe.threadContextStatus = safeDiagnostic(
                result.threadContextStatus, SAFE_THREAD_CONTEXT_STATUSES)
        }
        if (Object.hasOwn(result, 'contextCoverage')) {
            safe.contextCoverage = safeContextCoverage(result.contextCoverage)
        }
        if (typeof result.stateUpdated === 'boolean') {
            safe.stateUpdated = result.stateUpdated
        }
        if (Number.isSafeInteger(result.autonomousMinutesUntilDue) &&
            result.autonomousMinutesUntilDue >= 0 &&
            result.autonomousMinutesUntilDue <= 1440) {
            safe.autonomousMinutesUntilDue = result.autonomousMinutesUntilDue
        }
        return safe
    }
    throw new Error('Cognition Heartbeat 触发失败')
}

function formatHeartbeatLog(result) {
    // Defense in depth: formatters must also accept only fixed labels even if
    // they are called directly with an untrusted object.
    const reason = result.executed === true ? 'none' : (
        ['cooldown', 'wake_gate_skipped', 'no_user_messages',
            'new_user_message_during_tick'].includes(result.reason)
            ? result.reason : 'skipped')
    const detail = [
        `outcome=${safeDiagnostic(result.outcome, SAFE_OUTCOMES)}`,
        `gate=${safeDiagnostic(result.gateStatus, SAFE_GATE_STATUSES)}`,
        `wake=${safeWakeReasons(result.wakeReasons)?.join(',') || 'none'}`,
        `thread=${safeDiagnostic(result.threadStatus, SAFE_THREAD_STATUSES)}`,
        `decision=${safeDiagnostic(result.threadDecision, SAFE_THREAD_DECISIONS)}`,
        `thread_context=${safeDiagnostic(result.threadContextStatus, SAFE_THREAD_CONTEXT_STATUSES)}`,
        `state=${typeof result.stateUpdated !== 'boolean' ? 'unknown' :
            (result.stateUpdated ? 'updated' : 'failed')}`,
        `ctx_messages=${safeContextCoverage(result.contextCoverage)?.messages || 'unknown'}`,
        `ctx_memory=${safeContextCoverage(result.contextCoverage)?.memory || 'unknown'}`,
        `ctx_milestones=${safeContextCoverage(result.contextCoverage)?.milestones || 'unknown'}`,
        `ctx_previous=${safeContextCoverage(result.contextCoverage)?.previousThoughts || 'unknown'}`,
        `ctx_pending=${safeContextCoverage(result.contextCoverage)?.pendingTopic || 'unknown'}`,
        `ctx_system=${safeContextCoverage(result.contextCoverage)?.systemPrompt || 'unknown'}`,
        `ctx_character=${safeContextCoverage(result.contextCoverage)?.characterContext || 'unknown'}`,
        `ctx_lore=${safeContextCoverage(result.contextCoverage)?.characterLore || 'unknown'}`,
        `ctx_story=${safeContextCoverage(result.contextCoverage)?.storyLore || 'unknown'}`,
        `ctx_history_items=${safeContextCoverage(result.contextCoverage)?.historySummaryItems ?? 'unknown'}`,
        `ctx_recent_count=${safeContextCoverage(result.contextCoverage)?.recentMessageCount ?? 'unknown'}`,
        `ctx_recent_chars=${safeContextCoverage(result.contextCoverage)?.recentMessageChars ?? 'unknown'}`,
        `ctx_lore_items=${safeContextCoverage(result.contextCoverage)?.characterLoreItems ?? 'unknown'}`,
        `ctx_story_items=${safeContextCoverage(result.contextCoverage)?.storyLoreItems ?? 'unknown'}`,
        `autonomous_wait_minutes=${Number.isSafeInteger(result.autonomousMinutesUntilDue) &&
            result.autonomousMinutesUntilDue >= 0 &&
            result.autonomousMinutesUntilDue <= 1440
            ? result.autonomousMinutesUntilDue : 'unknown'}`,
    ]
    return `[cognition] heartbeat ok; executed=${result.executed === true}; ` +
        `stored=${result.stored === true}; reason=${reason}; ` + detail.join('; ')
}

async function main() {
    const result = await sendHeartbeat({
        endpoint: process.env.COGNITION_ENDPOINT,
        userId: process.env.COGNITION_USER_ID,
        secret: process.env.COGNITION_TICK_SECRET,
    })
    console.log(formatHeartbeatLog(result))
    // A 200 response means the request was handled, not necessarily that all
    // durable state bookkeeping completed. Surface partial outcomes as a red
    // Action without retrying the model request and duplicating saved work.
    if (result.outcome === 'partial' || result.stateUpdated === false) {
        throw new Error('Cognition Heartbeat partially completed: runtime state update failed')
    }
}

if (require.main === module) {
    main().catch((error) => {
        // No secrets, user IDs, user messages, or thoughts in public Action logs.
        console.error('[cognition] heartbeat failed:', error.message)
        process.exitCode = 1
    })
}

module.exports = { assertConfig, sendHeartbeat, formatHeartbeatLog }
