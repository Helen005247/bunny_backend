'use strict'

const crypto = require('crypto')
const { getWindow, validTimeZone } = require('./diaryWindows')
const { readDiaryMessages } = require('./diaryReader')
const { reviewAndWriteDiary } = require('./diaryWriter')

const { runAutonomousDailyTick, CATCHUP_DAYS, MAX_DAILY_JOBS_PER_TICK } =
    require('./diaryAutonomyService')
const ERROR_CODES = new Set([
    'invalid_diary_input', 'settings_timezone_missing', 'invalid_diary_range',
    'invalid_diary_date', 'invalid_local_day_boundary', 'diary_period_not_ended',
    'source_row_limit_exceeded', 'source_character_limit_exceeded',
    'source_database_unavailable', 'invalid_source_response',
    'review_chunk_limit_exceeded', 'model_not_configured', 'model_unavailable',
    'model_invalid_request', 'model_auth_failed', 'model_access_forbidden',
    'model_route_not_found', 'model_request_too_large', 'model_rate_limited',
    'model_timeout', 'model_upstream_failure', 'model_connection_failure',
    'model_empty_output', 'model_incomplete_output', 'invalid_model_json', 'invalid_review_summary',
    'invalid_review_chunks', 'invalid_review_chunk_options', 'invalid_diary_draft', 'invalid_diary_length',
    'oversized_review_piece', 'diary_lease_lost', 'diary_database_failure',
    'diary_job_busy', 'invalid_diary_timezone','review_partial',
    'invalid_diary_plan','diary_evidence_out_of_scope','diary_topic_not_found',
    'diary_topic_already_written','diary_revision_conflict',
    'source_context_limit_exceeded','source_context_mismatch',
    'source_context_character_limit_exceeded','acceptance_preview_partial',
    'acceptance_probe_failed',
])

function safeErrorCode(error) {
    return ERROR_CODES.has(error?.code) ? error.code :
        (ERROR_CODES.has(error?.message) ? error.message : 'diary_internal_failure')
}

function requireDb(result) {
    if (result?.error) {
        const err = new Error('diary_database_failure')
        err.code = 'diary_database_failure'
        throw err
    }
    return result?.data
}

async function rpc(supabase, name, params) {
    if (!supabase || typeof supabase.rpc !== 'function') {
        throw new Error('diary_database_unavailable')
    }
    return requireDb(await supabase.rpc(name, params))
}

function normalizedTopic(value) {
    if (value == null) return ''
    if (typeof value !== 'string' || value.length > 200) throw new Error('invalid_diary_input')
    return value.trim()
}

function getScopeKey({ window, triggerType, topicHint }) {
    if (triggerType === 'daily') return `daily:${window.startDate}`
    const canonical = JSON.stringify([
        window.timeZone, window.startDate, window.endDate, normalizedTopic(topicHint),
    ])
    return `backfill:${crypto.createHash('sha256').update(canonical).digest('hex')}`
}

async function isCoveredByDiary({ supabase, userId, agentId, window }) {
    const data = requireDb(await supabase.from('agent_diary')
        .select('id').eq('user_id', userId).eq('agent_id', agentId)
        .lte('period_start', window.periodStart)
        .gte('period_end', window.periodEnd).limit(1))
    return Array.isArray(data) && data.length > 0
}

