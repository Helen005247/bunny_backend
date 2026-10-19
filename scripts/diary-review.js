'use strict'

// GitHub Actions diary dispatcher + poller. Never prints diary text, model
// output, conversation content, request body, userId, secrets, or runId.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const SAFE_STATUSES = new Set(['written','skipped','completed','processing',
    'running','covered','failed','conflict','unavailable','revised','deferred','partial',
    'previewed','verified','committed','already_committed'])
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
    'acceptance_preview_partial','acceptance_probe_failed',
    'verify_search_no_hits','verify_context_missing','verify_revision_mismatch',
    'verify_recall_unavailable','diary_plan_missing','diary_readback_failed',
    'diary_plan_expired','diary_plan_not_found_or_mismatch',
    'diary_manual_scope_already_processed','diary_evidence_changed',
])
const MAX_POLL_MS = 28 * 60 * 1000

// GitHub workflow_dispatch text inputs can carry accidental surrounding whitespace.
// Normalize the same fields for BOTH validation and the POST payload.
function normalizeManualInputs(values) {
    const result={...values}
    for (const name of ['startDate','endDate','topicHint','acceptanceMode',
        'planId','planDigest','confirmWrite']) {
        if (typeof result[name] === 'string') result[name]=result[name].trim()
    }
    if (typeof result.planDigest === 'string') result.planDigest=result.planDigest.toLowerCase()
    return result
}

function assertConfig({ endpoint, userId, secret, startDate='', endDate='', topicHint='',
    acceptanceMode='off', planId='', planDigest='', confirmWrite='' }) {
    ({startDate,endDate,topicHint,acceptanceMode,planId,planDigest,confirmWrite} =
        normalizeManualInputs({startDate,endDate,topicHint,acceptanceMode,
            planId,planDigest,confirmWrite}))
    if (!UUID.test(userId || '') || !secret || secret.length < 24)
        throw new Error('Diary GitHub secrets not configured')
    let url
    try { url=new URL(endpoint) } catch(_) {throw new Error('Invalid diary endpoint')}
    if(url.protocol!=='https:'||url.username||url.password||
       url.pathname!=='/internal/diary/tick'||url.search||url.hash)
        throw new Error('Diary endpoint must be HTTPS /internal/diary/tick')
    if(!['off','preview','probe','live','commit','verify'].includes(acceptanceMode))
        throw new Error('Invalid diary acceptance mode')
    if(typeof topicHint!=='string'||topicHint.length>200)
        throw new Error('Invalid diary topic')
    if(acceptanceMode==='commit') {
        // Only log field names / lengths; never expose digest, token, plan or diary text.
        const invalid=[]
        if(startDate) invalid.push('start_date_not_empty')
        if(endDate) invalid.push('end_date_not_empty')
        if(topicHint) invalid.push('topic_hint_not_empty')
        if(!UUID.test(planId||'')) invalid.push('plan_id_invalid')
        if(!/^[0-9a-f]{64}$/.test(planDigest||'')) {
            const length=typeof planDigest==='string'?planDigest.length:'not_text'
            invalid.push(`plan_digest_invalid(length=${length})`)
        }
        if(confirmWrite!=='WRITE') invalid.push('confirm_write_not_WRITE')
        if(invalid.length) throw new Error('Diary commit plan_id/digest/WRITE inputs invalid: '+invalid.join(', '))
    } else {
        if(planId||planDigest||confirmWrite)
            throw new Error('Invalid plan confirmation fields for non-commit mode')
    }
    if(acceptanceMode==='probe' && (startDate||endDate||topicHint))
        throw new Error('Diary DB probe requires empty date and topic inputs')
    if(acceptanceMode==='verify' && (startDate||endDate||
        topicHint.trim().length<2||topicHint.length>48))
        throw new Error('Diary verify requires keyword only, no dates')
    if(['off','preview','live'].includes(acceptanceMode)) {
        if(Boolean(startDate)!==Boolean(endDate)||
            (startDate&&(!DATE.test(startDate)||!DATE.test(endDate))))
            throw new Error('Manual backfill requires both YYYY-MM-DD dates')
        if(['preview','live'].includes(acceptanceMode)&&!startDate)
            throw new Error('Diary V2 manual mode requires both date inputs')
        if(topicHint.trim()&&!startDate)
            throw new Error('Manual topic requires a date range')
    }
    return url.toString()
}

