'use strict'

const express = require('express')
const crypto = require('crypto')
const { secureEqual } = require('./cognition')
const { runDiaryTick, safeErrorCode } = require('../services/diary/diaryService')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VALID_STATUSES = new Set(['written','skipped','failed','completed','processing',
    'covered','unavailable','conflict','revised','deferred'])

function createInternalDiaryRouter({ supabase, callModel, getSettings,
    expectedSecret = process.env.COGNITION_TICK_SECRET,
    runTick = runDiaryTick } = {}) {
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
        if (!UUID_RE.test(input.userId || '') ||
            (input.agentId !== undefined && input.agentId !== 'star') ||
            !['daily','backfill'].includes(input.triggerType) ||
            (input.topicHint != null &&
                (typeof input.topicHint !== 'string' || input.topicHint.length > 200))) {
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
            const result = await runTick({ supabase, callModel, getSettings,
                userId: input.userId, agentId: 'star',
                triggerType: input.triggerType,
                startDate: input.startDate, endDate: input.endDate,
                topicHint: input.topicHint || '' })
            const status = VALID_STATUSES.has(result?.status) ? result.status : 'failed'
            const safe = { ok: status !== 'failed', status,
                runId, processed: Number.isInteger(result?.processed) ? result.processed :
                    (result?.processed === true ? 1 : 0) }
            for (const key of ['written','revised','deferred','created','skipped','reviewedCount','sourceCount','reviewedChunks','searchCount']) {
                if (Number.isSafeInteger(result?.[key]) && result[key] >= 0) {
                    safe[key] = result[key]
                }
            }
            if (result?.errorCode) safe.code = safeErrorCode({ code: result.errorCode })
            item.status = safe.ok ? 'done' : 'failed'
            item.safe = safe
        }).catch((error) => {
            const code = safeErrorCode(error)
            console.warn(`[diary] tick failed; code=${code}`)
            item.status = 'failed'
            item.safe = { ok: false, status: 'failed', runId, code }
        })
        return res.status(202).json({ ok: true, status: 'started', runId })
    })
    return router
}

function createUserDiaryRouter({ supabase } = {}) {
    const router = express.Router()
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
