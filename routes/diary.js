'use strict'

const express = require('express')
const crypto = require('crypto')
const { secureEqual } = require('./cognition')
const { runDiaryTick, safeErrorCode } = require('../services/diary/diaryService')
const { runAcceptancePreview, runAcceptanceProbe, runManualV2Live } = require('../services/diary/diaryAcceptance')
const {commitDiaryPreviewPlan} = require('../services/diary/diaryPlanStore')
const {runDiaryV2Verification} = require('../services/diary/diaryVerification')
const { parseMonthQuery, monthUtcSearchBounds, monthCalendarEntries } = require('../services/diary/diaryCalendar')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VALID_STATUSES = new Set(['written','skipped','failed','completed','processing',
    'covered','unavailable','conflict','revised','deferred','partial',
    'previewed','verified','committed','already_committed'])

function createInternalDiaryRouter({ supabase, callModel, getSettings,
    expectedSecret = process.env.COGNITION_TICK_SECRET,
    runTick = runDiaryTick, runPreview = runAcceptancePreview,
    runProbe = runAcceptanceProbe, runLive = runManualV2Live,
    runCommit = commitDiaryPreviewPlan, runVerify = runDiaryV2Verification } = {}) {
    const router = express.Router()
    // Model review can take several minutes across many chunks. The initiating
    // HTTP call returns immediately; GitHub polls until a terminal result.
    // This keeps Render awake even on plans with HTTP request time limits.
    // Durable lease/job state is stored in Postgres; after process failure a
    // future daily run may reclaim the lease, never mark a false success.
    const runs = new Map()
    const MAX_LOCAL_RUNS = 100
    function authorize(req, res) {
        if (typeof expectedSecret !== 'string' || expectedSecret.length < 24) {
            res.status(503).json({ ok: false, code: 'diary_secret_not_configured' })
            return false
        }
        if (!secureEqual(req.get('x-cognition-secret'), expectedSecret)) {
            res.status(401).json({ ok: false, code: 'unauthorized' })
            return false
        }
        return true
    }
    function purgeRuns() {
        const expiry = Date.now() - 2 * 60 * 60 * 1000
        for (const [id, item] of runs) {
            if (item.created < expiry && item.status !== 'running') runs.delete(id)
        }
        while (runs.size > MAX_LOCAL_RUNS) {
            const oldest = [...runs].find(([, value]) => value.status !== 'running')
            if (!oldest) break
            runs.delete(oldest[0])
        }
    }
    router.get('/status/:id', (req, res) => {
        if (!authorize(req, res)) return
        if (!UUID_RE.test(req.params.id || '')) {
            return res.status(400).json({ ok: false, code: 'invalid_run_id' })
        }
        const item = runs.get(req.params.id)
        // A restarted worker loses its in-process receipt. This is a failure,
        // not a reported successful diary. The Postgres job remains retryable.
        if (!item) return res.status(404).json({ ok: false, code: 'run_lost' })
        return res.set('Cache-Control', 'no-store').json(item.safe)
    })
    router.post('/tick', async (req, res) => {
        if (!authorize(req, res)) return
        if (!supabase || typeof callModel !== 'function' ||
            typeof getSettings !== 'function') {
            return res.status(503).json({ ok: false, code: 'diary_unavailable' })
        }
        const input = req.body || {}
        const type=input.triggerType
        const withDates=type==='acceptance_preview'||type==='manual_v2_live'
        const noDates=type==='acceptance_probe'||type==='acceptance_commit'||
            type==='acceptance_verify'||type==='daily'
        if (!UUID_RE.test(input.userId || '') ||
            (input.agentId !== undefined && input.agentId !== 'star') ||
            !['daily','backfill','acceptance_preview','acceptance_probe',
              'manual_v2_live','acceptance_commit','acceptance_verify'].includes(type) ||
            (input.topicHint != null &&
                (typeof input.topicHint !== 'string' || input.topicHint.length>200)) ||
            (withDates && (typeof input.startDate!=='string' ||
                typeof input.endDate!=='string' || !input.startDate || !input.endDate)) ||
            (noDates && (input.startDate!=null || input.endDate!=null)) ||
            (type==='acceptance_probe' && input.topicHint) ||
            (type==='acceptance_verify' &&
                (typeof input.topicHint!=='string' || input.topicHint.trim().length<2 ||
                 input.topicHint.length>48)) ||
            (type==='acceptance_commit' && (input.topicHint ||
                !UUID_RE.test(input.planId||'') ||
                !/^[0-9a-f]{64}$/.test(input.planDigest||'') ||
                input.confirmWrite!==true)) ||
            (type!=='acceptance_commit' && (input.planId!=null ||
                input.planDigest!=null || input.confirmWrite!=null))) {
            return res.status(400).json({ ok: false, code: 'invalid_diary_input' })
        }
        purgeRuns()
        const runId = crypto.randomUUID()
        const item = { created: Date.now(), status: 'running',
            safe: { ok: true, status: 'running', runId } }
        runs.set(runId, item)
        // All errors become a terminal FAILED status. Never print private
        // user text/model output in HTTP responses or Render diagnostic logs.
        void Promise.resolve().then(async () => {
            const common={supabase,callModel,getSettings,userId:input.userId,
                agentId:'star',startDate:input.startDate,endDate:input.endDate,
                topicHint:input.topicHint||''}
            const result = input.triggerType==='acceptance_preview'
                ? await runPreview(common)
                : input.triggerType==='manual_v2_live'
                    ? await runLive(common)
                    : input.triggerType==='acceptance_probe'
                        ? await runProbe(common)
                        : input.triggerType==='acceptance_verify'
                            ? await runVerify({...common,keyword:input.topicHint})
                            : input.triggerType==='acceptance_commit'
                                ? await runCommit({...common,planId:input.planId,
                                    planDigest:input.planDigest})
                                : await runTick({...common,triggerType:input.triggerType})
            const status = VALID_STATUSES.has(result?.status) ? result.status : 'failed'
            const safe = { ok: status !== 'failed', status,
                ...(['acceptance_preview','acceptance_probe','acceptance_verify',
                    'acceptance_commit','manual_v2_live'].includes(type)
                    ? {mode:type}:{}),
                runId, processed: Number.isInteger(result?.processed) ? result.processed :
                    (result?.processed === true ? 1 : 0) }
            for (const key of ['written','revised','deferred','created','skipped','reviewedCount','sourceCount','reviewedChunks','cacheHits','searchCount','reviewDone','reviewTotal','rollupDone','rollupTotal','reused','modelCalls','previewCreate','previewAppend',
                'previewRewrite','previewDefer','previewSkipped','probeCreate',
                'probeAppend','probeRewrite','probeDefer','probeDuplicate',
                'probeConflict','probeAtomic','rolledBack','probeStage',
                'committedActions','dbVerified','modelVerified','liveWriteVerified',
                'readbackVerified','twoCreateVerified','searchVerified',
                'contextVerified','versionVerified','recallVerified','contextCount',
                'revisionsChecked']) {
                if (Number.isSafeInteger(result?.[key]) && result[key] >= 0) {
                    safe[key] = result[key]
                }
            }
            if(UUID_RE.test(result?.planId||'')) safe.planId=result.planId
            if(/^[0-9a-f]{64}$/.test(result?.planDigest||'')) safe.planDigest=result.planDigest
            if (result?.probeSqlstate && /^[A-Z0-9]{5}$/.test(result.probeSqlstate))
                safe.probeSqlstate=result.probeSqlstate
            if (result?.errorCode) safe.code = safeErrorCode({ code: result.errorCode })
            if (status === 'partial') safe.code =
                ['acceptance_preview','manual_v2_live'].includes(type)
                    ? 'acceptance_preview_partial' : 'review_partial'
            item.status = safe.ok ? 'done' : 'failed'
            item.safe = safe
        }).catch((error) => {
            const code = safeErrorCode(error)
            console.warn(`[diary] tick failed; code=${code}`)
            item.status = 'failed'
            item.safe = { ok: false, status: 'failed', runId, code,
                ...(['acceptance_preview','acceptance_probe','acceptance_verify',
                    'acceptance_commit','manual_v2_live'].includes(type)
                    ? {mode:type}:{}) }
        })
        return res.status(202).json({ ok: true, status: 'started', runId })
    })
    return router
}

