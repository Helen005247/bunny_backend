'use strict'

// Hermit Diary V3-4 Step 1: one owner-authored entry per local calendar day.
// Mounted at /api/diary/mine INSIDE the existing requireAuth-protected
// createUserDiaryRouter. Never accepts owner or visibility from the browser.
const express = require('express')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OUTPUT_FIELDS = 'id,diary_date,title,body,visibility,edit_version,created_at,updated_at'
const MONTH_FIELDS = 'id,diary_date,title,visibility,edit_version,updated_at'
const MAX_BODY = 10000
const MAX_TITLE = 160

function localDiaryDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
    const [year, month, day] = value.split('-').map(Number)
    if (year < 2000 || year > 2100 || month < 1 || month > 12) return null
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return day >= 1 && day <= last ? value : null
}

function monthBounds(query) {
    if (!query || typeof query.year !== 'string' || typeof query.month !== 'string' ||
        !/^\d{4}$/.test(query.year) || !/^(?:0?[1-9]|1[0-2])$/.test(query.month)) return null
    const year = Number(query.year)
    const month = Number(query.month)
    if (year < 2000 || year > 2100) return null
    const first = `${year}-${String(month).padStart(2, '0')}-01`
    const following = month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`
    return { first, following }
}

function validateWrite(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    // No client-controlled user_id, visibility, version, timestamps or arbitrary columns.
    if (Object.keys(payload).some(key => !['body','title','expected_version'].includes(key))) return null
    const { body, title, expected_version: expectedVersion } = payload
    if (typeof body !== 'string' || body.trim().length === 0 ||
        Array.from(body).length > MAX_BODY) return null
    if (title !== undefined && (typeof title !== 'string' ||
        Array.from(title).length > MAX_TITLE || /[\r\n]/.test(title))) return null
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
        expectedVersion > 2147483646) return null
    return { body, ...(title === undefined ? {} : { title }), expectedVersion }
}

function createPersonalDiaryRouter({ supabase } = {}) {
    const router = express.Router()
    router.use((_req, res, next) => {
        res.set('Cache-Control', 'private, no-store')
        next()
    })
    router.use((req, res, next) => {
        if (typeof req.userId !== 'string' || !UUID_RE.test(req.userId)) {
            return res.status(401).json({ ok: false, code: 'unauthorized' })
        }
        if (!supabase) return res.status(503).json({ ok: false, code: 'diary_unavailable' })
        return next()
    })

    // Bounded month summary: at most 31 rows due to UNIQUE(user_id, diary_date).
    // Body is deliberately excluded; the reader fetches it only on demand.
    router.get('/month', async (req, res) => {
        const bounds = monthBounds(req.query)
        if (!bounds) return res.status(400).json({ ok: false, code: 'invalid_month' })
        try {
            const result = await supabase.from('user_diary').select(MONTH_FIELDS)
                .eq('user_id', req.userId)
                .gte('diary_date', bounds.first).lt('diary_date', bounds.following)
                .order('diary_date', { ascending: true })
            if (result.error || !Array.isArray(result.data)) throw new Error('read_error')
            return res.json({ ok: true, entries: result.data })
        } catch (_) {
            return res.status(503).json({ ok: false, code: 'diary_read_unavailable' })
        }
    })

    router.get('/:date', async (req, res) => {
        const date = localDiaryDate(req.params.date)
        if (!date) return res.status(400).json({ ok: false, code: 'invalid_date' })
        try {
            const result = await supabase.from('user_diary').select(OUTPUT_FIELDS)
                .eq('user_id', req.userId).eq('diary_date', date).maybeSingle()
            if (result.error) throw new Error('read_error')
            if (!result.data) return res.status(404).json({ ok: false, code: 'not_found' })
            return res.json({ ok: true, entry: result.data })
        } catch (_) {
            return res.status(503).json({ ok: false, code: 'diary_read_unavailable' })
        }
    })

    // POST avoids requiring an extra cross-origin HTTP method in Hermit's
    // existing CORS configuration. expected_version=0 means CREATE; any
    // positive version means EDIT, with optimistic concurrency protection.
    router.post('/:date', async (req, res) => {
        const date = localDiaryDate(req.params.date)
        if (!date) return res.status(400).json({ ok: false, code: 'invalid_date' })
        const input = validateWrite(req.body)
        if (!input) return res.status(400).json({ ok: false, code: 'invalid_diary_input' })
        try {
            if (input.expectedVersion === 0) {
                // SQL defaults set visibility='shared', edit_version=1.
                const result = await supabase.from('user_diary').insert({
                    user_id: req.userId, diary_date: date,
                    title: input.title ?? '', body: input.body,
                }).select(OUTPUT_FIELDS).single()
                if (result.error?.code === '23505') {
                    return res.status(409).json({ ok: false, code: 'diary_edit_conflict' })
                }
                if (result.error || !result.data) throw new Error('insert_error')
                return res.status(201).json({ ok: true, entry: result.data, created: true })
            }

            // Crucial: do NOT write visibility. Future 'locked' entries remain
            // locked even after editing their text; only the author can edit.
            const changes = { body: input.body }
            if (input.title !== undefined) changes.title = input.title
            const result = await supabase.from('user_diary').update(changes)
                .eq('user_id', req.userId).eq('diary_date', date)
                .eq('edit_version', input.expectedVersion)
                .select(OUTPUT_FIELDS).maybeSingle()
            if (result.error) throw new Error('update_error')
            if (result.data) return res.json({ ok: true, entry: result.data, created: false })

            // No rows updated: distinguish nonexistent day from stale editor.
            const check = await supabase.from('user_diary').select('id')
                .eq('user_id', req.userId).eq('diary_date', date).maybeSingle()
            if (check.error) throw new Error('check_error')
            if (!check.data) return res.status(404).json({ ok: false, code: 'not_found' })
            return res.status(409).json({ ok: false, code: 'diary_edit_conflict' })
        } catch (_) {
            return res.status(503).json({ ok: false, code: 'diary_write_unavailable' })
        }
    })
    return router
}

module.exports = { createPersonalDiaryRouter, localDiaryDate, monthBounds, validateWrite }
