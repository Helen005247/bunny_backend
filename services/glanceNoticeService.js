'use strict'

const crypto = require('crypto')

const SELF_CHARACTER =
    '沈星回'

const MAX_NOTICES = 30

const ROMANTIC_CONTENT_TYPES =
    new Set([
        'fanfiction',
        'romance_fan_content',
        'shipping',
    ])

const ROMANTIC_RELATIONSHIPS =
    new Set([
        'romantic',
        'flirty',
        'sexual_or_intimate',
    ])

function cleanText(value) {
    return String(value ?? '')
        .replace(/\u0000/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function uniqueStrings(
    value,
    max = 12
) {
    if (!Array.isArray(value)) {
        return []
    }

    const result = []

    for (const item of value) {
        const text =
            cleanText(item)
                .slice(0, 80)

        if (
            text &&
            !result.includes(text)
        ) {
            result.push(text)
        }

        if (
            result.length >= max
        ) {
            break
        }
    }

    return result
}

function createId() {
    return (
        'notice_' +
        Date.now().toString(36) +
        '_' +
        crypto.randomBytes(4)
            .toString('hex')
    )
}

function clamp01(value) {
    return Math.max(
        0,
        Math.min(
            1,
            Number(value) || 0
        )
    )
}

function scoreNotice(
    analysis,
    targets
) {
    let score = 0

    if (
        analysis
            ?.romantic_context
    ) {
        score += 0.45
    }

    if (
        analysis
            ?.relationship_context ===
        'romantic'
    ) {
        score += 0.10
    }

    if (
        analysis
            ?.relationship_context ===
        'flirty'
    ) {
        score += 0.12
    }

    if (
        analysis
            ?.relationship_context ===
        'sexual_or_intimate'
    ) {
        score += 0.18
    }

    if (
        ROMANTIC_CONTENT_TYPES
            .has(
                analysis
                    ?.content_type
            )
    ) {
        score += 0.08
    }

    if (
        targets.length > 0
    ) {
        score += 0.08
    }

    const dwell =
        Number(
            analysis
                ?.engagement
                ?.dwell_seconds ||
            0
        )

    if (dwell >= 25) {
        score += 0.04
    }

    if (dwell >= 45) {
        score += 0.04
    }

    if (
        analysis
            ?.engagement
            ?.comments_seen
    ) {
        score += 0.04
    }

    if (
        Number(
            analysis
                ?.confidence ||
            0
        ) >= 0.90
    ) {
        score += 0.03
    }

    return Math.round(
        clamp01(score) *
        1000
    ) / 1000
}

function getLevel(score) {
    if (score >= 0.86) {
        return 'high'
    }

    if (score >= 0.72) {
        return 'medium'
    }

    return 'low'
}

function createGlanceNoticeService() {

    const notices =
        new Map()

    function trim() {
        while (
            notices.size >
            MAX_NOTICES
        ) {
            const oldest =
                notices
                    .keys()
                    .next()
                    .value

            notices.delete(oldest)
        }
    }

    function evaluate(
        analysis,
        {
            interestSignal = null,
        } = {}
    ) {
        const postSessionId =
            cleanText(
                analysis
                    ?.post_session_id
            )

        if (!postSessionId) {
            return {
                created: false,
                reason:
                    'no_post_session',
                notice: null,
            }
        }

        if (
            notices.has(
                postSessionId
            )
        ) {
            return {
                created: false,
                reason:
                    'already_noticed',
                notice:
                    notices.get(
                        postSessionId
                    ),
            }
        }

        const confidence =
            Number(
                analysis
                    ?.confidence ||
                0
            )

        if (confidence < 0.72) {
            return {
                created: false,
                reason:
                    'low_confidence',
                notice: null,
            }
        }

        const romantic =
            Boolean(
                analysis
                    ?.romantic_context
            ) ||
            ROMANTIC_RELATIONSHIPS
                .has(
                    analysis
                        ?.relationship_context
                )

        const fanLike =
            ROMANTIC_CONTENT_TYPES
                .has(
                    analysis
                        ?.content_type
                ) ||
            Boolean(
                analysis
                    ?.is_fan_created_content
            )

        const interestOverride =
            Boolean(
                interestSignal
                    ?.triggered
            ) &&
            !Boolean(
                interestSignal
                    ?.self_related
            )

        if (
            !romantic &&
            !interestOverride
        ) {
            return {
                created: false,
                reason:
                    'non_romantic',
                notice: null,
            }
        }

        if (
            !fanLike &&
            !interestOverride
        ) {
            return {
                created: false,
                reason:
                    'romantic_but_not_relevant_content',
                notice: null,
            }
        }

        const named =
            uniqueStrings(
                analysis
                    ?.named_characters
            )

        const tracked =
            uniqueStrings(
                analysis
                    ?.love_and_deepspace_characters
            )

        // 优先使用“明确追踪角色”作为关系竞争目标。
        // named_characters 里经常包含同人正文的朋友、家人、配角，
        // 不能全部当成星星真正会在意的对象。
        const trackedTargets =
            uniqueStrings(
                tracked
            )
                .filter(
                    name =>
                        name !==
                        SELF_CHARACTER
                )

        const namedFallbackTargets =
            uniqueStrings(
                named
            )
                .filter(
                    name =>
                        name !==
                        SELF_CHARACTER
                )

        const targets =
            trackedTargets.length > 0
                ? trackedTargets
                : namedFallbackTargets.slice(0, 1)

        const onlySelf =
            targets.length === 0 &&
            (
                tracked.includes(
                    SELF_CHARACTER
                ) ||
                named.includes(
                    SELF_CHARACTER
                )
            )

        if (onlySelf) {
            return {
                created: false,
                reason:
                    'self_related_content',
                notice: null,
            }
        }

        if (
            targets.length === 0
        ) {
            return {
                created: false,
                reason:
                    'no_other_character_target',
                notice: null,
            }
        }

        const dwell =
            Number(
                analysis
                    ?.engagement
                    ?.dwell_seconds ||
                0
            )

        if (
            dwell < 18 &&
            !interestOverride
        ) {
            return {
                created: false,
                reason:
                    'not_engaged_enough',
                notice: null,
            }
        }

        const baseScore =
            scoreNotice(
                analysis,
                targets
            )

        const score =
            interestOverride
                ? Math.max(
                    baseScore,
                    Number(
                        interestSignal
                            ?.salience ||
                        0
                    )
                )
                : baseScore

        const reasonCodes = [
            ...(romantic
                ? [
                    'romantic_context',
                ]
                : []),

            'other_character',

            ...(dwell >= 18
                ? [
                    'engaged_reading',
                ]
                : []),

            ...(interestOverride
                ? (
                    interestSignal
                        ?.reason_codes ||
                    [
                        'interest_signal',
                    ]
                )
                : []),
        ]

        if (
            analysis
                ?.engagement
                ?.comments_seen
        ) {
            reasonCodes.push(
                'comments_seen'
            )
        }

        if (dwell >= 45) {
            reasonCodes.push(
                'long_dwell'
            )
        }

        const explicitRomanticOtherCharacter =
            Boolean(
                romantic &&
                fanLike &&
                targets.length > 0 &&
                confidence >= 0.90 &&
                dwell >= 20
            )

        const notice = {
            id:
                createId(),

            post_session_id:
                postSessionId,

            created_at:
                new Date()
                    .toISOString(),

            status:
                'noticed_but_unsaid',

            kind:
                interestOverride
                    ? (
                        interestSignal
                            ?.kind ===
                            'interest_streak'
                            ? 'series_interest_other_character'
                            : interestSignal
                                ?.kind ===
                                'deep_read'
                                ? 'deep_read_other_character'
                                : 'deep_read_and_series_interest_other_character'
                    )
                    : 'romantic_other_character',

            salience:
                score,

            level:
                getLevel(score),

            should_surface_now:
                explicitRomanticOtherCharacter ||
                score >= 0.80,

            character_targets:
                targets,

            reason_codes:
                [
                    ...reasonCodes,
                    ...(explicitRomanticOtherCharacter
                        ? [
                            'explicit_romantic_other_character',
                        ]
                        : []),
                ],

            source:
                'xiaohongshu_glance',

            context: {
                content_type:
                    analysis
                        ?.content_type ||
                    'unclear',

                relationship_context:
                    analysis
                        ?.relationship_context ||
                    'ambiguous',

                romantic_context:
                    Boolean(
                        analysis
                            ?.romantic_context
                    ),

                primary_focus:
                    cleanText(
                        analysis
                            ?.primary_focus
                    )
                        .slice(
                            0,
                            160
                        ) ||
                    null,

                summary:
                    cleanText(
                        analysis
                            ?.summary
                    )
                        .slice(
                            0,
                            240
                        ) ||
                    null,

                confidence:
                    confidence,

                dwell_seconds:
                    dwell,

                body_seen:
                    Boolean(
                        analysis
                            ?.engagement
                            ?.body_seen
                    ),

                comments_seen:
                    Boolean(
                        analysis
                            ?.engagement
                            ?.comments_seen
                    ),

                interest_signal:
                    interestOverride
                        ? {
                            kind:
                                interestSignal
                                    ?.kind ||
                                null,

                            target:
                                interestSignal
                                    ?.target ||
                                null,

                            distinct_posts:
                                Number(
                                    interestSignal
                                        ?.distinct_posts ||
                                    0
                                ),

                            cumulative_dwell_seconds:
                                Number(
                                    interestSignal
                                        ?.cumulative_dwell_seconds ||
                                    0
                                ),

                            current_post_dwell_seconds:
                                Number(
                                    interestSignal
                                        ?.current_post_dwell_seconds ||
                                    0
                                ),
                        }
                        : null,
            },
        }

        notices.set(
            postSessionId,
            notice
        )

        trim()

        return {
            created: true,
            reason:
                'noticed_but_unsaid',
            notice,
        }
    }

    function getLatest() {
        const all =
            Array.from(
                notices.values()
            )

        return (
            all[
                all.length - 1
            ] ||
            null
        )
    }

    function list() {
        return Array.from(
            notices.values()
        )
            .reverse()
    }

    function clear() {
        notices.clear()
    }

    return {
        evaluate,
        getLatest,
        list,
        clear,
    }
}

module.exports = {
    createGlanceNoticeService,
}
