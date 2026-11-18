'use strict'

// One private *manual* trigger for Background Cognition Step 2.
// Never expose user data through a public GET endpoint.

const crypto = require('crypto')
const express = require('express')
const { runCognitionTick } = require('../services/cognition/cognitionService')
const { matchesExpectedUserId } = require('../services/agentIdentity')
const { enqueueCognitionEvent, dispatchOneCognitionEvent } =
    require('../services/cognition/cognitionEventQueue')
const { scanIdle } = require('../services/cognition/phase4bIdleService')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function secureEqual(actual, expected) {
    if (typeof actual !== 'string' || typeof expected !== 'string' ||
        !actual || !expected) return false
    const a = Buffer.from(actual)
    const b = Buffer.from(expected)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function createCognitionRouter({ supabase, callModel,
    getSettings, getLatestMemory, getMilestoneContext,
    getCharacterLoreContext, getStoryLoreContext,
    runTick = runCognitionTick,
    enqueueEvent = enqueueCognitionEvent,
    dispatchEvent = dispatchOneCognitionEvent,
    scanConversation = scanIdle,
    expectedSecret = process.env.COGNITION_TICK_SECRET,
    expectedUserId = process.env.HERMIT_STAR_USER_ID,
} = {}) {
    const router = express.Router()

    router.post('/tick', async (req, res) => {
        try {
            if (!expectedSecret || expectedSecret.length < 24) {
                return res.status(503).json({ ok: false,
                    error: '未配置有效的 COGNITION_TICK_SECRET（至少24字符）' })
            }
            if (!secureEqual(req.get('x-cognition-secret'), expectedSecret)) {
                return res.status(401).json({ ok: false, error: 'Unauthorized' })
            }
            if (!supabase || typeof callModel !== 'function') {
                return res.status(503).json({ ok: false,
                    error: 'Cognition 数据库或模型尚未配置' })
            }
            const input = req.body || {}
            if (!UUID_RE.test(expectedUserId || '')) {
                return res.status(503).json({ ok: false,
                    error: '未配置有效的 HERMIT_STAR_USER_ID' })
            }
            if (!UUID_RE.test(input.userId || '')) {
                return res.status(400).json({ ok: false,
                    error: '请提供有效的 userId' })
            }
            if (!matchesExpectedUserId(input.userId, expectedUserId)) {
                return res.status(403).json({ ok: false,
                    error: '当前 Cognition 入口仅允许配置的 Star 用户' })
            }
            if (input.agentId != null && input.agentId !== 'star') {
                return res.status(400).json({ ok: false,
                    error: '当前 Cognition 入口仅支持 agentId=star' })
            }
            // Private callers may use heartbeat to check absence/review
            // checkpoints. Manual remains the Step 2 backwards-compatible default.
            const triggerType = input.triggerType == null
                ? 'manual' : input.triggerType
            if (triggerType !== 'manual' && triggerType !== 'heartbeat') {
                return res.status(400).json({ ok: false,
                    error: 'Step 3 只支持 triggerType=manual 或 heartbeat' })
            }
            if (!process.env.AI_API_KEY || !process.env.AI_BASE_URL) {
                return res.status(503).json({ ok: false,
                    error: 'AI_API_KEY 或 AI_BASE_URL 尚未配置' })
            }

            const result = await runTick({
                supabase, userId: input.userId, agentId: 'star',
                triggerType,
                callModel, getSettings, getLatestMemory, getMilestoneContext,
                getCharacterLoreContext, getStoryLoreContext,
            })
            return res.json({ ok: true, ...result })
        } catch (error) {
            // Any provider/DB exception may contain sensitive data. The service
            // logs only a fixed execution-stage code; never print raw errors.
            console.error('[cognition] tick request failed; see sanitized stage logs')
            return res.status(500).json({ ok: false,
                error: 'Cognition 执行失败，请查看后端日志（不会影响聊天）' })
        }
    })

    // Phase 4A is dormant unless explicitly enabled after migration.
    // Neither endpoint accepts a raw Thought or prompt from the caller.
    function checkEventAccess(req,res) {
        if (process.env.COGNITION_PHASE4_EVENTS_ENABLED !== 'true') {
            res.status(503).json({ok:false,error:'EVENT_QUEUE_DISABLED'})
            return false
        }
        if (!expectedSecret || expectedSecret.length < 24 ||
            !secureEqual(req.get('x-cognition-secret'),expectedSecret)) {
            res.status(401).json({ok:false,error:'Unauthorized'})
            return false
        }
        if (!supabase || !UUID_RE.test(expectedUserId || '')) {
            res.status(503).json({ok:false,error:'EVENT_QUEUE_UNAVAILABLE'})
            return false
        }
        const input=req.body || {}
        if (!UUID_RE.test(input.userId || '') ||
            !matchesExpectedUserId(input.userId,expectedUserId) ||
            (input.agentId != null && input.agentId !== 'star')) {
            res.status(403).json({ok:false,error:'EVENT_USER_NOT_ALLOWED'})
            return false
        }
        return true
    }

    // Do not register new endpoints until an operator enables Phase 4A.
    // This also preserves the legacy single-route contract by default.
    if (process.env.COGNITION_PHASE4_EVENTS_ENABLED === 'true') {
    router.post('/events/enqueue', async (req,res)=>{
        if (!checkEventAccess(req,res)) return
        try {
            const input=req.body || {}
            const result=await enqueueEvent({
                supabase,userId:input.userId,agentId:'star',
                eventType:input.eventType,eventKey:input.eventKey
            })
            return res.json({ok:true,status:result.status,eventId:result.id})
        } catch (_) {
            return res.status(400).json({ok:false,error:'EVENT_ENQUEUE_FAILED'})
        }
    })

    router.post('/events/dispatch', async (req,res)=>{
        if (!checkEventAccess(req,res)) return
        if (typeof callModel!=='function') return res.status(503)
            .json({ok:false,error:'MODEL_UNAVAILABLE'})
        try {
            const result=await dispatchEvent({
                supabase,userId:req.body.userId,agentId:'star',runTick,callModel,
                getSettings,getLatestMemory,getMilestoneContext,
                getCharacterLoreContext,getStoryLoreContext
            })
            // Do not expose the Thought body or raw event details.
            return res.json({ok:true,status:result.status,executed:result.executed})
        } catch (_) {
            console.warn('[cognition] event dispatch failed; stage=dispatch')
            return res.status(500).json({ok:false,error:'EVENT_DISPATCH_FAILED'})
        }
    })

    // Phase 4B scanning and dispatch are one private operation.  This is
    // only invoked by the scheduled GitHub Action (or an explicit test).
    if (process.env.COGNITION_PHASE4B_ENABLED === 'true') {
        router.post('/phase4b/scan-dispatch', async (req,res)=>{
            if (!checkEventAccess(req,res)) return
            if (typeof callModel !== 'function') return res.status(503)
                .json({ok:false,error:'MODEL_UNAVAILABLE'})
            try {
                const scan=await scanConversation({supabase,userId:req.body.userId,agentId:'star'})
                // Never start any event cognition while a conversation is active.
                if (scan.status==='voice_active' || scan.status==='not_idle') {
                    return res.json({ok:true,scan:scan.status,dispatch:'skipped_active'})
                }
                const dispatched=await dispatchEvent({
                    supabase,userId:req.body.userId,agentId:'star',runTick,callModel,
                    getSettings,getLatestMemory,getMilestoneContext,
                    getCharacterLoreContext,getStoryLoreContext,
                })
                return res.json({ok:true,scan:scan.status,dispatch:dispatched.status,
                    executed:dispatched.executed===true})
            } catch (_) {
                console.warn('[cognition] phase4b scan-dispatch failed')
                return res.status(500).json({ok:false,error:'PHASE4B_SCAN_DISPATCH_FAILED'})
            }
        })
    }
    } // End optional Phase 4A event endpoints.

    return router
}

module.exports = createCognitionRouter
module.exports.secureEqual = secureEqual
