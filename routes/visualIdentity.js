'use strict'

const express = require('express')
const {
    AGENT_ID,
    getCurrentVisualIdentity,
    getHistory,
    getIdentitiesBySource,
    addCandidate,
    approveVisualIdentity,
} = require('../services/visualIdentity/visualIdentityService')

function createVisualIdentityRouter({ supabase }) {
    const router = express.Router()

    function sendError(res, error) {
        const safe = Number.isInteger(error?.status) &&
            error.status >= 400 && error.status < 500 &&
            typeof error?.code === 'string'
        if (!safe) console.error('[visual-identity] request failed:', error?.code || 'database_error')
        return res.status(safe ? error.status : 500).json({
            ok: false,
            code: safe ? error.code : 'VISUAL_IDENTITY_FAILED',
            error: safe ? error.message : '视觉身份服务暂时不可用，请稍后重试',
        })
    }

    // req.userId is set by server.js /api/visual-identity requireAuth.
    // Do not accept userId or agentId query/body overrides.
    router.get('/current', async (req, res) => {
        try {
            const identity = await getCurrentVisualIdentity({ supabase, userId: req.userId, agentId: AGENT_ID })
            return res.json({ ok: true, identity })
        } catch (error) { return sendError(res, error) }
    })

    router.get('/history', async (req, res) => {
        try {
            const history = await getHistory({ supabase, userId: req.userId, agentId: AGENT_ID })
            return res.json({ ok: true, history })
        } catch (error) { return sendError(res, error) }
    })

    router.get('/source/:id', async (req, res) => {
        try {
            const identities = await getIdentitiesBySource({
                supabase, userId: req.userId, sourceImageId: req.params.id, agentId: AGENT_ID,
            })
            return res.json({ ok: true, identities })
        } catch (error) { return sendError(res, error) }
    })

    router.post('/candidate', async (req, res) => {
        try {
            const identity = await addCandidate({
                supabase, userId: req.userId, agentId: AGENT_ID, payload: req.body,
            })
            return res.status(201).json({ ok: true, identity })
        } catch (error) { return sendError(res, error) }
    })

    router.post('/approve', async (req, res) => {
        try {
            const identity = await approveVisualIdentity({
                supabase, userId: req.userId, agentId: AGENT_ID, id: req.body?.id,
            })
            return res.json({ ok: true, identity })
        } catch (error) { return sendError(res, error) }
    })

    return router
}

module.exports = createVisualIdentityRouter