function safeLog(result) {
    const status=SAFE_STATUSES.has(result.status)?result.status:'unknown'
    const code=SAFE_CODES.has(result.code)?result.code:'none'
    const num=v=>Number.isSafeInteger(v)&&v>=0&&v<1000000?v:'unknown'
    const plan=UUID.test(result.planId||'') && /^[0-9a-f]{64}$/.test(result.planDigest||'')
        ? `; plan_id=${result.planId}; plan_digest=${result.planDigest}`:''
    const layers=`; database=${num(result.dbVerified)}; model=${num(result.modelVerified)}; `+
        `actual_write=${num(result.liveWriteVerified)}`
    if(result.mode==='acceptance_preview'||result.mode==='manual_v2_live') {
        const kind=result.mode==='manual_v2_live'?'live':'preview'
        return `[diary-acceptance] ${kind} status=${status}; `+
          `create=${num(result.previewCreate ?? result.created)}; `+
          `append=${num(result.previewAppend)}; rewrite=${num(result.previewRewrite)}; `+
          `defer=${num(result.previewDefer)}; skipped=${num(result.previewSkipped)}; `+
          `read=${num(result.sourceCount)}; search_hits=${num(result.searchCount)}; `+
          `review=${num(result.reviewDone)}/${num(result.reviewTotal)}; `+
          `rollup=${num(result.rollupDone)}/${num(result.rollupTotal)}; `+
          `cache_hits=${num(result.cacheHits)}; model_calls=${num(result.modelCalls)}`+
          layers+plan+`; code=${code}`
    }
    if(result.mode==='acceptance_commit') {
        return `[diary-acceptance] commit status=${status}; created=${num(result.created)}; `+
          `revised=${num(result.revised)}; deferred=${num(result.deferred)}; `+
          `persisted_actions=${num(result.committedActions)}; readback=${num(result.readbackVerified)}`+
          layers+`; code=${code}`
    }
    if(result.mode==='acceptance_verify') {
        return `[diary-acceptance] verify status=${status}; `+
          `two_create=${num(result.twoCreateVerified)}; search=${num(result.searchVerified)}; `+
          `context=${num(result.contextVerified)}; revision=${num(result.versionVerified)}; `+
          `full_recall=${num(result.recallVerified)}; hits=${num(result.searchCount)}; `+
          `revisions_checked=${num(result.revisionsChecked)}`+layers+`; code=${code}`
    }
    if(result.mode==='acceptance_probe') {
        const state=typeof result.probeSqlstate==='string' && /^[A-Z0-9]{5}$/.test(result.probeSqlstate)
            ? result.probeSqlstate:'unknown'
        return `[diary-acceptance] probe status=${status}; `+
            `create=${num(result.probeCreate)}; append=${num(result.probeAppend)}; `+
            `rewrite=${num(result.probeRewrite)}; defer=${num(result.probeDefer)}; `+
            `duplicate=${num(result.probeDuplicate)}; conflict=${num(result.probeConflict)}; `+
            `atomic=${num(result.probeAtomic)}; rolled_back=${num(result.rolledBack)}; `+
            `stage=${num(result.probeStage)}; sqlstate=${state}; code=${code}`
    }
    return `[diary] review status=${status}; processed=${num(result.processed)}; `+
        `written=${num(result.written ?? result.created)}; revised=${num(result.revised)}; `+
        `deferred=${num(result.deferred)}; skipped=${num(result.skipped)}; `+
        `reviewed=${num(result.reviewedCount ?? result.sourceCount)}; `+
        `cache_hits=${num(result.cacheHits)}; shared_hits=${num(result.reused)}; `+
        `review=${num(result.reviewDone)}/${num(result.reviewTotal)}; `+
        `rollup=${num(result.rollupDone)}/${num(result.rollupTotal)}; `+
        `model_calls=${num(result.modelCalls)}; code=${code}`
}