function createUserDiaryRouter({ supabase } = {}) {
    const router = express.Router()
    // Authenticated owner-only preview plan APIs. Planned private prose is
    // NEVER emitted into GitHub or Render logs; it is available here only
    // after the normal requireAuth middleware sets req.userId.
    router.get('/acceptance/plans', async (req,res) => {
        if(!supabase || !req.userId) return res.status(503).json({ok:false})
        try {
            const result=await supabase.from('diary_acceptance_plans')
                .select('id,status,scope_hash,plan_digest,start_date,end_date,created_at,expires_at,committed_at,actions')
                .eq('user_id',req.userId).eq('agent_id','star')
                .order('created_at',{ascending:false}).limit(12)
            if(result.error) throw new Error()
            const plans=(result.data||[]).map(({actions,...row})=>({...row,
                actionKinds:Array.isArray(actions)?actions.map(a=>a.kind):[]}))
            return res.set('Cache-Control','no-store').json({ok:true,plans})
        } catch(_) {return res.status(503).json({ok:false,code:'diary_read_unavailable'})}
    })
    router.get('/acceptance/plans/:id', async (req,res) => {
        if(!supabase || !req.userId) return res.status(503).json({ok:false})
        if(!UUID_RE.test(req.params.id||''))
            return res.status(400).json({ok:false,code:'invalid_id'})
        try {
            const result=await supabase.from('diary_acceptance_plans')
                .select('id,status,plan_digest,start_date,end_date,topic_hint,actions,evidence_refs,source_messages,search_hits,created_at,expires_at,committed_at')
                .eq('user_id',req.userId).eq('agent_id','star').eq('id',req.params.id)
                .maybeSingle()
            if(result.error) throw new Error()
            if(!result.data)return res.status(404).json({ok:false,code:'not_found'})
            return res.set('Cache-Control','no-store').json({ok:true,plan:result.data})
        } catch(_) {return res.status(503).json({ok:false,code:'diary_read_unavailable'})}
    })
    router.get('/', async (req, res) => {
        if (!supabase || !req.userId) return res.status(503).json({ ok: false })
        const limit = req.query?.limit == null ? 20 : Number(req.query.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
            return res.status(400).json({ ok: false, code: 'invalid_limit' })
        }
        try {
            const { data, error } = await supabase.from('agent_diary')
                .select('id, title, topics, period_start, period_end, timezone, created_at')
                .eq('user_id', req.userId).eq('agent_id', 'star')
                .order('created_at', { ascending: false }).limit(limit)
            if (error) throw new Error()
            return res.set('Cache-Control','no-store').json({ ok: true, entries: data || [] })
        } catch (_) {
            return res.status(503).json({ ok: false, code: 'diary_read_unavailable' })
        }
    })
    // V3-2: read-only month index. The ordinary /api/diary and /:id routes
    // remain unchanged. Authentication is inherited from server.js requireAuth.
    // All queries constrain BOTH the verified owner and the Star persona.
    router.get('/month', async (req, res) => {
        if (!supabase || !req.userId) {
            return res.status(503).json({ ok: false, code: 'diary_unavailable' })
        }
        const input = parseMonthQuery(req.query)
        if (!input) {
            return res.status(400).json({ ok: false, code: 'invalid_month_query' })
        }
        const { year, month, limit, offset } = input
        const { start, end } = monthUtcSearchBounds(year, month)
        try {
            const result = await supabase.from('agent_diary')
                .select('id,title,created_at,updated_at,timezone')
                .eq('user_id', req.userId).eq('agent_id', 'star')
                .gte('created_at', start).lt('created_at', end)
                .order('created_at', { ascending: false })
                .order('id', { ascending: false })
                .range(offset, offset + limit - 1)
            if (result.error || !Array.isArray(result.data)) throw new Error()
            const entries = monthCalendarEntries(result.data, year, month)
            // nextOffset counts database rows BEFORE local-month filtering.
            // This prevents skipped pages near timezone boundaries.
            return res.set('Cache-Control', 'private, no-store').json({
                ok: true, entries,
                nextOffset: offset + result.data.length,
                hasMore: result.data.length === limit,
            })
        } catch (_) {
            return res.status(503).json({ ok: false, code: 'diary_read_unavailable' })
        }
    })

    // Immutable snapshots; authenticated owner only. The browser cannot
    // query diary_revisions directly because its table is service-only.
    router.get('/:id/revisions', async (req, res) => {
        if (!supabase || !req.userId) return res.status(503).json({ ok:false })
        if (!UUID_RE.test(req.params.id || '')) return res.status(400).json({ok:false,code:'invalid_id'})
        try {
            const result = await supabase.from('diary_revisions')
                .select('version,kind,created_at')
                .eq('diary_id',req.params.id).eq('user_id',req.userId).eq('agent_id','star')
                .order('version',{ascending:false}).limit(100)
            if (result.error) throw new Error()
            return res.set('Cache-Control','no-store').json({ok:true,revisions:result.data||[]})
        } catch (_) { return res.status(503).json({ok:false,code:'diary_read_unavailable'}) }
    })
    router.get('/:id/revisions/:version', async (req, res) => {
        if (!supabase || !req.userId) return res.status(503).json({ok:false})
        const version = Number(req.params.version)
        if (!UUID_RE.test(req.params.id||'') || !Number.isSafeInteger(version) ||
            version<1 || version>10000) return res.status(400).json({ok:false,code:'invalid_revision'})
        try {
            const result = await supabase.from('diary_revisions')
                .select('version,kind,title,body,topics,created_at')
                .eq('diary_id',req.params.id).eq('user_id',req.userId).eq('agent_id','star')
                .eq('version',version).maybeSingle()
            if (result.error) throw new Error()
            if (!result.data) return res.status(404).json({ok:false,code:'not_found'})
            return res.set('Cache-Control','no-store').json({ok:true,revision:result.data})
        } catch (_) { return res.status(503).json({ok:false,code:'diary_read_unavailable'}) }
    })
    router.get('/:id', async (req, res) => {
        if (!supabase || !req.userId) return res.status(503).json({ ok: false })
        if (!UUID_RE.test(req.params.id || '')) {
            return res.status(400).json({ ok: false, code: 'invalid_id' })
        }
        try {
            const { data, error } = await supabase.from('agent_diary')
                .select('id, title, body, topics, period_start, period_end, timezone, created_at, source_message_count')
                .eq('id', req.params.id).eq('user_id', req.userId).eq('agent_id', 'star')
                .maybeSingle()
            if (error) throw new Error()
            if (!data) return res.status(404).json({ ok: false, code: 'not_found' })
            return res.set('Cache-Control','no-store').json({ ok: true, entry: data })
        } catch (_) {
            return res.status(503).json({ ok: false, code: 'diary_read_unavailable' })
        }
    })
    return router
}

module.exports = { createInternalDiaryRouter, createUserDiaryRouter }
