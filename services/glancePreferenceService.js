'use strict'

const MAX_POSTS_PER_TROPE = 8

function cleanText(value) {
    return String(value ?? '')
        .replace(/\u0000/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function round3(value) {
    return Math.round(
        Math.max(
            0,
            Number(value) || 0
        ) * 1000
    ) / 1000
}

function createGlancePreferenceService() {

    const tropeMap =
        new Map()

    const seenPosts =
        new Set()

    function confidenceLabel(
        evidenceCount,
        score
    ) {
        if (
            evidenceCount >= 3 ||
            score >= 2.6
        ) {
            return 'high'
        }

        if (
            evidenceCount >= 2 ||
            score >= 1.55
        ) {
            return 'medium'
        }

        return 'tentative'
    }

    function observe(analysis) {
        const postSessionId =
            cleanText(
                analysis
                    ?.post_session_id
            )

        if (
            !postSessionId ||
            seenPosts.has(
                postSessionId
            )
        ) {
            return {
                updated: false,
                reason:
                    postSessionId
                        ? 'post_already_counted'
                        : 'no_post_session',
                hypotheses:
                    list(),
            }
        }

        const tropes =
            Array.isArray(
                analysis
                    ?.trope_signals
            )
                ? analysis
                    .trope_signals
                    .filter(Boolean)
                : []

        const romantic =
            Boolean(
                analysis
                    ?.romantic_context
            )

        const confidence =
            Number(
                analysis
                    ?.confidence ||
                0
            )

        const dwell =
            Number(
                analysis
                    ?.engagement
                    ?.dwell_seconds ||
                0
            )

        if (
            tropes.length === 0 ||
            !romantic ||
            confidence < 0.72 ||
            dwell < 18
        ) {
            seenPosts.add(
                postSessionId
            )

            return {
                updated: false,
                reason:
                    'not_enough_preference_evidence',
                hypotheses:
                    list(),
            }
        }

        const dwellBoost =
            dwell >= 45
                ? 0.18
                : dwell >= 25
                    ? 0.10
                    : 0.04

        const commentBoost =
            analysis
                ?.engagement
                ?.comments_seen
                ? 0.08
                : 0

        const weight =
            round3(
                Math.min(
                    1.25,
                    confidence +
                    dwellBoost +
                    commentBoost
                )
            )

        const targets =
            [
                ...(
                    Array.isArray(
                        analysis
                            ?.love_and_deepspace_characters
                    )
                        ? analysis
                            .love_and_deepspace_characters
                        : []
                ),
                ...(
                    Array.isArray(
                        analysis
                            ?.named_characters
                    )
                        ? analysis
                            .named_characters
                        : []
                ),
            ]
                .filter(Boolean)
                .slice(0, 10)

        for (
            const trope
            of tropes
        ) {
            const current =
                tropeMap.get(
                    trope
                ) || {
                    trope,
                    evidence_count: 0,
                    score: 0,
                    confidence: 'tentative',
                    first_seen_at:
                        new Date()
                            .toISOString(),
                    last_seen_at: null,
                    post_session_ids: [],
                    character_targets: [],
                    examples: [],
                }

            current
                .evidence_count += 1

            current.score =
                round3(
                    current.score +
                    weight
                )

            current.last_seen_at =
                new Date()
                    .toISOString()

            if (
                !current
                    .post_session_ids
                    .includes(
                        postSessionId
                    )
            ) {
                current
                    .post_session_ids
                    .push(
                        postSessionId
                    )
            }

            current
                .post_session_ids =
                current
                    .post_session_ids
                    .slice(
                        -MAX_POSTS_PER_TROPE
                    )

            for (
                const target
                of targets
            ) {
                if (
                    !current
                        .character_targets
                        .includes(
                            target
                        )
                ) {
                    current
                        .character_targets
                        .push(
                            target
                        )
                }
            }

            const example =
                cleanText(
                    analysis
                        ?.interaction_pattern ||
                    analysis
                        ?.summary ||
                    ''
                )
                    .slice(
                        0,
                        180
                    )

            if (
                example &&
                !current
                    .examples
                    .includes(
                        example
                    )
            ) {
                current
                    .examples
                    .push(
                        example
                    )
            }

            current.examples =
                current
                    .examples
                    .slice(-4)

            current.confidence =
                confidenceLabel(
                    current
                        .evidence_count,
                    current.score
                )

            tropeMap.set(
                trope,
                current
            )
        }

        seenPosts.add(
            postSessionId
        )

        return {
            updated: true,
            reason:
                'preference_hypothesis_updated',
            hypotheses:
                list(),
        }
    }

    function list() {
        return Array
            .from(
                tropeMap
                    .values()
            )
            .sort(
                (a, b) =>
                    b.score -
                    a.score
            )
            .map(
                item => ({
                    ...item,

                    inference_type:
                        'preference_hypothesis',

                    reading_is_not_consent:
                        true,
                })
            )
    }

    function getForTropes(
        tropes
    ) {
        const wanted =
            new Set(
                Array.isArray(tropes)
                    ? tropes
                    : []
            )

        return list()
            .filter(
                item =>
                    wanted.has(
                        item.trope
                    )
            )
    }

    function clear() {
        tropeMap.clear()
        seenPosts.clear()
    }

    return {
        observe,
        list,
        getForTropes,
        clear,
    }
}

module.exports = {
    createGlancePreferenceService,
}