async function runWindow({ supabase, userId, agentId, callModel, settings,
    window, triggerType, topicHint = '', reader = readDiaryMessages,
    writer = reviewAndWriteDiary } = {}) {
    if (!supabase || !userId || agentId !== 'star' ||
        !['daily','backfill'].includes(triggerType) ||
        typeof callModel !== 'function') throw new Error('invalid_diary_input')
    const topic = normalizedTopic(topicHint)
    // If a completed multiday backfill already covers this entire day, do not
    // create a redundant DAILY diary. Exact-scope collisions are covered by DB.
    if (triggerType === 'daily' && await isCoveredByDiary({
        supabase, userId, agentId, window,
    })) return { status: 'covered', processed: false }

    const claim = await rpc(supabase, 'diary_claim_review_job', {
        p_user_id: userId, p_agent_id: agentId,
        p_scope_key: getScopeKey({ window, triggerType, topicHint: topic }),
        p_trigger_type: triggerType, p_period_start: window.periodStart,
        p_period_end: window.periodEnd, p_timezone: window.timeZone,
        p_topic_hint: topic,
    })
    if (!claim || claim.claimed !== true) {
        const status = claim?.status
        if (status === 'written' || status === 'skipped') {
            return { status, processed: false }
        }
        // In progress / retry delayed is NOT a successful diary run.
        return { status: 'failed', processed: false,
            errorCode: 'diary_job_busy' }
    }
    const token = claim.leaseToken
    const jobId = claim.jobId
    try {
        const source = await reader({ supabase, userId, agentId,
            periodStart: window.periodStart, periodEnd: window.periodEnd })
        const draft = await writer({ callModel, settings, source, window,
            requested: triggerType === 'backfill', topicHint: topic,
            // Refresh the durable processing lease while reading numerous chunks.
            onChunkDone: async () => {
                const updated = await rpc(supabase, 'diary_renew_review_job', {
                    p_user_id: userId, p_agent_id: agentId,
                    p_job_id: jobId, p_lease_token: token,
                })
                if (updated !== true) {
                    const error = new Error('diary_lease_lost')
                    error.code = 'diary_lease_lost'
                    throw error
                }
            },
        })
        const finalized = await rpc(supabase, 'diary_finish_review_job', {
            p_user_id: userId, p_agent_id: agentId,
            p_job_id: jobId, p_lease_token: token,
            p_action: draft.action,
            p_title: draft.title || '', p_body: draft.body || '',
            p_topics: draft.topics || [], p_source_count: source.includedCount,
            p_source_hash: source.sourceHash, p_source_refs: source.sourceRefs,
            p_skip_code: draft.action === 'skipped' ? draft.reason : null,
        })
        if (!finalized?.ok) throw new Error('diary_finalize_failed')
        // Never return raw diary contents to Action logs or scheduler responses.
        return { status: finalized.status, processed: true,
            sourceCount: source.includedCount, reviewedChunks: draft.chunks }
    } catch (error) {
        const code = safeErrorCode(error)
        try {
            await rpc(supabase, 'diary_fail_review_job', {
                p_user_id: userId, p_agent_id: agentId,
                p_job_id: jobId, p_lease_token: token, p_error_code: code,
            })
        } catch (_) { /* Keep original safe failure; no message/secret logs. */ }
        return { status: 'failed', processed: true, errorCode: code }
    }
}

async function runDiaryTick({ supabase, userId, agentId = 'star',
    triggerType = 'daily', startDate, endDate, topicHint = '',
    getSettings, callModel, now = new Date(),
    reader, writer } = {}) {
    if (!supabase || !userId || agentId !== 'star' ||
        !['daily','backfill'].includes(triggerType) ||
        typeof getSettings !== 'function' || typeof callModel !== 'function') {
        throw new Error('invalid_diary_input')
    }
    const settings = await getSettings(userId)
    // Never silently put a birthday in the wrong local day due to a UTC
    // fallback. Ask the owner to configure settings.timezone instead.
    const timeZone = validTimeZone(settings?.timezone)
    if (!timeZone) {
        const error = new Error('settings_timezone_missing')
        error.code = 'settings_timezone_missing'
        throw error
    }
    const common = { supabase, userId, agentId, callModel, settings,
        ...(reader ? { reader } : {}), ...(writer ? { writer } : {}) }
    if (triggerType === 'backfill') {
        const window = getWindow({ startDate, endDate,
            timeZone, now, allowPartialToday: true })
        return runWindow({ ...common, window, triggerType, topicHint })
    }
    if (startDate != null || endDate != null || topicHint) {
        throw new Error('invalid_diary_input')
    }
    // Diary v2: the daily schedule selects topics and evidence, not a diary date.
    // Legacy manual backfills above retain their previous date-based behavior.
    return runAutonomousDailyTick({ ...common, now })
}

module.exports = { runWindow, runDiaryTick, getScopeKey, safeErrorCode,
    MAX_DAILY_JOBS_PER_TICK, CATCHUP_DAYS }
