'use strict'

// GitHub Actions diary dispatcher + poller. Never prints diary text, model
// output, conversation content, request body, userId, secrets, or runId.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const SAFE_STATUSES = new Set(['written','skipped','completed','processing',
    'running','covered','failed','conflict','unavailable','revised','deferred','partial'])
const SAFE_CODES = new Set([
    'settings_timezone_missing','source_row_limit_exceeded',
    'source_character_limit_exceeded','source_database_unavailable',
    'review_chunk_limit_exceeded','invalid_model_json','model_unavailable',
    'model_invalid_request','model_auth_failed','model_access_forbidden',
    'model_route_not_found','model_request_too_large','model_rate_limited',
    'model_timeout','model_upstream_failure','model_connection_failure',
    'model_empty_output','model_incomplete_output','invalid_review_summary','invalid_diary_draft',
    'invalid_diary_length','diary_lease_lost','diary_internal_failure',
    'diary_database_failure','diary_job_busy',
    'invalid_diary_plan','diary_evidence_out_of_scope','diary_topic_not_found',
    'diary_topic_already_written','diary_revision_conflict',
    'source_context_limit_exceeded','source_context_mismatch',
    'source_context_character_limit_exceeded','review_partial',
])
const MAX_POLL_MS = 28 * 60 * 1000

function assertConfig({ endpoint, userId, secret, startDate, endDate, topicHint = '' }) {
    if (!UUID.test(userId || '') || !secret || secret.length < 24) {
        throw new Error('Diary GitHub secrets not configured')
    }
    let url
    try { url = new URL(endpoint) } catch (_) { throw new Error('Invalid diary endpoint') }
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/internal/diary/tick' || url.search || url.hash) {
        throw new Error('Diary endpoint must be HTTPS /internal/diary/tick')
    }
    if (Boolean(startDate) !== Boolean(endDate) ||
        (startDate && (!DATE.test(startDate) || !DATE.test(endDate)))) {
        throw new Error('Manual backfill requires both YYYY-MM-DD dates')
    }
    if (typeof topicHint !== 'string' || topicHint.length > 200 ||
        (topicHint.trim() && !startDate)) {
        throw new Error('Manual topic requires a backfill date range')
    }
    return url.toString()
}

function safeLog(result) {
    const status = SAFE_STATUSES.has(result.status) ? result.status : 'unknown'
    const code = SAFE_CODES.has(result.code) ? result.code : 'none'
    const num = (value) => Number.isSafeInteger(value) && value >= 0 && value < 1000000
        ? value : 'unknown'
    return `[diary] review status=${status}; processed=${num(result.processed)}; ` +
        `written=${num(result.written ?? result.created)}; revised=${num(result.revised)}; ` +
        `deferred=${num(result.deferred)}; skipped=${num(result.skipped)}; ` +
        `reviewed=${num(result.reviewedCount ?? result.sourceCount)}; ` +
        `cache_hits=${num(result.cacheHits)}; shared_hits=${num(result.reused)}; ` +
        `review=${num(result.reviewDone)}/${num(result.reviewTotal)}; ` +
        `rollup=${num(result.rollupDone)}/${num(result.rollupTotal)}; ` +
        `model_calls=${num(result.modelCalls)}; code=${code}`
}

async function dispatchAndPoll({ endpoint, userId, secret, startDate = '', endDate = '',
    topicHint = '',
    fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxPollMs = MAX_POLL_MS, nowMs = () => Date.now() } = {}) {
    const url = assertConfig({ endpoint, userId, secret, startDate, endDate, topicHint })
    if (typeof fetchImpl !== 'function') throw new Error('Fetch unavailable')
    const headers = { 'content-type': 'application/json', 'x-cognition-secret': secret }
    const triggerType = startDate ? 'backfill' : 'daily'
    const body = JSON.stringify({ userId, agentId: 'star', triggerType,
        ...(startDate ? { startDate, endDate, topicHint: topicHint.trim() } : {}) })
    const response = await fetchImpl(url, { method: 'POST', headers, body,
        signal: AbortSignal.timeout(45000) })
    if (response.status !== 202) throw new Error(`Diary dispatch HTTP ${response.status}`)
    const initial = await response.json()
    if (!initial?.ok || !UUID.test(initial.runId || '')) {
        throw new Error('Diary dispatcher returned invalid receipt')
    }
    const pollUrl = new URL(`/internal/diary/status/${initial.runId}`, url).toString()
    const start = nowMs()
    while (nowMs() - start < maxPollMs) {
        await sleep(8000)
        const statusResponse = await fetchImpl(pollUrl, { method: 'GET',
            headers: { 'x-cognition-secret': secret },
            signal: AbortSignal.timeout(30000) })
        if (!statusResponse.ok) {
            // Process restart is an unresolved run, not a successful diary.
            throw new Error(`Diary status HTTP ${statusResponse.status}`)
        }
        const status = await statusResponse.json()
        if (!status || typeof status.status !== 'string') {
            throw new Error('Diary status response invalid')
        }
        if (status.status === 'running') continue
        if (!status.ok || status.status === 'failed' || status.status === 'processing') {
            throw new Error(safeLog(status))
        }
        if (!SAFE_STATUSES.has(status.status)) {
            throw new Error('Diary unexpected status')
        }
        return status
    }
    throw new Error('Diary review timed out; verify database job status')
}

async function main() {
    const result = await dispatchAndPoll({
        endpoint: process.env.DIARY_ENDPOINT,
        userId: process.env.COGNITION_USER_ID,
        secret: process.env.COGNITION_TICK_SECRET,
        startDate: process.env.DIARY_START_DATE || '',
        endDate: process.env.DIARY_END_DATE || '',
        topicHint: process.env.DIARY_TOPIC_HINT || '',
    })
    console.log(safeLog(result))
}
if (require.main === module) {
    main().catch((error) => {
        const message = String(error?.message || '')
        // Only known safe internal messages/status codes are passed through.
        const safe = /^(\[diary\] review status=|Diary |Invalid |Manual |Fetch )/.test(message)
            ? message : 'Diary review failed'
        console.error('[diary] failed:', safe)
        process.exitCode = 1
    })
}
module.exports = { assertConfig, safeLog, dispatchAndPoll }
