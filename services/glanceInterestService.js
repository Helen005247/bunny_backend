'use strict'

const SELF_CHARACTER = '沈星回'

const TRACKED_CHARACTERS =
    [
        '沈星回',
        '秦彻',
        '黎深',
        '祁煜',
        '夏以昼',
    ]

const FAN_CONTENT_TYPES =
    new Set([
        'fanfiction',
        'romance_fan_content',
        'shipping',
    ])

const DEFAULT_DEEP_READ_SECONDS = 50
const DEFAULT_STREAK_WINDOW_MINUTES = 12
const DEFAULT_STREAK_POSTS = 3
const MAX_EVENTS = 40

function cleanText(value) {
    return String(value ?? '')
        .replace(/\u0000/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function numberFromEnv(
    name,
    fallback,
    {
        min = 0,
        max = 9999,
    } = {}
) {
    const raw =
        Number(
            process.env[name]
        )

    if (!Number.isFinite(raw)) {
        return fallback
    }

    return Math.max(
        min,
        Math.min(
            max,
            raw
        )
    )
}

function round3(value) {
    return (
        Math.round(
            Number(value || 0) *
            1000
        ) /
        1000
    )
}

function uniqueStrings(
    values,
    max = 12
) {
    if (!Array.isArray(values)) {
        return []
    }

    const out = []

    for (const value of values) {
        const text =
            cleanText(value)
                .slice(0, 80)

        if (
            text &&
            !out.includes(text)
        ) {
            out.push(text)
        }

        if (out.length >= max) {
            break
        }
    }

    return out
}

function detectTrackedCharacters(
    text
) {
    const source =
        cleanText(text)

    if (!source) {
        return []
    }

    return TRACKED_CHARACTERS
        .filter(
            name =>
                source.includes(
                    name
                )
        )
}

function shouldQuickAnalyzeText(
    text
) {
    const source =
        cleanText(text)

    if (source.length < 70) {
        return false
    }

    return (
        detectTrackedCharacters(
            source
        ).length > 0
    )
}

function createGlanceInterestService() {

    const targetEntries =
        new Map()

    const latestSignals =
        new Map()

    const events = []

    function config() {
        return {
            deepReadSeconds:
                numberFromEnv(
                    'GLANCE_DEEP_READ_SECONDS',
                    DEFAULT_DEEP_READ_SECONDS,
                    {
                        min: 20,
                        max: 300,
                    }
                ),

            streakWindowMinutes:
                numberFromEnv(
                    'GLANCE_STREAK_WINDOW_MINUTES',
                    DEFAULT_STREAK_WINDOW_MINUTES,
                    {
                        min: 3,
                        max: 120,
                    }
                ),

            streakPosts:
                Math.round(
                    numberFromEnv(
                        'GLANCE_STREAK_POSTS',
                        DEFAULT_STREAK_POSTS,
                        {
                            min: 2,
                            max: 10,
                        }
                    )
                ),
        }
    }

    function getTargets(
        analysis
    ) {
        const tracked =
            uniqueStrings(
                analysis
                    ?.love_and_deepspace_characters
            )
                .filter(
                    name =>
                        TRACKED_CHARACTERS
                            .includes(name)
                )

        if (tracked.length > 0) {
            return tracked
        }

        // fallback 只允许明确列入追踪名单的名字，
        // 避免把同人里的朋友/配角算成“关注对象”。
        return uniqueStrings(
            analysis
                ?.named_characters
        )
            .filter(
                name =>
                    TRACKED_CHARACTERS
                        .includes(name)
            )
    }

    function isFanLike(
        analysis
    ) {
        return (
            FAN_CONTENT_TYPES.has(
                analysis
                    ?.content_type
            ) ||
            Boolean(
                analysis
                    ?.is_fan_created_content
            )
        )
    }

    function pruneTarget(
        target,
        nowMs
    ) {
        const {
            streakWindowMinutes,
        } = config()

        const cutoff =
            nowMs -
            streakWindowMinutes *
            60 *
            1000

        const current =
            targetEntries.get(
                target
            ) ||
            []

        const kept =
            current.filter(
                item =>
                    item.seen_at_ms >=
                    cutoff
            )

        targetEntries.set(
            target,
            kept
        )

        return kept
    }

    function upsertEntry(
        target,
        analysis,
        nowMs
    ) {
        const entries =
            pruneTarget(
                target,
                nowMs
            )

        const postSessionId =
            cleanText(
                analysis
                    ?.post_session_id
            )

        const existing =
            entries.find(
                item =>
                    item.post_session_id ===
                    postSessionId
            )

        const dwell =
            Number(
                analysis
                    ?.engagement
                    ?.dwell_seconds ||
                0
            )

        const sampleCount =
            Number(
                analysis
                    ?.engagement
                    ?.sample_count ||
                0
            )

        const next = {
            post_session_id:
                postSessionId,

            target,

            seen_at:
                new Date(nowMs)
                    .toISOString(),

            seen_at_ms:
                nowMs,

            dwell_seconds:
                Math.max(
                    dwell,
                    Number(
                        existing
                            ?.dwell_seconds ||
                        0
                    )
                ),

            sample_count:
                Math.max(
                    sampleCount,
                    Number(
                        existing
                            ?.sample_count ||
                        0
                    )
                ),

            body_seen:
                Boolean(
                    analysis
                        ?.engagement
                        ?.body_seen ||
                    existing
                        ?.body_seen
                ),

            comments_seen:
                Boolean(
                    analysis
                        ?.engagement
                        ?.comments_seen ||
                    existing
                        ?.comments_seen
                ),

            content_type:
                analysis
                    ?.content_type ||
                existing
                    ?.content_type ||
                'unclear',

            romantic_context:
                Boolean(
                    analysis
                        ?.romantic_context ||
                    existing
                        ?.romantic_context
                ),

            confidence:
                Math.max(
                    Number(
                        analysis
                            ?.confidence ||
                        0
                    ),
                    Number(
                        existing
                            ?.confidence ||
                        0
                    )
                ),

            analysis_stage:
                analysis
                    ?.analysis_stage ||
                existing
                    ?.analysis_stage ||
                'full',

            summary:
                cleanText(
                    analysis
                        ?.summary ||
                    existing
                        ?.summary ||
                    ''
                )
                    .slice(
                        0,
                        220
                    ),

            interaction_pattern:
                cleanText(
                    analysis
                        ?.interaction_pattern ||
                    existing
                        ?.interaction_pattern ||
                    ''
                )
                    .slice(
                        0,
                        180
                    ),
        }

        const merged =
            existing
                ? entries.map(
                    item =>
                        item.post_session_id ===
                        postSessionId
                            ? next
                            : item
                )
                : [
                    ...entries,
                    next,
                ]

        targetEntries.set(
            target,
            merged
        )

        return merged
    }

    function makeSignal({
        target,
        entries,
        current,
        deep,
        streak,
    }) {
        const {
            deepReadSeconds,
            streakWindowMinutes,
            streakPosts,
        } = config()

        const distinctPosts =
            entries.length

        const cumulativeDwell =
            entries.reduce(
                (
                    total,
                    item
                ) =>
                    total +
                    Number(
                        item
                            .dwell_seconds ||
                        0
                    ),
                0
            )

        const romanticPosts =
            entries.filter(
                item =>
                    item
                        .romantic_context
            ).length

        let salience = 0

        if (deep) {
            salience += 0.72
        }

        if (streak) {
            salience += 0.78
        }

        if (
            deep &&
            streak
        ) {
            salience += 0.12
        }

        if (
            current
                ?.comments_seen
        ) {
            salience += 0.05
        }

        if (
            romanticPosts > 0
        ) {
            salience += 0.05
        }

        salience =
            round3(
                Math.min(
                    1,
                    salience
                )
            )

        const kind =
            deep &&
            streak
                ? 'deep_read_and_interest_streak'
                : deep
                    ? 'deep_read'
                    : 'interest_streak'

        return {
            triggered:
                Boolean(
                    deep ||
                    streak
                ),

            kind,

            target,

            self_related:
                target ===
                SELF_CHARACTER,

            level:
                salience >= 0.88
                    ? 'high'
                    : salience >= 0.72
                        ? 'medium'
                        : 'low',

            salience,

            distinct_posts:
                distinctPosts,

            cumulative_dwell_seconds:
                cumulativeDwell,

            current_post_dwell_seconds:
                Number(
                    current
                        ?.dwell_seconds ||
                    0
                ),

            current_sample_count:
                Number(
                    current
                        ?.sample_count ||
                    0
                ),

            comments_seen:
                Boolean(
                    current
                        ?.comments_seen
                ),

            window_minutes:
                streakWindowMinutes,

            thresholds: {
                deep_read_seconds:
                    deepReadSeconds,

                streak_posts:
                    streakPosts,
            },

            reason_codes:
                [
                    ...(deep
                        ? [
                            'deep_read',
                        ]
                        : []),

                    ...(streak
                        ? [
                            'repeated_same_character_posts',
                        ]
                        : []),

                    ...(romanticPosts > 0
                        ? [
                            'romantic_evidence_present',
                        ]
                        : []),

                    ...(current
                        ?.comments_seen
                        ? [
                            'comments_seen',
                        ]
                        : []),
                ],

            latest_summary:
                current
                    ?.summary ||
                null,

            latest_interaction_pattern:
                current
                    ?.interaction_pattern ||
                null,
        }
    }

    function observeAnalysis(
        analysis
    ) {
        const postSessionId =
            cleanText(
                analysis
                    ?.post_session_id
            )

        if (!postSessionId) {
            return {
                updated: false,
                reason:
                    'no_post_session',
                signals: [],
                strongest_signal:
                    null,
            }
        }

        if (
            Number(
                analysis
                    ?.confidence ||
                0
            ) < 0.68
        ) {
            return {
                updated: false,
                reason:
                    'low_confidence',
                signals: [],
                strongest_signal:
                    null,
            }
        }

        if (!isFanLike(analysis)) {
            return {
                updated: false,
                reason:
                    'not_fan_content',
                signals: [],
                strongest_signal:
                    null,
            }
        }

        const targets =
            getTargets(
                analysis
            )

        if (targets.length === 0) {
            return {
                updated: false,
                reason:
                    'no_tracked_character',
                signals: [],
                strongest_signal:
                    null,
            }
        }

        const nowMs =
            Date.now()

        const {
            deepReadSeconds,
            streakPosts,
        } = config()

        const signals = []

        for (
            const target
            of targets
        ) {
            const entries =
                upsertEntry(
                    target,
                    analysis,
                    nowMs
                )

            const current =
                entries.find(
                    item =>
                        item
                            .post_session_id ===
                        postSessionId
                )

            const deep =
                Number(
                    current
                        ?.dwell_seconds ||
                    0
                ) >=
                    deepReadSeconds ||
                (
                    Boolean(
                        current
                            ?.comments_seen
                    ) &&
                    Number(
                        current
                            ?.dwell_seconds ||
                        0
                    ) >= 20
                ) ||
                (
                    Number(
                        current
                            ?.sample_count ||
                        0
                    ) >= 3 &&
                    Number(
                        current
                            ?.dwell_seconds ||
                        0
                    ) >= 35
                )

            const streak =
                entries.length >=
                streakPosts

            const signal =
                makeSignal({
                    target,
                    entries,
                    current,
                    deep,
                    streak,
                })

            latestSignals.set(
                target,
                signal
            )

            if (
                signal.triggered
            ) {
                const fingerprint =
                    [
                        target,
                        signal.kind,
                        entries
                            .map(
                                item =>
                                    item
                                        .post_session_id
                            )
                            .join('|'),
                    ]
                        .join('::')

                if (
                    !events.some(
                        item =>
                            item
                                .fingerprint ===
                            fingerprint
                    )
                ) {
                    events.push({
                        ...signal,

                        fingerprint,

                        created_at:
                            new Date()
                                .toISOString(),
                    })

                    while (
                        events.length >
                        MAX_EVENTS
                    ) {
                        events.shift()
                    }
                }
            }

            signals.push(
                signal
            )
        }

        const strongest =
            signals
                .filter(
                    signal =>
                        signal
                            .triggered
                )
                .sort(
                    (a, b) =>
                        b.salience -
                        a.salience
                )[0] ||
            null

        return {
            updated: true,
            reason:
                strongest
                    ? 'interest_signal'
                    : 'interest_tracking',
            signals,
            strongest_signal:
                strongest,
        }
    }

    function getLatestSignals() {
        return Array.from(
            latestSignals
                .values()
        )
            .sort(
                (a, b) =>
                    b.salience -
                    a.salience
            )
    }

    function listEvents() {
        return events
            .slice()
            .reverse()
            .map(
                item => {
                    const {
                        fingerprint,
                        ...rest
                    } = item

                    return rest
                }
            )
    }

    function clear() {
        targetEntries.clear()
        latestSignals.clear()
        events.splice(
            0,
            events.length
        )
    }

    return {
        detectTrackedCharacters,
        shouldQuickAnalyzeText,
        observeAnalysis,
        getLatestSignals,
        listEvents,
        clear,
        getConfig:
            config,
    }
}

module.exports = {
    createGlanceInterestService,
}
