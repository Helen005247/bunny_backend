'use strict'

const express = require('express')
const {
    getCurrentVisualIdentity,
    addCandidate,
    approveVisualIdentity,
    getHistory,
} = require('../services/visualIdentity/visualIdentityService')

function createVisualIdentityRouter({ supabase }) {
    const router = express.Router()

    router.get('/current', async (req, res) => {
        try {
            const data = await getCurrentVisualIdentity({ supabase })
            res.json({ ok: true, identity: data })
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message })
        }
    })

    router.get('/history', async (req, res) => {
        try {
            const data = await getHistory({ supabase })
            res.json({ ok: true, history: data })
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message })
        }
    })

    router.post('/candidate', async (req, res) => {
        try {
            const data = await addCandidate({
                supabase,
                payload: req.body || {},
            })
            res.status(201).json({ ok: true, identity: data })
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message })
        }
    })

    router.post('/approve', async (req, res) => {
        try {
            const data = await approveVisualIdentity({
                supabase,
                id: req.body.id,
            })
            res.json({ ok: true, identity: data })
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message })
        }
    })


    router.get('/source/:id', async (req, res) => {
        try {
            const { data, error } = await supabase
                .from('visual_identity')
                .select('*')
                .eq('source_image_id', req.params.id)

            if (error) throw error
            res.json({ ok: true, identities: data || [] })
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message })
        }
    })

    return router
}

module.exports = createVisualIdentityRouter
