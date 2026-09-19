'use strict'

const crypto = require('crypto')

const {
    createGlancePostTracker,
} = require('./glancePostTracker')

const MAX_TEXT = 12000
const MAX_RECENT = 18
const ACTIVE_TTL_MS = 2 * 60 * 60 * 1000
const DUPLICATE_WINDOW_MS = 90 * 1000

const UI_NOISE = [
    '推荐','RED','关注','热点','发现','直播','同城','短剧',
    '游戏','穿搭','已关注','评论','点赞','收藏','分享',
    '首页','消息','搜索'
]

function text(value) {
    return String(value ?? '')
        .replace(/\u0000/g, '')
        .replace(/\r\n/g, '\n')
        .trim()
}

function preview(value, max = 360) {
    const s = text(value).replace(/\s+/g, ' ')
    return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function hash(value) {
    return crypto.createHash('sha256')
        .update(String(value || ''), 'utf8')
        .digest('hex')
        .slice(0, 16)
}

function iso(value) {
    if (typeof value === 'string' && value.trim()) {
        const d = new Date(value.trim())
        if (!Number.isNaN(d.getTime())) return d.toISOString()
    }
    return new Date().toISOString()
}

function sessionId() {
    return `xhs_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`
}

function clean(value) {
    let s = text(value).toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
        .replace(/\b\d+(?:\.\d+)?\b/g, ' ')

    for (const term of UI_NOISE) {
        s = s.split(term.toLowerCase()).join(' ')
    }

    return s.replace(/[^\u4e00-\u9fffA-Za-z0-9]+/g, '')
}

function grams(value, n = 3) {
    const s = clean(value)
    const set = new Set()
    if (!s) return set
    if (s.length <= n) {
        set.add(s)
        return set
    }

    for (let i = 0; i <= Math.min(s.length, 5000) - n; i += 1) {
        set.add(s.slice(i, i + n))
    }
    return set
}

function round3(v) {
    return Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 1000) / 1000
}

function similarity(aText, bText) {
    const a = clean(aText)
    const b = clean(bText)

    if (!a || !b) return { score: 0, jaccard: 0, containment: 0 }
    if (a === b) return { score: 1, jaccard: 1, containment: 1 }

    const A = grams(a)
    const B = grams(b)
    if (!A.size || !B.size) return { score: 0, jaccard: 0, containment: 0 }

    const small = A.size <= B.size ? A : B
    const large = small === A ? B : A
    let inter = 0

    for (const item of small) {
        if (large.has(item)) inter += 1
    }

    const union = A.size + B.size - inter
    const j = union ? inter / union : 0
    const c = small.size ? inter / small.size : 0

    return {
        score: round3(Math.max(j, c * 0.78)),
        jaccard: round3(j),
        containment: round3(c),
    }
}

