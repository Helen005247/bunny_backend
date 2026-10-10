'use strict'

// One private *manual* trigger for Background Cognition Step 2.
// Never expose user data through a public GET endpoint.

const crypto = require('crypto')
const express = require('express')
const { runCognitionTick } = require('../services/cognition/cognitionService')

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
    runTick = runCognitionTick, expectedSecret = process.env.COGNITION_TICK_SECRET,
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
            if (!UUID_RE.test(input.userId || '') ||
                (input.agentId != null && input.agentId !== 'star')) {
                return res.status(400).json({ ok: false,
                    error: '请提供有效的 userId；Step 2 目前仅支持 agentId=star' })
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
            })
            return res.json({ ok: true, ...result })
        } catch (error) {
            console.error('[cognition] manual tick failed:', error?.message || error)
            return res.status(500).json({ ok: false,
                error: 'Cognition 执行失败，请查看后端日志（不会影响聊天）' })
        }
    })

    return router
}

module.exports = createCognitionRouter
module.exports.secureEqual = secureEqual
