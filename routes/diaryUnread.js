'use strict'

// V3-6 Step 2: owner-scoped, content-free unread diary notifications.
// Mounted only under the existing /api/diary requireAuth middleware.
const express = require('express')
const { dateKeyInTimezone } = require('../services/diary/diaryCalendar')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TYPES = new Set(['star_diary', 'star_note'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function isValidDate(value) {
    if (typeof value !== 'string' || !DATE_RE.test(value)) return false
    const [year,month,day] = value.split('-').map(Number)
    return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 &&
        day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}
function validTimestamp(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
function safeItem(row) {
    if (!row || !TYPES.has(row.kind) || !UUID_RE.test(row.target_id || '') ||
        !Number.isSafeInteger(row.event_id) || row.event_id < 1) return null
    if (row.kind === 'star_diary') {
        const date = dateKeyInTimezone(row.diary_created_at, row.diary_timezone)
        if (!isValidDate(date) || !validTimestamp(row.diary_updated_at) ||
            !Number.isSafeInteger(row.diary_version) || row.diary_version < 1 ||
            !['created','updated'].includes(row.action)) return null
        return { kind: 'star_diary', target_id: row.target_id, event_id: row.event_id,
            action: row.action, diary_date: date, diary_updated_at: row.diary_updated_at,
            diary_version: row.diary_version }
    }
    if (!isValidDate(row.diary_date) || !UUID_RE.test(row.annotation_id || '') ||
        row.action !== 'annotated') return null
    return { kind: 'star_note', target_id: row.target_id, event_id: row.event_id,
        action: 'annotated', diary_date: row.diary_date, annotation_id: row.annotation_id }
}

function createDiaryUnreadRouter({ supabase } = {}) {
    const router = express.Router()
    router.use((req, res, next) => {
        res.set('Cache-Control', 'private, no-store')
        if (!UUID_RE.test(req.userId || '')) return res.status(401).json({ ok:false, code:'unauthorized' })
        if (typeof supabase?.rpc !== 'function') return res.status(503).json({ ok:false, code:'diary_unavailable' })
        next()
    })
    router.get('/', async (req, res) => {
        try {
            const { data, error } = await supabase.rpc('diary_unread_snapshot_v36', {
                p_user_id: req.userId,
            })
            if (error || !data || !Array.isArray(data.items) ||
                typeof data.truncated !== 'boolean' || data.items.length > 500) throw Error('invalid_snapshot')
            const items = data.items.map(safeItem)
            // Never turn malformed metadata into an apparently empty inbox.
            if (items.some(item => item === null)) throw Error('invalid_item')
            return res.json({ ok:true, items, truncated:data.truncated })
        } catch (_) {
            return res.status(503).json({ ok:false, code:'diary_unread_unavailable' })
        }
    })
    router.post('/seen', async (req, res) => {
        const b = req.body
        if (!b || typeof b !== 'object' || Array.isArray(b) ||
            Object.keys(b).length !== 3 || !TYPES.has(b.kind) ||
            !UUID_RE.test(b.target_id || '') || !Number.isSafeInteger(b.event_id) ||
            b.event_id < 1) return res.status(400).json({ok:false,code:'invalid_receipt'})
        try {
            const { data, error } = await supabase.rpc('diary_mark_seen_v36', {
                p_user_id:req.userId, p_kind:b.kind,
                p_target_id:b.target_id, p_event_id:b.event_id,
            })
            if (error) throw Error('receipt_failed')
            if (data !== true) return res.status(404).json({ok:false,code:'not_found'})
            return res.json({ok:true})
        } catch (_) {
            return res.status(503).json({ok:false,code:'diary_unread_unavailable'})
        }
    })
    return router
}
module.exports = { createDiaryUnreadRouter, safeItem, isValidDate }