function tokens(value) {
    const stop = new Set(UI_NOISE.map(x => x.toLowerCase()))
    const parts = text(value)
        .replace(/[^\u4e00-\u9fffA-Za-z0-9#_-]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)

    const set = new Set()

    for (const raw of parts) {
        const s = raw.toLowerCase()
        if (stop.has(s) || /^\d+$/.test(s)) continue

        if (/^#[\u4e00-\u9fffA-Za-z0-9_-]{2,24}$/.test(s)) {
            set.add(s)
        } else if (/[\u4e00-\u9fff]/.test(s)) {
            if (s.length >= 2 && s.length <= 24) set.add(s)
        } else if (s.length >= 3 && s.length <= 32) {
            set.add(s)
        }
    }

    return set
}

function repeated(aText, bText, limit = 8) {
    const A = tokens(aText)
    const B = tokens(bText)

    return [...B]
        .filter(x => A.has(x))
        .sort((x, y) => y.length - x.length)
        .slice(0, limit)
}

function seconds(a, b) {
    const aa = new Date(a).getTime()
    const bb = new Date(b).getTime()
    if (Number.isNaN(aa) || Number.isNaN(bb)) return 0
    return Math.max(0, Math.round((bb - aa) / 1000))
}

function emptyReading() {
    return {
        cluster_started_at: null,
        last_sample_at: null,
        last_text: '',
        stable_samples: 0,
        dwell_seconds: 0,
        similarity: 0,
        jaccard: 0,
        containment: 0,
        repeated_terms: [],
        reading_state: 'idle',
    }
}

function createGlanceService({
    ownerId = '',
    maxTextChars = MAX_TEXT,
    maxRecent = MAX_RECENT,
    activeTtlMs = ACTIVE_TTL_MS,
} = {}) {

    const postTracker =
        createGlancePostTracker()

    const xhs = {
        active: false,
        sessionId: null,
        openedAt: null,
        closedAt: null,
        lastObservationAt: null,
        observationCount: 0,
        duplicateCount: 0,
        recent: [],
        reading: emptyReading(),
    }

    function resetReading() {
        xhs.reading = emptyReading()
    }

    function expire() {
        if (!xhs.active || !xhs.openedAt) return

        const opened = new Date(xhs.openedAt).getTime()
        if (!Number.isNaN(opened) && Date.now() - opened > activeTtlMs) {
            xhs.active = false
            xhs.closedAt = new Date().toISOString()
        }
    }

    function getReadingSummary() {
        const r = xhs.reading
        return {
            reading_state: r.reading_state,
            dwell_seconds: r.dwell_seconds,
            stable_samples: r.stable_samples,
            similarity: r.similarity,
            jaccard: r.jaccard,
            containment: r.containment,
            repeated_terms: [...(r.repeated_terms || [])],
            cluster_started_at: r.cluster_started_at,
            last_sample_at: r.last_sample_at,
        }
    }

    function getPublicState() {
        expire()
        return {
            active: xhs.active,
            session_id: xhs.sessionId,
            opened_at: xhs.openedAt,
            closed_at: xhs.closedAt,
            last_observation_at: xhs.lastObservationAt,
            observation_count: xhs.observationCount,
            duplicate_count: xhs.duplicateCount,
            recent_count: xhs.recent.length,
            owner_configured: Boolean(String(ownerId || '').trim()),
            reading: getReadingSummary(),
            post:
                postTracker
                    .getSummary(),
        }
    }

    function setXhsActive(active, {
        trigger = 'ios-shortcuts',
        device = 'iphone',
    } = {}) {
        expire()
        const now = new Date().toISOString()

        let stateTransition =
            'unchanged'

        if (active) {
            // iOS 快捷指令可能在同一次刷小红书过程中重复触发“打开 App”。
            // 如果余光 session 已经是 active，就不要重置 reading / post session。
            if (!xhs.active) {
                xhs.active = true
                xhs.sessionId = sessionId()
                xhs.openedAt = now
                xhs.closedAt = null
                resetReading()
                postTracker.reset()
                stateTransition =
                    'opened'
            } else {
                stateTransition =
                    'already_active'
            }
        } else {
            if (xhs.active) {
                xhs.active = false
                xhs.closedAt = now
                stateTransition =
                    'closed'
            } else {
                stateTransition =
                    'already_inactive'
            }
        }

        return {
            ...getPublicState(),
            state_transition:
                stateTransition,
            trigger: String(trigger || '').slice(0, 80),
            device: String(device || '').slice(0, 80),
        }
    }

    function updateReading(previousText, currentText, sampleAt, exactDuplicate) {
        const previousAt = xhs.reading.last_sample_at

        if (!previousText || !previousAt) {
            xhs.reading = {
                cluster_started_at: sampleAt,
                last_sample_at: sampleAt,
                last_text: currentText,
                stable_samples: 1,
                dwell_seconds: 0,
                similarity: 0,
                jaccard: 0,
                containment: 0,
                repeated_terms: [],
                reading_state: 'first_sample',
            }
            return getReadingSummary()
        }

        const sim = exactDuplicate
            ? { score: 1, jaccard: 1, containment: 1 }
            : similarity(previousText, currentText)

        const terms = repeated(previousText, currentText)
        const same = exactDuplicate || sim.score >= 0.30

        if (!same) {
            xhs.reading = {
                cluster_started_at: sampleAt,
                last_sample_at: sampleAt,
                last_text: currentText,
                stable_samples: 1,
                dwell_seconds: 0,
                similarity: sim.score,
                jaccard: sim.jaccard,
                containment: sim.containment,
                repeated_terms: terms,
                reading_state: 'browsing',
            }
            return getReadingSummary()
        }

        const start = xhs.reading.cluster_started_at || previousAt
        const dwell = seconds(start, sampleAt)
        const stable = Math.max(1, Number(xhs.reading.stable_samples || 1)) + 1

        let state = 'likely_same_content'

        if (exactDuplicate && dwell >= 12) {
            state = 'stable_reading'
        } else if (dwell >= 18 && (sim.score >= 0.30 || stable >= 3)) {
            state = 'engaged'
        }

        xhs.reading = {
            cluster_started_at: start,
            last_sample_at: sampleAt,
            last_text: currentText,
            stable_samples: stable,
            dwell_seconds: dwell,
            similarity: sim.score,
            jaccard: sim.jaccard,
            containment: sim.containment,
            repeated_terms: terms,
            reading_state: state,
        }

        return getReadingSummary()
    }

    function recordXhsObservation({
        text: rawText,
        capturedAt,
        source = 'ios-shortcuts',
    }) {
        expire()

        if (!xhs.active) {
            return { accepted: false, reason: 'xhs_inactive', state: getPublicState() }
        }

        let cleanText = text(rawText)

        if (!cleanText) {
            return { accepted: false, reason: 'empty_text', state: getPublicState() }
        }

        let truncated = false
        if (cleanText.length > maxTextChars) {
            cleanText = cleanText.slice(0, maxTextChars)
            truncated = true
        }

        const now = new Date().toISOString()
        const sampleAt = iso(capturedAt)
        const contentHash = hash(cleanText)
        const last = xhs.recent[xhs.recent.length - 1] || null
        const lastSeen = last?.last_seen_at ? new Date(last.last_seen_at).getTime() : 0

        const exactDuplicate = Boolean(
            last &&
            last.content_hash === contentHash &&
            Number.isFinite(lastSeen) &&
            Date.now() - lastSeen < DUPLICATE_WINDOW_MS
        )

        const reading = updateReading(
            xhs.reading.last_text || last?.text || '',
            cleanText,
            sampleAt,
            exactDuplicate
        )

        const post =
            postTracker
                .record({
                    text:
                        cleanText,
                    sampleAt,
                    reading,
                    exactDuplicate,
                })

        xhs.observationCount += 1
        xhs.lastObservationAt = now

        if (exactDuplicate) {
            last.last_seen_at = now
            last.seen_count = Number(last.seen_count || 1) + 1
            xhs.duplicateCount += 1

            return {
                accepted: true,
                duplicate: true,
                truncated,
                observation: {
                    id: last.id,
                    preview: last.preview,
                    char_count: last.char_count,
                    first_seen_at: last.first_seen_at,
                    last_seen_at: last.last_seen_at,
                    seen_count: last.seen_count,
                },
                reading,
                post,
                state: getPublicState(),
            }
        }

        const observation = {
            id: `obs_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
            session_id: xhs.sessionId,
            source: String(source || '').slice(0, 80),
            captured_at: sampleAt,
            received_at: now,
            first_seen_at: now,
            last_seen_at: now,
            seen_count: 1,
            char_count: cleanText.length,
            content_hash: contentHash,
            preview: preview(cleanText),
            text: cleanText,
            truncated,
            reading,
            post,
        }

        xhs.recent.push(observation)
        if (xhs.recent.length > maxRecent) {
            xhs.recent.splice(0, xhs.recent.length - maxRecent)
        }

        return {
            accepted: true,
            duplicate: false,
            truncated,
            observation: {
                id: observation.id,
                preview: observation.preview,
                char_count: observation.char_count,
                captured_at: observation.captured_at,
                received_at: observation.received_at,
                seen_count: observation.seen_count,
            },
            reading,
            post,
            state: getPublicState(),
        }
    }

    function getRecentObservations({ includeText = false } = {}) {
        expire()

        return xhs.recent.slice().reverse().map(item => {
            const out = {
                id: item.id,
                session_id: item.session_id,
                source: item.source,
                captured_at: item.captured_at,
                received_at: item.received_at,
                first_seen_at: item.first_seen_at,
                last_seen_at: item.last_seen_at,
                seen_count: item.seen_count,
                char_count: item.char_count,
                preview: item.preview,
                truncated: Boolean(item.truncated),
                reading: item.reading || null,
                post: item.post || null,
            }

            if (includeText) out.text = item.text
            return out
        })
    }

    function getPostSamples(
        postSessionId
    ) {
        const id =
            String(
                postSessionId || ''
            )
                .trim()

        if (!id) {
            return []
        }

        return xhs.recent
            .filter(
                item =>
                    item
                        ?.post
                        ?.post_session_id ===
                    id
            )
            .map(
                item => ({
                    captured_at:
                        item
                            .captured_at,

                    screen_mode:
                        item
                            ?.post
                            ?.current_screen_mode ||
                        'unknown',

                    text:
                        item
                            .text,
                })
            )
    }

    function clearRecent() {
        xhs.recent = []
        xhs.observationCount = 0
        xhs.duplicateCount = 0
        xhs.lastObservationAt = null
        resetReading()
        postTracker.reset()
        return getPublicState()
    }

    return {
        getPublicState,
        getReadingSummary,
        getPostSummary:
            () =>
                postTracker
                    .getSummary(),
        setXhsActive,
        recordXhsObservation,
        getRecentObservations,
        getPostSamples,
        clearRecent,
    }
}

module.exports = {
    createGlanceService,
}