async function dispatchAndPoll({ endpoint, userId, secret, startDate = '', endDate = '',
    topicHint = '', acceptanceMode='off', planId='', planDigest='', confirmWrite='',
    fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxPollMs = MAX_POLL_MS, nowMs = () => Date.now() } = {}) {
    ({startDate,endDate,topicHint,acceptanceMode,planId,planDigest,confirmWrite} =
        normalizeManualInputs({startDate,endDate,topicHint,acceptanceMode,
            planId,planDigest,confirmWrite}))
    const url = assertConfig({ endpoint, userId, secret, startDate, endDate, topicHint, acceptanceMode,planId,planDigest,confirmWrite })
    if (typeof fetchImpl !== 'function') throw new Error('Fetch unavailable')
    const headers = { 'content-type': 'application/json', 'x-cognition-secret': secret }
    const triggerType=({preview:'acceptance_preview',probe:'acceptance_probe',
        live:'manual_v2_live',commit:'acceptance_commit',verify:'acceptance_verify'})[acceptanceMode] ||
        (startDate?'backfill':'daily')
    const body=JSON.stringify({userId,agentId:'star',triggerType,
        ...(startDate?{startDate,endDate,topicHint:topicHint.trim()}:{}),
        ...(acceptanceMode==='verify'?{topicHint:topicHint.trim()}:{}),
        ...(acceptanceMode==='commit'?{planId,planDigest,confirmWrite:true}:{})})
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

// V3-6 Step 1: a single scheduled wake-up may need several checkpointed
// Review/Rollup passes. The database RPCs own leases, checkpoints, and the
// at-most-two autonomous actions of a single final decision. Never retry a
// finalized job merely because it wrote zero diaries.
const DAILY_TERMINAL_STATUSES = new Set([
    'completed','written','skipped','revised','deferred','covered',
])
const DAILY_AUTO_LIMITS = Object.freeze({
    maxRounds: 10,
    maxTotalModelCalls: 60,
    // The Action itself has a 35-minute timeout. Leave time for job cleanup.
    maxElapsedMs: 28 * 60 * 1000,
    maxPollPerRoundMs: 7 * 60 * 1000,
    assumedMaxCallsPerRound: 6, // Matches newReviewBudget's deployed default.
    minimumRemainingMs: 2 * 60 * 1000,
    delayBetweenRoundsMs: 5000,
    maxStalledRounds: 2,
})

function dailyModeOnly(input) {
    const v=normalizeManualInputs(input)
    return (v.acceptanceMode||'off')==='off' && !v.startDate && !v.endDate &&
        !v.topicHint && !v.planId && !v.planDigest && !v.confirmWrite
}

function progressOfPartial(result) {
    const num=(v)=>Number.isSafeInteger(v)&&v>=0&&v<=1000000
    if (!num(result?.reviewDone)||!num(result?.reviewTotal)||
        !num(result?.rollupDone)||!num(result?.rollupTotal)||
        !num(result?.modelCalls)||result.reviewDone>result.reviewTotal||
        result.rollupDone>result.rollupTotal) return null
    return {
        reviewDone:result.reviewDone,reviewTotal:result.reviewTotal,
        rollupDone:result.rollupDone,rollupTotal:result.rollupTotal,
        modelCalls:result.modelCalls,
    }
}

function summaryProgress(progress) {
    // No user data or diarized text; counters only.
    return `review=${progress.reviewDone}/${progress.reviewTotal}; `+
        `rollup=${progress.rollupDone}/${progress.rollupTotal}`
}

function incomplete(reason) {
    // The checkpoint is durable. Deliberately fail the Action instead of
    // reporting a green success for work that has not finished.
    throw new Error(`Diary incomplete (${reason}); checkpoint retained for the next run`)
}

async function continueDailyDiary({
    dispatch = dispatchAndPoll,
    dispatchOptions,
    sleep = ms => new Promise(resolve => setTimeout(resolve,ms)),
    nowMs = () => Date.now(),
    limits = DAILY_AUTO_LIMITS,
    log = message => console.log(message),
}={}) {
    if(typeof dispatch!=='function'||!dispatchOptions||typeof sleep!=='function'||
        typeof nowMs!=='function'||typeof log!=='function')
        throw new Error('Invalid diary auto-resume configuration')
    const started=nowMs()
    let totalCalls=0,previousProgress=null,stalledRounds=0
    for(let round=1;round<=limits.maxRounds;round++) {
        const remaining=limits.maxElapsedMs-(nowMs()-started)
        if(remaining<limits.minimumRemainingMs) incomplete('time budget')
        // Refuse to start another backend pass unless the full per-pass model
        // budget still fits. Cost caps apply across all resumptions.
        if(totalCalls+limits.assumedMaxCallsPerRound>limits.maxTotalModelCalls)
            incomplete('model-call budget')
        log(`[diary] auto-resume round=${round}/${limits.maxRounds}; `+
            `model_calls_total=${totalCalls}/${limits.maxTotalModelCalls}`)
        const result=await dispatch({...dispatchOptions,
            maxPollMs:Math.min(limits.maxPollPerRoundMs,remaining-30000)})
        if(result?.status!=='partial') {
            // A safe exit must represent a genuinely finished daily job. The
            // original poller also validates status.ok before returning.
            if(!result?.ok || !DAILY_TERMINAL_STATUSES.has(result?.status))
                throw new Error('Diary unexpected daily terminal status')
            // 'completed' can include a deliberate skip or zero new entries.
            // Never dispatch again after a finalized daily decision.
            log(`[diary] auto-resume completed in ${round} round(s); `+
                `model_calls_partial=${totalCalls}`)
            return result
        }
        const progress=progressOfPartial(result)
        if(!progress) incomplete('invalid partial progress')
        if(progress.modelCalls>limits.assumedMaxCallsPerRound)
            incomplete('unexpected model-call budget')
        totalCalls+=progress.modelCalls
        log(`[diary] auto-resume partial; ${summaryProgress(progress)}; `+
            `model_calls_total=${totalCalls}/${limits.maxTotalModelCalls}`)
        // A blocked lease or retry cooldown is not a reason to burn model calls
        // by immediately sending another tick. Resume at the next schedule.
        if(progress.reviewTotal===0&&progress.rollupTotal===0&&progress.modelCalls===0)
            incomplete('busy or retry cooldown')
        // Selection retries can leave review/rollup counters unchanged for one
        // pass; two consecutive passes with no measurable progress are a stall.
        const current=[progress.reviewDone,progress.reviewTotal,
            progress.rollupDone,progress.rollupTotal].join(':')
        stalledRounds=current===previousProgress?stalledRounds+1:0
        previousProgress=current
        if(stalledRounds>=limits.maxStalledRounds || progress.modelCalls===0)
            incomplete('no progress')
        if(round===limits.maxRounds) incomplete('round budget')
        if(limits.maxElapsedMs-(nowMs()-started)<limits.minimumRemainingMs)
            incomplete('time budget')
        if(totalCalls+limits.assumedMaxCallsPerRound>limits.maxTotalModelCalls)
            incomplete('model-call budget')
        await sleep(limits.delayBetweenRoundsMs)
    }
    incomplete('round budget')
}

async function main() {
    const options = {
        endpoint: process.env.DIARY_ENDPOINT,
        userId: process.env.COGNITION_USER_ID,
        secret: process.env.COGNITION_TICK_SECRET,
        startDate: process.env.DIARY_START_DATE || '',
        endDate: process.env.DIARY_END_DATE || '',
        topicHint: process.env.DIARY_TOPIC_HINT || '',
        acceptanceMode:process.env.DIARY_ACCEPTANCE_MODE || 'off',
        planId:process.env.DIARY_PLAN_ID || '',
        planDigest:process.env.DIARY_PLAN_DIGEST || '',
        confirmWrite:process.env.DIARY_CONFIRM_WRITE || '',
    }
    const result=dailyModeOnly(options)
        ? await continueDailyDiary({dispatchOptions:options})
        : await dispatchAndPoll(options)
    console.log(safeLog(result))
}
if (require.main === module) {
    main().catch((error) => {
        const message = String(error?.message || '')
        // Only known safe internal messages/status codes are passed through.
        const safe = /^(\[(?:diary|diary-acceptance)\] |Diary |Invalid |Manual |Fetch )/.test(message)
            ? message : 'Diary review failed'
        console.error('[diary] failed:', safe)
        process.exitCode = 1
    })
}
module.exports = { assertConfig, safeLog, dispatchAndPoll,
    continueDailyDiary, dailyModeOnly, progressOfPartial, DAILY_AUTO_LIMITS }
