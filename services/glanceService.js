'use strict'

const crypto = require('crypto')

const DEFAULT_MAX_TEXT_CHARS = 12000
const DEFAULT_MAX_RECENT = 12
const DEFAULT_ACTIVE_TTL_MS = 2 * 60 * 60 * 1000
const DUPLICATE_WINDOW_MS = 90 * 1000

function normalizeOcrText(value) {
    return String(value ?? '')
        .replace(/\u0000/g, '')
        .replace(/\r\n/g, '\n')
        .trim()
}

function toPreview(text, maxLength = 360) {
    const compact = String(text || '')
        .replace(/\s+/g, ' ')
        .trim()

    if (compact.length <= maxLength) {
        return compact
    }

    return compact.slice(
        0,
        Math.max(1, maxLength - 1)
    ) + '…'
}

function hashText(text) {
    return crypto
        .createHash('sha256')
        .update(String(text || ''), 'utf8')
        .digest('hex')
        .slice(0, 16)
}

function parseIsoOrNow(value) {
    if (typeof value === 'string' && value.trim()) {
        const date = new Date(value.trim())
        if (!Number.isNaN(date.getTime())) {
            return date.toISOString()
        }
    }

    return new Date().toISOString()
}

function createSessionId() {
    return (
        'xhs_' +
        Date.now().toString(36) +
        '_' +
        crypto.randomBytes(5).toString('hex')
    )
}

function createGlanceService({
    ownerId = '',
    maxTextChars = DEFAULT_MAX_TEXT_CHARS,
    maxRecent = DEFAULT_MAX_RECENT,
    activeTtlMs = DEFAULT_ACTIVE_TTL_MS,
} = {}) {

    const xhs = {
        active: false,
        sessionId: null,
        openedAt: null,
        closedAt: null,
        lastObservationAt: null,
        observationCount: 0,
        duplicateCount: 0,
        recent: [],
    }

    function expireIfNeeded() {
        if (!xhs.active || !xhs.openedAt) {
            return
        }

        const openedAtMs = new Date(
            xhs.openedAt
        ).getTime()

        if (Number.isNaN(openedAtMs)) {
            return
        }

        if (
            Date.now() - openedAtMs >
            activeTtlMs
        ) {
            xhs.active = false
            xhs.closedAt =
                new Date().toISOString()
        }
    }

    function getPublicState() {
        expireIfNeeded()

        return {
            active: xhs.active,
            session_id: xhs.sessionId,
            opened_at: xhs.openedAt,
            closed_at: xhs.closedAt,
            last_observation_at:
                xhs.lastObservationAt,
            observation_count:
                xhs.observationCount,
            duplicate_count:
                xhs.duplicateCount,
            recent_count:
                xhs.recent.length,
            owner_configured:
                Boolean(
                    String(ownerId || '').trim()
                ),
        }
    }

    function setXhsActive(
        active,
        {
            trigger = 'ios-shortcuts',
            device = 'iphone',
        } = {}
    ) {
        expireIfNeeded()

        const now =
            new Date().toISOString()

        if (active) {
            xhs.active = true
            xhs.sessionId =
                createSessionId()
            xhs.openedAt = now
            xhs.closedAt = null
        } else {
            xhs.active = false
            xhs.closedAt = now
        }

        return {
            ...getPublicState(),
            trigger:
                String(trigger || '').slice(0, 80),
            device:
                String(device || '').slice(0, 80),
        }
    }

    function recordXhsObservation({
        text,
        capturedAt,
        source = 'ios-shortcuts',
    }) {
        expireIfNeeded()

        if (!xhs.active) {
            return {
                accepted: false,
                reason: 'xhs_inactive',
                state: getPublicState(),
            }
        }

        let clean =
            normalizeOcrText(text)

        if (!clean) {
            return {
                accepted: false,
                reason: 'empty_text',
                state: getPublicState(),
            }
        }

        let truncated = false

        if (clean.length > maxTextChars) {
            clean = clean.slice(
                0,
                maxTextChars
            )
            truncated = true
        }

        const now =
            new Date().toISOString()

        const contentHash =
            hashText(clean)

        const last =
            xhs.recent[
                xhs.recent.length - 1
            ] || null

        const lastSeenMs =
            last?.last_seen_at
                ? new Date(
                    last.last_seen_at
                ).getTime()
                : 0

        if (
            last &&
            last.content_hash ===
                contentHash &&
            Number.isFinite(lastSeenMs) &&
            Date.now() - lastSeenMs <
                DUPLICATE_WINDOW_MS
        ) {
            last.last_seen_at = now
            last.seen_count =
                Number(
                    last.seen_count || 1
                ) + 1

            xhs.duplicateCount += 1
            xhs.lastObservationAt = now

            return {
                accepted: true,
                duplicate: true,
                truncated,
                observation: {
                    id: last.id,
                    preview: last.preview,
                    char_count:
                        last.char_count,
                    first_seen_at:
                        last.first_seen_at,
                    last_seen_at:
                        last.last_seen_at,
                    seen_count:
                        last.seen_count,
                },
                state: getPublicState(),
            }
        }

        const observation = {
            id:
                'obs_' +
                Date.now().toString(36) +
                '_' +
                crypto
                    .randomBytes(4)
                    .toString('hex'),

            session_id:
                xhs.sessionId,

            source:
                String(source || '')
                    .slice(0, 80),

            captured_at:
                parseIsoOrNow(
                    capturedAt
                ),

            received_at: now,
            first_seen_at: now,
            last_seen_at: now,
            seen_count: 1,
            char_count: clean.length,
            content_hash:
                contentHash,
            preview:
                toPreview(clean),

            // 只存在当前 Render Node 进程内存。
            text: clean,

            truncated,
        }

        xhs.recent.push(
            observation
        )

        if (
            xhs.recent.length >
            maxRecent
        ) {
            xhs.recent.splice(
                0,
                xhs.recent.length -
                    maxRecent
            )
        }

        xhs.observationCount += 1
        xhs.lastObservationAt = now

        return {
            accepted: true,
            duplicate: false,
            truncated,
            observation: {
                id: observation.id,
                preview:
                    observation.preview,
                char_count:
                    observation.char_count,
                captured_at:
                    observation.captured_at,
                received_at:
                    observation.received_at,
                seen_count:
                    observation.seen_count,
            },
            state: getPublicState(),
        }
    }

    function getRecentObservations({
        includeText = false,
    } = {}) {
        expireIfNeeded()

        return xhs.recent
            .slice()
            .reverse()
            .map((item) => {
                const output = {
                    id: item.id,
                    session_id:
                        item.session_id,
                    source: item.source,
                    captured_at:
                        item.captured_at,
                    received_at:
                        item.received_at,
                    first_seen_at:
                        item.first_seen_at,
                    last_seen_at:
                        item.last_seen_at,
                    seen_count:
                        item.seen_count,
                    char_count:
                        item.char_count,
                    preview: item.preview,
                    truncated:
                        Boolean(
                            item.truncated
                        ),
                }

                if (includeText) {
                    output.text =
                        item.text
                }

                return output
            })
    }

    function clearRecent() {
        xhs.recent = []
        xhs.observationCount = 0
        xhs.duplicateCount = 0
        xhs.lastObservationAt = null

        return getPublicState()
    }

    return {
        getPublicState,
        setXhsActive,
        recordXhsObservation,
        getRecentObservations,
        clearRecent,
    }
}

module.exports = {
    createGlanceService,
}
